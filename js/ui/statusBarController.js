import { isBinaryFile } from "../storage/fileImport.js";

/**
 * Controlador de la barra de estado inferior, indicador de red, etiqueta de contexto del asistente
 * y sincronización del estado de botones de la barra de herramientas del editor.
 */
export function createStatusBarController({
  editor,
  getActiveFile,
  getActiveSelection
}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = controller ? { signal: controller.signal } : undefined;

  const contextStatusEl = document.getElementById("chat-context-status");
  const contextFileEl = document.getElementById("chat-context-filename");
  const btnUndo = document.getElementById("btn-editor-undo");
  const btnRedo = document.getElementById("btn-editor-redo");
  const btnSearch = document.getElementById("btn-editor-search");
  const btnWrap = document.getElementById("btn-editor-wrap");
  const btnMinimap = document.getElementById("btn-editor-minimap");
  const btnExportFile = document.getElementById("btn-export-file");
  const zoomReadoutEl = document.getElementById("editor-zoom-readout");

  const statusFilePathEl = document.getElementById("status-file-path");
  const statusFileLangEl = document.getElementById("status-file-lang");
  const statusCursorPosEl = document.getElementById("status-cursor-pos");
  const statusNetworkEl = document.getElementById("status-network-state");

  function syncWordWrapPressed(enabled = editor?.isWordWrapEnabled?.()) {
    if (btnWrap && enabled !== undefined) {
      btnWrap.setAttribute("aria-pressed", String(Boolean(enabled)));
    }
  }

  function syncMinimapPressed(visible = editor?.isMinimapVisible?.()) {
    if (btnMinimap && visible !== undefined) {
      btnMinimap.setAttribute("aria-pressed", String(Boolean(visible)));
    }
  }

  function syncZoomReadout(size = editor?.getFontSize?.()) {
    if (zoomReadoutEl && size !== undefined) {
      zoomReadoutEl.textContent = `${size}px`;
    }
  }

  function syncToolbarState() {
    syncWordWrapPressed();
    syncMinimapPressed();
    syncZoomReadout();
  }

  function setEditorToolbarDisabled(disabled, isBinary = false) {
    if (btnUndo) btnUndo.disabled = disabled || isBinary;
    if (btnRedo) btnRedo.disabled = disabled || isBinary;
    if (btnSearch) btnSearch.disabled = disabled || isBinary;
    if (btnExportFile) btnExportFile.disabled = disabled;
    if (btnWrap) btnWrap.disabled = disabled || isBinary;
    if (btnMinimap) btnMinimap.disabled = disabled || isBinary;
  }

  function updateNetworkIndicator() {
    if (!statusNetworkEl) return;
    const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
    statusNetworkEl.textContent = isOnline ? "En línea" : "Sin conexión";
    statusNetworkEl.classList.toggle("is-offline", !isOnline);
  }

  function updateStatusBar() {
    const activeFile = getActiveFile?.() || null;
    const activeSelection = getActiveSelection?.() || { lineCount: 0, cursorLine: 1, cursorCol: 1 };

    if (!activeFile) {
      if (statusFilePathEl) statusFilePathEl.textContent = "Sin archivo abierto";
      if (statusFileLangEl) statusFileLangEl.textContent = "—";
      if (statusCursorPosEl) statusCursorPosEl.textContent = "—";
    } else if (isBinaryFile(activeFile)) {
      if (statusFilePathEl) statusFilePathEl.textContent = activeFile.path;
      if (statusFileLangEl) statusFileLangEl.textContent = activeFile.badge || "BIN";
      if (statusCursorPosEl) statusCursorPosEl.textContent = "Binario (Solo lectura)";
    } else {
      if (statusFilePathEl) statusFilePathEl.textContent = activeFile.path;
      if (statusFileLangEl) statusFileLangEl.textContent = activeFile.badge;
      const line = activeSelection.cursorLine || 1;
      const col = activeSelection.cursorCol || 1;
      const selSuffix =
        activeSelection.lineCount > 0 ? ` (${activeSelection.lineCount} sel.)` : "";
      if (statusCursorPosEl) {
        statusCursorPosEl.textContent = `Línea ${line}, Col ${col}${selSuffix}`;
      }
    }
    updateNetworkIndicator();
  }

  function updateAssistantContextLabel() {
    const activeFile = getActiveFile?.() || null;
    const activeSelection = getActiveSelection?.() || { lineCount: 0 };

    if (!activeFile) {
      if (contextStatusEl) contextStatusEl.textContent = "Sin archivo activo";
      if (contextFileEl) contextFileEl.textContent = "Ninguno";
      return;
    }

    if (isBinaryFile(activeFile)) {
      if (contextStatusEl) contextStatusEl.textContent = "Recurso binario (no editable)";
      if (contextFileEl) contextFileEl.textContent = activeFile.shortName;
      return;
    }

    if (activeSelection.lineCount > 0) {
      const label =
        activeSelection.lineCount === 1
          ? "1 línea seleccionada"
          : `${activeSelection.lineCount} líneas seleccionadas`;
      if (contextStatusEl) contextStatusEl.textContent = label;
    } else {
      if (contextStatusEl) contextStatusEl.textContent = "Leyendo archivo activo";
    }

    if (contextFileEl) {
      contextFileEl.textContent = activeFile.shortName;
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("online", updateNetworkIndicator, listenOpts);
    window.addEventListener("offline", updateNetworkIndicator, listenOpts);
  }

  return {
    updateStatusBar,
    updateNetworkIndicator,
    updateAssistantContextLabel,
    syncToolbarState,
    setEditorToolbarDisabled,
    syncWordWrapPressed,
    syncMinimapPressed,
    syncZoomReadout,
    destroy() {
      controller?.abort();
    }
  };
}
