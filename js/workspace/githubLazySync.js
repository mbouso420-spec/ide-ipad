import { isImageFile } from "../storage/fileImport.js";
import { cacheBatchGithubFileContents } from "../storage/workspaceDb.js";
import { applyCachedBlobRecordToFile } from "./githubBlobCache.js";

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
  cacheBatchFn = cacheBatchGithubFileContents,
  getGithubToken,
  fetchSingleRepoBlob,
  downloadBatchBlobs,
  markProjectOfflineCached,
  listProjects
}) {
  const inFlightFileFetches = new Map();
  let previewPreloadController = null;
  const MAX_PREVIEW_PRELOAD_FILES = 60;

  function isWebScriptOrMarkupFile(file) {
    if (!file) return false;
    if (file.lang === "html" || file.lang === "js" || file.lang === "ts" || file.lang === "tsx" || file.lang === "css") {
      return true;
    }
    const lowerPath = String(file.path || "").toLowerCase();
    return (
      lowerPath.endsWith(".tsx") ||
      lowerPath.endsWith(".ts") ||
      lowerPath.endsWith(".jsx") ||
      lowerPath.endsWith(".mjs") ||
      lowerPath.endsWith(".cjs")
    );
  }

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
          if (getActiveProject()?.id !== sourceProjectId) return;
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
        splitController?.dropFileState?.(fileObj.id);
      }
    }

    const currentFiles = getFilesOnly();
    if (currentFiles.length > 0 && currentFiles.every((f) => f.contentLoaded !== false)) {
      await markProjectOfflineCached(activeProject.id, true);
      if (getActiveProject()?.id !== sourceProjectId) return;
      activeProject.offlineCached = true;
      const nextProjects = await listProjects();
      if (getActiveProject()?.id !== sourceProjectId) return;
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
    const fetchKey = `${sourceProjectId}::${fileObj.path}`;
    const existingFetch = inFlightFileFetches.get(fetchKey);
    if (existingFetch) {
      return existingFetch;
    }

    const promise = (async () => {
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
      if (getActiveProject()?.id !== sourceProjectId) {
        return;
      }
      await finalizeLoadedProjectFiles(sourceProjectId, [fileObj], deleted);
    })();

    inFlightFileFetches.set(fetchKey, promise);
    try {
      await promise;
    } finally {
      if (inFlightFileFetches.get(fetchKey) === promise) {
        inFlightFileFetches.delete(fetchKey);
      }
    }
  }

  async function ensureFilesLoaded(fileList, onProgress, { signal = null } = {}) {
    const activeProject = getActiveProject();
    const candidates = (Array.isArray(fileList) ? fileList : []).filter(
      (f) => f && f.contentLoaded === false && f.blobSha
    );
    if (candidates.length === 0 || !activeProject || activeProject.kind !== "github" || !activeProject.github) {
      return;
    }

    const sourceProjectId = activeProject.id;
    const alreadyInFlight = [];
    const unloaded = [];
    for (const f of candidates) {
      const key = `${sourceProjectId}::${f.path}`;
      const existing = inFlightFileFetches.get(key);
      if (existing) {
        alreadyInFlight.push(existing);
      } else {
        unloaded.push(f);
      }
    }

    if (unloaded.length === 0) {
      await Promise.all(alreadyInFlight);
      return;
    }

    const batchPromise = (async () => {
      const loadedItems = await downloadBatchBlobs({
        token: getGithubToken(),
        owner: activeProject.github.owner,
        repo: activeProject.github.repo,
        items: unloaded.map((f) => ({ path: f.path, blobSha: f.blobSha, isBinary: Boolean(f.isBinary) })),
        onProgress,
        signal
      });

      const byPath = new Map((Array.isArray(loadedItems) ? loadedItems : []).map((item) => [item.path, item]));
      const syncedFiles = [];
      let hasDeleted = false;

      if (typeof cacheBatchFn === "function") {
        const matchedEntries = [];
        for (const fileObj of unloaded) {
          const hit = byPath.get(fileObj.path);
          if (!hit) continue;
          matchedEntries.push({
            fileObj,
            hit,
            batchItem: { path: fileObj.path, payload: hit, blobSha: hit.blobSha || fileObj.blobSha }
          });
        }
        const savedList = await cacheBatchFn(
          sourceProjectId,
          matchedEntries.map((m) => m.batchItem)
        );
        matchedEntries.forEach((m, idx) => {
          const { deleted } = applyCachedBlobRecordToFile(m.fileObj, savedList?.[idx], m.hit);
          if (deleted) hasDeleted = true;
          syncedFiles.push(m.fileObj);
        });
      } else {
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
      }

      if (getActiveProject()?.id !== sourceProjectId) {
        return;
      }
      await finalizeLoadedProjectFiles(sourceProjectId, syncedFiles, hasDeleted);
    })();

    for (const f of unloaded) {
      inFlightFileFetches.set(`${sourceProjectId}::${f.path}`, batchPromise);
    }
    try {
      await Promise.all([batchPromise, ...alreadyInFlight]);
    } finally {
      for (const f of unloaded) {
        const key = `${sourceProjectId}::${f.path}`;
        if (inFlightFileFetches.get(key) === batchPromise) {
          inFlightFileFetches.delete(key);
        }
      }
    }
  }

  async function preloadForPreview(activeFile) {
    const activeProject = getActiveProject();
    if (!activeProject || activeProject.kind !== "github" || !activeFile) return;
    const sourceProjectId = activeProject.id;
    const activeIsImage = isImageFile(activeFile);
    if (!activeIsImage && !PREVIEWABLE_LANGS.has(activeFile.lang) && !isWebScriptOrMarkupFile(activeFile)) return;

    if (activeIsImage || activeFile.lang === "markdown") {
      if (activeFile.contentLoaded === false && activeFile.blobSha) {
        try {
          await ensureFileContentLoaded(activeFile);
        } catch {
          // Se muestra con el estado actual en memoria
        }
      }
      if (getActiveProject()?.id !== sourceProjectId) {
        return;
      }
    }

    const lastSlash = activeFile.path.lastIndexOf("/");
    const folderPrefix = lastSlash === -1 ? "" : `${activeFile.path.slice(0, lastSlash + 1)}`;
    const isWeb = isWebScriptOrMarkupFile(activeFile) || activeIsImage;

    const needed = getFilesOnly().filter((f) => {
      if (f.contentLoaded !== false || !f.blobSha) return false;
      if (!isWeb && activeFile.lang !== "markdown" && folderPrefix && !f.path.startsWith(folderPrefix)) return false;
      if (activeFile.lang === "markdown") {
        return isImageFile(f);
      }
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
      const lowerP = f.path.toLowerCase();
      return (
        isWebScriptOrMarkupFile(f) ||
        /\.(?:json|csv|xml|txt|woff2?|ttf|otf)$/i.test(lowerP) ||
        isImageFile(f)
      );
    });

    if (needed.length > 0) {
      // Priorizar archivos en la misma carpeta y acotar precarga para no saturar batería/red en repos masivos.
      if (needed.length > MAX_PREVIEW_PRELOAD_FILES) {
        needed.sort((a, b) => {
          const aSame = folderPrefix && a.path.startsWith(folderPrefix) ? 0 : 1;
          const bSame = folderPrefix && b.path.startsWith(folderPrefix) ? 0 : 1;
          if (aSame !== bSame) return aSame - bSame;
          const aScript = isWebScriptOrMarkupFile(a) ? 0 : 1;
          const bScript = isWebScriptOrMarkupFile(b) ? 0 : 1;
          return aScript - bScript;
        });
        needed.length = MAX_PREVIEW_PRELOAD_FILES;
      }

      previewPreloadController?.abort();
      previewPreloadController = typeof AbortController === "function" ? new AbortController() : null;
      const preloadSignal = previewPreloadController ? previewPreloadController.signal : null;

      explorer.setAutosaveStatus(`Cargando ${needed.length} archivo(s) para la vista previa…`);
      try {
        await ensureFilesLoaded(needed, undefined, { signal: preloadSignal });
        if (!preloadSignal?.aborted && getActiveProject()?.id === sourceProjectId) {
          explorer.setAutosaveStatus("Vista previa lista");
        }
      } catch (err) {
        if (err?.name !== "AbortError" && !preloadSignal?.aborted && getActiveProject()?.id === sourceProjectId) {
          explorer.setAutosaveStatus("Vista previa parcial (sin red)");
        }
      }
    }
  }

  function cancelPreviewPreload() {
    previewPreloadController?.abort();
    previewPreloadController = null;
  }

  return {
    syncOfflineButtonState,
    ensureFileContentLoaded,
    ensureFilesLoaded,
    preloadForPreview,
    cancelPreviewPreload
  };
}
