import { hydrateIcons } from "./ui/icons.js";
import { initLayoutController } from "./ui/layout.js";
import { initSymbolBar } from "./ui/symbolBar.js";
import { generateDuplicatePath, initExplorerController } from "./ui/explorerController.js";
import { buildZipBlob, downloadZip } from "./storage/zipExporter.js";
import { initDiffModal } from "./ui/diffModal.js";
import { initProjectModal } from "./ui/projectModal.js";
import { initLivePreviewModal } from "./ui/livePreviewModal.js";
import { initQuickOpenModal } from "./ui/quickOpenModal.js";
import { initGlobalSearchModal } from "./ui/globalSearchModal.js";
import { initSettingsModal } from "./ui/settingsModal.js";
import { confirmDialogAsync, showConfirmDialog } from "./ui/confirmDialog.js";
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
  getKeyStorageMode,
  getSyncCredentialsBackupPayload,
  hasStoredCredentials,
  importKeysBundle,
  setKeyStorageMode
} from "./ai/providers.js";
import {
  cacheBatchGithubFileContents,
  closeWorkspaceBroadcast,
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
  saveProjectGistId,
  saveProjectState,
  saveProjectTabsState,
  setSavedActiveProjectId,
  updateFileContent,
  upsertEntry,
  validateUserPath
} from "./storage/workspaceDb.js";
import { formatSafeErrorMessage } from "./security/credentialGuard.js";
import { keyboardRouter } from "./ui/keyboardRouter.js";
import { restoreEmergencyBackup } from "./storage/emergencyBackup.js";
import { base64ToUint8Array, isBinaryFile, isImageFile } from "./storage/fileImport.js";
import { cacheAndSyncGithubFile } from "./workspace/githubBlobCache.js";
import { downloadBlob } from "./utils/dom.js";
import { readStoredValue, removeStoredValue, saveStoredValue } from "./utils/storage.js";
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
      void saveCredentialsBackup(getSyncCredentialsBackupPayload());
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
      const sourceProjectId = activeProject.id;
      await autosaveManager.flushPendingSaves();
      if (activeProject?.id !== sourceProjectId) return;
      const isSvgText = typeof payload?.text === "string";
      const base64 = isSvgText ? null : (payload?.base64 || null);
      const content = isSvgText ? payload.text : "";
      const isBinary = !isSvgText;

      await upsertEntry(sourceProjectId, file.path, {
        isFolder: false,
        content,
        isBinary,
        base64
      });
      if (activeProject?.id !== sourceProjectId) return;

      file.content = content;
      file.base64 = base64;
      file.isBinary = isBinary;
      file.contentLoaded = true;

      editor.dropFileState(file.path);
      splitController?.dropFileState(file.path);
      await reloadProjectEntries();
      if (activeProject?.id !== sourceProjectId) return;
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
    saveProjectTabsState,
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
    cacheBatchFn: cacheBatchGithubFileContents,
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
            removeStoredValue(THEME_STORAGE_KEY);
            settingsModal?.syncControls?.();
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
            saveStoredValue(THEME_STORAGE_KEY, "dracula");
            settingsModal?.syncControls?.();
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
            saveStoredValue(THEME_STORAGE_KEY, "nord");
            settingsModal?.syncControls?.();
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
            saveStoredValue(THEME_STORAGE_KEY, "monokai");
            settingsModal?.syncControls?.();
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
    const projectFiles = filesOnly
      .filter((f) => !isBinaryFile(f))
      .map((f) => ({
        id: f.id,
        path: f.path,
        shortName: f.shortName,
        lang: f.lang,
        contentLoaded: f.contentLoaded !== false,
        content: f.contentLoaded !== false ? (f.content ?? "") : ""
      }));

    return {
      activeFile,
      selection: activeSelection,
      otherOpenFiles,
      projectFiles
    };
  };

  const symbolBar = initSymbolBar({
    onInsert(text, cursorBack) {
      if (!activeFileId) return;
      const activeFile = filesOnly.find((f) => f.id === activeFileId);
      if (!activeFile || isBinaryFile(activeFile)) return;
      editor.insertAtCursor(text, cursorBack);
    },
    onToggle(touchKeyboardVisible) {
      const hardwareMode = !touchKeyboardVisible;
      editor.setHardwareKeyboardMode?.(hardwareMode);
      splitController?.setHardwareKeyboardMode?.(hardwareMode);
      settingsModal?.syncControls?.();
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
    onKeyStorageModeChange(mode) {
      void github?.refreshTopbarBadge?.();
      explorer?.setAutosaveStatus?.(
        mode === "session"
          ? "Claves solo en esta sesión"
          : "Claves persistentes en este dispositivo"
      );
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

  let pendingProjectSelectSeq = 0;

  async function createNewLocalProject(name, templateId = null) {
    const selectSeq = ++pendingProjectSelectSeq;
    try {
      await autosaveManager.flushPendingSaves();
      if (selectSeq !== pendingProjectSelectSeq) return;
      const created = await createLocalProject(name, templateId);
      if (selectSeq !== pendingProjectSelectSeq) return;
      projects = await listProjects();
      if (selectSeq !== pendingProjectSelectSeq) return;
      await switchProject(created.id);
    } catch (error) {
      explorer.setAutosaveStatus(
        error instanceof Error ? error.message : "No se pudo crear el espacio"
      );
    }
  }

  const projectModal = initProjectModal({
    onCreateProject: createNewLocalProject
  });

  explorer = initExplorerController({
    onSelectFile(path) {
      openOrFocusFile(path);
    },
    async onCreateEntry(path, isFolder) {
      const sourceProjectId = activeProject?.id;
      if (!sourceProjectId) return;
      try {
        await autosaveManager.flushPendingSaves();
        if (activeProject?.id !== sourceProjectId) return;
        const isImg = !isFolder && isImageFile(path) && !path.toLowerCase().endsWith(".svg");
        await upsertEntry(sourceProjectId, path, {
          isFolder,
          content: isFolder ? "" : (isImg ? "" : defaultStarterTemplate(path)),
          isBinary: isImg,
          base64: null,
          allowOverwrite: false
        });
        if (activeProject?.id !== sourceProjectId) return;
        await reloadProjectEntries();
        if (activeProject?.id !== sourceProjectId) return;
        if (!isFolder) {
          await openOrFocusFile(path);
        } else {
          renderWorkspaceView();
        }
        await github.refreshTopbarBadge();
      } catch (error) {
        if (activeProject?.id === sourceProjectId) {
          explorer.setAutosaveStatus(
            error instanceof Error ? error.message : "No se pudo crear el elemento"
          );
        }
        throw error;
      }
    },
    async onRenameEntry(oldPath, newPath, isFolder) {
      const sourceProjectId = activeProject?.id;
      if (!sourceProjectId) return;
      try {
        await autosaveManager.flushPendingSaves();
        if (activeProject?.id !== sourceProjectId) return;
        const affectedUnloaded = filesOnly.filter(
          (f) =>
            f.contentLoaded === false &&
            (f.id === oldPath || (isFolder && f.id.startsWith(`${oldPath}/`)))
        );
        if (affectedUnloaded.length > 0) {
          await githubLazySync.ensureFilesLoaded(affectedUnloaded);
        }
        if (activeProject?.id !== sourceProjectId) {
          return;
        }

        await renameProjectEntry(sourceProjectId, oldPath, newPath, isFolder);
        if (activeProject?.id !== sourceProjectId) {
          return;
        }

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
        if (activeProject?.id !== sourceProjectId) return;
        await reloadProjectEntries();
        if (activeProject?.id !== sourceProjectId) return;
        renderWorkspaceView();
        await github.refreshTopbarBadge();
      } catch (error) {
        if (activeProject?.id === sourceProjectId) {
          explorer.setAutosaveStatus(
            error instanceof Error ? error.message : "No se pudo renombrar el elemento"
          );
        }
        throw error;
      }
    },
    async onDeleteEntry(path, isFolder) {
      const sourceProjectId = activeProject?.id;
      if (!sourceProjectId) return;
      try {
        await autosaveManager.flushPendingSaves();
        if (activeProject?.id !== sourceProjectId) return;
        await deleteProjectEntry(sourceProjectId, path, isFolder);
        if (activeProject?.id !== sourceProjectId) return;

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
        if (activeProject?.id !== sourceProjectId) return;
        await reloadProjectEntries();
        if (activeProject?.id !== sourceProjectId) return;
        const nextActive = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
        if (nextActive && nextActive.contentLoaded === false) {
          await openOrFocusFile(nextActive.id);
        } else {
          renderWorkspaceView();
        }
        await github.refreshTopbarBadge();
      } catch (error) {
        if (activeProject?.id === sourceProjectId) {
          explorer.setAutosaveStatus(
            error instanceof Error ? error.message : "No se pudo eliminar el elemento"
          );
        }
      }
    },
    async onSwitchProject(selectedValue) {
      const selectSeq = ++pendingProjectSelectSeq;
      await autosaveManager.flushPendingSaves();
      if (selectSeq !== pendingProjectSelectSeq) return;
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
          if (selectSeq !== pendingProjectSelectSeq) return;
          const createdProj = await hydrateLazyGithubProject({
            owner,
            repo,
            branch: index.branch || defaultBranch,
            commitSha: index.commitSha,
            entries: index.entries
          });
          if (selectSeq !== pendingProjectSelectSeq) return;
          projects = await listProjects();
          if (selectSeq !== pendingProjectSelectSeq) return;
          await switchProject(createdProj.id);
          if (selectSeq !== pendingProjectSelectSeq) return;
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
          if (selectSeq !== pendingProjectSelectSeq) return;
          explorer.renderProjects(projects, activeProject.id);
          explorer.setAutosaveStatus(
            error instanceof Error ? error.message : "No se pudo conectar con GitHub"
          );
        }
        return;
      }

      await switchProject(selectedValue);
    },
    onRequestNewProject: () => projectModal.open(),
    onCreateProject: createNewLocalProject,
    async onDeleteCurrentProject() {
      if (projects.length <= 1) return;
      const selectSeq = ++pendingProjectSelectSeq;
      const removedId = activeProject?.id;
      if (!removedId) return;
      try {
        await autosaveManager.flushPendingSaves();
        if (selectSeq !== pendingProjectSelectSeq || activeProject?.id !== removedId) return;
        await deleteProject(removedId);
        projects = await listProjects();
        if (selectSeq !== pendingProjectSelectSeq) return;
        if (projects.length > 0) {
          await switchProject(projects[0].id);
        }
      } catch (error) {
        explorer.setAutosaveStatus(
          error instanceof Error ? error.message : "No se pudo eliminar el espacio"
        );
      }
    },
    async onImportFiles(importedList) {
      const sourceProjectId = activeProject?.id;
      await autosaveManager.flushPendingSaves();
      if (activeProject?.id !== sourceProjectId) return;
      let lastPath = null;
      let importedCount = 0;
      let importError = null;
      try {
        for (const item of importedList) {
          if (activeProject?.id !== sourceProjectId) return;
          await upsertEntry(sourceProjectId, item.path, {
            isFolder: false,
            content: item.content,
            isBinary: Boolean(item.isBinary),
            base64: item.base64 || null
          });
          editor.dropFileState(item.path);
          splitController?.dropFileState(item.path);
          lastPath = item.path;
          importedCount += 1;
        }
      } catch (error) {
        importError = error;
      }
      if (activeProject?.id !== sourceProjectId) return;
      await reloadProjectEntries();
      if (activeProject?.id !== sourceProjectId) return;
      if (lastPath) {
        await openOrFocusFile(lastPath);
      } else {
        renderWorkspaceView();
      }
      if (activeProject?.id !== sourceProjectId) return;
      if (importError) {
        const errMsg = importError instanceof Error ? importError.message : "No se pudo importar el archivo";
        explorer.setAutosaveStatus(
          importedCount > 0
            ? `Importación parcial (${importedCount}/${importedList.length}): ${errMsg}`
            : errMsg
        );
      } else if (importedCount > 0) {
        explorer.setAutosaveStatus(
          importedCount === 1 ? "Archivo importado" : `${importedCount} archivos importados`
        );
      }
      await github.refreshTopbarBadge();
    },
    async onDuplicateEntry(sourcePath) {
      const sourceProjectId = activeProject?.id;
      await autosaveManager.flushPendingSaves();
      if (activeProject?.id !== sourceProjectId) return;
      const source = filesOnly.find((f) => f.id === sourcePath);
      if (!source) return;

      try {
        await githubLazySync.ensureFileContentLoaded(source);
      } catch (error) {
        if (activeProject?.id === sourceProjectId) {
          explorer.setAutosaveStatus(
            error instanceof Error ? error.message : "No se pudo leer el archivo a duplicar"
          );
        }
        return;
      }
      if (activeProject?.id !== sourceProjectId) return;

      const existingPaths = new Set(filesOnly.map((f) => f.path));
      const newPath = generateDuplicatePath(source.path, existingPaths);

      await upsertEntry(sourceProjectId, newPath, {
        isFolder: false,
        content: source.content,
        isBinary: Boolean(source.isBinary),
        base64: source.base64 || null,
        allowOverwrite: false
      });
      if (activeProject?.id !== sourceProjectId) return;
      await reloadProjectEntries();
      if (activeProject?.id !== sourceProjectId) return;
      await openOrFocusFile(newPath);
      if (activeProject?.id !== sourceProjectId) return;
      explorer.setAutosaveStatus(`Archivo duplicado como "${newPath.split("/").pop()}"`);
      await github.refreshTopbarBadge();
    },
    onDownloadFile: downloadSingleFile,
    onDownloadActiveFile: downloadCurrentActiveFile,
    async onExportProjectZip() {
      const sourceProjectId = activeProject?.id;
      await autosaveManager.flushPendingSaves();
      if (activeProject?.id !== sourceProjectId) return;
      if (!filesOnly || filesOnly.length === 0) {
        explorer.setAutosaveStatus("No hay archivos para exportar");
        return;
      }
      explorer.setAutosaveStatus("Preparando archivo ZIP…");

      const unloaded = filesOnly.filter((f) => f.contentLoaded === false && f.blobSha);
      if (unloaded.length > 0) {
        try {
          await githubLazySync.ensureFilesLoaded(unloaded, (done, total) => {
            if (activeProject?.id === sourceProjectId) {
              explorer.setAutosaveStatus(`Descargando archivos para el ZIP (${done}/${total})…`);
            }
          });
        } catch {
          // Continuar si falla la red
        }
      }
      if (activeProject?.id !== sourceProjectId) return;

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
        const zipBlob = buildZipBlob(zipFiles);
        const projectName = (activeProject?.name || "proyecto").replace(/[/\\?%*:|"<>]/g, "-");
        downloadZip(zipBlob, `${projectName}.zip`);
        explorer.setAutosaveStatus(`Proyecto exportado como "${projectName}.zip"`);
      } catch (err) {
        explorer.setAutosaveStatus(
          err instanceof Error ? `Error al exportar ZIP: ${err.message}` : "No se pudo crear el archivo ZIP"
        );
      }
    },
    async onSaveRepoOffline() {
      const sourceProjectId = activeProject?.id;
      if (activeProject.kind !== "github" || !activeProject.github) return;
      await autosaveManager.flushPendingSaves();
      if (activeProject?.id !== sourceProjectId) return;

      const pending = filesOnly.filter((f) => f.contentLoaded === false && f.blobSha);
      if (pending.length === 0) {
        await markProjectOfflineCached(sourceProjectId, true);
        if (activeProject?.id !== sourceProjectId) return;
        activeProject.offlineCached = true;
        projects = await listProjects();
        if (activeProject?.id !== sourceProjectId) return;
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

      try {
        await githubLazySync.ensureFilesLoaded(pending, (done, total) => {
          if (activeProject?.id === sourceProjectId) {
            explorer.setAutosaveStatus(`Guardando copia offline (${done}/${total})…`);
          }
        });
        if (activeProject.id !== sourceProjectId) {
          return;
        }
        await markProjectOfflineCached(sourceProjectId, true);
        if (activeProject.id !== sourceProjectId) {
          return;
        }
        activeProject.offlineCached = true;
        projects = await listProjects();
        if (activeProject.id !== sourceProjectId) {
          return;
        }
        explorer.renderProjects(projects, activeProject.id);
        githubLazySync.syncOfflineButtonState();
        explorer.setAutosaveStatus("Copia offline guardada en el iPad");
      } catch (error) {
        if (activeProject?.id === sourceProjectId) {
          githubLazySync.syncOfflineButtonState();
          explorer.setAutosaveStatus(
            error instanceof Error ? error.message : "No se pudo completar la copia offline"
          );
        }
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
      const sourceProject = activeProject;
      if (!sourceProject) return;
      const sourceProjectId = sourceProject.id;
      try {
        explorer.setAutosaveStatus("Respaldando en Gist privado…");
        await autosaveManager.flushPendingSaves();
        const projectEntries = await getProjectEntries(sourceProjectId);
        const res = await saveProjectToGist(token, {
          projectName: sourceProject.name,
          entries: projectEntries,
          existingGistId: sourceProject.gistId || null
        });
        sourceProject.gistId = res.id;
        await saveProjectGistId(sourceProjectId, res.id);
        if (activeProject?.id === sourceProjectId) {
          explorer.setAutosaveStatus(`¡Respaldado en Gist! (${res.id.slice(0, 6)})`);
        }
      } catch (err) {
        if (activeProject?.id === sourceProjectId) {
          const msg = formatSafeErrorMessage(err, [token], "al respaldar en Gist");
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
    async onResolveFileContent(targetPath) {
      const sourceProjectId = activeProject?.id;
      const norm = normalizePath(String(targetPath || "").trim());
      if (!norm) return null;
      const match = filesOnly.find((f) => normalizePath(f.path) === norm);
      if (!match || isBinaryFile(match)) return null;
      if (match.contentLoaded === false) {
        await githubLazySync.ensureFilesLoaded([match]);
        if (activeProject?.id !== sourceProjectId) return null;
      }
      const fresh = filesOnly.find((f) => normalizePath(f.path) === norm);
      if (!fresh || isBinaryFile(fresh) || fresh.contentLoaded === false) return null;
      return {
        path: fresh.path,
        lang: fresh.lang,
        content: fresh.content ?? ""
      };
    },
    async onInsertAtCursor(code, lang) {
      await ensureAnOpenFile(lang);
      if (!activeFileId) {
        return false;
      }
      const targetFile = filesOnly.find((f) => f.id === activeFileId);
      if (!targetFile || isBinaryFile(targetFile) || targetFile.contentLoaded === false) {
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
      const targetFile = filesOnly.find((f) => f.id === activeFileId);
      if (!targetFile || isBinaryFile(targetFile) || targetFile.contentLoaded === false) {
        return false;
      }
      editor.replaceSelection(code, contextHint);
      layout.closeRightOnCompactAction();
      return true;
    },
    async onApplyWholeFile(code, lang, contextHint = null) {
      const sourceProjectId = activeProject?.id;
      await ensureAnOpenFile(lang);
      if (activeProject?.id !== sourceProjectId) return;
      const activeFile = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
      if (!activeFile || isBinaryFile(activeFile) || activeFile.contentLoaded === false) return;
      const targetFileId = activeFile.id;
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
          if (activeProject?.id !== sourceProjectId || activeFileId !== targetFileId) return;
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
      const sourceProjectId = activeProject?.id;
      await autosaveManager.flushPendingSaves();
      if (activeProject?.id !== sourceProjectId) return false;
      let targetFile = filesOnly.find((f) => normalizePath(f.path) === norm);
      if (!targetFile) {
        await upsertEntry(sourceProjectId, norm, {
          content: code,
          isFolder: false,
          allowOverwrite: true
        });
        if (activeProject?.id !== sourceProjectId) return false;
        await reloadProjectEntries();
        if (activeProject?.id !== sourceProjectId) return false;
        targetFile = filesOnly.find((f) => normalizePath(f.path) === norm);
        if (targetFile) {
          await openOrFocusFile(targetFile.id);
        }
      } else {
        if (isBinaryFile(targetFile)) return false;
        autosaveManager.clearTimersForProject(sourceProjectId, (p) => normalizePath(p) === norm);
        await openOrFocusFile(targetFile.id);
        if (activeProject?.id !== sourceProjectId) return false;
        const freshTarget = filesOnly.find((f) => f.id === targetFile.id);
        if (!freshTarget || isBinaryFile(freshTarget)) return false;
        if (activeFileId === freshTarget.id && freshTarget.contentLoaded !== false) {
          editor.replaceEntireDocument(code);
          splitController?.replaceIfActive(freshTarget.id, code);
          freshTarget.content = code;
          autosaveManager.scheduleAutosave(sourceProjectId, freshTarget.id, code);
          tabManager.renderTabs();
        } else {
          freshTarget.content = code;
          freshTarget.contentLoaded = true;
          await updateFileContent(sourceProjectId, freshTarget.path, code);
          if (activeProject?.id !== sourceProjectId) return false;
          editor.dropFileState(freshTarget.id);
          splitController?.syncOrDropPath(freshTarget.id, code, { markDirty: false });
          tabManager.renderTabs();
        }
      }
      return true;
    },
    async onApplyMultiFile(filesToApply) {
      if (!Array.isArray(filesToApply) || filesToApply.length === 0) return false;
      const sourceProjectId = activeProject?.id;
      if (!sourceProjectId) return false;

      await autosaveManager.flushPendingSaves();
      if (activeProject?.id !== sourceProjectId) return false;

      const deduped = new Map();
      for (const item of filesToApply) {
        const rawPath = String(item?.path || "").trim().replace(/^(?:\.\/)+/, "");
        let norm;
        try {
          norm = validateUserPath(rawPath);
        } catch {
          continue;
        }
        if (!norm) continue;
        const existing = filesOnly.find((f) => normalizePath(f.path) === norm);
        if (existing && isBinaryFile(existing)) continue;
        deduped.set(norm, { path: norm, code: String(item?.code ?? ""), existing });
      }
      if (deduped.size === 0) return false;

      const lazyToLoad = [];
      for (const entry of deduped.values()) {
        if (entry.existing && entry.existing.contentLoaded === false) {
          lazyToLoad.push(entry.existing);
        }
      }
      if (lazyToLoad.length > 0) {
        try {
          await githubLazySync.ensureFilesLoaded(lazyToLoad);
        } catch {
          if (activeProject?.id === sourceProjectId) {
            explorer.setAutosaveStatus("No se pudieron cargar archivos de GitHub para comparar cambios");
          }
          return false;
        }
        if (activeProject?.id !== sourceProjectId) return false;
      }

      const diffItems = [];
      for (const entry of deduped.values()) {
        const fresh = filesOnly.find((f) => normalizePath(f.path) === entry.path);
        if (fresh && fresh.contentLoaded === false) continue;
        diffItems.push({
          path: entry.path,
          oldCode: fresh ? (fresh.content ?? "") : "",
          newCode: entry.code,
          isNew: !fresh,
          lang: fresh?.lang || inferFileMeta(entry.path).lang
        });
      }
      if (diffItems.length === 0) return false;

      return new Promise((resolve) => {
        diffModal.openMultiFileApplyDiff({
          files: diffItems,
          onCancel: () => resolve(false),
          onConfirm: async (selectedItems) => {
            const rollbackLog = [];
            try {
              if (!Array.isArray(selectedItems) || selectedItems.length === 0) {
                resolve(false);
                return;
              }
              if (activeProject?.id !== sourceProjectId) {
                resolve(false);
                return;
              }
              let firstValidNorm = null;
              for (const item of selectedItems) {
                if (activeProject?.id !== sourceProjectId) {
                  throw new Error("El proyecto cambió durante la aplicación multiarchivo.");
                }
                const norm = normalizePath(item.path);
                if (!firstValidNorm) firstValidNorm = norm;
                const existing = filesOnly.find((f) => normalizePath(f.path) === norm);
                if (existing && (isBinaryFile(existing) || existing.contentLoaded === false)) continue;
                autosaveManager.clearTimersForProject(sourceProjectId, (p) => normalizePath(p) === norm);
                if (existing) {
                  const prevContent = existing.content ?? "";
                  await updateFileContent(sourceProjectId, norm, item.newCode);
                  rollbackLog.push({ kind: "update", path: norm, existingId: existing.id, prevContent });
                  existing.content = item.newCode;
                  existing.contentLoaded = true;
                  if (activeProject?.id !== sourceProjectId) {
                    throw new Error("El proyecto cambió durante la aplicación multiarchivo.");
                  }
                  if (activeFileId === existing.id) {
                    editor.replaceEntireDocument(item.newCode);
                  } else {
                    editor.dropFileState(existing.id);
                  }
                  splitController?.syncOrDropPath(existing.id, item.newCode, { markDirty: false });
                } else {
                  await upsertEntry(sourceProjectId, norm, {
                    content: item.newCode,
                    isFolder: false,
                    allowOverwrite: true
                  });
                  rollbackLog.push({ kind: "create", path: norm });
                  if (activeProject?.id !== sourceProjectId) {
                    throw new Error("El proyecto cambió durante la aplicación multiarchivo.");
                  }
                }
              }
              await reloadProjectEntries();
              if (activeProject?.id !== sourceProjectId || !firstValidNorm) {
                resolve(false);
                return;
              }
              const firstTarget = filesOnly.find((f) => normalizePath(f.path) === firstValidNorm);
              if (firstTarget) {
                await openOrFocusFile(firstTarget.id);
              }
              if (activeProject?.id !== sourceProjectId) {
                resolve(false);
                return;
              }
              tabManager.renderTabs();
              await github.refreshTopbarBadge();
              layout.closeRightOnCompactAction();
              resolve(true);
            } catch {
              for (let r = rollbackLog.length - 1; r >= 0; r -= 1) {
                const entry = rollbackLog[r];
                try {
                  if (entry.kind === "create") {
                    await deleteProjectEntry(sourceProjectId, entry.path, false);
                  } else {
                    await updateFileContent(sourceProjectId, entry.path, entry.prevContent);
                  }
                  editor.dropFileState(entry.existingId || entry.path);
                  splitController?.dropFileState(entry.existingId || entry.path);
                } catch {
                  // Continuar intentando revertir los demás archivos del lote
                }
              }
              if (activeProject?.id === sourceProjectId) {
                try {
                  await reloadProjectEntries();
                  renderWorkspaceView();
                  await github.refreshTopbarBadge();
                } catch {
                  // Ignorar si falla la recarga tras rollback
                }
                explorer.setAutosaveStatus("No se pudo aplicar todo el lote; cambios locales revertidos.");
              }
              resolve(false);
            }
          }
        });
      });
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
    onOpenMultiDiff({ title, items, initialIndex }) {
      diffModal.openMultiFileReadOnlyDiff({ title, items, initialIndex });
    },
    onRequestConfirm: confirmDialogAsync,
    async onDiscardLocalChange(projectId, targetPath) {
      if (activeProject?.id !== projectId) return;
      const norm = normalizePath(targetPath);
      autosaveManager.clearTimersForProject(projectId, (p) => normalizePath(p) === norm);
      await reloadProjectEntries();
      if (activeProject?.id !== projectId) return;
      const fresh = filesOnly.find((f) => normalizePath(f.path) === norm);
      if (!fresh) {
        if (openTabIds.includes(norm)) {
          await closeTab(norm);
        } else {
          renderWorkspaceView();
        }
      } else {
        editor.dropFileState(fresh.id);
        splitController?.syncOrDropPath(fresh.id, fresh.content ?? "", { markDirty: false });
        if (activeFileId === fresh.id) {
          await openOrFocusFile(fresh.id);
        } else {
          renderWorkspaceView();
        }
      }
      await github.refreshTopbarBadge();
    },
    onReposListChanged(remoteRepos) {
      explorer.renderProjects(projects, activeProject.id, remoteRepos);
    },
    async onProjectClonedOrSynced(projectId) {
      const capturedSwitchSeq = switchProjectSeq;
      await autosaveManager.flushPendingSaves();
      if (capturedSwitchSeq !== switchProjectSeq) return;
      projects = await listProjects();
      if (capturedSwitchSeq !== switchProjectSeq) return;
      await switchProject(projectId);
    }
  });

  // Atajo universal Cmd+S / Ctrl+S y Cmd+W / Ctrl+W / Alt+W enrutados vía keyboardRouter
  const triggerManualSave = () => {
    void (async () => {
      const ok = await autosaveManager.flushPendingSaves();
      if (ok) {
        explorer.setAutosaveStatus("Guardado en IndexedDB");
      }
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
    openOrFocusFile,
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

  let switchProjectSeq = 0;

  async function switchProject(projectId) {
    const seq = ++switchProjectSeq;
    const nextProj = await getProject(projectId);
    if (!nextProj || seq !== switchProjectSeq) return;

    const nextProjects = await listProjects();
    if (seq !== switchProjectSeq) return;

    for (const f of filesOnly) {
      editor.dropFileState(f.id);
      splitController?.dropFileState(f.id);
    }

    activeProject = nextProj;
    projects = nextProjects;
    setSavedActiveProjectId(activeProject.id);

    await reloadProjectEntries();
    if (seq !== switchProjectSeq) return;

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
          if (seq !== switchProjectSeq) return;
          openTabIds = openTabIds.filter((id) => id !== activeFileId);
          activeFileId = openTabIds[0] || null;
        }
        if (seq !== switchProjectSeq) return;
      }
    }

    explorer.renderProjects(projects, activeProject.id);
    chat.setConversation(activeProject.chatHistory || [], activeProject.id);
    renderWorkspaceView();
    await github.refreshTopbarBadge();
  }

  let reloadEntriesSeq = 0;

  async function reloadProjectEntries() {
    const seq = ++reloadEntriesSeq;
    const targetProjectId = activeProject?.id;
    if (!targetProjectId) {
      treeEntries = [];
      filesOnly = [];
      return;
    }
    const rawEntries = await getProjectEntries(targetProjectId);
    if (seq !== reloadEntriesSeq || activeProject?.id !== targetProjectId) {
      return;
    }
    treeEntries = rawEntries.map((e) => ({
      path: e.path,
      isFolder: Boolean(e.isFolder)
    }));
    filesOnly = rawEntries
      .filter((e) => !e.isFolder)
      .map((e) => {
        const meta = inferFileMeta(e.path);
        const shortName = e.path.split("/").pop() || e.path;
        const resolvedBase64 = e.base64 || (e.isBinary && typeof e.content === "string" ? e.content : null);
        const resolvedBaseBase64 = Object.prototype.hasOwnProperty.call(e, "baseBase64")
          ? (e.baseBase64 ?? null)
          : (e.trackedInGithub && e.isBinary ? resolvedBase64 : null);
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
          base64: resolvedBase64,
          baseBase64: resolvedBaseBase64
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
    const sourceProjectId = activeProject?.id;
    const initialIdx = openTabIds.indexOf(filePath);
    if (initialIdx === -1) return;

    await autosaveManager.flushFile(sourceProjectId, filePath);
    if (activeProject?.id !== sourceProjectId) return;

    const currentIdx = openTabIds.indexOf(filePath);
    if (currentIdx === -1) return;

    openTabIds.splice(currentIdx, 1);
    editor.dropFileState(filePath);
    splitController?.dropFileState(filePath);
    if (activeFileId === filePath) {
      activeFileId = openTabIds.length > 0 ? openTabIds[Math.min(currentIdx, openTabIds.length - 1)] : null;
    }
    await tabManager.persistTabsState();
    if (activeProject?.id !== sourceProjectId) return;
    const nextActive = activeFileId ? filesOnly.find((f) => f.id === activeFileId) : null;
    if (nextActive && nextActive.contentLoaded === false) {
      await openOrFocusFile(nextActive.id);
      return;
    }
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
        editor.clearActiveFile();
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
      const contentModified = isBinaryFile(file)
        ? (file.base64 ?? null) !== (file.baseBase64 ?? null) || file.content !== file.baseContent
        : file.content !== file.baseContent;
      return (
        Boolean(file.forceModified) ||
        !file.trackedInGithub ||
        contentModified
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
      closeWorkspaceBroadcast();
      autosaveManager?.destroy?.();
      statusBar?.destroy?.();
      splitController?.destroy?.();
      symbolBar?.destroy?.();
      diffModal?.destroy?.();
      projectModal?.destroy?.();
      binaryPreview?.destroy?.();
      editor?.destroy?.();
      chat?.destroy?.();
      github?.destroy?.();
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
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => {
        for (const reg of regs) {
          reg.unregister().catch(() => {});
        }
      })
      .catch(() => {});
    if ("caches" in window) {
      caches
        .keys()
        .then((keys) => {
          for (const k of keys) {
            if (k.startsWith("studio-ide-shell-")) {
              caches.delete(k).catch(() => {});
            }
          }
        })
        .catch(() => {});
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
      window.addEventListener("load", startRegistration, { once: true });
    }
  }
}

export { applyCachedBlobRecordToFile, cacheAndSyncGithubFile } from "./workspace/githubBlobCache.js";

if (typeof document !== "undefined") {
  const startApp = () => {
    void initApp().catch((err) => {
      console.error("[Studio IDE] Error fatal al inicializar:", err);
    });
  };
  if (document.readyState === "interactive" || document.readyState === "complete") {
    startApp();
  } else if (typeof document.addEventListener === "function") {
    document.addEventListener("DOMContentLoaded", startApp, { once: true });
  }
}
