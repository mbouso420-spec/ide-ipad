/**
 * Generadores de vista previa independiente para TypeScript/JSX, JavaScript e Imágenes.
 */

import { formatStorageBytes } from "../../storage/storageQuota.js";
import { transpileTypeScriptAndJsx } from "../tsTranspiler.js";
import {
  TS_EXTENSIONS,
  getFileExtension,
  getParentFolder,
  escapeAttr,
  escapeHtmlText,
  escapeCloseScript,
  buildSafeImageDataUrl
} from "../previewUtils.js";
import {
  buildExactModuleMap,
  inspectModuleUsage,
  hasRelativeDepsInUsage,
  buildVirtualModuleBundle,
  formatVirtualModuleExecution
} from "../moduleBundler.js";
import { buildWorkspaceAssetMap, createProjectAssetHelpers } from "./assetResolver.js";
import { buildConsoleBridgeScript } from "./consoleBridge.js";

export function buildStandaloneTsPreview(tsFile, transformJs = (code) => code, options = {}) {
  const exactMap = options?.prebuiltExactMap || buildExactModuleMap(options?.assetMap || options?.companionFiles || null);
  const ext = getFileExtension(tsFile?.path || "");
  const isJsx = ext === "tsx" || ext === "jsx";
  const compiled = transpileTypeScriptAndJsx(tsFile?.content || "", {
    jsx: isJsx,
    fileName: tsFile?.path || "main.ts"
  });
  const precomputedUsage = inspectModuleUsage(compiled.code);
  return buildStandaloneJsPreview(
    {
      ...tsFile,
      content: compiled.code
    },
    transformJs,
    {
      ...options,
      prebuiltExactMap: exactMap,
      precompiledEntryCode: compiled.code,
      precomputedUsage
    }
  );
}

