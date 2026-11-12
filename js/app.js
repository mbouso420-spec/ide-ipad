import { hydrateIcons } from "./ui/icons.js";
import { initLayoutController } from "./ui/layout.js";
import { initSymbolBar } from "./ui/symbolBar.js";
import { generateDuplicatePath, initExplorerController } from "./ui/explorerController.js";
import { buildZipArchive, downloadZip } from "./storage/zipExporter.js";
import { initDiffModal } from "./ui/diffModal.js";
import { initLivePreviewModal } from "./ui/livePreviewModal.js";
import { initQuickOpenModal } from "./ui/quickOpenModal.js";
import { initGlobalSearchModal } from "./ui/globalSearchModal.js";
import { initSettingsModal } from "./ui/settingsModal.js";
import { showConfirmDialog } from "./ui/confirmDialog.js";
import { createStatusBarController } from "./ui/statusBarController.js";
import {
  applyDocumentEdit,
  computeSmartReplacement,
  createEditorManager
} from "./editor/editorManager.js";
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
  importKeysBundle,
  setKeyStorageMode
} from "./ai/providers.js";
import {
  cacheSingleGithubFileContent,
  createLocalProject,
  deleteProject,
  deleteProjectEntry,
  ensureInitialWorkspace,
  entryExists,
  getEntryRecord,
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
import { restoreEmergencyBackup } from "./storage/emergencyBackup.js";
import { base64ToUint8Array, isBinaryFile, isImageFile } from "./storage/fileImport.js";
import { downloadBlob } from "./utils/dom.js";
import { readStoredValue } from "./utils/storage.js";
import { createAutosaveManager } from "./workspace/autosaveManager.js";
import { createTabManager } from "./workspace/tabManager.js";
import { createGithubLazySync } from "./workspace/githubLazySync.js";
import { initBroadcastSync } from "./workspace/broadcastSync.js";

const THEME_STORAGE_KEY = "studio_theme";

async function initApp() {
  hydrateIcons(document);
  registerPwaServiceWorker();
  void requestPersistentStorage();
  keyboardRouter.attach();

  const appListeners = typeof AbortController === "function" ? new AbortController() : null;
  const appListenOpts = appListeners ? { signal: appListeners.signal } : undefined;

  // Inicializar tema visual (persistido en localStorage)
  const selectThemeEl = document.getElementById("select-theme");
  const savedTheme = readStoredValue(THEME_STORAGE_KEY, "default") || "default";
  if (savedTheme !== "default") {
    document.documentElement.dataset.theme = savedTheme;
  }
  if (selectThemeEl) {
    selectThemeEl.value = savedTheme;
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

  const btnUndo = document.getElementById("btn-editor-undo");
  const btnRedo = document.getElementById("btn-editor-redo");
  const btnSearch = document.getElementById("btn-editor-search");
  const btnFormat = document.getElementById("btn-editor-format");
  const btnWrap = document.getElementById("btn-editor-wrap");
  const btnMinimap = document.getElementById("btn-editor-minimap");
  const btnEditorSplit = document.getElementById("btn-editor-split");
  const btnFontDown = document.getElementById("btn-font-down");
  const btnFontUp = document.getElementById("btn-font-up");
  const btnToggleSymbols = document.getElementById("btn-toggle-symbols");

  const editorStageEl = document.getElementById("editor-stage");
  const splitDividerEl = document.getElementById("editor-split-divider");
  const splitMountEl = document.getElementById("editor-mount-split");
  const splitBodyEl = document.getElementById("editor-split-body");
  const splitTitleTextEl = document.getElementById("editor-split-title-text");
  const splitFileSelectEl = document.getElementById("editor-split-file-select");
  const btnCloseSplit = document.getElementById("btn-close-split");

  const binaryPreview = createBinaryPreview({
    binaryPreviewEl: document.getElementById("editor-binary-preview"),
    onDownloadFile: downloadCurrentActiveFile,
    async onUpdateFileContent(file, payload) {
      if (!activeProject || !file) return;
      await autosaveManager.flushPendingSaves();
      const isSvgText = typeof payload?.text === "string";
      const base64 = isSvgText ? null : (payload?.base64 || null);
      const content = isSvgText ? payload.text : "";
      const isBinary = !isSvgText;

      await upsertEntry(activeProject.id, file.path, {
        isFolder: false,
        content,
        isBinary,
        base64
      });

      file.content = content;
      file.base64 = base64;
      file.isBinary = isBinary;
      file.contentLoaded = true;

      editor.dropFileState(file.path);
      await reloadProjectEntries();
      const updated = filesOnly.find((f) => f.id === file.id);
      if (updated) {
        binaryPreview.render(updated);
      }
      explorer.setAutosaveStatus("Imagen guardada en el proyecto");
      await github.refreshTopbarBadge();
    }
  });

  /** @type {ReturnType<typeof createSplitEditorController> | null} */
  let splitController = null;
  let chat = null;
  let explorer = null;
  let github = null;
  let settingsModal = null;
  let statusBar = null;
  let tabManager = null;

  let projects = await ensureInitialWorkspace();
  let restoredFromBackup = 0;
  try {
    restoredFromBackup = await restoreEmergencyBackup({
      entryExists,
      getEntryRecord,
      getProjectEntries,
      updateFileContent
    });
  } catch {
    // Si falla, el respaldo queda en localStorage y se reintenta en la próxima apertura
  }

  let activeProject =
    projects.find((p) => p.id === getSavedActiveProjectId()) || projects[0];
  setSavedActiveProjectId(activeProject.id);

  /** @type {Array<{ path: string, isFolder: boolean }>} */
  let treeEntries = [];
  /** @type {Array<any>} */
  let filesOnly = [];
  let openTabIds = [];
  let activeFileId = null;
  let activeSelection = { text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 };

  const autosaveManager = createAutosaveManager({
    getActiveProjectId: () => activeProject?.id || null,
    updateFileContent,
    setAutosaveStatus: (msg) => explorer?.setAutosaveStatus(msg),
    refreshStorageIndicator: () => explorer?.refreshStorageIndicator?.(),
    refreshTopbarBadge: () => github?.refreshTopbarBadge()
  });

  const editor = await createEditorManager({
    mountEl: editorMountEl,
    onDocChange(filePath, newContent) {
      applyDocumentEdit({
        filePath,
        newContent,
        getFilesOnly: () => filesOnly,
        isFileDirtyForProject,
        onDirtyChange: (target, nowDirty) => tabManager?.updateTabDirtyBadge(target.id, nowDirty),
        getActiveProject: () => activeProject,
        scheduleAutosave: (pid, path, content) => autosaveManager.scheduleAutosave(pid, path, content),
        onAfterEdit: (path, content) => splitController?.syncDoc(path, content)
      });
    },
    onSelectionChange(selection) {
      activeSelection = selection;
      statusBar?.updateAssistantContextLabel();
      statusBar?.updateStatusBar();
      chat?.notifySelectionChanged();
    }
  });

  statusBar = createStatusBarController({
    editor,
    getActiveFile: () => (activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null),
    getActiveSelection: () => activeSelection
  });

  tabManager = createTabManager({
    tabStripEl,
    emptyQuickListEl,
    getFilesOnly: () => filesOnly,
    getOpenTabIds: () => openTabIds,
    getActiveFileId: () => activeFileId,
    getActiveProject: () => activeProject,
    saveProjectState,
    isFileDirtyForProject,
    onOpenFile: (path) => openOrFocusFile(path),
    onRequestCloseTab: (path) => requestCloseTab(path),
    onAfterRenderTabs: () => splitController?.refreshIfOpen()
  });

  const githubLazySync = createGithubLazySync({
    getActiveProject: () => activeProject,
    setProjects: (next) => {
      projects = next;
    },
    getTreeEntries: () => treeEntries,
    setTreeEntries: (next) => {
      treeEntries = next;
    },
    getFilesOnly: () => filesOnly,
    setFilesOnly: (next) => {
      filesOnly = next;
    },
    getOpenTabIds: () => openTabIds,
    setOpenTabIds: (next) => {
      openTabIds = next;
    },
    getActiveFileId: () => activeFileId,
    setActiveFileId: (next) => {
      activeFileId = next;
    },
    persistTabsState: () => tabManager.persistTabsState(),
    renderWorkspaceView,
    renderTabs: (opts) => tabManager.renderTabs(opts),
    explorer: {
      setOfflineRepoState: (state) => explorer.setOfflineRepoState(state),
      setAutosaveStatus: (msg) => explorer.setAutosaveStatus(msg),
      renderTree: (entriesArg, activeIdArg) => explorer.renderTree(entriesArg, activeIdArg),
      renderProjects: (projs, activeIdArg) => explorer.renderProjects(projs, activeIdArg)
    },
    editor,
    getSplitController: () => splitController,
    cacheAndSyncGithubFileFn: cacheAndSyncGithubFile,
    getGithubToken,
    fetchSingleRepoBlob,
    downloadBatchBlobs,
    markProjectOfflineCached,
    listProjects
  });

  const quickOpenModal = initQuickOpenModal({
    getFiles: () => filesOnly,
    getActiveFile: () => (activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null),
    async onSelectFile(path, targetLine) {
      await openOrFocusFile(path);
      if (typeof targetLine === "number" && targetLine > 0) {
        editor.goToLine(targetLine);
      }
    },
    getCommands() {
      return [
        {
          id: "format-code",
          title: "Formatear documento",
          category: "Editor",
          icon: "alignLeft",
          shortcut: "Shift+Alt+F",
          run: () => formatActiveDocument()
        },
        {
          id: "toggle-zen",
          title: layout.isZenMode() ? "Salir del Modo Zen" : "Modo Zen / Enfoque total",
          category: "Vista",
          icon: layout.isZenMode() ? "minimize" : "maximize",
          shortcut: "Cmd+Alt+Z",
          run: () => layout.toggleZenMode()
        },
        {
          id: "toggle-explorer",
          title: layout.isLeftPanelOpen() ? "Ocultar panel del Explorador" : "Mostrar panel del Explorador",
          category: "Vista",
          icon: "panelLeft",
          shortcut: "Cmd+B",
          run: () => layout.toggleLeftPanel()
        },
        {
          id: "toggle-assistant",
          title: layout.isRightPanelOpen() ? "Ocultar panel del Asistente IA" : "Mostrar panel del Asistente IA",
          category: "Vista",
          icon: "panelRight",
          shortcut: "Cmd+J",
          run: () => layout.toggleRightPanel()
        },
        {
          id: "live-preview",
          title: "Ejecutar vista previa web en vivo",
          category: "Ejecución",
          icon: "play",
          shortcut: "",
          run: () => document.getElementById("btn-live-preview")?.click()
        },
        {
          id: "split-editor",
          title: "Dividir editor en dos paneles (Split View)",
          category: "Editor",
          icon: "columns",
          shortcut: "Cmd+\\",
          run: () => document.getElementById("btn-editor-split")?.click()
        },
        {
          id: "toggle-word-wrap",
          title: "Alternar ajuste de línea (Word Wrap)",
          category: "Editor",
          icon: "wrapText",
          shortcut: "",
          run: () => document.getElementById("btn-editor-wrap")?.click()
        },
        {
          id: "toggle-minimap",
          title: "Alternar minimapa",
          category: "Editor",
          icon: "layout",
          shortcut: "",
          run: () => document.getElementById("btn-editor-minimap")?.click()
        },
        {
          id: "toggle-symbols",
          title: "Alternar teclado táctil y barra de símbolos",
          category: "Editor",
          icon: "keyboard",
          shortcut: "",
          run: () => document.getElementById("btn-toggle-symbols")?.click()
        },
        {
          id: "global-search",
          title: "Buscar en todo el proyecto",
          category: "Buscar",
          icon: "fileSearch",
          shortcut: "Cmd+Shift+F",
          run: () => globalSearchModal?.open()
        },
        {
          id: "settings",
          title: "Configuración y atajos de teclado",
          category: "Ajustes",
          icon: "settings",
          shortcut: "Cmd+,",
          run: () => settingsModal?.open()
        },
        {
          id: "github-sync",
          title: "Sincronización con GitHub (Repositorio / Commit)",
          category: "Git",
          icon: "gitBranch",
          shortcut: "",
          run: () => document.getElementById("btn-open-github")?.click()
        },
        {
          id: "export-zip",
          title: "Descargar proyecto completo como archivo ZIP",
          category: "Proyecto",
          icon: "layers",
          shortcut: "",
          run: () => document.getElementById("btn-export-zip")?.click()
        },
        {
          id: "new-file",
          title: "Nuevo archivo en proyecto",
          category: "Proyecto",
          icon: "plus",
          shortcut: "",
          run: () => document.getElementById("btn-new-file")?.click()
        },
        {
          id: "new-folder",
          title: "Nueva carpeta en proyecto",
          category: "Proyecto",
          icon: "folderPlus",
          shortcut: "",
          run: () => document.getElementById("btn-new-folder")?.click()
        },
        {
          id: "theme-default",
          title: "Tema: Grafito neutro (Por defecto)",
          category: "Tema",
          icon: "sparkles",
          shortcut: "",
          run: () => {
            delete document.documentElement.dataset.theme;
            localStorage.removeItem("studio_theme");
          }
        },
        {
          id: "theme-dracula",
          title: "Tema: Dracula Dark",
          category: "Tema",
          icon: "sparkles",
          shortcut: "",
          run: () => {
            document.documentElement.dataset.theme = "dracula";
            localStorage.setItem("studio_theme", "dracula");
          }
        },
        {
          id: "theme-nord",
          title: "Tema: Nord Frost",
          category: "Tema",
          icon: "sparkles",
          shortcut: "",
          run: () => {
            document.documentElement.dataset.theme = "nord";
            localStorage.setItem("studio_theme", "nord");
          }
        },
        {
          id: "theme-monokai",
          title: "Tema: Monokai Pro",
          category: "Tema",
          icon: "sparkles",
          shortcut: "",
          run: () => {
            document.documentElement.dataset.theme = "monokai";
            localStorage.setItem("studio_theme", "monokai");
          }
        },
        {
          id: "clear-chat",
          title: "Asistente IA: Limpiar conversación",
          category: "Asistente",
          icon: "trash",
          shortcut: "",
          run: () => document.getElementById("btn-ai-clear-chat")?.click()
        }
      ];
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
      const activeFile = filesOnly.find((f) => f.id === activeFileId);
      if (!activeFile || isBinaryFile(activeFile)) return;
      editor.insertAtCursor(text, cursorBack);
    }
  });

  settingsModal = initSettingsModal({
    editor,
    getContextSnapshot,
    onHardwareKeyboardChange(hardwareMode) {
      splitController?.setHardwareKeyboardMode(hardwareMode);
    },
    onWordWrapChange(enabled) {
      statusBar.syncWordWrapPressed(enabled);
    },
    onMinimapChange(visible) {
      statusBar.syncMinimapPressed(visible);
    },
    onThinkingSpeedChange(speed) {
      chat?.syncThinkingSpeed?.(speed);
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
      await githubLazySync.ensureFileContentLoaded(target);
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
    downloadBlob(blob, filename, { revokeDelayMs: 1000 });
  }

  async function downloadCurrentActiveFile() {
    const current = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
    if (!current) return;
    await downloadSingleFile(current.id);
  }

  explorer = initExplorerController({
    onSelectFile(path) {
      openOrFocusFile(path);
    },
    async onCreateEntry(path, isFolder) {
      await autosaveManager.flushPendingSaves();
      const isImg = !isFolder && isImageFile(path) && !path.toLowerCase().endsWith(".svg");
      await upsertEntry(activeProject.id, path, {
        isFolder,
        content: isFolder ? "" : (isImg ? "" : defaultStarterTemplate(path)),
        isBinary: isImg,
        base64: null,
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
      await autosaveManager.flushPendingSaves();
      const affectedUnloaded = filesOnly.filter(
        (f) =>
          f.contentLoaded === false &&
          (f.id === oldPath || (isFolder && f.id.startsWith(`${oldPath}/`)))
      );
      const sourceProjectId = activeProject.id;
      if (affectedUnloaded.length > 0) {
        await githubLazySync.ensureFilesLoaded(affectedUnloaded);
      }
      if (activeProject.id !== sourceProjectId) {
        return;
      }

      await renameProjectEntry(activeProject.id, oldPath, newPath, isFolder);

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

      await tabManager.persistTabsState();
      await reloadProjectEntries();
      renderWorkspaceView();
      await github.refreshTopbarBadge();
    },
    async onDeleteEntry(path, isFolder) {
      await autosaveManager.flushPendingSaves();
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

      await tabManager.persistTabsState();
      await reloadProjectEntries();
      renderWorkspaceView();
      await github.refreshTopbarBadge();
    },
    async onSwitchProject(selectedValue) {
      await autosaveManager.flushPendingSaves();
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
          await switchProject(createdProj.id);
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
      await autosaveManager.flushPendingSaves();
      const created = await createLocalProject(name);
      projects = await listProjects();
      await switchProject(created.id);
    },
    async onDeleteCurrentProject() {
      if (projects.length <= 1) return;
      await autosaveManager.flushPendingSaves();
      const removedId = activeProject.id;
      await deleteProject(removedId);
      projects = await listProjects();
      await switchProject(projects[0].id);
    },
    async onImportFiles(importedList) {
      await autosaveManager.flushPendingSaves();
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
      await autosaveManager.flushPendingSaves();
      const source = filesOnly.find((f) => f.id === sourcePath);
      if (!source) return;

      try {
        await githubLazySync.ensureFileContentLoaded(source);
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
      await autosaveManager.flushPendingSaves();
      if (!filesOnly || filesOnly.length === 0) {
        explorer.setAutosaveStatus("No hay archivos para exportar");
        return;
      }
      explorer.setAutosaveStatus("Preparando archivo ZIP…");

      const unloaded = filesOnly.filter((f) => f.contentLoaded === false && f.blobSha);
      if (unloaded.length > 0) {
        try {
          await githubLazySync.ensureFilesLoaded(unloaded, (done, total) => {
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
      await autosaveManager.flushPendingSaves();

      const pending = filesOnly.filter((f) => f.contentLoaded === false && f.blobSha);
      if (pending.length === 0) {
        await markProjectOfflineCached(activeProject.id, true);
        activeProject.offlineCached = true;
        projects = await listProjects();
        explorer.renderProjects(projects, activeProject.id);
        githubLazySync.syncOfflineButtonState();
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
        await githubLazySync.ensureFilesLoaded(pending, (done, total) => {
          explorer.setAutosaveStatus(`Guardando copia offline (${done}/${total})…`);
        });
        if (activeProject.id !== sourceProjectId) {
          return;
        }
        await markProjectOfflineCached(activeProject.id, true);
        activeProject.offlineCached = true;
        projects = await listProjects();
        explorer.renderProjects(projects, activeProject.id);
        githubLazySync.syncOfflineButtonState();
        explorer.setAutosaveStatus("Copia offline guardada en el iPad");
      } catch (error) {
        githubLazySync.syncOfflineButtonState();
        explorer.setAutosaveStatus(
          error instanceof Error ? error.message : "No se pudo completar la copia offline"
        );
      }
    },
    async onCloudBackupProject() {
      const token = getGithubToken();
      if (!token) {
        if (typeof github.openModal === "function") {
          github.openModal();
        } else {
          document.getElementById("btn-open-github")?.click();
        }
        return;
      }
      try {
        explorer.setAutosaveStatus("Respaldando en Gist privado…");
        await autosaveManager.flushPendingSaves();
        const projectEntries = await getProjectEntries(activeProject.id);
        const res = await saveProjectToGist(token, {
          projectName: activeProject.name,
          entries: projectEntries,
          existingGistId: activeProject.gistId || null
        });
        activeProject.gistId = res.id;
        await saveProjectState(activeProject);
        explorer.setAutosaveStatus(`¡Respaldado en Gist! (${res.id.slice(0, 6)})`);
      } catch (err) {
        const msg = err?.message || "al respaldar en Gist";
        if (
          msg.includes("Resource not accessible") ||
          msg.includes("permiso para Gists") ||
          msg.includes("token no tiene permiso")
        ) {
          explorer.setAutosaveStatus("Error: el token necesita permiso 'Gists: Read and write'");
        } else {
          explorer.setAutosaveStatus(`Error: ${msg}`);
        }
      }
    }
  });

  const livePreviewModal = initLivePreviewModal({
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
        await githubLazySync.ensureFileContentLoaded(target);
      }
      return target;
    },
    async ensureFilesLoaded(fileList) {
      if (!Array.isArray(fileList) || fileList.length === 0) return;
      const targets = fileList
        .map((f) =>
          typeof f === "string"
            ? filesOnly.find((item) => normalizePath(item.path) === normalizePath(f))
            : f
        )
        .filter(Boolean);
      await githubLazySync.ensureFilesLoaded(targets);
    },
    onErrorMarker(lineNum, errorMessage) {
      editor?.addErrorMarker?.(lineNum, errorMessage);
    },
    onClearErrorMarkers() {
      editor?.clearErrorMarkers?.();
    },
    onGoToLine(lineNum) {
      editor?.goToLine?.(lineNum);
    },
    async onBeforePreview() {
      await autosaveManager.flushPendingSaves();
      const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
      await githubLazySync.preloadForPreview(activeFile);
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
      const rawPath = String(targetPath || "").trim().replace(/^(?:\.\/)+/, "");
      let norm;
      try {
        norm = validateUserPath(rawPath);
      } catch {
        return false;
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
        autosaveManager.scheduleAutosave(activeProject.id, targetFile.id, code);
        tabManager.renderTabs();
      }
      return true;
    },
    async onApplyMultiFile(filesToApply) {
      if (!Array.isArray(filesToApply) || filesToApply.length === 0) return false;
      let firstValidNorm = null;
      for (const item of filesToApply) {
        const rawPath = String(item?.path || "").trim().replace(/^(?:\.\/)+/, "");
        let norm;
        try {
          norm = validateUserPath(rawPath);
        } catch {
          continue;
        }
        if (!norm) continue;
        if (!firstValidNorm) firstValidNorm = norm;
        const existing = filesOnly.find((f) => normalizePath(f.path) === norm);
        if (existing) {
          existing.content = item.code;
          await updateFileContent(activeProject.id, norm, item.code);
          if (activeFileId === existing.id) {
            editor.replaceEntireDocument(item.code);
          } else {
            editor.dropFileState(existing.id);
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
      if (!firstValidNorm) return false;
      const firstTarget = filesOnly.find((f) => normalizePath(f.path) === firstValidNorm);
      if (firstTarget) {
        await openOrFocusFile(firstTarget.id);
      }
      tabManager.renderTabs();
      return true;
    },
    onConversationChange(history, projectId) {
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

  github = initGithubController({
    getActiveProject: () => activeProject,
    onFlushPendingSaves: () => autosaveManager.flushPendingSaves(),
    onOpenDiff({ title, oldCode, newCode }) {
      diffModal.openReadOnlyDiff({ title, oldCode, newCode });
    },
    onReposListChanged(remoteRepos) {
      explorer.renderProjects(projects, activeProject.id, remoteRepos);
    },
    async onProjectClonedOrSynced(projectId) {
      await autosaveManager.flushPendingSaves();
      projects = await listProjects();
      await switchProject(projectId);
    }
  });

  // Atajo universal Cmd+S / Ctrl+S y Cmd+W / Ctrl+W / Alt+W enrutados vía keyboardRouter
  const triggerManualSave = () => {
    void (async () => {
      await autosaveManager.flushPendingSaves();
      explorer.setAutosaveStatus("Guardado en IndexedDB");
    })();
  };
  keyboardRouter.registerGlobalShortcut("ctrl+s", triggerManualSave);
  keyboardRouter.registerGlobalShortcut("meta+s", triggerManualSave);

  const triggerCloseActiveTab = () => {
    if (activeFileId) {
      requestCloseTab(activeFileId);
    }
  };
  keyboardRouter.registerGlobalShortcut("ctrl+w", triggerCloseActiveTab);
  keyboardRouter.registerGlobalShortcut("meta+w", triggerCloseActiveTab);
  keyboardRouter.registerGlobalShortcut("alt+w", triggerCloseActiveTab);

  // Sincronización multi-pestaña en vivo vía BroadcastChannel
  const broadcastSync = initBroadcastSync({
    onWorkspaceBroadcast,
    getActiveProject: () => activeProject,
    autosaveManager,
    reloadProjectEntries,
    getFilesOnly: () => filesOnly,
    getOpenTabIds: () => openTabIds,
    setOpenTabIds: (next) => {
      openTabIds = next;
    },
    getActiveFileId: () => activeFileId,
    setActiveFileId: (next) => {
      activeFileId = next;
    },
    persistTabsState: () => tabManager.persistTabsState(),
    editor,
    editorMountEl,
    binaryPreview,
    symbolBar,
    statusBar,
    tabManager,
    renderWorkspaceView,
    getSplitController: () => splitController,
    github,
    onKeyStorageModeBroadcast: (mode) => {
      setKeyStorageMode(mode);
      settingsModal?.syncControls?.();
      void github.refreshTopbarBadge();
      explorer?.setAutosaveStatus(
        mode === "session"
          ? "Claves solo en esta sesión (sincronizado)"
          : "Claves persistentes en este dispositivo"
      );
    }
  });

  statusBar.syncToolbarState();
  preventFocusSteal(
    [
      btnUndo,
      btnRedo,
      btnFontDown,
      btnFontUp,
      btnMinimap,
      btnEditorSplit,
      btnCloseSplit,
      btnToggleSymbols
    ],
    appListenOpts
  );

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
    ensureFileContentLoaded: (fileObj) => githubLazySync.ensureFileContentLoaded(fileObj),
    isFileDirtyForProject,
    renderTabs: (opts) => tabManager.renderTabs(opts),
    onDirtyChange: (target, nowDirty) => tabManager.updateTabDirtyBadge(target.id, nowDirty),
    scheduleAutosave: (pid, path, content) => autosaveManager.scheduleAutosave(pid, path, content),
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

  btnUndo?.addEventListener("click", () => editor.triggerUndo(), appListenOpts);
  btnRedo?.addEventListener("click", () => editor.triggerRedo(), appListenOpts);
  btnSearch?.addEventListener("click", () => editor.triggerSearch(), appListenOpts);
  btnFormat?.addEventListener("click", () => formatActiveDocument(), appListenOpts);
  btnWrap?.addEventListener("click", () => {
    statusBar.syncWordWrapPressed(editor.toggleWordWrap());
  }, appListenOpts);
  btnMinimap?.addEventListener("click", () => {
    statusBar.syncMinimapPressed(editor.toggleMinimap());
  }, appListenOpts);
  btnFontDown?.addEventListener("click", () => {
    statusBar.syncZoomReadout(editor.stepFontSize(-1));
  }, appListenOpts);
  btnFontUp?.addEventListener("click", () => {
    statusBar.syncZoomReadout(editor.stepFontSize(1));
  }, appListenOpts);

  async function switchProject(projectId) {
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
          await githubLazySync.ensureFileContentLoaded(activeTarget);
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
    const rawEntries = await getProjectEntries(activeProject.id);
    treeEntries = rawEntries.map((e) => ({
      path: e.path,
      isFolder: Boolean(e.isFolder)
    }));
    filesOnly = rawEntries
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

  let openRequestSeq = 0;

  async function openOrFocusFile(filePath) {
    const target = filesOnly.find((f) => f.id === filePath);
    if (!target) return;

    const currentSeq = ++openRequestSeq;
    const currentProjId = activeProject?.id;

    if (target.contentLoaded === false) {
      explorer.setAutosaveStatus(`Abriendo ${target.shortName}…`);
      try {
        await githubLazySync.ensureFileContentLoaded(target);
        if (currentSeq !== openRequestSeq || activeProject?.id !== currentProjId) {
          return;
        }
        if (target.deleted || !filesOnly.some((f) => f.id === target.id)) {
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
    await tabManager.persistTabsState();

    renderWorkspaceView();
    layout.closeLeftOnCompactSelect();
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

    await autosaveManager.flushFile(activeProject.id, filePath);

    openTabIds.splice(idx, 1);
    editor.dropFileState(filePath);
    splitController?.dropFileState(filePath);
    if (activeFileId === filePath) {
      activeFileId = openTabIds.length > 0 ? openTabIds[Math.min(idx, openTabIds.length - 1)] : null;
    }
    await tabManager.persistTabsState();
    renderWorkspaceView();
  }

  function renderWorkspaceView() {
    explorer.renderProjects(projects, activeProject.id);
    explorer.renderTree(treeEntries, activeFileId);
    githubLazySync.syncOfflineButtonState();
    tabManager.renderTabs();

    const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;

    if (activeFile) {
      if (emptyStateEl) emptyStateEl.hidden = true;
      if (isBinaryFile(activeFile)) {
        if (editorMountEl) editorMountEl.hidden = true;
        binaryPreview.render(activeFile);
        symbolBar.setLanguage(activeFile.lang);
        statusBar.setEditorToolbarDisabled(false, true);
      } else {
        binaryPreview.hide();
        if (editorMountEl) editorMountEl.hidden = false;
        editor.openFile(activeFile);
        symbolBar.setLanguage(activeFile.lang);
        statusBar.setEditorToolbarDisabled(false, false);
      }
    } else {
      binaryPreview.hide();
      editor.clearActiveFile();
      if (editorMountEl) editorMountEl.hidden = true;
      if (emptyStateEl) emptyStateEl.hidden = false;
      tabManager.renderEmptyQuickList();
      statusBar.setEditorToolbarDisabled(true, false);
    }

    statusBar.updateAssistantContextLabel();
    statusBar.updateStatusBar();
    chat.notifyWorkspaceChanged();
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

  await switchProject(activeProject.id);
  if (restoredFromBackup > 0) {
    explorer.setAutosaveStatus(
      restoredFromBackup === 1
        ? "Se recuperó 1 archivo con cambios sin guardar"
        : `Se recuperaron ${restoredFromBackup} archivos con cambios sin guardar`
    );
  }
  void github.syncExplorerReposInBackground();

  return {
    destroy() {
      appListeners?.abort();
      broadcastSync?.destroy?.();
      autosaveManager?.destroy?.();
      statusBar?.destroy?.();
      splitController?.destroy?.();
      explorer?.destroy?.();
      quickOpenModal?.destroy?.();
      globalSearchModal?.destroy?.();
      settingsModal?.destroy?.();
      livePreviewModal?.destroy?.();
      layout?.destroy?.();
      keyboardRouter?.destroy?.();
    }
  };
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

function preventFocusSteal(buttons, listenOpts) {
  for (const btn of buttons) {
    btn?.addEventListener("pointerdown", (event) => {
      event.preventDefault();
    }, listenOpts);
  }
}

function registerPwaServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  const isLocalDev =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const allowLocalSw =
    window.__STUDIO_ENABLE_SW__ === true ||
    new URLSearchParams(window.location.search).get("sw") === "1";

  if (isLocalDev && !allowLocalSw) {
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

  if (window.location.protocol === "https:" || (isLocalDev && allowLocalSw)) {
    const startRegistration = () => {
      navigator.serviceWorker
        .register("./sw.js")
        .then((reg) => {
          reg.update().catch(() => {});
        })
        .catch(() => {
          // Silencioso en entornos sin soporte de SW
        });
    };
    if (document.readyState === "complete") {
      startRegistration();
    } else {
      window.addEventListener("load", startRegistration);
    }
  }
}

/**
 * Sincroniza un objeto de archivo en memoria con el registro persistido en IndexedDB tras cachear un blob.
 */
export function applyCachedBlobRecordToFile(fileObj, saved, remotePayload) {
  if (!fileObj || typeof fileObj !== "object") {
    return { deleted: false };
  }
  const isRemoteObj = Boolean(remotePayload && typeof remotePayload === "object");
  const fallbackIsBinary = isRemoteObj && Boolean(remotePayload.isBinary);
  const fallbackContent = fallbackIsBinary
    ? ""
    : String(isRemoteObj ? (remotePayload.content ?? "") : (remotePayload ?? ""));
  const fallbackBase64 = fallbackIsBinary ? (remotePayload.base64 ?? null) : null;
  const fallbackBaseBase64 = fallbackIsBinary
    ? (remotePayload.baseBase64 ?? remotePayload.base64 ?? null)
    : null;

  if (saved && typeof saved === "object") {
    if (saved.deleted) {
      fileObj.deleted = true;
      fileObj.content = typeof saved.content === "string" ? saved.content : "";
      fileObj.baseContent = typeof saved.baseContent === "string" ? saved.baseContent : "";
      fileObj.isBinary = Boolean(saved.isBinary);
      fileObj.base64 = saved.base64 ?? null;
      fileObj.baseBase64 = saved.baseBase64 ?? null;
      fileObj.contentLoaded = saved.contentLoaded !== false;
      return { deleted: true };
    }

    const nextIsBinary = typeof saved.isBinary === "boolean" ? saved.isBinary : fallbackIsBinary;
    fileObj.deleted = false;
    fileObj.isBinary = nextIsBinary;
    fileObj.content = nextIsBinary
      ? ""
      : (typeof saved.content === "string" ? saved.content : fallbackContent);
    fileObj.baseContent = nextIsBinary
      ? ""
      : (typeof saved.baseContent === "string" ? saved.baseContent : fileObj.content);
    fileObj.base64 = nextIsBinary ? (saved.base64 ?? null) : null;
    fileObj.baseBase64 = nextIsBinary ? (saved.baseBase64 ?? fileObj.base64 ?? null) : null;
    fileObj.contentLoaded = saved.contentLoaded !== false;
    if (saved.blobSha) {
      fileObj.blobSha = saved.blobSha;
    }
    return { deleted: false };
  }

  fileObj.deleted = false;
  fileObj.isBinary = fallbackIsBinary;
  fileObj.content = fallbackContent;
  fileObj.baseContent = fallbackContent;
  fileObj.base64 = fallbackBase64;
  fileObj.baseBase64 = fallbackBaseBase64;
  fileObj.contentLoaded = true;
  return { deleted: false };
}

/**
 * Persiste el payload descargado de GitHub (texto o binario) y reconcilia `fileObj` con el registro guardado.
 */
export async function cacheAndSyncGithubFile({
  projectId,
  fileObj,
  remotePayload,
  blobSha = null,
  cacheFn = cacheSingleGithubFileContent
}) {
  const payload = remotePayload && typeof remotePayload === "object"
    ? remotePayload
    : String(remotePayload ?? "");
  const saved = await cacheFn(projectId, fileObj.path, payload, blobSha ?? fileObj.blobSha ?? null);
  const status = applyCachedBlobRecordToFile(fileObj, saved, payload);
  return { saved, ...status };
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initApp);
}
