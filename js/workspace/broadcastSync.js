import { isBinaryFile } from "../storage/fileImport.js";

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
  const unsubscribe = onWorkspaceBroadcast(async (event) => {
    if (!event) return;

    if (event.type === "KEY_STORAGE_MODE_CHANGED" && (event.mode === "session" || event.mode === "local")) {
      onKeyStorageModeBroadcast?.(event.mode);
      return;
    }

    const activeProject = getActiveProject();
    if (!activeProject || event.projectId !== activeProject.id) return;
    const splitController = getSplitController?.();

    // Actualización de contenido de archivo emitida por otra pestaña (contrato FILE_UPDATED)
    if (event.type === "FILE_UPDATED" && event.path) {
      if (autosaveManager.hasPendingTimer(activeProject.id, event.path)) {
        return;
      }

      await reloadProjectEntries();
      const currentProject = getActiveProject();
      if (!currentProject || event.projectId !== currentProject.id || autosaveManager.hasPendingTimer(currentProject.id, event.path)) {
        return;
      }

      const updated = getFilesOnly().find((f) => f.id === event.path);
      if (!updated) return;

      if (event.path === getActiveFileId()) {
        editor.dropFileState(event.path);
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
        editor.dropFileState(event.path);
        tabManager.renderTabs();
      }

      splitController?.handleRemoteFileUpdated(event.path, updated);
      await github.refreshTopbarBadge();
      return;
    }

    let tabsChanged = false;

    if (event.type === "ENTRY_DELETED" && event.path && activeProject) {
      const deletedPrefix = `${event.path}/`;
      const isDeletedTarget = (p) =>
        p === event.path || (Boolean(event.isFolder) && Boolean(p) && p.startsWith(deletedPrefix));

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
      splitController?.dropFileState(event.path, Boolean(event.isFolder));
      if (isDeletedTarget(getActiveFileId())) {
        setActiveFileId(getOpenTabIds()[0] || null);
        tabsChanged = true;
      }
    } else if (event.type === "ENTRY_RENAMED" && event.oldPath && activeProject) {
      const oldPrefix = `${event.oldPath}/`;
      const matchesOld = (p) =>
        p === event.oldPath || (Boolean(event.isFolder) && Boolean(p) && p.startsWith(oldPrefix));

      autosaveManager.clearTimersForProject(activeProject.id, matchesOld);

      if (event.newPath) {
        const remapPath = (p) => {
          if (!p) return p;
          if (p === event.oldPath) return event.newPath;
          if (event.isFolder && p.startsWith(oldPrefix)) {
            return `${event.newPath}${p.slice(event.oldPath.length)}`;
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

        editor.renameFileStates(event.oldPath, event.newPath, Boolean(event.isFolder));
        splitController?.handleEntryRenamed(event.oldPath, event.newPath, Boolean(event.isFolder));
      }
    }

    await autosaveManager.flushPendingSaves();
    await reloadProjectEntries();
    if (tabsChanged) {
      const validIds = new Set(getFilesOnly().map((f) => f.id));
      const filteredTabs = getOpenTabIds().filter((id) => validIds.has(id));
      setOpenTabIds(filteredTabs);
      const currentActive = getActiveFileId();
      if (currentActive && !validIds.has(currentActive)) {
        setActiveFileId(filteredTabs[0] || null);
      }
      await persistTabsState();
    }
    renderWorkspaceView();
    await github.refreshTopbarBadge();
  });

  return {
    destroy() {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    }
  };
}