export function buildStandaloneJsPreview(jsFile, transformJs = (code) => code, options = {}) {
  const safeTransformJs = typeof transformJs === "function" ? transformJs : (code) => code;
  const bridge = buildConsoleBridgeScript(true);
  const exactMap = options?.prebuiltExactMap || buildExactModuleMap(options?.assetMap || options?.companionFiles || null);
  const allowParentTraversal = options?.allowParentTraversal !== false;
  const entryCode = typeof options?.precompiledEntryCode === "string"
    ? options.precompiledEntryCode
    : String(jsFile?.content || "");
  const entryExt = getFileExtension(jsFile?.path || "");
  const needsEntryTranspile =
    typeof options?.precompiledEntryCode !== "string" && (TS_EXTENSIONS.has(entryExt) || entryExt === "jsx");
  const normalizedJsCode = needsEntryTranspile
    ? transpileTypeScriptAndJsx(entryCode, {
        jsx: entryExt === "tsx" || entryExt === "jsx",
        fileName: jsFile?.path || "main.ts"
      }).code
    : entryCode;

  const moduleUsage = options?.precomputedUsage || inspectModuleUsage(normalizedJsCode);
  const usesLocalModules = exactMap.size > 0 && hasRelativeDepsInUsage(moduleUsage);
  const isModule = Boolean(!usesLocalModules && (moduleUsage.hasModuleSyntax || moduleUsage.hasTopLevelAwait));
  const safeName = escapeHtmlText(String(jsFile?.path || "script.js"));

  let scriptSnippet = "";
  if (usesLocalModules) {
    const cssAssetMap =
      options?.assetMap instanceof Map
        ? options.assetMap
        : Array.isArray(options?.companionFiles)
          ? buildWorkspaceAssetMap(options.companionFiles)
          : exactMap;
    const { inlineCssImports } = createProjectAssetHelpers(
      getParentFolder(jsFile?.path || ""),
      cssAssetMap,
      allowParentTraversal
    );
    const bundle = buildVirtualModuleBundle({
      entryPath: jsFile.path,
      entryCode: jsFile.content,
      exactMap,
      transformJs: safeTransformJs,
      transformCss: (cssText, cssPath) => inlineCssImports(cssText, cssPath),
      allowParentTraversal,
      precompiledEntryCode: normalizedJsCode,
      precomputedEntryUsage: moduleUsage
    });
    const exec = formatVirtualModuleExecution(bundle);
    const statusFooter = `
      var st = document.getElementById("__js_status");
      if (st && st.dataset.failed !== "1") {
        st.textContent = "Ejecutado correctamente (Módulos ES)";
      }
      var out = document.getElementById("__js_screen_log");
      if (out && out.children.length === 0) {
        var note = document.createElement("div");
        note.className = "js-empty";
        note.textContent = "El grafo de módulos se ejecutó sin errores. Usá console.log(...) para mostrar resultados acá.";
        out.appendChild(note);
      }`;
    const openTag = exec.isModuleTag ? '<script type="module">' : "<script>";
    const preamble = exec.extImportPreamble ? `${exec.extImportPreamble}\n` : "";
    scriptSnippet = `${openTag}
${preamble}try {
${exec.scriptBodyCode}
${statusFooter}
} catch (err) {
  var stErr = document.getElementById("__js_status");
  if (stErr) {
    stErr.dataset.failed = "1";
    stErr.style.color = "var(--err)";
    stErr.textContent = "Error en ejecución: " + (err && err.message ? err.message : String(err));
  }
  console.error(err);
}
</script>`;
  } else {
    const safeJs = escapeCloseScript(safeTransformJs(normalizedJsCode, isModule));
    scriptSnippet = isModule
      ? `<script type="module">
${safeJs}
</script>
<script type="module">
  window.addEventListener("load", function () {
    setTimeout(function () {
      var st = document.getElementById("__js_status");
      if (st && st.dataset.failed !== "1") {
        st.textContent = "Ejecutado correctamente (Módulo ES)";
      }
      var out = document.getElementById("__js_screen_log");
      if (out && out.children.length === 0) {
        var note = document.createElement("div");
        note.className = "js-empty";
        note.textContent = "El módulo JS se cargó sin errores. Usá console.log(...) para mostrar resultados acá.";
        out.appendChild(note);
      }
    }, 40);
  });
</script>`
      : `<script>
    try {
${safeJs}
      var st = document.getElementById("__js_status");
      if (st && st.dataset.failed !== "1") {
        st.textContent = "Ejecutado correctamente";
      }
      var out = document.getElementById("__js_screen_log");
      if (out && out.children.length === 0) {
        var note = document.createElement("div");
        note.className = "js-empty";
        note.textContent = "El archivo se ejecutó sin errores. Usá console.log(...) para mostrar resultados acá.";
        out.appendChild(note);
      }
    } catch (err) {
      var stErr = document.getElementById("__js_status");
      if (stErr) {
        stErr.dataset.failed = "1";
        stErr.style.color = "var(--err)";
        stErr.textContent = "Error en ejecución: " + (err && err.message ? err.message : String(err));
      }
      console.error(err);
    }
</script>`;
  }

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Vista previa de JS: ${safeName}</title>
  <style>
    :root {
      --bg: oklch(15% 0.011 255);
      --card: oklch(20.5% 0.014 255);
      --surface-input: oklch(16.5% 0.012 255);
      --border: oklch(33% 0.016 255 / 0.65);
      --ink: oklch(94.5% 0.007 255);
      --muted: oklch(67% 0.014 255);
      --accent: oklch(74% 0.13 252);
      --ok: oklch(66% 0.14 152);
      --warn: oklch(74% 0.14 75);
      --err: oklch(62% 0.18 25);
      --font-ui: system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      background: var(--bg);
      color: var(--ink);
      font-family: var(--font-ui);
    }
    .js-runner-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      overflow: hidden;
    }
    .js-runner-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .js-runner-file {
      font-family: var(--font-mono);
      color: var(--accent);
      font-weight: 500;
    }
    .js-runner-status {
      color: var(--ok);
      font-size: 12px;
    }
    .js-screen-log {
      padding: 12px 14px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.6;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .js-line {
      white-space: pre-wrap;
      word-break: break-word;
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--surface-input);
    }
    .js-line-warn { color: var(--warn); }
    .js-line-error { color: var(--err); }
    .js-empty {
      color: var(--muted);
      font-style: italic;
    }
  </style>
  ${bridge}
</head>
<body>
  <div class="js-runner-card">
    <div class="js-runner-head">
      <span class="js-runner-file">${safeName}</span>
      <span id="__js_status" class="js-runner-status">Ejecutando…</span>
    </div>
    <div id="__js_screen_log" class="js-screen-log"></div>
  </div>
  ${scriptSnippet}
