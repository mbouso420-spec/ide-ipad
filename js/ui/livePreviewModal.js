import { normalizePath } from "../storage/workspaceDb.js";
import { redactSensitiveTokens } from "../security/credentialGuard.js";
import { instrumentLoops } from "../preview/loopGuard.js";
import { isBlockedPreviewUrlScheme } from "../preview/previewUtils.js";
import { buildSqlRunnerPreview } from "../preview/sqlRunner.js";
import { mountCRunnerView } from "../preview/cRunner.js";

const ACORN_URL = "https://esm.sh/acorn@8.14.0";
let acornModule = null;
let acornLoading = null;

/** Carga (una sola vez) el analizador de JS usado para proteger los bucles. Sin red, la vista previa sigue sin protección. */
function loadAcorn() {
  if (!acornLoading) {
    acornLoading = Promise.race([
      import(ACORN_URL),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("timeout")), 5000))
    ])
      .then((mod) => {
        acornModule = mod && typeof mod.parse === "function" ? mod : null;
        return acornModule;
      })
      .catch(() => {
        acornLoading = null; // reintentar la próxima vez que se abra la vista previa
        return null;
      });
  }
  return acornLoading;
}

/** Inserta el guardián de bucles si el analizador está disponible. */
function guardJs(code, isModule = false) {
  if (!acornModule) return code;
  return instrumentLoops(code, acornModule, { module: isModule }).code;
}

import {
  HTML_EXTENSIONS,
  JS_EXTENSIONS,
  CSS_EXTENSIONS,
  PYTHON_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  SQL_EXTENSIONS,
  C_EXTENSIONS,
  CPP_EXTENSIONS,
  RUST_EXTENSIONS,
  GO_EXTENSIONS,
  JAVA_EXTENSIONS,
  CSHARP_EXTENSIONS,
  TS_EXTENSIONS,
  IGNORED_PREVIEW_DIRS,
  getFileExtension,
  getParentFolder,
  filterFolderScopeFiles,
  buildWorkspaceAssetMap,
  extractReferencedAssetPaths,
  extractCssImportPaths,
  extractModuleDependencyPaths,
  getSavedPreviewHtml,
  savePreviewHtml,
  findBestHtmlEntrypoint,
  findTargetHtmlFile,
  bundleHtmlWithFolderAssets,
  buildStandaloneJsPreview,
  buildStandaloneTsPreview,
  buildStandalonePythonPreview,
  buildMarkdownPreview,
  IMAGE_EXTENSIONS,
  buildStandaloneImagePreview
} from "../preview/htmlBundler.js";

export * from "../preview/htmlBundler.js";

/**
 * Vista previa contextual según la pestaña activa:
 * - Si la pestaña es .html -> "Vista previa de HTML" (ensambla CSS y JS de su misma carpeta/subcarpetas).
 * - Si la pestaña es .js   -> "Vista previa de JS" (ejecuta el JS mostrando su salida en pantalla y consola,
 *                             o junto al HTML de su misma carpeta si forman un proyecto web conjunto).
 * - Si la pestaña es .py   -> "Vista previa de Python" (ejecuta Python 3 real en el navegador vía Pyodide WebAssembly,
 *                             incluyendo módulos .py vecinos de su misma carpeta, print() e input()).
 * - Si la pestaña es .css  -> "Vista previa de CSS" (aplica sobre el HTML de su misma carpeta si existe).
 * - Cualquier otro archivo (.c, .cpp, .sql, etc.) -> informa claramente que la vista previa no está disponible.
 */
