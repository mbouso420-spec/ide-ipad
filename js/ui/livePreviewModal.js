import { normalizePath } from "../storage/workspaceDb.js";
import { instrumentLoops } from "../preview/loopGuard.js";
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
  getSavedPreviewHtml,
  savePreviewHtml,
  findBestHtmlEntrypoint,
  findTargetHtmlFile,
  bundleHtmlWithFolderAssets,
  buildStandaloneJsPreview,
  buildStandalonePythonPreview,
  buildMarkdownPreview
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
  const iframeWrapper = document.getElementById("preview-iframe-wrapper");
  const iframe = document.getElementById("preview-iframe");
  const cRunnerContainer = document.getElementById("preview-c-runner");
  const pageSelect = document.getElementById("preview-page-select");
  const backBtn = document.getElementById("btn-preview-back");
  const forwardBtn = document.getElementById("btn-preview-forward");
  const navControls = dialog?.querySelector(".preview-nav-controls");

  let consoleVisible = true;
  let previewRunSeq = 0;
  let currentPreviewPath = null;
  /** @type {"auto" | "standalone" | "folder"} */
  let jsRunOverride = "auto";
  let activeCRunnerDestroy = null;

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
  });

  backBtn?.addEventListener("click", () => {
    if (historyIndex > 0) {
      historyIndex -= 1;
      void navigateToHtml(historyStack[historyIndex], false);
    }
  });

  forwardBtn?.addEventListener("click", () => {
    if (historyIndex < historyStack.length - 1) {
      historyIndex += 1;
      void navigateToHtml(historyStack[historyIndex], false);
    }
  });

  async function prepareHtmlForPreview(targetFile, allFiles) {
    if (!targetFile) return { html: "", assetMap: new Map() };

    // 1. Si el HTML está pendiente de descarga bajo demanda (lazy en GitHub), descargarlo primero
    if (targetFile.contentLoaded === false || (targetFile.content === "" && targetFile.blobSha)) {
      if (typeof ensureFileLoaded === "function") {
        await ensureFileLoaded(targetFile);
      }
    }

    // 2. Extraer todos los assets locales referenciados por el HTML
    const referencedPaths = extractReferencedAssetPaths(targetFile.path, targetFile.content || "");
    const unloadedToFetch = [];
    const filesByNormPath = new Map();
    for (const f of allFiles || []) {
      if (f && f.path) {
        filesByNormPath.set(normalizePath(f.path), f);
      }
    }

    for (const refPath of referencedPaths) {
      const assetFile = filesByNormPath.get(normalizePath(refPath));
      if (assetFile && (assetFile.contentLoaded === false || (assetFile.content === "" && assetFile.blobSha))) {
        unloadedToFetch.push(assetFile);
      }
    }

    // 3. Descargar en lote los assets pendientes desde GitHub
    if (unloadedToFetch.length > 0 && typeof ensureFilesLoaded === "function") {
      await ensureFilesLoaded(unloadedToFetch);
    }

    // 4. Revisar si entre los CSS descargados hay reglas @import url(...) que a su vez requieran descarga
    const secondaryUnloaded = [];
    for (const refPath of referencedPaths) {
      const assetFile = filesByNormPath.get(normalizePath(refPath));
      if (assetFile && getFileExtension(assetFile.path) === "css" && typeof assetFile.content === "string") {
        const cssImports = extractCssImportPaths(assetFile.path, assetFile.content);
        for (const impPath of cssImports) {
          const impFile = filesByNormPath.get(normalizePath(impPath));
          if (impFile && (impFile.contentLoaded === false || (impFile.content === "" && impFile.blobSha))) {
            secondaryUnloaded.push(impFile);
          }
        }
      }
    }
    if (secondaryUnloaded.length > 0 && typeof ensureFilesLoaded === "function") {
      await ensureFilesLoaded(secondaryUnloaded);
    }

    // 5. Construir mapa de assets del proyecto completo
    const assetMap = buildWorkspaceAssetMap(allFiles);
    return {
      html: targetFile.content || "",
      assetMap
    };
  }

  async function navigateToHtml(targetPath, pushHistory = true) {
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
    btn.addEventListener("click", () => {
      const device = btn.getAttribute("data-device") || "desktop";
      deviceButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
      if (iframe) {
        iframe.className = `preview-iframe device-${device}`;
      }
    });
  });

  // Precargar el analizador Acorn en segundo plano para tener el guardián listo de inmediato
  if (typeof window !== "undefined") {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => void loadAcorn());
    } else {
      window.setTimeout(() => void loadAcorn(), 1500);
    }
  }

  openBtn?.addEventListener("click", async () => {
    jsRunOverride = "auto";
    await loadAcorn();
    await openPreview();
  });

  closeBtn?.addEventListener("click", () => {
    stopIframe();
    dialog?.close();
  });

  dialog?.addEventListener("close", () => {
    stopIframe();
  });

  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      stopIframe();
      dialog.close();
    }
  });

  jsModeBtn?.addEventListener("click", () => {
    jsRunOverride = jsRunOverride === "folder" ? "standalone" : "folder";
    void renderActiveTabPreview();
  });

  reloadBtn?.addEventListener("click", () => {
    void renderActiveTabPreview();
  });

  toggleConsoleBtn?.addEventListener("click", () => {
    consoleVisible = !consoleVisible;
    if (consolePanel && !iframe?.hidden) {
      consolePanel.hidden = !consoleVisible;
    }
    toggleConsoleBtn.setAttribute("aria-pressed", String(consoleVisible));
  });

  clearConsoleBtn?.addEventListener("click", () => {
    clearConsoleOutput();
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "studio-ide-preview") {
      return;
    }
    if (!iframe || event.source !== iframe.contentWindow) {
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
  });

  function handlePreviewNavigation(href) {
    const { files } = getWorkspaceSnapshot();
    const targetFile = findTargetHtmlFile(files, currentPreviewPath, href);
    if (!targetFile) {
      appendConsoleLine("warn", `No se encontró "${href}" en el proyecto (navegación desde "${currentPreviewPath || 'raíz'}").`);
      return;
    }

    navigateToHtml(targetFile.path, true);
  }

  function stopIframe() {
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
    const rawStr = String(text ?? "");
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
    hasConsole = true
  }) {
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
      iframe.srcdoc = `${compiledHtml}\n<!-- studio-run:${previewRunSeq} -->`;
    }
    if (consolePanel) {
      consolePanel.hidden = !hasConsole || !consoleVisible;
    }

    if (jsModeBtn) {
      if (siblingHtml) {
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
    if (jsModeBtn) jsModeBtn.hidden = true;
    if (reloadBtn) reloadBtn.hidden = true;
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
      const compiledJsHtml = buildStandaloneJsPreview(activeFile, guardJs);
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
      const compiledMdHtml = buildMarkdownPreview(activeFile);
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
        hasConsole: true
      });
      return;
    }

    // 7. Pestaña C / C++ / Rust / Go / Java / C# / TypeScript: Runner nativo sin iframe
    if (
      C_EXTENSIONS.has(ext) ||
      CPP_EXTENSIONS.has(ext) ||
      RUST_EXTENSIONS.has(ext) ||
      GO_EXTENSIONS.has(ext) ||
      JAVA_EXTENSIONS.has(ext) ||
      CSHARP_EXTENSIONS.has(ext) ||
      TS_EXTENSIONS.has(ext)
    ) {
      showCRunnerView(activeFile, sameFolderFiles);
      return;
    }

    // 8. Extensiones no soportadas
    hideWebNavigationControls();
    showUnavailableState({
      headerTitle: "Vista previa",
      badgeText: activeFile.path,
      messageTitle: `La vista previa no está disponible para este archivo ${extLabel}`,
      messageDesc: "La vista previa en vivo ejecuta archivos .html, .js, .ts, .css (en conjunto con el proyecto web), scripts .py de Python, bases de datos .sql de SQLite, código C/C++, Java, C# y documentos .md."
    });
  }

  return {
    openPreview
  };
}
