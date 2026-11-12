import { inferFileMeta } from "../storage/workspaceDb.js";
import { saveStoredValue } from "../utils/storage.js";
import { createMinimapController } from "./minimap.js";
import { computeSmartReplacement } from "./smartReplace.js";
import {
  extractWordBeforeCursor,
  getLanguageCompletions,
  createAutocompleteBarController
} from "./autocompleteCatalog.js";
import { getIndentSize } from "./languageConfig.js";
import { createErrorMarkersController } from "./errorMarkersController.js";

/**
 * Respaldo local ligero por si el usuario abre el IDE sin conexión antes del cacheo PWA
 * o en entornos de prueba sin CodeMirror 6.
 */
export function createFallbackEditor({
  mountEl,
  initialWrap,
  initialFontSize,
  initialHardwareKeyboard = true,
  prefKeys,
  clampFontSize,
  applyFontSize,
  applyHardwareKeyboardAttributes,
  wrapTextWithDelimiters,
  onDocChange,
  onSelectionChange,
  enableMinimap = true,
  isSplitInstance = false,
  enableGlobalRuler = !isSplitInstance,
  enableAutocomplete = !isSplitInstance,
  minimapParent = mountEl
}) {
  let wordWrap = initialWrap;
  let fontSize = initialFontSize;
  let hardwareKeyboard = initialHardwareKeyboard;
  let activeFileId = null;
  let activeLang = "js";

  const textarea = document.createElement("textarea");
  textarea.className = "editor-fallback-surface";
  textarea.spellcheck = false;
  textarea.autocapitalize = "off";
  textarea.autocomplete = "off";
  textarea.setAttribute("aria-label", "Editor de código");
  applyHardwareKeyboardAttributes(hardwareKeyboard, textarea);
  textarea.wrap = wordWrap ? "soft" : "off";
  if (mountEl) {
    mountEl.innerHTML = "";
    mountEl.appendChild(textarea);
  }

  // Caché ligero de líneas para el minimapa del fallback, invalidado al mutar `textarea.value`
  let cachedLineText = null;
  let cachedLines = [];
  function getFallbackLines() {
    const val = textarea ? textarea.value : "";
    if (cachedLineText !== val) {
      cachedLineText = val;
      cachedLines = val.split("\n");
    }
    return cachedLines;
  }

  const fallbackMinimap = enableMinimap
    ? createMinimapController({
        mountEl: minimapParent || mountEl,
        getLineCount: () => getFallbackLines().length,
        getLine: (index) => getFallbackLines()[index] || "",
        getViewport: () => {
          if (textarea) {
            return {
              top: textarea.scrollTop,
              height: textarea.clientHeight,
              totalHeight: textarea.scrollHeight
            };
          }
          return { top: 0, height: 100, totalHeight: 100 };
        },
        onScrollToRatio: (ratio) => {
          if (textarea) {
            textarea.scrollTop = ratio * (textarea.scrollHeight - textarea.clientHeight);
          }
        }
      })
    : null;

  const fallbackAutocompleteBar = createAutocompleteBarController({
    mountEl,
    enabled: enableAutocomplete,
    sharedGlobalBar: enableAutocomplete,
    onAccept(item, wordRange) {
      const docLen = textarea.value.length;
      const from = Math.min(Math.max(0, wordRange.from), docLen);
      const to = Math.min(Math.max(from, wordRange.to), docLen);
      const insertText = item.apply || item.label;
      textarea.focus();
      textarea.setRangeText(insertText, from, to, "end");
      const newPos = from + insertText.length;
      textarea.setSelectionRange(newPos, newPos);
      fallbackAutocompleteBar.hide();
      if (activeFileId) {
        onDocChange(activeFileId, textarea.value);
      }
      fallbackMinimap?.render();
      emitSel();
    }
  });

  function refreshFallbackAutocomplete() {
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (start !== end) {
      fallbackAutocompleteBar.hide();
      return;
    }
    const wordRange = extractWordBeforeCursor(textarea.value, end);
    if (!wordRange.word || wordRange.word.length < 2) {
      fallbackAutocompleteBar.hide();
      return;
    }
    const suggestions = getLanguageCompletions(activeLang, wordRange.word, textarea.value, 6);
    fallbackAutocompleteBar.update(suggestions, wordRange);
  }

  const listenerController = typeof AbortController === "function" ? new AbortController() : null;
  const listenerOpts = listenerController ? { signal: listenerController.signal } : undefined;

  textarea.addEventListener("scroll", () => {
    fallbackMinimap?.updateSlider();
  }, { passive: true, ...(listenerController ? { signal: listenerController.signal } : {}) });

  textarea.addEventListener("input", () => {
    if (activeFileId) {
      onDocChange(activeFileId, textarea.value);
    }
    fallbackMinimap?.render();
    refreshFallbackAutocomplete();
    emitSel();
  }, listenerOpts);

  const emitSel = () => {
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const before = textarea.value.slice(0, end);
    const lastNl = before.lastIndexOf("\n");
    let cursorLine = 1;
    if (lastNl !== -1) {
      for (let i = 0; i <= lastNl; i++) {
        if (before.charCodeAt(i) === 10) cursorLine += 1;
      }
    }
    const cursorCol = lastNl === -1 ? end + 1 : end - lastNl;

    if (start === end) {
      onSelectionChange({ text: "", lineCount: 0, cursorLine, cursorCol });
      return;
    }
    const text = textarea.value.slice(start, end);
    onSelectionChange({ text, lineCount: text.split("\n").length, cursorLine, cursorCol });
  };

  textarea.addEventListener("select", emitSel, listenerOpts);
  textarea.addEventListener("keyup", emitSel, listenerOpts);
  textarea.addEventListener("mouseup", emitSel, listenerOpts);
  textarea.addEventListener("click", emitSel, listenerOpts);

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      if (!fallbackAutocompleteBar.isOpen()) {
        refreshFallbackAutocomplete();
      }
      if (fallbackAutocompleteBar.isOpen() && fallbackAutocompleteBar.acceptCurrent()) {
        return;
      }
      const spaces = " ".repeat(getIndentSize(activeLang));
      insertInTextarea(spaces, 0);
      return;
    }
    if (event.key === "Escape" && fallbackAutocompleteBar.isOpen()) {
      event.preventDefault();
      fallbackAutocompleteBar.hide();
    }
  }, listenerOpts);

  function insertInTextarea(text, cursorBack = 0) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.focus();
    if (start !== end && cursorBack > 0 && cursorBack < text.length) {
      const selected = textarea.value.slice(start, end);
      const wrapped = wrapTextWithDelimiters(text, selected, cursorBack);
      textarea.setRangeText(wrapped.text, start, end, "select");
      textarea.setSelectionRange(start + wrapped.selectFrom, start + wrapped.selectTo);
    } else {
      textarea.setRangeText(text, start, end, "end");
      const pos = Math.max(0, start + text.length - cursorBack);
      textarea.setSelectionRange(pos, pos);
    }
    if (activeFileId) {
      onDocChange(activeFileId, textarea.value);
    }
    refreshFallbackAutocomplete();
    emitSel();
  }

  function goToFallbackLine(lineNo) {
    const target = Math.max(1, parseInt(lineNo, 10) || 1);
    const lines = getFallbackLines();
    const boundedLine = Math.min(target, lines.length);
    let offset = 0;
    for (let i = 0; i < boundedLine - 1; i++) {
      offset += lines[i].length + 1;
    }
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    const approxLineHeight = 20;
    const targetScroll = Math.max(0, (boundedLine - 3) * approxLineHeight);
    if (typeof textarea.scrollTo === "function") {
      textarea.scrollTo({ top: targetScroll, behavior: "smooth" });
    } else {
      textarea.scrollTop = targetScroll;
    }
    emitSel();
  }

  const errorMarkers = createErrorMarkersController({
    enableGlobalRuler,
    onJump: goToFallbackLine
  });

  function syncFallbackErrorRuler() {
    const markers = errorMarkers.getMarkers(activeFileId);
    if (markers.length > 0) {
      const last = markers[markers.length - 1];
      textarea.classList.add("has-error");
      textarea.title = `Línea ${last.lineNum}: ${last.errorMessage}`;
    } else {
      textarea.classList.remove("has-error");
      textarea.title = "";
    }
    errorMarkers.syncRuler(activeFileId, Math.max(1, getFallbackLines().length));
  }

  return {
    openFile(file) {
      if (!file || file.isBinary || file.encoding === "base64") {
        return;
      }
      activeFileId = file.id;
      activeLang = file.lang;
      if (mountEl && !mountEl.contains(textarea)) {
        mountEl.appendChild(textarea);
      }
      textarea.value = file.content;
      fallbackAutocompleteBar.hide();
      syncFallbackErrorRuler();
      fallbackMinimap?.render();
      fallbackMinimap?.updateSlider();
      onSelectionChange?.({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
    },
    clearActiveFile() {
      activeFileId = null;
      textarea.value = "";
      fallbackAutocompleteBar.hide();
      this.clearErrorMarkers();
      onSelectionChange?.({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
    },
    dropFileState(fileId) {
      errorMarkers.dropFile(fileId);
      if (activeFileId === fileId) {
        activeFileId = null;
        textarea.value = "";
        this.clearErrorMarkers();
        onSelectionChange?.({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
      }
    },
    purgeViewDocument() {
      textarea.value = "";
      cachedLineText = null;
      cachedLines = [];
    },
    renameFileStates(oldPath, newPath, isFolder) {
      errorMarkers.renamePaths(oldPath, newPath, isFolder);
      if (!activeFileId) return;
      if (activeFileId === oldPath) {
        activeFileId = newPath;
      } else if (isFolder && activeFileId.startsWith(`${oldPath}/`)) {
        activeFileId = `${newPath}${activeFileId.slice(oldPath.length)}`;
      } else {
        return;
      }
      activeLang = inferFileMeta(activeFileId).lang;
    },
    insertAtCursor: insertInTextarea,
    replaceSelection(text, contextHint = null) {
      const start = textarea.selectionStart ?? 0;
      const end = textarea.selectionEnd ?? 0;
      if (start < end) {
        insertInTextarea(text, 0);
        return;
      }
      const before = textarea.value.slice(0, end);
      const lastNl = before.lastIndexOf("\n");
      const cursorLine = lastNl === -1 ? 1 : before.split("\n").length;
      const smart = computeSmartReplacement(textarea.value, text, {
        cursorLine,
        selectionFrom: start,
        selectionTo: end,
        contextHint
      });
      if (smart.mode === "full") {
        textarea.value = smart.insertedText;
        textarea.setSelectionRange(0, 0);
      } else {
        textarea.value = smart.text;
        textarea.setSelectionRange(smart.from, smart.from + smart.insertedText.length);
      }
      if (activeFileId) onDocChange(activeFileId, textarea.value);
      emitSel();
    },
    replaceEntireDocument(text, { preserveCursorLine = false } = {}) {
      let prevLine = 1;
      if (preserveCursorLine) {
        const head = textarea.selectionStart || 0;
        prevLine = textarea.value.slice(0, head).split("\n").length;
      }
      textarea.value = text;
      let nextOffset = 0;
      if (preserveCursorLine && prevLine > 1) {
        const lines = getFallbackLines();
        const clamped = Math.max(1, Math.min(prevLine, lines.length));
        for (let i = 0; i < clamped - 1; i += 1) {
          nextOffset += lines[i].length + 1;
        }
      }
      textarea.setSelectionRange(nextOffset, nextOffset);
      if (activeFileId) {
        onDocChange?.(activeFileId, text);
      }
      emitSel();
    },
    replaceCode(text, forceWholeDoc = false, contextHint = null) {
      if (forceWholeDoc) {
        this.replaceEntireDocument(text);
      } else {
        this.replaceSelection(text, contextHint);
      }
    },
    addErrorMarker(lineNum, errorMessage) {
      const { marker } = errorMarkers.addMarker(activeFileId, lineNum, errorMessage);
      const lines = getFallbackLines();
      const boundedLine = Math.min(marker.lineNum, lines.length);
      let offset = 0;
      for (let i = 0; i < boundedLine - 1; i++) {
        offset += lines[i].length + 1;
      }
      textarea.setSelectionRange(offset, offset);
      syncFallbackErrorRuler();
    },
    clearErrorMarkers() {
      errorMarkers.clearFile(activeFileId);
      syncFallbackErrorRuler();
    },
    getErrorMarkers() {
      return errorMarkers.getMarkers(activeFileId);
    },
    goToLine: goToFallbackLine,
    triggerUndo() {
      textarea.focus();
      document.execCommand?.("undo");
    },
    triggerRedo() {
      textarea.focus();
      document.execCommand?.("redo");
    },
    triggerSearch() {
      textarea.focus();
    },
    toggleWordWrap() {
      wordWrap = !wordWrap;
      textarea.wrap = wordWrap ? "soft" : "off";
      saveStoredValue(prefKeys.wordWrap, String(wordWrap));
      return wordWrap;
    },
    isWordWrapEnabled: () => wordWrap,
    stepFontSize(delta) {
      fontSize = clampFontSize(fontSize + delta);
      saveStoredValue(prefKeys.fontSize, String(fontSize));
      applyFontSize(fontSize);
      return fontSize;
    },
    getFontSize: () => fontSize,
    toggleMinimap: (force) => fallbackMinimap?.toggle(force),
    isMinimapVisible: () => (fallbackMinimap ? fallbackMinimap.isVisible() : false),
    setHardwareKeyboardMode(nextState) {
      hardwareKeyboard = Boolean(nextState);
      saveStoredValue(prefKeys.hardwareKeyboard, String(hardwareKeyboard));
      applyHardwareKeyboardAttributes(hardwareKeyboard, textarea);
      return hardwareKeyboard;
    },
    toggleHardwareKeyboardMode() {
      return this.setHardwareKeyboardMode(!hardwareKeyboard);
    },
    isHardwareKeyboardMode: () => hardwareKeyboard,
    getActiveFileId: () => activeFileId,
    getValue: () => (textarea ? textarea.value : ""),
    getCompletions: (prefix) => {
      const query = prefix !== undefined
        ? prefix
        : extractWordBeforeCursor(textarea.value, textarea.selectionEnd ?? textarea.value.length).word;
      return getLanguageCompletions(activeLang, query, textarea.value);
    },
    acceptTopCompletion: () => {
      if (!fallbackAutocompleteBar.isOpen()) {
        refreshFallbackAutocomplete();
      }
      return fallbackAutocompleteBar.acceptCurrent();
    },
    syncDoc: (fileId, newContent) => {
      if (activeFileId === fileId && textarea) {
        if (textarea.value !== newContent) {
          textarea.value = newContent;
        }
      }
    },
    focus: () => textarea?.focus(),
    destroy() {
      listenerController?.abort();
      errorMarkers.destroy();
      fallbackAutocompleteBar.destroy();
      fallbackMinimap?.destroy?.();
      cachedLineText = null;
      cachedLines = [];
      textarea.value = "";
      if (mountEl) mountEl.innerHTML = "";
      activeFileId = null;
    }
  };
}