</body>
</html>`;
}

/**
 * Genera el documento HTML interactivo para la previsualización directa de imágenes.
 * Soporta PNG, JPEG, GIF, WebP, SVG, AVIF, BMP e ICO con cuadrícula de transparencia y controles de zoom.
 */
export function buildStandaloneImagePreview(imageFile) {
  const ext = getFileExtension(imageFile?.path || "");
  const safeName = escapeHtmlText(imageFile?.shortName || imageFile?.path || "Imagen");
  const safeExtLabel = escapeHtmlText(ext || "IMG");
  const built = buildSafeImageDataUrl(imageFile, imageFile?.path || "");
  const imgSrc = built?.src || "";
  const sizeFormatted = built ? formatStorageBytes(built.byteLength) : "";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>${safeName}</title>
  <style>
    :root {
      --bg: #0f1117;
      --card: #181a20;
      --border: #282c37;
      --text: #e6edf3;
      --text-muted: #8b949e;
      --accent: #79c0ff;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .img-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: var(--card);
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      gap: 12px;
      flex-shrink: 0;
      flex-wrap: wrap;
    }
    .img-meta-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge {
      background: #21262d;
      border: 1px solid var(--border);
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      color: var(--accent);
      text-transform: uppercase;
    }
    .img-dim, .img-size {
      color: var(--text-muted);
      font-size: 12px;
    }
    .img-controls {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-ctrl {
      background: #21262d;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 3px 9px;
      border-radius: 5px;
      font-size: 12px;
      cursor: pointer;
      user-select: none;
    }
    .btn-ctrl:hover {
      background: #30363d;
    }
    .btn-ctrl.is-active {
      background: var(--accent);
      color: #0d1117;
      border-color: var(--accent);
      font-weight: 600;
    }
    .img-canvas-wrap {
      flex: 1;
      width: 100%;
      height: 100%;
      overflow: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: repeating-conic-gradient(#1c2128 0% 25%, #161b22 0% 50%) 50% / 20px 20px;
    }
    .preview-img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      border-radius: 4px;
      transition: transform 0.15s ease;
      cursor: zoom-in;
    }
    .preview-img.mode-100 {
      max-width: none;
      max-height: none;
      cursor: zoom-out;
    }
    .preview-img.mode-200 {
      max-width: none;
      max-height: none;
      transform: scale(2);
      transform-origin: center;
      cursor: zoom-out;
    }
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: var(--text-muted);
      font-size: 14px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="img-toolbar">
    <div class="img-meta-group">
      <span class="badge">${safeExtLabel}</span>
      <span class="img-name">${safeName}</span>
      <span class="img-size">${escapeHtmlText(sizeFormatted)}</span>
      <span id="dim-text" class="img-dim"></span>
    </div>
    <div class="img-controls">
      <button type="button" class="btn-ctrl is-active" id="btn-fit">Ajustar</button>
      <button type="button" class="btn-ctrl" id="btn-100">100%</button>
      <button type="button" class="btn-ctrl" id="btn-200">200%</button>
    </div>
  </div>
  <div class="img-canvas-wrap">
    ${imgSrc ? `<img id="main-img" class="preview-img" src="${escapeAttr(imgSrc)}" alt="${safeName}">` : '<div class="empty-state">Esta imagen está vacía o no contiene datos binarios válidos.</div>'}
  </div>
  <script>
    const img = document.getElementById("main-img");
    const dim = document.getElementById("dim-text");
    const btnFit = document.getElementById("btn-fit");
    const btn100 = document.getElementById("btn-100");
    const btn200 = document.getElementById("btn-200");
    if (img && dim) {
      img.addEventListener("load", () => {
        dim.textContent = img.naturalWidth + " × " + img.naturalHeight + " px";
      });
      if (img.complete && img.naturalWidth) {
        dim.textContent = img.naturalWidth + " × " + img.naturalHeight + " px";
      }
      function setMode(mode) {
        img.classList.remove("mode-100", "mode-200");
        btnFit?.classList.toggle("is-active", mode === "fit");
        btn100?.classList.toggle("is-active", mode === "100");
        btn200?.classList.toggle("is-active", mode === "200");
        if (mode === "100") img.classList.add("mode-100");
        if (mode === "200") img.classList.add("mode-200");
      }
      btnFit?.addEventListener("click", () => setMode("fit"));
      btn100?.addEventListener("click", () => setMode("100"));
      btn200?.addEventListener("click", () => setMode("200"));
      img.addEventListener("click", () => {
        if (img.classList.contains("mode-100")) setMode("fit");
        else setMode("100");
      });
    }
  </script>
</body>
</html>`;
}
