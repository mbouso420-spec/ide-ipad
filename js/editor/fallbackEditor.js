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
  applyHardwareKeyboardAttributes(hardwareKeyboard, textarea, !isSplitInstance);
  textarea.wrap = wordWrap ? "soft" : "off";
  if (mountEl) {
    mountEl.innerHTML = "";
    mountEl.appendChild(textarea);
  }

  // Caché ligero de líneas para navegación/errores y muestreo directo sin split masivo para el minimapa
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

  function sampleFallbackDocLines(maxSamples) {
    const val = textarea ? textarea.value : "";
    const len = val.length;
    if (!len) return { totalLines: 1, samples: [] };
    let totalLines = 1;
    for (let pos = val.indexOf("\n"); pos !== -1; pos = val.indexOf("\n", pos + 1)) {
      totalLines += 1;
    }
    const targetSamples = Math.max(1, Math.min(totalLines, Number(maxSamples) || 200));
    const step = totalLines > targetSamples * 2 ? Math.max(1, Math.floor(totalLines / targetSamples)) : 1;
    const samples = [];
    let lineIdx = 0;
    let lineStart = 0;
    while (lineStart <= len) {
      const nlIdx = val.indexOf("\n", lineStart);
      const lineEnd = nlIdx === -1 ? len : nlIdx;
      if (lineIdx % step === 0) {
        const textEnd = lineEnd > lineStart && val.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
        samples.push({ index: lineIdx, text: val.slice(lineStart, textEnd) });
      }
      if (nlIdx === -1) break;
      lineStart = nlIdx + 1;
      lineIdx += 1;
    }
    return { totalLines, samples };
  }

  const fallbackMinimap = enableMinimap
    ? createMinimapController({
        mountEl: minimapParent || mountEl,
        sampleDocLines: sampleFallbackDocLines,
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
    if (!enableAutocomplete) return;
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
    const val = textarea.value;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const lastNl = end > 0 ? val.lastIndexOf("\n", end - 1) : -1;
    let cursorLine = 1;
    for (let i = 0; i <= lastNl; i++) {
      if (val.charCodeAt(i) === 10) cursorLine += 1;
    }
    const cursorCol = lastNl === -1 ? end + 1 : end - lastNl;

    if (start === end) {
      onSelectionChange({ text: "", lineCount: 0, cursorLine, cursorCol });
      return;
    }
    const text = val.slice(start, end);
    let selLines = 1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) selLines += 1;
    }
    onSelectionChange({ text, lineCount: selLines, cursorLine, cursorCol });
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
    fallbackMinimap?.render();
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

  function clearErrorMarkers() {
    errorMarkers.clearFile(activeFileId);
    syncFallbackErrorRuler();
  }

  function setHardwareKeyboardMode(nextState) {
    hardwareKeyboard = Boolean(nextState);
    saveStoredValue(prefKeys.hardwareKeyboard, String(hardwareKeyboard));
    applyHardwareKeyboardAttributes(hardwareKeyboard, textarea, !isSplitInstance);
    return hardwareKeyboard;
  }

  function replaceSelection(text, contextHint = null) {
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
    fallbackMinimap?.render();
    emitSel();
  }

  function replaceEntireDocument(text, { preserveCursorLine = false } = {}) {
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
    fallbackMinimap?.render();
    emitSel();
  }

  return {
    openFile(file) {
      if (!file || file.isBinary || file.encoding === "base64") {
        return;
      }
      activeFileId = file.id;
      activeLang = file.lang || inferFileMeta(file.id).lang || "js";
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
      clearErrorMarkers();
      fallbackMinimap?.render();
      fallbackMinimap?.updateSlider();
      onSelectionChange?.({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
    },
    dropFileState(fileId, isFolder = false) {
      errorMarkers.dropFile(fileId, isFolder);
      const affectsActive =
        activeFileId === fileId ||
        Boolean(isFolder && typeof fileId === "string" && fileId && activeFileId?.startsWith(`${fileId}/`));
      if (affectsActive) {
        activeFileId = null;
        textarea.value = "";
        fallbackAutocompleteBar.hide();
        clearErrorMarkers();
        fallbackMinimap?.render();
        fallbackMinimap?.updateSlider();
        onSelectionChange?.({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
      }
    },
    purgeViewDocument() {
      fallbackAutocompleteBar.hide();
      textarea.value = "";
      cachedLineText = null;
      cachedLines = [];
      fallbackMinimap?.render();
      fallbackMinimap?.updateSlider();
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
    replaceSelection,
    replaceEntireDocument,
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
    clearErrorMarkers,
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
    setHardwareKeyboardMode,
    toggleHardwareKeyboardMode() {
      return setHardwareKeyboardMode(!hardwareKeyboard);
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
          const prevStart = Math.min(textarea.selectionStart ?? 0, newContent.length);
          const prevEnd = Math.min(textarea.selectionEnd ?? prevStart, newContent.length);
          const prevScrollTop = textarea.scrollTop;
          textarea.value = newContent;
          try {
            textarea.setSelectionRange(prevStart, prevEnd);
          } catch (_) {
            /* entorno sin soporte */
          }
          textarea.scrollTop = prevScrollTop;
          fallbackMinimap?.render();
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
