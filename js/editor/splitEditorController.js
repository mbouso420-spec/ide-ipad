import { createEditorManager } from "./editorManager.js";
import { isBinaryFile } from "../storage/fileImport.js";

/**
 * Controlador del segundo panel de edición en vista dividida (`split-mount`),
 * incluyendo redimensionamiento táctil/ratón y sincronización de estado con el panel principal.
 */
export function createSplitEditorController({
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
  getActiveProject,
  getActiveFileId,
  getFilesOnly,
  getOpenTabIds,
  isFileDirtyForProject,
  renderTabs,
  scheduleAutosave,
  onSyncMainDoc,
  onFocusMain
}) {
  let isSplitOpen = false;
  let splitActiveFileId = null;
  /** @type {any} */
  let editorSplit = null;

  async function initSplitEditorIfNeeded() {
    if (editorSplit) return editorSplit;
    editorSplit = await createEditorManager({
      mountEl: splitBodyEl,
      enableMinimap: false,
      onDocChange(filePath, newContent) {
        const filesOnly = getFilesOnly();
        const target = filesOnly.find((f) => f.id === filePath);
        if (!target) return;
        const wasDirty = isFileDirtyForProject(target);
        target.content = newContent;
        const nowDirty = isFileDirtyForProject(target);
        if (wasDirty !== nowDirty) {
          renderTabs();
        }
        const activeProject = getActiveProject();
        if (activeProject) {
          scheduleAutosave(activeProject.id, filePath, newContent);
        }
        onSyncMainDoc?.(filePath, newContent);
      },
      onSelectionChange() {
        // En editor secundario no sobreescribe la selección del principal
      }
    });
    return editorSplit;
  }

  function populateSelect() {
    if (!splitFileSelectEl) return;
    const filesOnly = getFilesOnly();
    splitFileSelectEl.innerHTML = "";
    for (const f of filesOnly) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.shortName;
      if (f.id === splitActiveFileId) {
        opt.selected = true;
      }
      splitFileSelectEl.appendChild(opt);
    }
  }

  function openFile(file) {
    if (!file || !editorSplit || isBinaryFile(file)) return;
    splitActiveFileId = file.id;
    editorSplit.openFile(file);
    if (splitTitleTextEl) splitTitleTextEl.textContent = file.shortName;
    populateSelect();
  }

  async function toggle(forceState) {
    const nextState = typeof forceState === "boolean" ? forceState : !isSplitOpen;
    if (nextState === isSplitOpen) return;
    isSplitOpen = nextState;

    if (btnEditorSplit) {
      btnEditorSplit.setAttribute("aria-pressed", String(isSplitOpen));
      btnEditorSplit.classList.toggle("is-active", isSplitOpen);
    }

    if (isSplitOpen) {
      editorStageEl?.classList.add("is-split");
      if (splitDividerEl) splitDividerEl.hidden = false;
      if (splitMountEl) splitMountEl.hidden = false;
      await initSplitEditorIfNeeded();

      const filesOnly = getFilesOnly();
      const openTabIds = getOpenTabIds();
      const activeFileId = getActiveFileId();

      let targetFile = null;
      if (openTabIds.length > 1) {
        const otherId = openTabIds.find((id) => id !== activeFileId) || openTabIds[0];
        targetFile = filesOnly.find((f) => f.id === otherId);
      } else if (activeFileId) {
        targetFile = filesOnly.find((f) => f.id === activeFileId);
      }

      if (targetFile) {
        openFile(targetFile);
      }
      populateSelect();
    } else {
      editorStageEl?.classList.remove("is-split");
      if (splitDividerEl) splitDividerEl.hidden = true;
      if (splitMountEl) splitMountEl.hidden = true;
      if (editorMountEl) {
        editorMountEl.style.flex = "";
        editorMountEl.style.width = "";
      }
      if (splitMountEl) {
        splitMountEl.style.flex = "";
        splitMountEl.style.width = "";
      }
      if (editorSplit) {
        editorSplit.destroy?.();
        editorSplit = null;
      }
      onFocusMain?.();
    }
  }

  btnEditorSplit?.addEventListener("click", () => void toggle());
  btnCloseSplit?.addEventListener("click", () => void toggle(false));
  splitFileSelectEl?.addEventListener("change", () => {
    const chosen = getFilesOnly().find((f) => f.id === splitFileSelectEl.value);
    if (chosen) openFile(chosen);
  });

  if (splitDividerEl && editorStageEl) {
    let startX = 0;
    let startLeftWidth = 0;
    let totalWidth = 0;
    let isDragging = false;

    const onPointerMove = (e) => {
      if (!isDragging) return;
      const delta = e.clientX - startX;
      const newLeft = startLeftWidth + delta;
      const leftPct = Math.max(20, Math.min(80, (newLeft / totalWidth) * 100));
      if (editorMountEl) editorMountEl.style.flex = `0 0 ${leftPct}%`;
      if (splitMountEl) splitMountEl.style.flex = `0 0 ${100 - leftPct}%`;
    };

    const onPointerUp = () => {
      if (!isDragging) return;
      isDragging = false;
      splitDividerEl.classList.remove("is-dragging");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    splitDividerEl.addEventListener("pointerdown", (e) => {
      isDragging = true;
      startX = e.clientX;
      startLeftWidth = editorMountEl ? editorMountEl.getBoundingClientRect().width : 0;
      totalWidth = editorStageEl.getBoundingClientRect().width;
      splitDividerEl.classList.add("is-dragging");
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    });
  }

  keyboardRouter?.registerGlobalShortcut("ctrl+\\", () => void toggle());
  keyboardRouter?.registerGlobalShortcut("meta+\\", () => void toggle());

  return {
    toggle,
    openFile,
    populateSelect,
    refreshIfOpen() {
      if (isSplitOpen) {
        populateSelect();
      }
    },
    syncDoc(filePath, newContent) {
      editorSplit?.syncDoc(filePath, newContent);
    },
    setHardwareKeyboardMode(hardwareMode) {
      editorSplit?.setHardwareKeyboardMode?.(hardwareMode);
    },
    handleEntryRenamed(oldPath, newPath, isFolder) {
      if (splitActiveFileId === oldPath) {
        splitActiveFileId = newPath;
      } else if (isFolder && splitActiveFileId && splitActiveFileId.startsWith(`${oldPath}/`)) {
        splitActiveFileId = `${newPath}${splitActiveFileId.slice(oldPath.length)}`;
      }
      editorSplit?.renameFileStates?.(oldPath, newPath, isFolder);
    },
    dropFileState(filePath) {
      editorSplit?.dropFileState?.(filePath);
    },
    replaceIfActive(fileId, code) {
      if (editorSplit && editorSplit.getActiveFileId() === fileId) {
        editorSplit.replaceEntireDocument(code);
      }
    },
    handleRemoteFileUpdated(filePath, updatedFile) {
      if (!editorSplit) return;
      if (splitActiveFileId === filePath && !isBinaryFile(updatedFile)) {
        editorSplit.dropFileState(filePath);
        editorSplit.openFile(updatedFile);
      } else {
        editorSplit.dropFileState(filePath);
      }
    }
  };
}
