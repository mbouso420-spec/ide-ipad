import { applyDocumentEdit, createEditorManager } from "./editorManager.js";
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
  ensureFileContentLoaded,
  isFileDirtyForProject,
  renderTabs,
  onDirtyChange,
  scheduleAutosave,
  onSyncMainDoc,
  onFocusMain
}) {
  let isSplitOpen = false;
  let splitActiveFileId = null;
  let openRequestSeq = 0;
  let initSplitPromise = null;
  let isDestroyed = false;
  /** @type {any} */
  let editorSplit = null;
  const listenerController = typeof AbortController === "function" ? new AbortController() : null;
  const listenerOpts = listenerController ? { signal: listenerController.signal } : undefined;
  let activeDragCleanup = null;

  async function initSplitEditorIfNeeded() {
    if (editorSplit) return editorSplit;
    if (initSplitPromise) return initSplitPromise;
    initSplitPromise = (async () => {
      const instance = await createEditorManager({
        mountEl: splitBodyEl,
        enableMinimap: false,
        isSplitInstance: true,
        enableGlobalRuler: false,
        enableAutocomplete: false,
        onDocChange(filePath, newContent) {
          applyDocumentEdit({
            filePath,
            newContent,
            getFilesOnly,
            isFileDirtyForProject,
            renderTabs,
            onDirtyChange,
            getActiveProject,
            scheduleAutosave,
            onAfterEdit: (editedPath, editedContent) => {
              onSyncMainDoc?.(editedPath, editedContent);
            }
          });
        },
        onSelectionChange() {
          // En editor secundario no sobreescribe la selección del principal
        }
      });
      if (isDestroyed || !isSplitOpen) {
        instance.destroy?.();
        return null;
      }
      editorSplit = instance;
      return editorSplit;
    })();
    try {
      return await initSplitPromise;
    } finally {
      initSplitPromise = null;
    }
  }

  function populateSelect() {
    if (!splitFileSelectEl) return;
    const textFiles = getFilesOnly().filter((f) => f && !isBinaryFile(f));
    splitFileSelectEl.innerHTML = "";
    const frag = typeof document.createDocumentFragment === "function"
      ? document.createDocumentFragment()
      : null;
    for (const f of textFiles) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.shortName;
      if (f.id === splitActiveFileId) {
        opt.selected = true;
      }
      if (frag) {
        frag.appendChild(opt);
      } else {
        splitFileSelectEl.appendChild(opt);
      }
    }
    if (frag) {
      splitFileSelectEl.appendChild(frag);
    }
    if (!splitActiveFileId || !textFiles.some((f) => f.id === splitActiveFileId)) {
      splitFileSelectEl.value = "";
    }
  }

  async function openFile(file) {
    if (!file || !editorSplit) return;
    if (isBinaryFile(file)) {
      if (splitFileSelectEl) {
        splitFileSelectEl.value = splitActiveFileId || "";
      }
      return;
    }

    const reqId = ++openRequestSeq;
    if (typeof ensureFileContentLoaded === "function") {
      try {
        await ensureFileContentLoaded(file);
      } catch (err) {
        console.warn("No se pudo cargar archivo lazy para Split View:", err);
        if (reqId === openRequestSeq && splitFileSelectEl) {
          splitFileSelectEl.value = splitActiveFileId || "";
        }
        return;
      }
    }

    if (reqId !== openRequestSeq || isDestroyed || !isSplitOpen || !editorSplit) {
      return;
    }

    if (isBinaryFile(file)) {
      if (splitFileSelectEl) {
        splitFileSelectEl.value = splitActiveFileId || "";
      }
      return;
    }

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
      if (!isSplitOpen) return;

      const textFiles = getFilesOnly().filter((f) => f && !isBinaryFile(f));
      const openTabIds = getOpenTabIds();
      const activeFileId = getActiveFileId();

      let targetFile = null;
      if (openTabIds.length > 1) {
        const otherId = openTabIds.find((id) => id !== activeFileId && textFiles.some((f) => f.id === id));
        targetFile = textFiles.find((f) => f.id === otherId) || textFiles.find((f) => f.id === activeFileId) || textFiles[0] || null;
      } else if (activeFileId) {
        targetFile = textFiles.find((f) => f.id === activeFileId) || textFiles[0] || null;
      } else {
        targetFile = textFiles[0] || null;
      }

      populateSelect();
      if (targetFile) {
        await openFile(targetFile);
      } else if (splitTitleTextEl) {
        splitActiveFileId = null;
        splitTitleTextEl.textContent = "Sin archivo";
      }
    } else {
      openRequestSeq += 1;
      activeDragCleanup?.();
      activeDragCleanup = null;
      splitActiveFileId = null;
      if (splitTitleTextEl) splitTitleTextEl.textContent = "Sin archivo";
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

  btnEditorSplit?.addEventListener("click", () => void toggle(), listenerOpts);
  btnCloseSplit?.addEventListener("click", () => void toggle(false), listenerOpts);
  splitFileSelectEl?.addEventListener("change", () => {
    const chosen = getFilesOnly().find((f) => f.id === splitFileSelectEl.value);
    if (chosen) void openFile(chosen);
  }, listenerOpts);

  if (splitDividerEl && editorStageEl) {
    let startX = 0;
    let startLeftWidth = 0;
    let totalWidth = 0;
    let isDragging = false;
    let activePointerId = null;
    let pendingClientX = null;
    let dragRaf = null;
    const safeRaf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    const safeCancelRaf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (id) => clearTimeout(id);

    const flushDragLayout = () => {
      dragRaf = null;
      if (!isDragging || totalWidth <= 0 || pendingClientX === null) return;
      const delta = pendingClientX - startX;
      const newLeft = startLeftWidth + delta;
      const leftPct = Math.max(20, Math.min(80, (newLeft / totalWidth) * 100));
      if (editorMountEl) editorMountEl.style.flex = `0 0 ${leftPct}%`;
      if (splitMountEl) splitMountEl.style.flex = `0 0 ${100 - leftPct}%`;
    };

    const onPointerMove = (e) => {
      if (!isDragging || totalWidth <= 0) return;
      if (activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId) return;
      pendingClientX = e.clientX;
      if (!dragRaf) {
        dragRaf = safeRaf(flushDragLayout);
      }
    };

    const onPointerUp = (e) => {
      if (!isDragging) return;
      if (e && activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId) return;
      if (dragRaf) {
        safeCancelRaf(dragRaf);
        dragRaf = null;
      }
      if (pendingClientX !== null && totalWidth > 0) {
        flushDragLayout();
      }
      pendingClientX = null;
      isDragging = false;
      if (activePointerId !== null) {
        try {
          splitDividerEl.releasePointerCapture?.(activePointerId);
        } catch {
          // Ignorar si ya fue liberado
        }
        activePointerId = null;
      }
      splitDividerEl.classList.remove("is-dragging");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      activeDragCleanup = null;
    };

    splitDividerEl.addEventListener("lostpointercapture", onPointerUp, listenerOpts);
    splitDividerEl.addEventListener("pointerdown", (e) => {
      isDragging = true;
      activePointerId = e.pointerId ?? null;
      if (activePointerId !== null) {
        try {
          splitDividerEl.setPointerCapture?.(activePointerId);
        } catch {
          // Ignorar en entornos sin soporte
        }
      }
      startX = e.clientX;
      pendingClientX = e.clientX;
      startLeftWidth = editorMountEl ? editorMountEl.getBoundingClientRect().width : 0;
      totalWidth = editorStageEl.getBoundingClientRect().width;
      splitDividerEl.classList.add("is-dragging");
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      activeDragCleanup = onPointerUp;
    }, listenerOpts);
  }

  keyboardRouter?.registerGlobalShortcut("ctrl+\\", () => void toggle());
  keyboardRouter?.registerGlobalShortcut("meta+\\", () => void toggle());

  return {
    toggle,
    openFile,
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
      let activeUpdated = false;
      if (splitActiveFileId === oldPath) {
        splitActiveFileId = newPath;
        activeUpdated = true;
      } else if (isFolder && splitActiveFileId && splitActiveFileId.startsWith(`${oldPath}/`)) {
        splitActiveFileId = `${newPath}${splitActiveFileId.slice(oldPath.length)}`;
        activeUpdated = true;
      }
      editorSplit?.renameFileStates?.(oldPath, newPath, isFolder);
      if (activeUpdated && splitTitleTextEl) {
        const renamedFile = getFilesOnly().find((f) => f.id === splitActiveFileId);
        splitTitleTextEl.textContent =
          renamedFile?.shortName || splitActiveFileId.split("/").pop() || splitActiveFileId;
      }
      if (isSplitOpen) {
        populateSelect();
      }
    },
    dropFileState(filePath, isFolder = false) {
      openRequestSeq += 1;
      editorSplit?.dropFileState?.(filePath, isFolder);
      const affectsActive =
        splitActiveFileId === filePath ||
        Boolean(isFolder && splitActiveFileId && splitActiveFileId.startsWith(`${filePath}/`));
      if (affectsActive) {
        splitActiveFileId = null;
        editorSplit?.clearActiveFile?.();
        if (splitTitleTextEl) {
          splitTitleTextEl.textContent = "Sin archivo";
        }
      }
      if (isSplitOpen) {
        populateSelect();
      }
    },
    syncOrDropPath(filePath, nextContent, { markDirty = false } = {}) {
      if (!editorSplit) return;
      if (markDirty) {
        if (editorSplit.getActiveFileId() === filePath) {
          editorSplit.replaceEntireDocument(nextContent);
        } else {
          editorSplit.dropFileState(filePath);
        }
        return;
      }
      if (typeof nextContent === "string") {
        editorSplit.syncDoc(filePath, nextContent);
      } else {
        editorSplit.dropFileState(filePath);
      }
    },
    replaceIfActive(fileId, code) {
      if (editorSplit && editorSplit.getActiveFileId() === fileId) {
        editorSplit.syncDoc(fileId, code);
      }
    },
    handleRemoteFileUpdated(filePath, updatedFile) {
      if (!editorSplit) return;
      if (splitActiveFileId === filePath && isBinaryFile(updatedFile)) {
        splitActiveFileId = null;
        editorSplit.dropFileState(filePath);
        if (splitTitleTextEl) splitTitleTextEl.textContent = "Sin archivo";
        if (isSplitOpen) populateSelect();
        return;
      }
      if (splitActiveFileId === filePath && !isBinaryFile(updatedFile)) {
        editorSplit.dropFileState(filePath);
        if (updatedFile?.contentLoaded === false) {
          void openFile(updatedFile);
          return;
        }
        editorSplit.openFile(updatedFile);
      } else {
        editorSplit.dropFileState(filePath);
      }
      if (isSplitOpen) {
        populateSelect();
      }
    },
    destroy() {
      isDestroyed = true;
      openRequestSeq += 1;
      activeDragCleanup?.();
      activeDragCleanup = null;
      listenerController?.abort();
      keyboardRouter?.unregisterGlobalShortcut?.("ctrl+\\");
      keyboardRouter?.unregisterGlobalShortcut?.("meta+\\");
      if (editorSplit) {
        editorSplit.destroy?.();
        editorSplit = null;
      }
      splitActiveFileId = null;
      isSplitOpen = false;
    }
  };
}
