import { hydrateIcons, icon } from "./ui/icons.js";
import { initLayoutController } from "./ui/layout.js";
import { initSymbolBar } from "./ui/symbolBar.js";
import { generateDuplicatePath, initExplorerController } from "./ui/explorerController.js";
import { buildZipArchive, downloadZip } from "./storage/zipExporter.js";
import { initDiffModal } from "./ui/diffModal.js";
import { initLivePreviewModal } from "./ui/livePreviewModal.js";
import { initQuickOpenModal } from "./ui/quickOpenModal.js";
import { initGlobalSearchModal } from "./ui/globalSearchModal.js";
import { initSettingsModal } from "./ui/settingsModal.js";
import { computeSmartReplacement, createEditorManager } from "./editor/editorManager.js";
import { createSplitEditorController } from "./editor/splitEditorController.js";
import { createBinaryPreview } from "./ui/binaryPreview.js";
import { formatCode } from "./editor/codeFormatter.js";
import { initChatController } from "./ai/chatController.js";
import { initGithubController } from "./github/githubController.js";
import {
  downloadBatchBlobs,
  fetchRepoTreeIndex,
  fetchSingleRepoBlob,
  getGithubToken,
  saveProjectToGist
} from "./github/githubService.js";
import {
  exportKeysBundle,
  getKeyStorageMode,
  hasStoredCredentials,
  importKeysBundle
} from "./ai/providers.js";
import {
  cacheSingleGithubFileContent,
  createLocalProject,
  deleteProject,
  deleteProjectEntry,
  ensureInitialWorkspace,
  entryExists,
  getProject,
  getProjectEntries,
  getSavedActiveProjectId,
  hydrateLazyGithubProject,
  inferFileMeta,
  listProjects,
  markProjectOfflineCached,
  normalizePath,
  onWorkspaceBroadcast,
  readCredentialsBackup,
  renameProjectEntry,
  requestPersistentStorage,
  saveCredentialsBackup,
  saveProjectChatHistory,
  saveProjectState,
  setSavedActiveProjectId,
  updateFileContent,
  upsertEntry,
  validateUserPath
} from "./storage/workspaceDb.js";
import { keyboardRouter } from "./ui/keyboardRouter.js";
import {
  clearEmergencyBackup,
  restoreEmergencyBackup,
  writeEmergencyBackup,
  getTabInstanceId
} from "./storage/emergencyBackup.js";
import {
  base64ToUint8Array,
  isBinaryFile
} from "./storage/fileImport.js";