export function initLivePreviewModal({
  getWorkspaceSnapshot,
  onBeforePreview,
  onErrorMarker,
  onClearErrorMarkers,
  onGoToLine,
  ensureFileLoaded,
  ensureFilesLoaded
}) {
  const openBtn = document.getElementById("btn-live-preview");
  const dialog = document.getElementById("preview-dialog");
  const titleEl = document.getElementById("preview-dialog-title");
  const fileBadgeEl = document.getElementById("preview-file-badge");
  const jsModeBtn = document.getElementById("btn-preview-js-mode");
  const closeBtn = document.getElementById("btn-close-preview");
  const reloadBtn = document.getElementById("btn-preview-reload");
  const toggleConsoleBtn = document.getElementById("btn-preview-console");
  const clearConsoleBtn = document.getElementById("btn-preview-clear-console");
  const unavailableBox = document.getElementById("preview-unavailable-state");
  const unavailableTitleEl = document.getElementById("preview-unavailable-title");
  const unavailableDescEl = document.getElementById("preview-unavailable-desc");
  const consolePanel = document.getElementById("preview-console-panel");
  const consoleTitleEl = document.getElementById("preview-console-title");
  const consoleList = document.getElementById("preview-console-list");
  const replForm = document.getElementById("preview-repl-form");
  const replInput = document.getElementById("preview-repl-input");
  const iframeWrapper = document.getElementById("preview-iframe-wrapper");
  const iframe = document.getElementById("preview-iframe");
  const cRunnerContainer = document.getElementById("preview-c-runner");
  const pageSelect = document.getElementById("preview-page-select");
  const backBtn = document.getElementById("btn-preview-back");
  const forwardBtn = document.getElementById("btn-preview-forward");
  const navControls = dialog?.querySelector(".preview-nav-controls");

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = controller ? { signal: controller.signal } : undefined;

  let consoleVisible = true;
  let hasControlledSrcdoc = false;
  let expectingControlledLoad = false;
  let idleAcornHandle = null;
  let idleAcornUsesIdleApi = false;
  let previewRunSeq = 0;
  let renderSeq = 0;
  let currentPreviewPath = null;
  let activePreviewExt = "";
  /** @type {"auto" | "standalone" | "folder"} */
  let jsRunOverride = "auto";
  /** @type {"auto" | "browser" | "compiler"} */
  let tsRunOverride = "auto";
  /** @type {"auto" | "standalone" | "folder"} */
  let imageRunOverride = "auto";
  let activeCRunnerDestroy = null;
  const replHistory = [];
  let replHistoryIdx = -1;

  let historyStack = [];
  let historyIndex = -1;

  function updateNavButtons() {
    if (backBtn) backBtn.disabled = historyIndex <= 0;
    if (forwardBtn) forwardBtn.disabled = historyIndex >= historyStack.length - 1;
  }

  function hideWebNavigationControls() {
    if (pageSelect) pageSelect.hidden = true;
    if (navControls) navControls.hidden = true;
  }

  function syncPageSelect(allFiles, activeHtmlPath) {
    if (!pageSelect) return;
    const validHtmlFiles = (allFiles || []).filter((f) => {
      if (!f || !f.path) return false;
      const clean = normalizePath(f.path);
      const parts = clean.split("/");
      for (const part of parts) {
        if (IGNORED_PREVIEW_DIRS.has(part.toLowerCase())) return false;
      }
      const ext = getFileExtension(f.path);
      return HTML_EXTENSIONS.has(ext);
    });

    const uniqueMap = new Map();
    for (const hf of validHtmlFiles) {
      const clean = normalizePath(hf.path);
      if (!uniqueMap.has(clean)) {
        uniqueMap.set(clean, hf);
      }
    }
    const htmlFiles = Array.from(uniqueMap.values());

    if (htmlFiles.length === 0) {
      hideWebNavigationControls();
      return;
    }

    const nameCount = new Map();
    for (const hf of htmlFiles) {
      const base = hf.path.split("/").pop();
      nameCount.set(base, (nameCount.get(base) || 0) + 1);
    }

    pageSelect.innerHTML = "";
    for (const hf of htmlFiles) {
      const opt = document.createElement("option");
      opt.value = hf.path;
      const base = hf.path.split("/").pop();
      opt.textContent = (nameCount.get(base) > 1 || hf.path.includes("/")) ? hf.path : base;
      if (normalizePath(hf.path) === normalizePath(activeHtmlPath)) {
        opt.selected = true;
      }
      pageSelect.appendChild(opt);
    }

    pageSelect.hidden = false;
    if (navControls) navControls.hidden = false;
  }

  pageSelect?.addEventListener("change", () => {
    if (pageSelect.value) {
      const snap = getWorkspaceSnapshot();
      savePreviewHtml(snap?.projectId, pageSelect.value);
      void navigateToHtml(pageSelect.value, true);
    }
  }, listenOpts);

  backBtn?.addEventListener("click", () => {
    if (historyIndex > 0) {
      historyIndex -= 1;
      void navigateToHtml(historyStack[historyIndex], false);
    }
  }, listenOpts);

  forwardBtn?.addEventListener("click", () => {
    if (historyIndex < historyStack.length - 1) {
      historyIndex += 1;
      void navigateToHtml(historyStack[historyIndex], false);
    }
  }, listenOpts);

  const MAX_TRANSITIVE_DEPS = 250;

  function isFileContentUnloaded(file) {
    return Boolean(
      file &&
      (file.isLoaded === false ||
        file.contentLoaded === false ||
        (file.content === "" && Boolean(file.blobSha)))
    );
  }

  function buildFilesByNormPathMap(allFiles) {
    const map = new Map();
    for (const f of allFiles || []) {
      if (f && f.path) {
        map.set(normalizePath(f.path), f);
      }
    }
    return map;
  }

  function collectDirectDependencies(file, allFiles) {
    if (!file || typeof file.content !== "string") return [];
    const ext = getFileExtension(file.path);
    if (HTML_EXTENSIONS.has(ext)) {
      return extractReferencedAssetPaths(file.path, file.content);
    }
    if (ext === "css") {
      return extractCssImportPaths(file.path, file.content);
    }
    if (JS_EXTENSIONS.has(ext) || TS_EXTENSIONS.has(ext) || ext === "jsx") {
      return extractModuleDependencyPaths(file.path, file.content, allFiles, {
        allowParentTraversal: true
      });
    }
    return [];
  }

  async function loadTransitiveDependencies(seedFiles, allFiles) {
    const filesByNormPath = buildFilesByNormPathMap(allFiles);
    const visited = new Set();
    let wave = [];

    for (const f of seedFiles || []) {
      if (!f || !f.path) continue;
      const norm = normalizePath(f.path);
      if (visited.has(norm)) continue;
      visited.add(norm);
      wave.push(f);
    }

    while (wave.length > 0) {
      const unloaded = wave.filter(isFileContentUnloaded);
      if (unloaded.length > 0) {
        if (typeof ensureFilesLoaded === "function") {
          await ensureFilesLoaded(unloaded);
        } else if (typeof ensureFileLoaded === "function") {
          await Promise.all(unloaded.map((f) => ensureFileLoaded(f)));
        }
      }

      const nextWave = [];
      for (const loadedFile of wave) {
        if (visited.size >= MAX_TRANSITIVE_DEPS) break;
        const depPaths = collectDirectDependencies(loadedFile, allFiles);
        for (const depPath of depPaths) {
          const norm = normalizePath(depPath);
          if (visited.has(norm)) continue;
          const depFile = filesByNormPath.get(norm);
          if (!depFile) continue;
          visited.add(norm);
          nextWave.push(depFile);
          if (visited.size >= MAX_TRANSITIVE_DEPS) break;
        }
      }
      wave = nextWave;
    }
  }

  async function prepareHtmlForPreview(targetFile, allFiles) {
    if (!targetFile) return { html: "", assetMap: new Map() };

    // 1. Si el HTML está pendiente de descarga bajo demanda (lazy en GitHub), descargarlo primero
    if (isFileContentUnloaded(targetFile) && typeof ensureFileLoaded === "function") {
      await ensureFileLoaded(targetFile);
    }

    // 2. Descargar transitivamente todas las dependencias locales (HTML -> CSS -> @import / JS/TS)
    await loadTransitiveDependencies([targetFile], allFiles);

    // 3. Construir mapa de assets del proyecto completo
    const assetMap = buildWorkspaceAssetMap(allFiles);
    return {
      html: targetFile.content || "",
      assetMap
    };
  }

  async function ensureStandaloneDepsLoaded(activeFile, allFiles) {
    if (!activeFile) return;
    if (isFileContentUnloaded(activeFile) && typeof ensureFileLoaded === "function") {
      await ensureFileLoaded(activeFile);
    }
    await loadTransitiveDependencies([activeFile], allFiles);
  }

  async function navigateToHtml(targetPath, pushHistory = true) {
    const seq = ++renderSeq;
    const { files, projectId } = getWorkspaceSnapshot();
    const targetFile = files.find((f) => normalizePath(f.path) === normalizePath(targetPath));
    if (!targetFile) return;

    currentPreviewPath = targetFile.path;
    savePreviewHtml(projectId, targetFile.path);

    if (pushHistory) {
      if (historyIndex < historyStack.length - 1) {
        historyStack = historyStack.slice(0, historyIndex + 1);
      }
      historyStack.push(targetFile.path);
      historyIndex = historyStack.length - 1;
    }
    updateNavButtons();
    syncPageSelect(files, targetFile.path);

    const { html, assetMap } = await prepareHtmlForPreview(targetFile, files);
    if (seq !== renderSeq) return;
    const compiledHtml = bundleHtmlWithFolderAssets(targetFile.path, html, assetMap, null, guardJs, null, true);

    showRunnableIframe({
      headerTitle: "Vista previa de HTML",
      badgeText: targetFile.path,
      compiledHtml,
      siblingHtml: null
    });
  }

  const deviceButtons = dialog?.querySelectorAll(".preview-device-btn") || [];
  deviceButtons.forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.classList.contains("is-active")));
    btn.addEventListener("click", () => {
      const device = btn.getAttribute("data-device") || "desktop";
      deviceButtons.forEach((b) => {
        const isSelected = b === btn;
        b.classList.toggle("is-active", isSelected);
        b.setAttribute("aria-checked", String(isSelected));
      });
      if (iframe) {
        iframe.className = `preview-iframe device-${device}`;
      }
    }, listenOpts);
  });

  // Precargar el analizador Acorn en segundo plano para tener el guardián listo de inmediato
  if (typeof window !== "undefined") {
    if (typeof window.requestIdleCallback === "function") {
      idleAcornUsesIdleApi = true;
      idleAcornHandle = window.requestIdleCallback(() => void loadAcorn());
    } else {
      idleAcornUsesIdleApi = false;
      idleAcornHandle = window.setTimeout(() => void loadAcorn(), 1500);
    }
  }

  openBtn?.addEventListener("click", async () => {
    jsRunOverride = "auto";
    tsRunOverride = "auto";
    imageRunOverride = "auto";
    await loadAcorn();
    await openPreview();
  }, listenOpts);

  closeBtn?.addEventListener("click", () => {
    renderSeq += 1;
    stopIframe();
    dialog?.close();
  }, listenOpts);

  dialog?.addEventListener("close", () => {
    renderSeq += 1;
    stopIframe();
  }, listenOpts);

  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      renderSeq += 1;
      stopIframe();
      dialog.close();
    }
  }, listenOpts);

  jsModeBtn?.addEventListener("click", () => {
    if (TS_EXTENSIONS.has(activePreviewExt)) {
      tsRunOverride = tsRunOverride === "compiler" ? "browser" : "compiler";
    } else if (IMAGE_EXTENSIONS.has(activePreviewExt)) {
      imageRunOverride = imageRunOverride === "folder" ? "standalone" : "folder";
    } else {
      jsRunOverride = jsRunOverride === "folder" ? "standalone" : "folder";
    }
    void renderActiveTabPreview();
  }, listenOpts);

  replForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = String(replInput?.value || "").trim();
    if (!code || !iframe?.contentWindow || !hasControlledSrcdoc) return;
    if (replHistory[replHistory.length - 1] !== code) {
      replHistory.push(code);
      if (replHistory.length > 50) replHistory.shift();
    }
    replHistoryIdx = replHistory.length;
    iframe.contentWindow.postMessage(
      { source: "studio-ide-repl", action: "eval", code },
      "*"
    );
    if (replInput) replInput.value = "";
  }, listenOpts);

  replInput?.addEventListener("keydown", (event) => {
    if (replHistory.length === 0) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (replHistoryIdx < 0 || replHistoryIdx > replHistory.length) {
        replHistoryIdx = replHistory.length;
      }
      replHistoryIdx = Math.max(0, replHistoryIdx - 1);
      replInput.value = replHistory[replHistoryIdx] || "";
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      replHistoryIdx = Math.min(replHistory.length, replHistoryIdx + 1);
      replInput.value = replHistoryIdx < replHistory.length ? replHistory[replHistoryIdx] : "";
    }
  }, listenOpts);

  reloadBtn?.addEventListener("click", () => {
    void renderActiveTabPreview();
  }, listenOpts);

  toggleConsoleBtn?.addEventListener("click", () => {
    consoleVisible = !consoleVisible;
    if (consolePanel && !iframe?.hidden) {
      consolePanel.hidden = !consoleVisible;
    }
    toggleConsoleBtn.setAttribute("aria-pressed", String(consoleVisible));
  }, listenOpts);

  clearConsoleBtn?.addEventListener("click", () => {
    clearConsoleOutput();
  }, listenOpts);

  iframe?.addEventListener("load", () => {
    if (expectingControlledLoad) {
      expectingControlledLoad = false;
      return;
    }
    // Navegación inesperada dentro del sandbox: invalidar confianza en el documento activo
    hasControlledSrcdoc = false;
  }, listenOpts);

  window.addEventListener("message", (event) => {
    if (event.origin !== "null") {
      return;
    }
    const data = event.data;
    if (!data || data.source !== "studio-ide-preview") {
      return;
    }
    if (!iframe || !hasControlledSrcdoc || event.source !== iframe.contentWindow) {
      return;
    }
    if (data.action === "clear") {
      clearConsoleOutput();
      return;
    }
    if (data.action === "navigate" && typeof data.href === "string") {
      handlePreviewNavigation(data.href);
      return;
    }
    appendConsoleLine(data.level || "log", data.text || "");
  }, listenOpts);

  function handlePreviewNavigation(href) {
    if (isBlockedPreviewUrlScheme(href)) {
      appendConsoleLine("warn", "Navegación bloqueada por política de seguridad.");
      return;
    }
    const { files } = getWorkspaceSnapshot();
    const targetFile = findTargetHtmlFile(files, currentPreviewPath, href);
    if (!targetFile) {
      appendConsoleLine("warn", `No se encontró "${href}" en el proyecto (navegación desde "${currentPreviewPath || 'raíz'}").`);
      return;
    }

    navigateToHtml(targetFile.path, true);
  }

  function stopIframe() {
    hasControlledSrcdoc = false;
    expectingControlledLoad = false;
    if (iframe) {
      iframe.srcdoc = "";
    }
    if (activeCRunnerDestroy && typeof activeCRunnerDestroy === "function") {
      activeCRunnerDestroy();
      activeCRunnerDestroy = null;
    }
  }

  function clearConsoleOutput() {
    if (!consoleList) return;
    consoleList.innerHTML = "";
  }

  const MAX_CONSOLE_LINES = 500;
  const MAX_CONSOLE_LINE_CHARS = 10000;

  function appendConsoleLine(level, text) {
    if (!consoleList) return;
    while (consoleList.children.length >= MAX_CONSOLE_LINES && consoleList.firstElementChild) {
      consoleList.removeChild(consoleList.firstElementChild);
    }
    const rawStr = redactSensitiveTokens(String(text ?? ""));
    const safeText =
      rawStr.length > MAX_CONSOLE_LINE_CHARS
        ? `${rawStr.slice(0, MAX_CONSOLE_LINE_CHARS)}… [truncado]`
        : rawStr;
    const item = document.createElement("div");
    item.className =
      level === "error"
        ? "preview-log-item is-error"
        : level === "warn"
          ? "preview-log-item is-warn"
          : "preview-log-item";
    item.textContent = safeText;
    consoleList.appendChild(item);
    consoleList.scrollTop = consoleList.scrollHeight;
  }

  async function openPreview() {
    if (!dialog) return;
    await loadAcorn();
    if (typeof onBeforePreview === "function") {
      try {
        await onBeforePreview();
      } catch (_) {}
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    await renderActiveTabPreview();
  }

  function showUnavailableState({ headerTitle, badgeText, messageTitle, messageDesc }) {
    stopIframe();
    clearConsoleOutput();
    hideWebNavigationControls();

    if (titleEl) titleEl.textContent = headerTitle;
    if (fileBadgeEl) {
      fileBadgeEl.textContent = badgeText || "";
      fileBadgeEl.hidden = !badgeText;
    }
    if (jsModeBtn) jsModeBtn.hidden = true;
    if (reloadBtn) reloadBtn.hidden = true;
    if (toggleConsoleBtn) toggleConsoleBtn.hidden = true;
    if (iframe) iframe.hidden = true;
    if (iframeWrapper) iframeWrapper.hidden = true;
    if (cRunnerContainer) cRunnerContainer.hidden = true;
    if (consolePanel) consolePanel.hidden = true;
    if (replForm) replForm.hidden = true;

    if (unavailableTitleEl) unavailableTitleEl.textContent = messageTitle;
    if (unavailableDescEl) unavailableDescEl.textContent = messageDesc;
    if (unavailableBox) unavailableBox.hidden = false;
  }

  function showRunnableIframe({
    headerTitle,
    badgeText,
    compiledHtml,
    siblingHtml,
    consoleTitle = "Consola JS",
    hasConsole = true,
    hasRepl = true,
    modeLabel = null
  }) {
    stopIframe();
    clearConsoleOutput();
    if (cRunnerContainer) cRunnerContainer.hidden = true;
    if (iframeWrapper) iframeWrapper.hidden = false;

    if (titleEl) titleEl.textContent = headerTitle;
    if (consoleTitleEl) consoleTitleEl.textContent = consoleTitle;
    if (fileBadgeEl) {
      fileBadgeEl.textContent = badgeText || "";
      fileBadgeEl.hidden = !badgeText;
    }

    if (unavailableBox) unavailableBox.hidden = true;
    if (reloadBtn) reloadBtn.hidden = false;
    if (toggleConsoleBtn) {
      toggleConsoleBtn.hidden = !hasConsole;
      toggleConsoleBtn.setAttribute("aria-pressed", String(consoleVisible));
    }
    if (iframe) {
      previewRunSeq += 1;
      iframe.hidden = false;
      expectingControlledLoad = true;
      hasControlledSrcdoc = true;
      iframe.srcdoc = `${compiledHtml}\n<!-- studio-run:${previewRunSeq} -->`;
    }
    if (consolePanel) {
      consolePanel.hidden = !hasConsole || !consoleVisible;
    }
    if (replForm) {
      replForm.hidden = !(hasConsole && hasRepl);
    }

    if (jsModeBtn) {
      if (modeLabel) {
        jsModeBtn.hidden = false;
        jsModeBtn.textContent = modeLabel;
      } else if (siblingHtml) {
        jsModeBtn.hidden = false;
        jsModeBtn.textContent =
          jsRunOverride === "folder"
            ? "Ejecutar solo este .js"
            : `Ver junto a ${siblingHtml.shortName}`;
      } else {
        jsModeBtn.hidden = true;
      }
    }
  }

  function showCRunnerView(activeFile, companionFiles = []) {
    stopIframe();
    clearConsoleOutput();
    hideWebNavigationControls();

    const ext = getFileExtension(activeFile.path);
    const isC = C_EXTENSIONS.has(ext);
    if (titleEl) {
      if (ext === "rs") {
        titleEl.textContent = "Compilador Rust (rustc)";
      } else if (ext === "go") {
        titleEl.textContent = "Compilador Go (golang)";
      } else if (JAVA_EXTENSIONS.has(ext)) {
        titleEl.textContent = "Compilador Java (OpenJDK)";
      } else if (CSHARP_EXTENSIONS.has(ext)) {
        titleEl.textContent = "Compilador C# (.NET)";
      } else if (TS_EXTENSIONS.has(ext)) {
        titleEl.textContent = "Compilador TypeScript";
      } else if (ext === "h" || ext === "hpp") {
        titleEl.textContent = ext === "h" ? "Cabecera C (.h)" : "Cabecera C++ (.hpp)";
      } else {
        titleEl.textContent = isC ? "Compilador C (GCC)" : "Compilador C++ (G++)";
      }
    }
    if (fileBadgeEl) {
      fileBadgeEl.textContent = activeFile.path;
      fileBadgeEl.hidden = false;
    }

    if (unavailableBox) unavailableBox.hidden = true;
    if (iframe) iframe.hidden = true;
    if (iframeWrapper) iframeWrapper.hidden = true;
    if (consolePanel) consolePanel.hidden = true;
    if (replForm) replForm.hidden = true;
    if (jsModeBtn) {
      if (TS_EXTENSIONS.has(ext)) {
        jsModeBtn.hidden = false;
        jsModeBtn.textContent = "Ejecutar offline (TS/JSX)";
      } else {
        jsModeBtn.hidden = true;
      }
    }
    if (reloadBtn) reloadBtn.hidden = false;
    if (toggleConsoleBtn) toggleConsoleBtn.hidden = true;

    if (cRunnerContainer) {
      cRunnerContainer.hidden = false;
      const runnerInstance = mountCRunnerView(cRunnerContainer, {
        activeFile,
        companionFiles,
        onCompilerResult({ success, errors }) {
          if (!success && errors && errors.length > 0) {
            if (typeof onClearErrorMarkers === "function") {
              onClearErrorMarkers();
            }
            for (const err of errors) {
              if (typeof onErrorMarker === "function") {
                onErrorMarker(err.line, err.message);
              }
            }
          } else if (success) {
            if (typeof onClearErrorMarkers === "function") {
              onClearErrorMarkers();
            }
          }
        },
        onGoToLine(lineNum) {
          stopIframe();
          dialog?.close();
          if (typeof onGoToLine === "function") {
            onGoToLine(lineNum);
          }
        }
      });
      activeCRunnerDestroy = runnerInstance?.destroy || null;
    }
  }

  async function renderActiveTabPreview() {
    const seq = ++renderSeq;
    const isStale = () => seq !== renderSeq;
    const { files, activeFileId, projectId } = getWorkspaceSnapshot();
    const activeFile = activeFileId
      ? files.find((f) => normalizePath(f.path) === normalizePath(activeFileId)) || null
      : null;

    if (!activeFile) {
      showUnavailableState({
        headerTitle: "Vista previa",
        badgeText: "",
        messageTitle: "No hay ninguna pestaña activa",
        messageDesc: "Abrí un archivo en el editor central para ver su vista previa."
      });
      return;
    }

    currentPreviewPath = activeFile.path;

    const ext = getFileExtension(activeFile.path);
    activePreviewExt = ext;
    const extLabel = ext ? `.${ext}` : "sin extensión";
    const folder = getParentFolder(activeFile.path);
    const sameFolderFiles = filterFolderScopeFiles(files, folder);

    // 1. Pestaña HTML: ensambla recursos relativos de todo el proyecto web
    if (HTML_EXTENSIONS.has(ext)) {
      currentPreviewPath = activeFile.path;
      savePreviewHtml(projectId, activeFile.path);
      historyStack = [activeFile.path];
      historyIndex = 0;
      updateNavButtons();
      syncPageSelect(files, activeFile.path);

      const { html, assetMap } = await prepareHtmlForPreview(activeFile, files);
      if (isStale()) return;
      const compiledHtml = bundleHtmlWithFolderAssets(activeFile.path, html, assetMap, null, guardJs, null, true);
      showRunnableIframe({
        headerTitle: "Vista previa de HTML",
        badgeText: activeFile.path,
        compiledHtml,
        siblingHtml: null
      });
      return;
    }

    // 2. Pestaña JS: ejecuta el archivo .js (asociado al HTML del proyecto o en sandbox aislado)
    if (JS_EXTENSIONS.has(ext)) {
      const savedHtml = getSavedPreviewHtml(projectId);
      const bestHtml = findBestHtmlEntrypoint(files, activeFile, savedHtml);

      if (jsRunOverride === "auto") {
        jsRunOverride = bestHtml ? "folder" : "standalone";
      }

      if (jsRunOverride === "folder" && bestHtml) {
        currentPreviewPath = bestHtml.path;
        historyStack = [bestHtml.path];
        historyIndex = 0;
        updateNavButtons();
        syncPageSelect(files, bestHtml.path);

        const { html, assetMap } = await prepareHtmlForPreview(bestHtml, files);
        if (isStale()) return;
        assetMap.set(normalizePath(activeFile.path), activeFile);

        const compiledHtml = bundleHtmlWithFolderAssets(
          bestHtml.path,
          html,
          assetMap,
          activeFile,
          guardJs,
          null,
          true
        );
        showRunnableIframe({
          headerTitle: "Vista previa de JS",
          badgeText: `${activeFile.path} (${bestHtml.shortName || bestHtml.path})`,
          compiledHtml,
          siblingHtml: bestHtml
        });
        return;
      }

      hideWebNavigationControls();
      await ensureStandaloneDepsLoaded(activeFile, files);
      if (isStale()) return;
      const compiledJsHtml = buildStandaloneJsPreview(activeFile, guardJs, {
        assetMap: buildWorkspaceAssetMap(files)
      });
      showRunnableIframe({
        headerTitle: "Vista previa de JS",
        badgeText: activeFile.path,
        compiledHtml: compiledJsHtml,
        siblingHtml: bestHtml
      });
      return;
    }

    // 3. Pestaña CSS: se previsualiza resolviendo de forma inteligente el HTML principal del proyecto
    if (CSS_EXTENSIONS.has(ext)) {
      const savedHtml = getSavedPreviewHtml(projectId);
      const bestHtml = findBestHtmlEntrypoint(files, activeFile, savedHtml);
      if (bestHtml) {
        currentPreviewPath = bestHtml.path;
        historyStack = [bestHtml.path];
        historyIndex = 0;
        updateNavButtons();
        syncPageSelect(files, bestHtml.path);

        const { html, assetMap } = await prepareHtmlForPreview(bestHtml, files);
        if (isStale()) return;
        assetMap.set(normalizePath(activeFile.path), activeFile);

        const compiledHtml = bundleHtmlWithFolderAssets(
          bestHtml.path,
          html,
          assetMap,
          null,
          guardJs,
          activeFile,
          true
        );
        showRunnableIframe({
          headerTitle: "Vista previa de CSS",
          badgeText: `${activeFile.path} (${bestHtml.shortName || bestHtml.path})`,
          compiledHtml,
          siblingHtml: null
        });
      } else {
        hideWebNavigationControls();
        showUnavailableState({
          headerTitle: "Vista previa de CSS",
          badgeText: activeFile.path,
          messageTitle: `No hay ningún archivo .html en el proyecto para ${activeFile.shortName}`,
          messageDesc: "Creá un archivo .html en el proyecto para ver estos estilos aplicados en vivo."
        });
      }
      return;
    }

    // Asegurar carga de activeFile y archivos compañeros de la carpeta si provienen de GitHub lazy
    if (isFileContentUnloaded(activeFile) && typeof ensureFileLoaded === "function") {
      await ensureFileLoaded(activeFile);
      if (isStale()) return;
    }
    const unloadedFolderCompanions = sameFolderFiles.filter(isFileContentUnloaded);
    if (unloadedFolderCompanions.length > 0) {
      if (typeof ensureFilesLoaded === "function") {
        await ensureFilesLoaded(unloadedFolderCompanions);
      } else if (typeof ensureFileLoaded === "function") {
        await Promise.all(unloadedFolderCompanions.map((f) => ensureFileLoaded(f)));
      }
      if (isStale()) return;
    }

    // 4. Pestaña Python: ejecuta Python 3 real en el navegador (Pyodide WebAssembly) con entrada inline sin popups
    if (PYTHON_EXTENSIONS.has(ext)) {
      hideWebNavigationControls();
      const compiledPyHtml = buildStandalonePythonPreview(activeFile, sameFolderFiles, folder);
      showRunnableIframe({
        headerTitle: "Vista previa de Python",
        badgeText: activeFile.path,
        compiledHtml: compiledPyHtml,
        siblingHtml: null,
        consoleTitle: "Consola Python",
        hasConsole: true
      });
      return;
    }

    // 5. Pestaña Markdown (.md / README.md): documento formateado limpio
    if (MARKDOWN_EXTENSIONS.has(ext)) {
      hideWebNavigationControls();
      const compiledMdHtml = buildMarkdownPreview(activeFile, buildWorkspaceAssetMap(files));
      showRunnableIframe({
        headerTitle: "Vista previa de Markdown",
        badgeText: activeFile.path,
        compiledHtml: compiledMdHtml,
        siblingHtml: null,
        hasConsole: false
      });
      return;
    }

    // 6. Pestaña SQL (.sql): base de datos SQLite interactiva en WebAssembly
    if (SQL_EXTENSIONS.has(ext)) {
      hideWebNavigationControls();
      const compiledSqlHtml = buildSqlRunnerPreview(activeFile, sameFolderFiles);
      showRunnableIframe({
        headerTitle: "Vista previa de SQL (SQLite)",
        badgeText: activeFile.path,
        compiledHtml: compiledSqlHtml,
        siblingHtml: null,
        consoleTitle: "Consola SQL",
        hasConsole: true,
        hasRepl: false
      });
      return;
    }

    // 7. TypeScript / TSX (.ts / .tsx): ejecución offline en navegador o compilador remoto
    if (TS_EXTENSIONS.has(ext)) {
      if (tsRunOverride === "compiler") {
        showCRunnerView(activeFile, sameFolderFiles);
        return;
      }
      const savedHtml = getSavedPreviewHtml(projectId);
      const bestHtml = findBestHtmlEntrypoint(files, activeFile, savedHtml);
      if (bestHtml) {
        currentPreviewPath = bestHtml.path;
        historyStack = [bestHtml.path];
        historyIndex = 0;
        updateNavButtons();
        syncPageSelect(files, bestHtml.path);

        const { html, assetMap } = await prepareHtmlForPreview(bestHtml, files);
        if (isStale()) return;
        assetMap.set(normalizePath(activeFile.path), activeFile);
        const compiledHtml = bundleHtmlWithFolderAssets(
          bestHtml.path,
          html,
          assetMap,
          activeFile,
          guardJs,
          null,
          true
        );
        showRunnableIframe({
          headerTitle: ext === "tsx" ? "Vista previa de TSX (Offline)" : "Vista previa de TypeScript (Offline)",
          badgeText: `${activeFile.path} (${bestHtml.shortName || bestHtml.path})`,
          compiledHtml,
          siblingHtml: bestHtml,
          modeLabel: "Usar compilador remoto (tsc)"
        });
        return;
      }
      hideWebNavigationControls();
      await ensureStandaloneDepsLoaded(activeFile, files);
      if (isStale()) return;
      const compiledTsHtml = buildStandaloneTsPreview(activeFile, guardJs, {
        assetMap: buildWorkspaceAssetMap(files)
      });
      showRunnableIframe({
        headerTitle: ext === "tsx" ? "Vista previa de TSX (Offline)" : "Vista previa de TypeScript (Offline)",
        badgeText: activeFile.path,
        compiledHtml: compiledTsHtml,
        siblingHtml: null,
        modeLabel: "Usar compilador remoto (tsc)"
      });
      return;
    }

    // 8. Pestaña C / C++ / Rust / Go / Java / C#: Runner nativo sin iframe
    if (
      C_EXTENSIONS.has(ext) ||
      CPP_EXTENSIONS.has(ext) ||
      RUST_EXTENSIONS.has(ext) ||
      GO_EXTENSIONS.has(ext) ||
      JAVA_EXTENSIONS.has(ext) ||
      CSHARP_EXTENSIONS.has(ext)
    ) {
      showCRunnerView(activeFile, sameFolderFiles);
      return;
    }

    // 9. Pestaña Imagen (.png, .jpg, .jpeg, .gif, .webp, .avif, .ico, .bmp, .svg)
    if (IMAGE_EXTENSIONS.has(ext)) {
      const savedHtml = getSavedPreviewHtml(projectId);
      const bestHtml = findBestHtmlEntrypoint(files, activeFile, savedHtml);

      if (imageRunOverride === "auto") {
        imageRunOverride = bestHtml ? "folder" : "standalone";
      }

      if (imageRunOverride === "folder" && bestHtml) {
        currentPreviewPath = bestHtml.path;
        historyStack = [bestHtml.path];
        historyIndex = 0;
        updateNavButtons();
        syncPageSelect(files, bestHtml.path);

        const { html, assetMap } = await prepareHtmlForPreview(bestHtml, files);
        if (isStale()) return;
        assetMap.set(normalizePath(activeFile.path), activeFile);

        const compiledHtml = bundleHtmlWithFolderAssets(
          bestHtml.path,
          html,
          assetMap,
          null,
          guardJs,
          null,
          true
        );
        showRunnableIframe({
          headerTitle: "Vista previa de Imagen en HTML",
          badgeText: `${activeFile.path} (${bestHtml.shortName || bestHtml.path})`,
          compiledHtml,
          siblingHtml: bestHtml,
          modeLabel: "Ver imagen individual"
        });
        return;
      }

      hideWebNavigationControls();
      if (isFileContentUnloaded(activeFile) && typeof ensureFileLoaded === "function") {
        await ensureFileLoaded(activeFile);
        if (isStale()) return;
      }
      const compiledImgHtml = buildStandaloneImagePreview(activeFile);
      showRunnableIframe({
        headerTitle: "Vista previa de Imagen",
        badgeText: activeFile.path,
        compiledHtml: compiledImgHtml,
        siblingHtml: bestHtml,
        modeLabel: bestHtml ? "Ver en HTML del proyecto" : ""
      });
      return;
    }

    // 10. Extensiones no soportadas
    hideWebNavigationControls();
    showUnavailableState({
      headerTitle: "Vista previa",
      badgeText: activeFile.path,
      messageTitle: `La vista previa no está disponible para este archivo ${extLabel}`,
      messageDesc: "La vista previa en vivo ejecuta archivos .html, .js, .ts, .css (en conjunto con el proyecto web), imágenes (.png, .jpg, .webp, .svg…), scripts .py de Python, bases de datos .sql de SQLite, código C/C++, Java, C# y documentos .md."
    });
  }

  return {
    openPreview,
    destroy() {
      renderSeq += 1;
      if (idleAcornHandle !== null && typeof window !== "undefined") {
        if (idleAcornUsesIdleApi && typeof window.cancelIdleCallback === "function") {
          window.cancelIdleCallback(idleAcornHandle);
        } else {
          window.clearTimeout(idleAcornHandle);
        }
        idleAcornHandle = null;
      }
      stopIframe();
      controller?.abort();
    }
  };
}
