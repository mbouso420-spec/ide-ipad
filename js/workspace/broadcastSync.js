import { isBinaryFile } from "../storage/fileImport.js";
import { validateUserPath } from "../storage/workspaceDb.js";

function sanitizeBroadcastPath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath) return "";
  try {
    return validateUserPath(rawPath);
  } catch {
    return "";
  }
}

/**
 * Conecta la sincronización multi-pestaña vía BroadcastChannel para actualizaciones de archivos,
 * borrados, renombrados y cambios en el modo de almacenamiento de credenciales.
 * Devuelve un manejador con `destroy()` para desuscribirse limpiamente.
 */
export function initBroadcastSync({
  onWorkspaceBroadcast,
  getActiveProject,
  autosaveManager,
  reloadProjectEntries,
  getFilesOnly,
  getOpenTabIds,
  setOpenTabIds,
  getActiveFileId,
  setActiveFileId,
  persistTabsState,
  editor,
  editorMountEl,
  binaryPreview,
  symbolBar,
  statusBar,
  tabManager,
  renderWorkspaceView,
  getSplitController,
  github,
  onKeyStorageModeBroadcast
}) {
  let destroyed = false;
  let eventQueue = Promise.resolve();

  async function processWorkspaceEvent(event) {
    if (destroyed || !event || typeof event !== "object" || typeof event.type !== "string") return;

    if (event.type === "KEY_STORAGE_MODE_CHANGED" && (event.mode === "session" || event.mode === "local")) {
      onKeyStorageModeBroadcast?.(event.mode);
      return;
    }

    if (typeof event.projectId !== "string" || !event.projectId) return;
    const activeProject = getActiveProject();
    if (!activeProject || event.projectId !== activeProject.id) return;
    const splitController = getSplitController?.();

    const safeEventPath = sanitizeBroadcastPath(event.path);
    const safeOldPath = sanitizeBroadcastPath(event.oldPath);
    const safeNewPath = sanitizeBroadcastPath(event.newPath);

    if (event.type === "ENTRY_UPSERTED") {
      if (safeEventPath && !event.isFolder && autosaveManager.hasPendingTimer(activeProject.id, safeEventPath)) {
        return;
      }

      await reloadProjectEntries();
      const currentProject = getActiveProject();
      if (destroyed || !currentProject || event.projectId !== currentProject.id) {
        return;
      }

      if (!event.isFolder && safeEventPath) {
        if (autosaveManager.hasPendingTimer(currentProject.id, safeEventPath)) {
          return;
        }
        const upserted = getFilesOnly().find((f) => f.id === safeEventPath);
        editor.dropFileState(safeEventPath);
        if (upserted) {
          splitController?.handleRemoteFileUpdated?.(safeEventPath, upserted);
        }
      }

      renderWorkspaceView();
      await github.refreshTopbarBadge();
      return;
    }

    // Actualización de contenido de archivo emitida por otra pestaña (contrato FILE_UPDATED)
    if (event.type === "FILE_UPDATED" && safeEventPath) {
      if (autosaveManager.hasPendingTimer(activeProject.id, safeEventPath)) {
        return;
      }

      await reloadProjectEntries();
      const currentProject = getActiveProject();
      if (destroyed || !currentProject || event.projectId !== currentProject.id || autosaveManager.hasPendingTimer(currentProject.id, safeEventPath)) {
        return;
      }

      const updated = getFilesOnly().find((f) => f.id === safeEventPath);
      if (!updated) return;

      if (safeEventPath === getActiveFileId()) {
        editor.dropFileState(safeEventPath);
        if (isBinaryFile(updated)) {
          if (editorMountEl) editorMountEl.hidden = true;
          binaryPreview.render(updated);
          symbolBar.setLanguage(updated.lang);
          statusBar.setEditorToolbarDisabled(false, true);
        } else {
          binaryPreview.hide();
          if (editorMountEl) editorMountEl.hidden = false;
          editor.openFile(updated);
          symbolBar.setLanguage(updated.lang);
          statusBar.setEditorToolbarDisabled(false, false);
        }
        tabManager.renderTabs();
        statusBar.updateStatusBar();
      } else {
        editor.dropFileState(safeEventPath);
        tabManager.renderTabs();
      }

      splitController?.handleRemoteFileUpdated?.(safeEventPath, updated);
      await github.refreshTopbarBadge();
      return;
    }

    let tabsChanged = false;

    if (event.type === "ENTRY_DELETED" && safeEventPath) {
      const deletedPrefix = `${safeEventPath}/`;
      const isDeletedTarget = (p) =>
        p === safeEventPath || (Boolean(event.isFolder) && Boolean(p) && p.startsWith(deletedPrefix));

      autosaveManager.clearTimersForProject(activeProject.id, isDeletedTarget);

      const nextTabs = [];
      for (const tabId of getOpenTabIds()) {
        if (isDeletedTarget(tabId)) {
          editor.dropFileState(tabId);
          tabsChanged = true;
        } else {
          nextTabs.push(tabId);
        }
      }
      if (tabsChanged) {
        setOpenTabIds(nextTabs);
      }
      splitController?.dropFileState?.(safeEventPath, Boolean(event.isFolder));
      if (isDeletedTarget(getActiveFileId())) {
        setActiveFileId(getOpenTabIds()[0] || null);
        tabsChanged = true;
      }
    } else if (event.type === "ENTRY_RENAMED" && safeOldPath) {
      const oldPrefix = `${safeOldPath}/`;
      const matchesOld = (p) =>
        p === safeOldPath || (Boolean(event.isFolder) && Boolean(p) && p.startsWith(oldPrefix));

      autosaveManager.clearTimersForProject(activeProject.id, matchesOld);

      if (safeNewPath) {
        const remapPath = (p) => {
          if (!p) return p;
          if (p === safeOldPath) return safeNewPath;
          if (event.isFolder && p.startsWith(oldPrefix)) {
            return `${safeNewPath}${p.slice(safeOldPath.length)}`;
          }
          return p;
        };

        const remappedTabs = [];
        for (const tabId of getOpenTabIds()) {
          const nextId = remapPath(tabId);
          if (nextId !== tabId) tabsChanged = true;
          if (!remappedTabs.includes(nextId)) {
            remappedTabs.push(nextId);
          }
        }
        setOpenTabIds(remappedTabs);

        const activeFileId = getActiveFileId();
        if (activeFileId) {
          const nextActive = remapPath(activeFileId);
          if (nextActive !== activeFileId) {
            setActiveFileId(nextActive);
            tabsChanged = true;
          }
        }

        editor.renameFileStates(safeOldPath, safeNewPath, Boolean(event.isFolder));
        splitController?.handleEntryRenamed?.(safeOldPath, safeNewPath, Boolean(event.isFolder));
      }
    } else {
      return;
    }

    await autosaveManager.flushPendingSaves();
    await reloadProjectEntries();
    if (destroyed || getActiveProject()?.id !== activeProject.id) return;
    const validIds = new Set(getFilesOnly().map((f) => f.id));
    const currentTabs = getOpenTabIds();
    const filteredTabs = currentTabs.filter((id) => validIds.has(id));
    if (filteredTabs.length !== currentTabs.length) {
      setOpenTabIds(filteredTabs);
      tabsChanged = true;
    }
    const currentActive = getActiveFileId();
    if (currentActive && !validIds.has(currentActive)) {
      setActiveFileId(filteredTabs[0] || null);
      tabsChanged = true;
    } else if (!currentActive && filteredTabs.length > 0) {
      setActiveFileId(filteredTabs[0]);
      tabsChanged = true;
    }
    if (tabsChanged) {
      await persistTabsState();
    }
    if (destroyed) return;
    renderWorkspaceView();
    await github.refreshTopbarBadge();
  }

  const unsubscribe = onWorkspaceBroadcast((event) => {
    eventQueue = eventQueue
      .then(() => processWorkspaceEvent(event))
      .catch((err) => {
        console.warn("[BroadcastSync] Error sincronizando evento de pestaña:", err?.message || err);
      });
  });

  return {
    destroy() {
      destroyed = true;
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    }
  };
}