async function initApp() {
  hydrateIcons(document);
  registerPwaServiceWorker();
  void requestPersistentStorage();
  keyboardRouter.attach();

  // Inicializar Tema visual (persistido en localStorage)
  const THEME_STORAGE_KEY = "studio_theme";
  const selectThemeEl = document.getElementById("select-theme");
  try {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || "default";
    if (savedTheme && savedTheme !== "default") {
      document.documentElement.dataset.theme = savedTheme;
    }
    if (selectThemeEl) {
      selectThemeEl.value = savedTheme;
      selectThemeEl.addEventListener("change", (e) => {
        const chosen = e.target.value;
        if (chosen === "default") {
          delete document.documentElement.dataset.theme;
          localStorage.removeItem(THEME_STORAGE_KEY);
        } else {
          document.documentElement.dataset.theme = chosen;
          localStorage.setItem(THEME_STORAGE_KEY, chosen);
        }
      });
    }
  } catch {
    // Entorno restringido o sin localStorage
  }

  // Restaurar credenciales (claves IA y token GitHub) desde IndexedDB si Safari/iPadOS vació localStorage
  try {
    if (getKeyStorageMode() === "session") {
      void saveCredentialsBackup("");
    } else if (!hasStoredCredentials()) {
      const backupJson = await readCredentialsBackup();
      if (backupJson) {
        importKeysBundle(backupJson);
      }
    } else {
      void saveCredentialsBackup(exportKeysBundle());
    }
  } catch {
    // Continuar con el arranque normal si falla la lectura de respaldo
  }

  const layout = initLayoutController();
  const diffModal = initDiffModal();

  const tabStripEl = document.getElementById("editor-tabs");
  const editorMountEl = document.getElementById("editor-mount");
  const emptyStateEl = document.getElementById("editor-empty-state");
  const emptyQuickListEl = document.getElementById("editor-empty-quicklist");
  const contextStatusEl = document.getElementById("chat-context-status");
  const contextFileEl = document.getElementById("chat-context-filename");

  const btnUndo = document.getElementById("btn-editor-undo");
  const btnRedo = document.getElementById("btn-editor-redo");
  const btnSearch = document.getElementById("btn-editor-search");
  const btnFormat = document.getElementById("btn-editor-format");
  const btnWrap = document.getElementById("btn-editor-wrap");
  const btnMinimap = document.getElementById("btn-editor-minimap");
  const btnEditorSplit = document.getElementById("btn-editor-split");
  const btnFontDown = document.getElementById("btn-font-down");
  const btnFontUp = document.getElementById("btn-font-up");
  const btnExportFile = document.getElementById("btn-export-file");
  const zoomReadoutEl = document.getElementById("editor-zoom-readout");

  const editorStageEl = document.getElementById("editor-stage");
  const splitDividerEl = document.getElementById("editor-split-divider");
  const splitMountEl = document.getElementById("editor-mount-split");
  const splitBodyEl = document.getElementById("editor-split-body");
  const splitTitleTextEl = document.getElementById("editor-split-title-text");
  const splitFileSelectEl = document.getElementById("editor-split-file-select");
  const btnCloseSplit = document.getElementById("btn-close-split");
  const binaryPreview = createBinaryPreview({
    binaryPreviewEl: document.getElementById("editor-binary-preview"),
    onDownloadFile: downloadCurrentActiveFile
  });

  /** @type {ReturnType<typeof createSplitEditorController> | null} */
  let splitController = null;

  const statusFilePathEl = document.getElementById("status-file-path");
  const statusFileLangEl = document.getElementById("status-file-lang");
  const statusCursorPosEl = document.getElementById("status-cursor-pos");
  const statusNetworkEl = document.getElementById("status-network-state");

  let projects = await ensureInitialWorkspace();
  // Recuperar lo escrito justo antes de un cierre/recarga abrupta (ver emergencyBackup.js)
  let restoredFromBackup = 0;
  try {
    restoredFromBackup = await restoreEmergencyBackup({ entryExists, updateFileContent });
  } catch {
    // Si falla, el respaldo queda en localStorage y se reintenta en la próxima apertura
  }
  let activeProject =
    projects.find((p) => p.id === getSavedActiveProjectId()) || projects[0];
  setSavedActiveProjectId(activeProject.id);

  /** @type {Array<any>} */
  let entries = [];
  /** @type {Array<any>} */
  let filesOnly = [];
  let openTabIds = [];
  let activeFileId = null;
  let activeSelection = { text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 };
  let chat = null;

  /** @type {Map<string, number>} */
  const saveTimers = new Map();

  const editor = await createEditorManager({
    mountEl: editorMountEl,
    onDocChange(filePath, newContent) {
      const target = filesOnly.find((f) => f.id === filePath);
      if (!target) {
        return;
      }
      const wasDirty = isFileDirtyForProject(target);
      target.content = newContent;
      const nowDirty = isFileDirtyForProject(target);

      if (wasDirty !== nowDirty) {
        renderTabs();
      }

      scheduleAutosave(activeProject.id, filePath, newContent);
      splitController?.syncDoc(filePath, newContent);
    },
    onSelectionChange(selection) {
      activeSelection = selection;
      updateAssistantContextLabel();
      updateStatusBar();
      chat?.notifySelectionChanged();
    }
  });

  initQuickOpenModal({
    getFiles: () => filesOnly,
    getActiveFile: () => (activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null),
    async onSelectFile(path, targetLine) {
      await openOrFocusFile(path);
      if (typeof targetLine === "number" && targetLine > 0) {
        editor.goToLine(targetLine);
      }
    }
  });

  const globalSearchModal = initGlobalSearchModal({
    getFiles: () => filesOnly,
    async onSelectMatch({ path, line }) {
      await openOrFocusFile(path);
      if (typeof line === "number" && line > 0) {
        editor.goToLine(line);
      }
    }
  });

  keyboardRouter.registerGlobalShortcut("ctrl+shift+f", () => globalSearchModal.open());
  keyboardRouter.registerGlobalShortcut("meta+shift+f", () => globalSearchModal.open());

  const getContextSnapshot = () => {
    const rawActive = activeFileId ? filesOnly.find((f) => f.id === activeFileId) ?? null : null;
    const activeFile = rawActive && isBinaryFile(rawActive) ? null : rawActive;
    const otherOpenFiles = openTabIds
      .filter((id) => id !== activeFileId)
      .map((id) => filesOnly.find((f) => f.id === id))
      .filter((f) => Boolean(f) && f.contentLoaded !== false && !isBinaryFile(f));

    return {
      activeFile,
      selection: activeSelection,
      otherOpenFiles
    };
  };

  const symbolBar = initSymbolBar({
    onInsert(text, cursorBack) {
      if (!activeFileId) return;
      editor.insertAtCursor(text, cursorBack);
    }
  });

  const settingsModal = initSettingsModal({
    editor,
    getContextSnapshot,
    onHardwareKeyboardChange(hardwareMode) {
      splitController?.setHardwareKeyboardMode(hardwareMode);
    },
    onSelectProvider(providerId) {
      if (!layout.isRightPanelOpen()) {
        layout.toggleRightPanel();
      }
      chat?.switchProvider?.(providerId);
    }
  });

  keyboardRouter.registerGlobalShortcut("ctrl+,", () => settingsModal?.open());
  keyboardRouter.registerGlobalShortcut("meta+,", () => settingsModal?.open());

  async function downloadSingleFile(filePath) {
    const target = filesOnly.find((f) => f.id === filePath);
    if (!target) return;
    try {
      await ensureFileContentLoaded(target);
    } catch (error) {
      explorer.setAutosaveStatus(
        error instanceof Error ? error.message : "No se pudo descargar el archivo desde GitHub"
      );
      return;
    }
    const filename = target.path.split("/").pop() || "archivo.txt";
    let blob;
    if (target.isBinary && (target.base64 || target.content)) {
      const rawBytes = base64ToUint8Array(target.base64 || target.content);
      blob = new Blob([rawBytes], { type: "application/octet-stream" });
    } else {
      blob = new Blob([target.content ?? ""], { type: "text/plain;charset=utf-8" });
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadCurrentActiveFile() {
    const current = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
    if (!current) return;
    await downloadSingleFile(current.id);
  }

  const explorer = initExplorerController({
    onSelectFile(path) {
      openOrFocusFile(path);
    },
    async onCreateEntry(path, isFolder) {
      await flushPendingSaves();
      await upsertEntry(activeProject.id, path, {
        isFolder,
        content: isFolder ? "" : defaultStarterTemplate(path),
        allowOverwrite: false
      });
      await reloadProjectEntries();
      if (!isFolder) {
        await openOrFocusFile(path);
      } else {
        renderWorkspaceView();
      }
      await github.refreshTopbarBadge();
    },
    async onRenameEntry(oldPath, newPath, isFolder) {
      await flushPendingSaves();
      const affectedUnloaded = filesOnly.filter(
        (f) =>
          f.contentLoaded === false &&
          (f.id === oldPath || (isFolder && f.id.startsWith(`${oldPath}/`)))
      );
      const sourceProjectId = activeProject.id;
      if (affectedUnloaded.length > 0) {
        await ensureFilesLoaded(affectedUnloaded);
      }
      if (activeProject.id !== sourceProjectId) {
        // El usuario cambió de proyecto mientras se descargaban los archivos: no renombrar en el proyecto equivocado.
        return;
      }

      await renameProjectEntry(activeProject.id, oldPath, newPath, isFolder);

      // Actualizar pestañas abiertas afectadas por el renombrado
      openTabIds = openTabIds.map((id) => {
        if (id === oldPath) return newPath;
        if (isFolder && id.startsWith(`${oldPath}/`)) {
          return `${newPath}${id.slice(oldPath.length)}`;
        }
        return id;
      });
      if (activeFileId === oldPath) {
        activeFileId = newPath;
      } else if (isFolder && activeFileId && activeFileId.startsWith(`${oldPath}/`)) {
        activeFileId = `${newPath}${activeFileId.slice(oldPath.length)}`;
      }
      splitController?.handleEntryRenamed(oldPath, newPath, isFolder);
      editor.renameFileStates(oldPath, newPath, isFolder);

      await persistTabsState();
      await reloadProjectEntries();
      renderWorkspaceView();
      await github.refreshTopbarBadge();
    },
    async onDeleteEntry(path, isFolder) {
      await flushPendingSaves();
      await deleteProjectEntry(activeProject.id, path, isFolder);

      const removedTabs = openTabIds.filter(
        (id) => id === path || (isFolder && id.startsWith(`${path}/`))
      );
      for (const rem of removedTabs) {
        editor.dropFileState(rem);
        splitController?.dropFileState(rem);
      }

      openTabIds = openTabIds.filter(
        (id) => id !== path && !(isFolder && id.startsWith(`${path}/`))
      );
      if (!openTabIds.includes(activeFileId)) {
        activeFileId = openTabIds[0] || null;
      }

      await persistTabsState();
      await reloadProjectEntries();
      renderWorkspaceView();
      await github.refreshTopbarBadge();
    },
    async onSwitchProject(selectedValue) {
      await flushPendingSaves();
      if (selectedValue.startsWith("ghlive::")) {
        const parts = selectedValue.split("::");
        const fullName = parts[1] || "";
        const defaultBranch = parts[2] || "main";
        const [owner, repo] = fullName.split("/");
        if (!owner || !repo) return;

        explorer.setAutosaveStatus(`Abriendo ${fullName}…`);
        try {
          const index = await fetchRepoTreeIndex({
            token: getGithubToken(),
            owner,
            repo,
            branch: defaultBranch
          });
          const createdProj = await hydrateLazyGithubProject({
            owner,
            repo,
            branch: index.branch || defaultBranch,
            commitSha: index.commitSha,
            entries: index.entries
          });
          projects = await listProjects();
          await switchProject(createdProj.id, true);
          if (index.isTruncated) {
            explorer.setAutosaveStatus(
              `Atención: Árbol de ${repo} incompleto (truncado por GitHub en ${index.entries.length} archivos)`
            );
          } else {
            explorer.setAutosaveStatus(
              `Árbol de ${repo} listo (${index.entries.length} archivos bajo demanda)`
            );
          }
        } catch (error) {
          explorer.renderProjects(projects, activeProject.id);
          explorer.setAutosaveStatus(
            error instanceof Error ? error.message : "No se pudo conectar con GitHub"
          );
        }
        return;
      }

      await switchProject(selectedValue);
    },
    async onCreateProject(name) {
      await flushPendingSaves();
      const created = await createLocalProject(name);
      projects = await listProjects();
      await switchProject(created.id);
    },
    async onDeleteCurrentProject() {
      if (projects.length <= 1) return;
      await flushPendingSaves();
      const removedId = activeProject.id;
      await deleteProject(removedId);
      projects = await listProjects();
      await switchProject(projects[0].id);
    },
    async onImportFiles(importedList) {
      await flushPendingSaves();
      let lastPath = null;
      let importedCount = 0;
      try {
        for (const item of importedList) {
          await upsertEntry(activeProject.id, item.path, {
            isFolder: false,
            content: item.content,
            isBinary: Boolean(item.isBinary),
            base64: item.base64 || null
          });
          editor.dropFileState(item.path);
          lastPath = item.path;
          importedCount += 1;
        }
      } catch (error) {
        explorer.setAutosaveStatus(
          error instanceof Error ? error.message : "No se pudo importar el archivo"
        );
      }
      await reloadProjectEntries();
      if (lastPath) {
        await openOrFocusFile(lastPath);
        if (importedCount > 0) {
          explorer.setAutosaveStatus(
            importedCount === 1 ? "Archivo importado" : `${importedCount} archivos importados`
          );
        }
      } else {
        renderWorkspaceView();
      }
      await github.refreshTopbarBadge();
    },
    async onDuplicateEntry(sourcePath) {
      await flushPendingSaves();
      const source = filesOnly.find((f) => f.id === sourcePath);
      if (!source) return;

      try {
        await ensureFileContentLoaded(source);
      } catch (error) {
        explorer.setAutosaveStatus(
          error instanceof Error ? error.message : "No se pudo leer el archivo a duplicar"
        );
        return;
      }

      const existingPaths = new Set(filesOnly.map((f) => f.path));
      const newPath = generateDuplicatePath(source.path, existingPaths);

      await upsertEntry(activeProject.id, newPath, {
        isFolder: false,
        content: source.content,
        isBinary: Boolean(source.isBinary),
        base64: source.base64 || null,
        allowOverwrite: false
      });
      await reloadProjectEntries();
      await openOrFocusFile(newPath);
      explorer.setAutosaveStatus(`Archivo duplicado como "${newPath.split("/").pop()}"`);
      await github.refreshTopbarBadge();
    },
    onDownloadFile: downloadSingleFile,
    onDownloadActiveFile: downloadCurrentActiveFile,
    async onExportProjectZip() {
      await flushPendingSaves();
      if (!filesOnly || filesOnly.length === 0) {
        explorer.setAutosaveStatus("No hay archivos para exportar");
        return;
      }
      explorer.setAutosaveStatus("Preparando archivo ZIP…");

      const unloaded = filesOnly.filter((f) => f.contentLoaded === false && f.blobSha);
      if (unloaded.length > 0) {
        try {
          await ensureFilesLoaded(unloaded, (done, total) => {
            explorer.setAutosaveStatus(`Descargando archivos para el ZIP (${done}/${total})…`);
          });
        } catch {
          // Continuar si falla la red
        }
      }

      try {
        const zipFiles = filesOnly.map((f) => {
          if (f.isBinary && (f.base64 || f.content)) {
            return {
              path: f.path,
              content: base64ToUint8Array(f.base64 || f.content)
            };
          }
          return {
            path: f.path,
            content: f.content || ""
          };
        });
        const zipBytes = buildZipArchive(zipFiles);
        const projectName = (activeProject?.name || "proyecto").replace(/[/\\?%*:|"<>]/g, "-");
        downloadZip(zipBytes, `${projectName}.zip`);
        explorer.setAutosaveStatus(`Proyecto exportado como "${projectName}.zip"`);
      } catch (err) {
        explorer.setAutosaveStatus(
          err instanceof Error ? `Error al exportar ZIP: ${err.message}` : "No se pudo crear el archivo ZIP"
        );
      }
    },
    async onSaveRepoOffline() {
      if (activeProject.kind !== "github" || !activeProject.github) return;
      await flushPendingSaves();

      const pending = filesOnly.filter((f) => f.contentLoaded === false && f.blobSha);
      if (pending.length === 0) {
        await markProjectOfflineCached(activeProject.id, true);
        activeProject.offlineCached = true;
        projects = await listProjects();
        explorer.renderProjects(projects, activeProject.id);
        syncOfflineButtonState();
        explorer.setAutosaveStatus("Copia offline completa en el iPad");
        return;
      }

      explorer.setOfflineRepoState({
        visible: true,
        isOfflineReady: false,
        pendingCount: pending.length,
        busy: true
      });
      explorer.setAutosaveStatus(`Guardando copia offline (0/${pending.length})…`);

      const sourceProjectId = activeProject.id;
      try {
        await ensureFilesLoaded(pending, (done, total) => {
          explorer.setAutosaveStatus(`Guardando copia offline (${done}/${total})…`);
        });
        if (activeProject.id !== sourceProjectId) {
          // ensureFilesLoaded ya guardó cada archivo en su repositorio de origen; no marcar otro proyecto.
          return;
        }
        await markProjectOfflineCached(activeProject.id, true);
        activeProject.offlineCached = true;
        projects = await listProjects();
        explorer.renderProjects(projects, activeProject.id);
        syncOfflineButtonState();
        explorer.setAutosaveStatus("Copia offline guardada en el iPad");
      } catch (error) {
        syncOfflineButtonState();
        explorer.setAutosaveStatus(
          error instanceof Error ? error.message : "No se pudo completar la copia offline"
        );
      }
    },
    async onCloudBackupProject() {
      const token = getGithubToken();
      if (!token) {
        document.getElementById("btn-open-github")?.click();
        return;
      }
      try {
        explorer.setAutosaveStatus("Respaldando en Gist privado…");
        await flushPendingSaves();
        const entries = await getProjectEntries(activeProject.id);
        const res = await saveProjectToGist(token, {
          projectName: activeProject.name,
          entries,
          existingGistId: activeProject.gistId || null
        });
        activeProject.gistId = res.id;
        await saveProjectState(activeProject);
        explorer.setAutosaveStatus(`¡Respaldado en Gist! (${res.id.slice(0, 6)})`);
      } catch (err) {
        const msg = err?.message || "al respaldar en Gist";
        if (msg.includes("Resource not accessible") || msg.includes("permiso para Gists") || msg.includes("token no tiene permiso")) {
          explorer.setAutosaveStatus("Error: el token necesita permiso 'Gists: Read and write'");
        } else {
          explorer.setAutosaveStatus(`Error: ${msg}`);
        }
      }
    }
  });

  const PREVIEWABLE_LANGS = new Set(["html", "js", "css", "python", "markdown", "c", "cpp", "sql", "rust", "go"]);

  initLivePreviewModal({
    getWorkspaceSnapshot() {
      return {
        files: filesOnly,
        activeFileId,
        projectId: activeProject?.id || null
      };
    },
    async ensureFileLoaded(fileOrPath) {
      const target = typeof fileOrPath === "string"
        ? filesOnly.find((f) => normalizePath(f.path) === normalizePath(fileOrPath))
        : fileOrPath;
      if (target) {
        await ensureFileContentLoaded(target);
      }
      return target;
    },
    async ensureFilesLoaded(fileList) {
      if (!Array.isArray(fileList) || fileList.length === 0) return;
      const targets = fileList.map((f) => {
        return typeof f === "string"
          ? filesOnly.find((item) => normalizePath(item.path) === normalizePath(f))
          : f;
      }).filter(Boolean);
      await ensureFilesLoaded(targets);
    },
    onErrorMarker(lineNum, errorMessage) {
      if (editor && typeof editor.addErrorMarker === "function") {
        editor.addErrorMarker(lineNum, errorMessage);
      }
    },
    onClearErrorMarkers() {
      if (editor && typeof editor.clearErrorMarkers === "function") {
        editor.clearErrorMarkers();
      }
    },
    onGoToLine(lineNum) {
      if (editor && typeof editor.goToLine === "function") {
        editor.goToLine(lineNum);
      }
    },
    async onBeforePreview() {
      await flushPendingSaves();
      if (activeProject.kind !== "github" || !activeFileId) return;
      const activeFile = filesOnly.find((f) => f.id === activeFileId);
      if (!activeFile || !PREVIEWABLE_LANGS.has(activeFile.lang)) return;

      if (activeFile.lang === "markdown") {
        if (activeFile.contentLoaded === false && activeFile.blobSha) {
          try {
            await ensureFileContentLoaded(activeFile);
          } catch {
            // Se muestra con el estado actual en memoria
          }
        }
        return;
      }

      const lastSlash = activeFile.path.lastIndexOf("/");
      const folderPrefix = lastSlash === -1 ? "" : `${activeFile.path.slice(0, lastSlash + 1)}`;
      const isWeb = activeFile.lang === "html" || activeFile.lang === "js" || activeFile.lang === "css";

      const needed = filesOnly.filter((f) => {
        if (f.contentLoaded !== false || !f.blobSha) return false;
        if (!isWeb && folderPrefix && !f.path.startsWith(folderPrefix)) return false;
        if (activeFile.lang === "python") {
          return f.lang === "python";
        }
        if (activeFile.lang === "c" || activeFile.lang === "cpp" || activeFile.lang === "rust" || activeFile.lang === "go") {
          return f.lang === activeFile.lang || f.path.endsWith(".h") || f.path.endsWith(".hpp");
        }
        if (activeFile.lang === "sql") {
          return f.lang === "sql";
        }
        return (
          f.lang === "html" ||
          f.lang === "js" ||
          f.lang === "css" ||
          f.path.endsWith(".json")
        );
      });

      if (needed.length > 0) {
        explorer.setAutosaveStatus(`Cargando ${needed.length} archivo(s) para la vista previa…`);
        try {
          await ensureFilesLoaded(needed);
          explorer.setAutosaveStatus("Vista previa lista");
        } catch {
          // Si falla la red, abre con los archivos ya disponibles en memoria
        }
      }
    }
  });

  function inferFallbackFilename(rawLang) {
    const clean = String(rawLang || "").trim().toLowerCase();
    switch (clean) {
      case "py":
      case "python":
        return "main.py";
      case "cpp":
      case "c++":
        return "main.cpp";
      case "rust":
      case "rs":
        return "main.rs";
      case "go":
      case "golang":
        return "main.go";
      case "c":
        return "main.c";
      case "html":
        return "index.html";
      case "css":
        return "styles.css";
      case "js":
      case "javascript":
        return "app.js";
      case "sql":
        return "consulta.sql";
      case "md":
      case "markdown":
        return "README.md";
      case "json":
        return "datos.json";
      default:
        return "archivo.txt";
    }
  }

  async function ensureAnOpenFile(preferredLang = "") {
    if (activeFileId) return;
    if (filesOnly.length > 0) {
      // Preferir un archivo ya disponible en el iPad para no depender de la red
      const candidate = filesOnly.find((f) => f.contentLoaded !== false) || filesOnly[0];
      await openOrFocusFile(candidate.id);
      return;
    }
    const fallbackPath = inferFallbackFilename(preferredLang);
    await upsertEntry(activeProject.id, fallbackPath, {
      isFolder: false,
      content: "",
      allowOverwrite: false
    });
    await reloadProjectEntries();
    await openOrFocusFile(fallbackPath);
    await github.refreshTopbarBadge();
  }

  chat = initChatController({
    getContextSnapshot,
    async onInsertAtCursor(code, lang) {
      await ensureAnOpenFile(lang);
      if (!activeFileId) {
        return false;
      }
      editor.insertAtCursor(code, 0);
      layout.closeRightOnCompactAction();
      return true;
    },
    async onReplaceSelection(code, contextHint = null) {
      if (!activeFileId) {
        return false;
      }
      editor.replaceSelection(code, contextHint);
      layout.closeRightOnCompactAction();
      return true;
    },
    async onApplyWholeFile(code, lang, contextHint = null) {
      await ensureAnOpenFile(lang);
      const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
      if (!activeFile) return;
      const smart = computeSmartReplacement(activeFile.content ?? "", code, {
        cursorLine: activeSelection?.cursorLine || 1,
        selectionFrom: 0,
        selectionTo: 0,
        contextHint
      });
      diffModal.openConfirmApplyDiff({
        fileName: activeFile.shortName,
        oldCode: activeFile.content,
        newCode: smart.text,
        onConfirm() {
          editor.replaceEntireDocument(smart.text);
          layout.closeRightOnCompactAction();
        }
      });
    },
    async onApplyToFile(targetPath, code) {
      let norm;
      try {
        norm = validateUserPath(targetPath);
      } catch {
        norm = normalizePath(targetPath);
      }
      if (!norm) return false;
      let targetFile = filesOnly.find((f) => normalizePath(f.path) === norm);
      if (!targetFile) {
        await upsertEntry(activeProject.id, norm, {
          content: code,
          isFolder: false,
          allowOverwrite: true
        });
        await reloadProjectEntries();
        targetFile = filesOnly.find((f) => normalizePath(f.path) === norm);
        if (targetFile) {
          await openOrFocusFile(targetFile.id);
        }
      } else {
        await openOrFocusFile(targetFile.id);
        editor.replaceEntireDocument(code);
        targetFile.content = code;
        scheduleAutosave(activeProject.id, targetFile.id, code);
        renderTabs();
      }
      return true;
    },
    async onApplyMultiFile(filesToApply) {
      if (!Array.isArray(filesToApply) || filesToApply.length === 0) return false;
      let firstValidNorm = null;
      for (const item of filesToApply) {
        let norm;
        try {
          norm = validateUserPath(item.path);
        } catch {
          norm = normalizePath(item.path);
        }
        if (!norm || /[\x00-\x1f:*?"<>|]/.test(norm)) continue;
        if (!firstValidNorm) firstValidNorm = norm;
        const existing = filesOnly.find((f) => normalizePath(f.path) === norm);
        if (existing) {
          existing.content = item.code;
          await updateFileContent(activeProject.id, norm, item.code);
          scheduleAutosave(activeProject.id, existing.id, item.code);
          if (activeFileId === existing.id) {
            editor.replaceEntireDocument(item.code);
          }
          splitController?.replaceIfActive(existing.id, item.code);
        } else {
          await upsertEntry(activeProject.id, norm, {
            content: item.code,
            isFolder: false,
            allowOverwrite: true
          });
        }
      }
      await reloadProjectEntries();
      if (firstValidNorm) {
        const firstTarget = filesOnly.find((f) => normalizePath(f.path) === firstValidNorm);
        if (firstTarget) {
          await openOrFocusFile(firstTarget.id);
        }
      }
      renderTabs();
      return true;
    },
    onConversationChange(history, projectId) {
      // La respuesta puede terminar después de cambiar de proyecto: se guarda donde se hizo la pregunta.
      const targetId = projectId || activeProject.id;
      if (targetId === activeProject.id) {
        activeProject.chatHistory = history;
      }
      void saveProjectChatHistory(targetId, history);
    },
    onKeysImported() {
      void github.syncExplorerReposInBackground();
    }
  });

  const github = initGithubController({
    getActiveProject: () => activeProject,
    onFlushPendingSaves: flushPendingSaves,
    onOpenDiff({ title, oldCode, newCode }) {
      diffModal.openReadOnlyDiff({ title, oldCode, newCode });
    },
    onReposListChanged(remoteRepos) {
      explorer.renderProjects(projects, activeProject.id, remoteRepos);
    },
    async onProjectClonedOrSynced(projectId) {
      await flushPendingSaves();
      projects = await listProjects();
      await switchProject(projectId, true);
    }
  });

  // Atajo universal Cmd+S / Ctrl+S para forzar volcado inmediato a IndexedDB sin diálogo del navegador
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void (async () => {
        await flushPendingSaves();
        explorer.setAutosaveStatus("Guardado en IndexedDB");
      })();
    }
  });

  // Atajo universal Cmd+W / Ctrl+W / Alt+W para cerrar la pestaña activa (Alt+W prioritario en Safari PWA)
  window.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey || event.altKey) &&
      !event.shiftKey &&
      (event.key === "w" || event.key === "W")
    ) {
      if (keyboardRouter.getActiveModal() || document.querySelector("dialog[open]")) {
        return;
      }
      if (activeFileId) {
        event.preventDefault();
        requestCloseTab(activeFileId);
      }
    }
  });

  // Sincronización multi-pestaña en vivo vía BroadcastChannel
  onWorkspaceBroadcast(async (event) => {
    if (!event || !activeProject || event.projectId !== activeProject.id) return;

    // Actualización de contenido de archivo emitida por otra pestaña (contrato FILE_UPDATED)
    if (event.type === "FILE_UPDATED" && event.path) {
      const timerKey = `${activeProject.id}::${event.path}`;
      // Si esta pestaña tiene escrituras locales en vuelo para este archivo, no pisarlas
      if (saveTimers.has(timerKey)) {
        return;
      }

      await reloadProjectEntries();
      // Re-verificar tras la lectura asíncrona por si el usuario tecleó mientras se cargaban las entradas
      if (!activeProject || event.projectId !== activeProject.id || saveTimers.has(timerKey)) {
        return;
      }

      const updated = filesOnly.find((f) => f.id === event.path);
      if (!updated) return;

      if (event.path === activeFileId) {
        // Invalida el estado cacheado en statesByFile y reabre limpiamente desde IndexedDB sin recargar toda la UI
        editor.dropFileState(event.path);
        if (isBinaryFile(updated)) {
          binaryPreview.render(updated);
        } else {
          binaryPreview.hide();
          editor.openFile(updated);
        }
        renderTabs();
      } else {
        // Invalida el estado en segundo plano para que al hacer clic se lea el contenido fresco
        editor.dropFileState(event.path);
        renderTabs();
      }

      splitController?.handleRemoteFileUpdated(event.path, updated);
      return;
    }

    // Para cambios estructurales (creación, renombrado, borrado): volcar primero ediciones pendientes locales
    await flushPendingSaves();
    await reloadProjectEntries();
    renderWorkspaceView();
  });

  // Autoguardado inmediato si Safari en iPad suspende la app o cambia en Stage Manager.
  // Primero se escribe un respaldo SÍNCRONO particionado por proyecto e instancia de pestaña en localStorage.
  const tabInstanceId = getTabInstanceId();
  const backupAndFlush = () => {
    if (saveTimers.size === 0) return;
    const currentPid = activeProject?.id || null;
    writeEmergencyBackup([...saveTimers.values()], window.localStorage, currentPid, tabInstanceId);
    void flushPendingSaves().then(() => {
      if (saveTimers.size === 0) {
        clearEmergencyBackup(window.localStorage, currentPid, tabInstanceId);
      }
    });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      backupAndFlush();
    }
  });
  window.addEventListener("pagehide", backupAndFlush);
  window.addEventListener("beforeunload", backupAndFlush);

  const btnToggleSymbols = document.getElementById("btn-toggle-symbols");
  syncToolbarState();
  preventFocusSteal([btnUndo, btnRedo, btnFontDown, btnFontUp, btnMinimap, btnEditorSplit, btnCloseSplit, btnToggleSymbols]);

  splitController = createSplitEditorController({
    btnEditorSplit,
    btnCloseSplit,
    editorStageEl,
    editorMountEl,
    splitMountEl,
    splitDividerEl,
    splitBodyEl,
    splitTitleTextEl,
    splitFileSelectEl,
    keyboardRouter,
    getActiveProject: () => activeProject,
    getActiveFileId: () => activeFileId,
    getFilesOnly: () => filesOnly,
    getOpenTabIds: () => openTabIds,
    isFileDirtyForProject,
    renderTabs,
    scheduleAutosave,
    onSyncMainDoc: (filePath, newContent) => editor.syncDoc(filePath, newContent),
    onFocusMain: () => editor.focus()
  });

  function formatActiveDocument() {
    if (!activeFileId) return;
    const target = filesOnly.find((f) => f.id === activeFileId);
    if (!target || target.contentLoaded === false || isBinaryFile(target)) return;
    const current = editor.getValue();
    const lang = target.lang || inferFileMeta(target.path).lang;
    const result = formatCode(current, lang);
    if (!result.ok) {
      explorer.setAutosaveStatus(result.error);
      return;
    }
    if (!result.changed) {
      explorer.setAutosaveStatus("El archivo ya está correctamente formateado");
      return;
    }
    editor.replaceEntireDocument(result.formatted, { preserveCursorLine: true });
    explorer.setAutosaveStatus("Documento formateado (Cmd/Ctrl+Z para deshacer)");
  }

  keyboardRouter.registerGlobalShortcut("alt+shift+f", () => formatActiveDocument());

  btnUndo?.addEventListener("click", () => editor.triggerUndo());
  btnRedo?.addEventListener("click", () => editor.triggerRedo());
  btnSearch?.addEventListener("click", () => editor.triggerSearch());
  btnFormat?.addEventListener("click", () => formatActiveDocument());
  btnWrap?.addEventListener("click", () => {
    const enabled = editor.toggleWordWrap();
    btnWrap.setAttribute("aria-pressed", String(enabled));
  });
  btnMinimap?.addEventListener("click", () => {
    const visible = editor.toggleMinimap();
    btnMinimap.setAttribute("aria-pressed", String(visible));
  });
  btnFontDown?.addEventListener("click", () => {
    const size = editor.stepFontSize(-1);
    if (zoomReadoutEl) zoomReadoutEl.textContent = `${size}px`;
  });
  btnFontUp?.addEventListener("click", () => {
    const size = editor.stepFontSize(1);
    if (zoomReadoutEl) zoomReadoutEl.textContent = `${size}px`;
  });

  const AUTOSAVE_STORAGE_KEY = "studio_autosave_delay";
  function getAutosaveDelay() {
    try {
      const stored = localStorage.getItem(AUTOSAVE_STORAGE_KEY);
      if (stored === "manual") return -1;
      if (stored === "1000") return 1000;
      return 240;
    } catch {
      return 240;
    }
  }

  function scheduleAutosave(projectId, filePath, content) {
    const delay = getAutosaveDelay();
    const timerKey = `${projectId}::${filePath}`;
    const prev = saveTimers.get(timerKey);
    if (prev && prev.timerId) {
      window.clearTimeout(prev.timerId);
    }

    if (delay < 0) {
      saveTimers.set(timerKey, { timerId: 0, projectId, filePath, content });
      explorer.setAutosaveStatus("Modificado (Guardar con Cmd+S)");
      return;
    }

    explorer.setAutosaveStatus("Guardando…");
    const item = { timerId: 0, projectId, filePath, content };
    item.timerId = window.setTimeout(async () => {
      item.timerId = 0;
      try {
        // La entrada sigue registrada mientras se escribe: así el respaldo de emergencia y
        // flushPendingSaves también cubren un guardado que está "en vuelo".
        await updateFileContent(projectId, filePath, content);
        if (saveTimers.get(timerKey) === item) {
          saveTimers.delete(timerKey);
        }
        explorer.setAutosaveStatus("Autoguardado en IndexedDB");
        explorer.refreshStorageIndicator?.();
        await github.refreshTopbarBadge();
      } catch (err) {
        const isQuota = err && err.name === "QuotaExceededError";
        explorer.setAutosaveStatus(
          isQuota ? "Error: Almacenamiento local lleno" : "Error al guardar en IndexedDB"
        );
      }
    }, delay);

    saveTimers.set(timerKey, item);
  }

  async function flushPendingSaves() {
    if (saveTimers.size === 0) return;
    const entries = [...saveTimers.entries()];
    for (const [key, item] of entries) {
      if (item && item.timerId) {
        window.clearTimeout(item.timerId);
        item.timerId = 0;
      }
      if (item && item.projectId && item.filePath && typeof item.content === "string") {
        await updateFileContent(item.projectId, item.filePath, item.content);
      }
      if (saveTimers.get(key) === item) {
        saveTimers.delete(key);
      }
    }
    explorer.setAutosaveStatus("Autoguardado en IndexedDB");
  }

  async function switchProject(projectId, _forceClearCache = false) {
    const nextProj = await getProject(projectId);
    if (!nextProj) return;

    for (const f of filesOnly) {
      editor.dropFileState(f.id);
      splitController?.dropFileState(f.id);
    }

    activeProject = nextProj;
    setSavedActiveProjectId(activeProject.id);
    projects = await listProjects();

    await reloadProjectEntries();

    const validPaths = new Set(filesOnly.map((f) => f.id));
    openTabIds = (activeProject.openTabIds || []).filter((id) => validPaths.has(id));
    const shouldAutoOpenFirst =
      openTabIds.length === 0 &&
      filesOnly.length > 0 &&
      (activeProject.kind !== "github" || Boolean(activeProject.offlineCached));
    if (shouldAutoOpenFirst) {
      openTabIds = [filesOnly[0].id];
    }
    activeFileId =
      activeProject.activeFileId && openTabIds.includes(activeProject.activeFileId)
        ? activeProject.activeFileId
        : openTabIds[0] || null;

    if (activeFileId) {
      const activeTarget = filesOnly.find((f) => f.id === activeFileId);
      if (activeTarget && activeTarget.contentLoaded === false) {
        try {
          await ensureFileContentLoaded(activeTarget);
        } catch {
          openTabIds = openTabIds.filter((id) => id !== activeFileId);
          activeFileId = openTabIds[0] || null;
        }
      }
    }

    explorer.renderProjects(projects, activeProject.id);
    chat.setConversation(activeProject.chatHistory || [], activeProject.id);
    renderWorkspaceView();
    await github.refreshTopbarBadge();
  }

  async function reloadProjectEntries() {
    entries = await getProjectEntries(activeProject.id);
    filesOnly = entries
      .filter((e) => !e.isFolder)
      .map((e) => {
        const meta = inferFileMeta(e.path);
        const shortName = e.path.split("/").pop() || e.path;
        return {
          id: e.path,
          path: e.path,
          name: e.path,
          shortName,
          lang: meta.lang,
          badge: meta.badge,
          icon: meta.icon,
          content: e.content,
          baseContent: e.baseContent,
          blobSha: e.blobSha || null,
          contentLoaded: e.contentLoaded !== false,
          trackedInGithub: Boolean(e.trackedInGithub),
          forceModified: Boolean(e.forceModified),
          isBinary: Boolean(e.isBinary),
          base64: e.base64 || (e.isBinary && typeof e.content === "string" ? e.content : null)
        };
      });
  }

  function syncOfflineButtonState() {
    if (!activeProject || activeProject.kind !== "github") {
      explorer.setOfflineRepoState({ visible: false });
      return;
    }
    const pendingCount = filesOnly.filter((f) => f.contentLoaded === false && f.blobSha).length;
    explorer.setOfflineRepoState({
      visible: true,
      isOfflineReady: pendingCount === 0,
      pendingCount,
      busy: false
    });
  }

  async function ensureFileContentLoaded(fileObj) {
    if (
      !fileObj ||
      fileObj.contentLoaded !== false ||
      activeProject.kind !== "github" ||
      !activeProject.github ||
      !fileObj.blobSha
    ) {
      return;
    }

    // Fijar el proyecto ANTES de esperar a la red: si el usuario cambia de proyecto mientras se descarga,
    // el contenido debe guardarse en el repositorio de origen y nunca en el proyecto que quedó activo.
    const sourceProjectId = activeProject.id;
    const content = await fetchSingleRepoBlob({
      token: getGithubToken(),
      owner: activeProject.github.owner,
      repo: activeProject.github.repo,
      blobSha: fileObj.blobSha
    });

    const saved = await cacheSingleGithubFileContent(sourceProjectId, fileObj.path, content, fileObj.blobSha);
    // Usar lo que efectivamente quedó guardado (si hubo contenido local, se respeta en vez del remoto).
    fileObj.content = saved?.content ?? content;
    fileObj.baseContent = saved?.baseContent ?? content;
    fileObj.contentLoaded = true;
    if (activeProject.id !== sourceProjectId) {
      return;
    }
    editor.dropFileState(fileObj.id);

    if (filesOnly.length > 0 && filesOnly.every((f) => f.contentLoaded !== false)) {
      activeProject.offlineCached = true;
      await markProjectOfflineCached(activeProject.id, true);
      projects = await listProjects();
      explorer.renderProjects(projects, activeProject.id);
    }
    syncOfflineButtonState();
  }

  async function ensureFilesLoaded(fileList, onProgress) {
    const unloaded = fileList.filter((f) => f && f.contentLoaded === false && f.blobSha);
    if (unloaded.length === 0 || activeProject.kind !== "github" || !activeProject.github) {
      return;
    }

    const sourceProjectId = activeProject.id;
    const loadedItems = await downloadBatchBlobs({
      token: getGithubToken(),
      owner: activeProject.github.owner,
      repo: activeProject.github.repo,
      items: unloaded.map((f) => ({ path: f.path, blobSha: f.blobSha })),
      onProgress
    });

    const byPath = new Map(loadedItems.map((item) => [item.path, item]));
    for (const fileObj of unloaded) {
      const hit = byPath.get(fileObj.path);
      if (!hit) continue;
      const saved = await cacheSingleGithubFileContent(
        sourceProjectId,
        fileObj.path,
        hit.content,
        hit.blobSha || fileObj.blobSha
      );
      fileObj.content = saved?.content ?? hit.content;
      fileObj.baseContent = saved?.baseContent ?? hit.content;
      fileObj.contentLoaded = true;
      if (activeProject.id === sourceProjectId) {
        editor.dropFileState(fileObj.id);
      }
    }

    if (activeProject.id !== sourceProjectId) {
      return;
    }
    if (filesOnly.length > 0 && filesOnly.every((f) => f.contentLoaded !== false)) {
      activeProject.offlineCached = true;
      await markProjectOfflineCached(activeProject.id, true);
      projects = await listProjects();
      explorer.renderProjects(projects, activeProject.id);
    }
    syncOfflineButtonState();
  }

  async function persistTabsState() {
    activeProject.openTabIds = [...openTabIds];
    activeProject.activeFileId = activeFileId;
    await saveProjectState(activeProject);
  }

  let openRequestSeq = 0;

  async function openOrFocusFile(filePath) {
    const target = filesOnly.find((f) => f.id === filePath);
    if (!target) return;

    const currentSeq = ++openRequestSeq;
    const currentProjId = activeProject?.id;

    if (target.contentLoaded === false) {
      explorer.setAutosaveStatus(`Abriendo ${target.shortName}…`);
      try {
        await ensureFileContentLoaded(target);
        if (currentSeq !== openRequestSeq || activeProject?.id !== currentProjId) {
          return;
        }
        explorer.setAutosaveStatus("Archivo cargado desde GitHub");
      } catch (error) {
        if (currentSeq !== openRequestSeq || activeProject?.id !== currentProjId) {
          return;
        }
        explorer.setAutosaveStatus(
          error instanceof Error ? error.message : "Sin conexión para abrir este archivo de GitHub"
        );
        return;
      }
    }

    if (currentSeq !== openRequestSeq || activeProject?.id !== currentProjId) {
      return;
    }

    if (!openTabIds.includes(target.id)) {
      openTabIds.push(target.id);
    }
    activeFileId = target.id;
    await persistTabsState();

    // Guardia de archivos binarios: si es binario/Base64, evitar pasarlo a CodeMirror como texto plano
    if (isBinaryFile(target)) {
      renderWorkspaceView();
      layout.closeLeftOnCompactSelect();
      return;
    }

    renderWorkspaceView();
    layout.closeLeftOnCompactSelect();
  }

  function showConfirmDialog({
    title,
    message,
    confirmText = "Confirmar",
    confirmVariant = "btn-primary",
    onConfirm
  }) {
    const dialog = document.getElementById("confirm-dialog");
    const titleEl = document.getElementById("confirm-dialog-title");
    const msgEl = document.getElementById("confirm-dialog-message");
    const cancelBtn = document.getElementById("btn-confirm-cancel");
    const actionBtn = document.getElementById("btn-confirm-action");
    const closeBtn = document.getElementById("btn-close-confirm");

    if (!dialog) {
      if (window.confirm(message)) {
        onConfirm?.();
      }
      return;
    }

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (actionBtn) {
      actionBtn.textContent = confirmText;
      actionBtn.className = `btn ${confirmVariant}`;
    }

    const cleanup = () => {
      keyboardRouter.popModal("confirm-dialog");
      cancelBtn?.removeEventListener("click", onCancel);
      closeBtn?.removeEventListener("click", onCancel);
      actionBtn?.removeEventListener("click", onProceed);
      dialog.removeEventListener("close", onDialogClose);
    };

    const onCancel = () => {
      cleanup();
      dialog.close();
    };

    const onProceed = () => {
      cleanup();
      dialog.close();
      onConfirm?.();
    };

    const onDialogClose = () => {
      cleanup();
    };

    cancelBtn?.addEventListener("click", onCancel);
    closeBtn?.addEventListener("click", onCancel);
    actionBtn?.addEventListener("click", onProceed);
    dialog.addEventListener("close", onDialogClose);

    keyboardRouter.pushModal({
      id: "confirm-dialog",
      onEscape: () => onCancel(),
      onEnter: () => {
        onProceed();
        return true;
      }
    });

    dialog.showModal();
  }

  function requestCloseTab(filePath) {
    const file = filesOnly.find((f) => f.id === filePath);
    if (!file) return;

    if (isFileDirtyForProject(file)) {
      showConfirmDialog({
        title: "¿Cerrar pestaña con cambios?",
        message: `El archivo "${file.shortName}" tiene modificaciones pendientes frente al repositorio. Si lo cerrás, tus cambios siguen guardados en el almacenamiento del iPad pero la pestaña se ocultará.`,
        confirmText: "Cerrar pestaña",
        confirmVariant: "btn-primary",
        onConfirm: () => {
          void closeTab(filePath);
        }
      });
      return;
    }

    void closeTab(filePath);
  }

  async function closeTab(filePath) {
    const idx = openTabIds.indexOf(filePath);
    if (idx === -1) return;

    // Si había un guardado pendiente para este archivo, aplicarlo de inmediato
    const timerKey = `${activeProject.id}::${filePath}`;
    const pending = saveTimers.get(timerKey);
    if (pending) {
      if (pending.timerId) window.clearTimeout(pending.timerId);
      saveTimers.delete(timerKey);
      await updateFileContent(pending.projectId, pending.filePath, pending.content);
    }

    openTabIds.splice(idx, 1);
    editor.dropFileState(filePath);
    splitController?.dropFileState(filePath);
    if (activeFileId === filePath) {
      activeFileId = openTabIds.length > 0 ? openTabIds[Math.min(idx, openTabIds.length - 1)] : null;
    }
    await persistTabsState();
    renderWorkspaceView();
  }

  function renderWorkspaceView() {
    explorer.renderProjects(projects, activeProject.id);
    explorer.renderTree(entries, activeFileId);
    syncOfflineButtonState();
    renderTabs();

    const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;

    if (activeFile) {
      if (emptyStateEl) emptyStateEl.hidden = true;
      if (isBinaryFile(activeFile)) {
        if (editorMountEl) editorMountEl.hidden = true;
        binaryPreview.render(activeFile);
        symbolBar.setLanguage(activeFile.lang);
        setEditorToolbarDisabled(false, true);
      } else {
        binaryPreview.hide();
        if (editorMountEl) editorMountEl.hidden = false;
        editor.openFile(activeFile);
        symbolBar.setLanguage(activeFile.lang);
        setEditorToolbarDisabled(false, false);
      }
    } else {
      binaryPreview.hide();
      editor.clearActiveFile();
      if (editorMountEl) editorMountEl.hidden = true;
      if (emptyStateEl) emptyStateEl.hidden = false;
      renderEmptyQuickList();
      setEditorToolbarDisabled(true, false);
    }

    updateAssistantContextLabel();
    updateStatusBar();
    chat.notifyWorkspaceChanged();
  }

  function renderTabs() {
    if (!tabStripEl) return;
    tabStripEl.innerHTML = "";

    for (const tabId of openTabIds) {
      const file = filesOnly.find((f) => f.id === tabId);
      if (!file) continue;

      const isActive = file.id === activeFileId;
      const dirty = isFileDirtyForProject(file);

      const wrapper = document.createElement("div");
      wrapper.className = isActive ? "editor-tab-item is-active" : "editor-tab-item";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.role = "tab";
      selectBtn.className = "editor-tab-trigger";
      selectBtn.title = file.path;
      selectBtn.setAttribute("aria-selected", String(isActive));
      selectBtn.innerHTML = `
        ${icon(file.icon)}
        <span>${escapeHtml(file.shortName)}</span>
        ${dirty ? '<span class="editor-tab-dirty" title="Modificado frente al repositorio" aria-label="Modificado"></span>' : ""}
      `;
      selectBtn.addEventListener("click", () => openOrFocusFile(file.id));

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "editor-tab-close";
      closeBtn.setAttribute("aria-label", `Cerrar pestaña ${file.shortName}`);
      closeBtn.innerHTML = icon("x");
      closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        requestCloseTab(file.id);
      });

      wrapper.addEventListener("auxclick", (event) => {
        if (event.button === 1) {
          event.preventDefault();
          event.stopPropagation();
          requestCloseTab(file.id);
        }
      });

      wrapper.append(selectBtn, closeBtn);
      tabStripEl.appendChild(wrapper);
    }

    revealActiveTab();
    splitController?.refreshIfOpen();
  }

  /** En pantallas angostas desplaza la tira de pestañas hasta la activa (sin mover el resto de la página). */
  function revealActiveTab() {
    if (!tabStripEl) return;
    const activeEl = tabStripEl.querySelector(".editor-tab-item.is-active");
    if (!(activeEl instanceof HTMLElement)) return;
    const strip = tabStripEl.getBoundingClientRect();
    const tab = activeEl.getBoundingClientRect();
    if (tab.width >= strip.width) {
      // Más ancha que la tira: alinear el comienzo para que se lea el nombre del archivo
      tabStripEl.scrollLeft += tab.left - strip.left;
    } else if (tab.left < strip.left) {
      tabStripEl.scrollLeft -= strip.left - tab.left + 8;
    } else if (tab.right > strip.right) {
      tabStripEl.scrollLeft += tab.right - strip.right + 8;
    }
  }

  function renderEmptyQuickList() {
    if (!emptyQuickListEl) return;
    emptyQuickListEl.innerHTML = "";
    for (const file of filesOnly.slice(0, 6)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.innerHTML = `${icon(file.icon)}<span>${escapeHtml(file.shortName)}</span>`;
      btn.addEventListener("click", () => openOrFocusFile(file.id));
      emptyQuickListEl.appendChild(btn);
    }
  }

  function isFileDirtyForProject(file) {
    if (file.contentLoaded === false) {
      return false;
    }
    if (activeProject.kind === "github") {
      return (
        Boolean(file.forceModified) ||
        !file.trackedInGithub ||
        file.content !== file.baseContent
      );
    }
    return false;
  }

  function syncToolbarState() {
    if (btnWrap) {
      btnWrap.setAttribute("aria-pressed", String(editor.isWordWrapEnabled()));
    }
    if (zoomReadoutEl) {
      zoomReadoutEl.textContent = `${editor.getFontSize()}px`;
    }
  }

  function setEditorToolbarDisabled(disabled, isBinary = false) {
    if (btnUndo) btnUndo.disabled = disabled || isBinary;
    if (btnRedo) btnRedo.disabled = disabled || isBinary;
    if (btnSearch) btnSearch.disabled = disabled || isBinary;
    if (btnExportFile) btnExportFile.disabled = disabled;
    if (btnWrap) btnWrap.disabled = disabled || isBinary;
    if (btnMinimap) btnMinimap.disabled = disabled || isBinary;
  }

  function updateNetworkIndicator() {
    if (!statusNetworkEl) return;
    const isOnline = navigator.onLine !== false;
    statusNetworkEl.textContent = isOnline ? "En línea" : "Sin conexión";
    statusNetworkEl.classList.toggle("is-offline", !isOnline);
  }

  function updateStatusBar() {
    const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
    if (!activeFile) {
      if (statusFilePathEl) statusFilePathEl.textContent = "Sin archivo abierto";
      if (statusFileLangEl) statusFileLangEl.textContent = "—";
      if (statusCursorPosEl) statusCursorPosEl.textContent = "—";
    } else if (isBinaryFile(activeFile)) {
      if (statusFilePathEl) statusFilePathEl.textContent = activeFile.path;
      if (statusFileLangEl) statusFileLangEl.textContent = activeFile.badge || "BIN";
      if (statusCursorPosEl) statusCursorPosEl.textContent = "Binario (Solo lectura)";
    } else {
      if (statusFilePathEl) statusFilePathEl.textContent = activeFile.path;
      if (statusFileLangEl) statusFileLangEl.textContent = activeFile.badge;
      const line = activeSelection.cursorLine || 1;
      const col = activeSelection.cursorCol || 1;
      const selSuffix =
        activeSelection.lineCount > 0 ? ` (${activeSelection.lineCount} sel.)` : "";
      if (statusCursorPosEl) {
        statusCursorPosEl.textContent = `Línea ${line}, Col ${col}${selSuffix}`;
      }
    }
    updateNetworkIndicator();
  }

  window.addEventListener("online", updateNetworkIndicator);
  window.addEventListener("offline", updateNetworkIndicator);

  function updateAssistantContextLabel() {
    const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
    if (!activeFile) {
      if (contextStatusEl) contextStatusEl.textContent = "Sin archivo activo";
      if (contextFileEl) contextFileEl.textContent = "Ninguno";
      return;
    }

    if (isBinaryFile(activeFile)) {
      if (contextStatusEl) contextStatusEl.textContent = "Recurso binario (no editable)";
      if (contextFileEl) contextFileEl.textContent = activeFile.shortName;
      return;
    }

    if (activeSelection.lineCount > 0) {
      const label =
        activeSelection.lineCount === 1
          ? "1 línea seleccionada"
          : `${activeSelection.lineCount} líneas seleccionadas`;
      if (contextStatusEl) contextStatusEl.textContent = label;
    } else {
      if (contextStatusEl) contextStatusEl.textContent = "Leyendo archivo activo";
    }

    if (contextFileEl) {
      contextFileEl.textContent = activeFile.shortName;
    }
  }

  await switchProject(activeProject.id);
  if (restoredFromBackup > 0) {
    explorer.setAutosaveStatus(
      restoredFromBackup === 1
        ? "Se recuperó 1 archivo con cambios sin guardar"
        : `Se recuperaron ${restoredFromBackup} archivos con cambios sin guardar`
    );
  }
  void github.syncExplorerReposInBackground();
}

