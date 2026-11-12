const PREVIEWABLE_LANGS = new Set([
  "html",
  "js",
  "ts",
  "tsx",
  "css",
  "python",
  "markdown",
  "c",
  "cpp",
  "java",
  "csharp",
  "sql",
  "rust",
  "go"
]);

/**
 * Sincroniza bajo demanda archivos remotos de GitHub (lazy blobs, lotes, precarga de vista previa
 * y sincronización de estado offline del repositorio).
 */
export function createGithubLazySync({
  getActiveProject,
  setProjects,
  getTreeEntries,
  setTreeEntries,
  getFilesOnly,
  setFilesOnly,
  getOpenTabIds,
  setOpenTabIds,
  getActiveFileId,
  setActiveFileId,
  persistTabsState,
  renderWorkspaceView,
  renderTabs,
  explorer,
  editor,
  getSplitController,
  cacheAndSyncGithubFileFn,
  getGithubToken,
  fetchSingleRepoBlob,
  downloadBatchBlobs,
  markProjectOfflineCached,
  listProjects
}) {
  function syncOfflineButtonState() {
    const activeProject = getActiveProject();
    if (!activeProject || activeProject.kind !== "github") {
      explorer.setOfflineRepoState({ visible: false });
      return;
    }
    const pendingCount = getFilesOnly().filter((f) => f.contentLoaded === false && f.blobSha).length;
    explorer.setOfflineRepoState({
      visible: true,
      isOfflineReady: pendingCount === 0,
      pendingCount,
      busy: false
    });
  }

  async function finalizeLoadedProjectFiles(sourceProjectId, loadedFiles, hasDeleted = false) {
    const activeProject = getActiveProject();
    if (!activeProject || activeProject.id !== sourceProjectId) {
      return;
    }

    const splitController = getSplitController?.();

    if (hasDeleted) {
      const deletedIds = new Set(loadedFiles.filter((f) => f?.deleted).map((f) => f.id));
      if (deletedIds.size > 0) {
        setTreeEntries(getTreeEntries().filter((entry) => !deletedIds.has(entry.path)));
        setFilesOnly(getFilesOnly().filter((file) => !deletedIds.has(file.id)));
        const nextOpenTabs = getOpenTabIds().filter((id) => !deletedIds.has(id));
        setOpenTabIds(nextOpenTabs);

        const activeFileId = getActiveFileId();
        if (activeFileId && deletedIds.has(activeFileId)) {
          setActiveFileId(nextOpenTabs[0] || null);
          await persistTabsState();
          renderWorkspaceView();
        } else {
          renderTabs();
        }
        explorer.renderTree(getTreeEntries(), getActiveFileId());
        for (const deletedId of deletedIds) {
          editor.dropFileState(deletedId);
          splitController?.dropFileState?.(deletedId);
        }
      }
    }

    for (const fileObj of loadedFiles) {
      if (fileObj && !fileObj.deleted) {
        editor.dropFileState(fileObj.id);
      }
    }

    const currentFiles = getFilesOnly();
    if (currentFiles.length > 0 && currentFiles.every((f) => f.contentLoaded !== false)) {
      activeProject.offlineCached = true;
      await markProjectOfflineCached(activeProject.id, true);
      const nextProjects = await listProjects();
      setProjects(nextProjects);
      explorer.renderProjects(nextProjects, activeProject.id);
    }
    syncOfflineButtonState();
  }

  async function ensureFileContentLoaded(fileObj) {
    const activeProject = getActiveProject();
    if (
      !fileObj ||
      fileObj.contentLoaded !== false ||
      !activeProject ||
      activeProject.kind !== "github" ||
      !activeProject.github ||
      !fileObj.blobSha
    ) {
      return;
    }

    // Fijar el proyecto ANTES de esperar a la red para no contaminar otro proyecto si el usuario cambia
    const sourceProjectId = activeProject.id;
    const blobPayload = await fetchSingleRepoBlob({
      token: getGithubToken(),
      owner: activeProject.github.owner,
      repo: activeProject.github.repo,
      blobSha: fileObj.blobSha,
      path: fileObj.path,
      isBinary: Boolean(fileObj.isBinary)
    });
    const { deleted } = await cacheAndSyncGithubFileFn({
      projectId: sourceProjectId,
      fileObj,
      remotePayload: blobPayload ?? "",
      blobSha: fileObj.blobSha
    });
    await finalizeLoadedProjectFiles(sourceProjectId, [fileObj], deleted);
  }

  async function ensureFilesLoaded(fileList, onProgress) {
    const activeProject = getActiveProject();
    const unloaded = fileList.filter((f) => f && f.contentLoaded === false && f.blobSha);
    if (unloaded.length === 0 || !activeProject || activeProject.kind !== "github" || !activeProject.github) {
      return;
    }

    const sourceProjectId = activeProject.id;
    const loadedItems = await downloadBatchBlobs({
      token: getGithubToken(),
      owner: activeProject.github.owner,
      repo: activeProject.github.repo,
      items: unloaded.map((f) => ({ path: f.path, blobSha: f.blobSha, isBinary: Boolean(f.isBinary) })),
      onProgress
    });

    const byPath = new Map(loadedItems.map((item) => [item.path, item]));
    const syncedFiles = [];
    let hasDeleted = false;
    for (const fileObj of unloaded) {
      const hit = byPath.get(fileObj.path);
      if (!hit) continue;
      const { deleted } = await cacheAndSyncGithubFileFn({
        projectId: sourceProjectId,
        fileObj,
        remotePayload: hit,
        blobSha: hit.blobSha || fileObj.blobSha
      });
      if (deleted) {
        hasDeleted = true;
      }
      syncedFiles.push(fileObj);
    }

    await finalizeLoadedProjectFiles(sourceProjectId, syncedFiles, hasDeleted);
  }

  async function preloadForPreview(activeFile) {
    const activeProject = getActiveProject();
    if (!activeProject || activeProject.kind !== "github" || !activeFile) return;
    if (!PREVIEWABLE_LANGS.has(activeFile.lang)) return;

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
    const isWeb =
      activeFile.lang === "html" ||
      activeFile.lang === "js" ||
      activeFile.lang === "ts" ||
      activeFile.lang === "tsx" ||
      activeFile.lang === "css";

    const needed = getFilesOnly().filter((f) => {
      if (f.contentLoaded !== false || !f.blobSha) return false;
      if (!isWeb && folderPrefix && !f.path.startsWith(folderPrefix)) return false;
      if (activeFile.lang === "python") {
        return f.lang === "python";
      }
      if (
        activeFile.lang === "c" ||
        activeFile.lang === "cpp" ||
        activeFile.lang === "rust" ||
        activeFile.lang === "go" ||
        activeFile.lang === "java" ||
        activeFile.lang === "csharp"
      ) {
        return f.lang === activeFile.lang || f.path.endsWith(".h") || f.path.endsWith(".hpp");
      }
      if (activeFile.lang === "sql") {
        return f.lang === "sql";
      }
      return (
        f.lang === "html" ||
        f.lang === "js" ||
        f.lang === "ts" ||
        f.lang === "tsx" ||
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

  return {
    syncOfflineButtonState,
    ensureFileContentLoaded,
    ensureFilesLoaded,
    finalizeLoadedProjectFiles,
    preloadForPreview
  };
}