function defaultStarterTemplate(path) {
  const meta = inferFileMeta(path);
  switch (meta.lang) {
    case "cpp":
      return `#include <iostream>\n\nint main() {\n    return 0;\n}\n`;
    case "c":
      return `#include <stdio.h>\n\nint main(void) {\n    return 0;\n}\n`;
    case "html":
      return `<!DOCTYPE html>\n<html lang="es">\n<head>\n  <meta charset="UTF-8" />\n  <title>Documento</title>\n</head>\n<body>\n\n</body>\n</html>\n`;
    case "python":
      return `def principal():\n    print("Hola desde Python en Studio IDE")\n\nif __name__ == "__main__":\n    principal()\n`;
    case "markdown":
      return `# Documento\n\n`;
    case "sql":
      return `SELECT 1;\n`;
    default:
      return "";
  }
}

function preventFocusSteal(buttons) {
  for (const btn of buttons) {
    btn?.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    });
  }
}

function registerPwaServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  const isLocalDev =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

  if (isLocalDev) {
    // En servidor local de PC desactivamos cualquier Service Worker viejo para ver cambios al instante
    navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) {
        reg.unregister();
      }
    });
    if ("caches" in window) {
      caches.keys().then((keys) => {
        for (const k of keys) {
          if (k.startsWith("studio-ide-shell-")) {
            caches.delete(k);
          }
        }
      });
    }
    return;
  }

  if (window.location.protocol === "https:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./sw.js")
        .then((reg) => {
          reg.update().catch(() => {});
        })
        .catch(() => {
          // Silencioso en entornos sin soporte de SW
        });
    });
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

document.addEventListener("DOMContentLoaded", initApp);
