import { normalizePath } from "../storage/workspaceDb.js";
import { getImageMimeType } from "../storage/fileImport.js";
import { buildLoopGuardRuntime } from "./loopGuard.js";
import { transpileTypeScriptAndJsx } from "./tsTranspiler.js";
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
  MAX_PREVIEW_ASSET_BYTES,
  MAX_TOTAL_INLINED_CSS,
  IGNORED_PREVIEW_DIRS,
  getFileExtension,
  getParentFolder,
  resolveRelativePath,
  escapeAttr,
  escapeHtmlText
} from "./previewUtils.js";
import {
  buildExactModuleMap,
  hasLocalModuleDependencies,
  extractModuleDependencyPaths,
  buildVirtualModuleBundle,
  formatVirtualModuleExecution
} from "./moduleBundler.js";
import { buildStandalonePythonPreview } from "./pythonRunner.js";
import {
  buildMarkdownPreview,
  renderMarkdownDocumentHtml,
  formatMdInline
} from "./markdownPreview.js";

export {
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
  MAX_PREVIEW_ASSET_BYTES,
  MAX_TOTAL_INLINED_CSS,
  IGNORED_PREVIEW_DIRS,
  getFileExtension,
  getParentFolder,
  resolveRelativePath,
  escapeAttr,
  escapeHtmlText,
  extractModuleDependencyPaths,
  buildStandalonePythonPreview,
  buildMarkdownPreview,
  renderMarkdownDocumentHtml,
  formatMdInline
};

/**
 * Filtra únicamente los archivos que pertenecen a la misma carpeta base (y subcarpetas relativas de ese conjunto),
 * omitiendo carpetas masivas (node_modules, dist, etc.) y archivos sin contenido descargado (lazy).
 */
export function filterFolderScopeFiles(allFiles, baseFolder) {
  if (!Array.isArray(allFiles)) return [];
  const cleanBase = baseFolder ? normalizePath(baseFolder) : "";
  const prefix = cleanBase ? `${cleanBase}/` : "";

  return allFiles.filter((f) => {
    if (!f || !f.path) return false;
    const clean = normalizePath(f.path);

    const parts = clean.split("/");
    for (const part of parts) {
      if (IGNORED_PREVIEW_DIRS.has(part.toLowerCase())) return false;
    }

    if (f.content === null || f.content === undefined) return false;
    if (prefix && !clean.startsWith(prefix)) return false;

    return true;
  });
}

/**
 * Construye un mapa de todos los archivos del espacio de trabajo disponibles para la vista previa,
 * indexados por su ruta normalizada y excluyendo directorios pesados.
 */
export function buildWorkspaceAssetMap(allFiles) {
  const map = new Map();
  for (const f of allFiles || []) {
    if (!f || !f.path) continue;
    const clean = normalizePath(f.path);
    const parts = clean.split("/");
    let isIgnored = false;
    for (const part of parts) {
      if (IGNORED_PREVIEW_DIRS.has(part.toLowerCase())) {
        isIgnored = true;
        break;
      }
    }
    if (!isIgnored) {
      map.set(clean, f);
      const baseName = f.shortName || clean.split("/").pop();
      if (baseName && !map.has(baseName)) {
        map.set(baseName, f);
      }
    }
  }
  return map;
}

/**
 * Extrae todas las rutas relativas de hojas CSS y scripts JS referenciados por el HTML.
 */
export function extractReferencedAssetPaths(entryPath, rawHtml) {
  if (!rawHtml || typeof rawHtml !== "string") return [];
  const dir = getParentFolder(entryPath);
  const paths = new Set();

  const linkRegex = /<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(rawHtml)) !== null) {
    const hrefMatch = match[0].match(/href=["']([^"']+)["']/i);
    if (hrefMatch && hrefMatch[1] && !/^(https?:|data:|blob:|\/\/)/i.test(hrefMatch[1])) {
      const cleanRef = hrefMatch[1].split("?")[0].split("#")[0];
      const resolved = resolveRelativePath(dir, cleanRef);
      if (resolved) paths.add(resolved);
      const rootClean = normalizePath(cleanRef);
      if (rootClean) paths.add(rootClean);
    }
  }

  const scriptRegex = /<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((match = scriptRegex.exec(rawHtml)) !== null) {
    const srcMatch = match[0].match(/src=["']([^"']+)["']/i);
    if (srcMatch && srcMatch[1] && !/^(https?:|data:|blob:|\/\/)/i.test(srcMatch[1])) {
      const cleanRef = srcMatch[1].split("?")[0].split("#")[0];
      const resolved = resolveRelativePath(dir, cleanRef);
      if (resolved) paths.add(resolved);
      const rootClean = normalizePath(cleanRef);
      if (rootClean) paths.add(rootClean);
    }
  }

  return Array.from(paths);
}

/**
 * Analiza las condiciones complejas asociadas a una regla `@import` de CSS
 * (tales como capas `@layer`, consultas de soporte `@supports` y consultas de medios `@media`).
 * @param {string} rawConditions
 * @returns {{ layerClause: string, supportsCondition: string, mediaQueries: string }}
 */
export function parseCssImportConditions(rawConditions) {
  let conditions = (rawConditions || "").trim();
  let layerClause = "";
  let supportsCondition = "";
  let mediaQueries = "";

  if (!conditions) {
    return { layerClause, supportsCondition, mediaQueries };
  }

  // 1. Extraer layer(...) o layer
  const layerMatch = conditions.match(/\blayer(?:\(([^)]*)\))?/i);
  if (layerMatch) {
    const layerName = layerMatch[1] ? layerMatch[1].trim() : "";
    layerClause = layerName ? `@layer ${layerName}` : `@layer`;
    conditions = conditions.replace(layerMatch[0], "").trim();
  }

  // 2. Extraer supports(...)
  const supportsMatch = conditions.match(/\bsupports\(([^)]*)\)/i);
  if (supportsMatch) {
    supportsCondition = supportsMatch[1].trim();
    conditions = conditions.replace(supportsMatch[0], "").trim();
  }

  // 3. El resto de las condiciones corresponden a la lista de media queries
  mediaQueries = conditions.trim();

  return { layerClause, supportsCondition, mediaQueries };
}

/**
 * Envuelve el código CSS inlined con las condiciones semánticas preservadas del `@import`.
 * @param {string} cssContent
 * @param {{ layerClause?: string, supportsCondition?: string, mediaQueries?: string, commentHeader?: string }} options
 * @returns {string}
 */
export function wrapCssWithConditions(cssContent, { layerClause = "", supportsCondition = "", mediaQueries = "", commentHeader = "" } = {}) {
  let wrapped = cssContent;
  if (mediaQueries) {
    wrapped = `@media ${mediaQueries} {\n${wrapped}\n}`;
  }
  if (supportsCondition) {
    wrapped = `@supports (${supportsCondition}) {\n${wrapped}\n}`;
  }
  if (layerClause) {
    wrapped = `${layerClause} {\n${wrapped}\n}`;
  }
  return commentHeader ? `${commentHeader}\n${wrapped}` : wrapped;
}

/**
 * Extrae las rutas locales de reglas @import url(...) presentes en un archivo CSS.
 * Soporta URLs entre comillas simples, dobles, url(...) y con especificadores condicionales (layer, media, supports).
 *
 * @param {string} cssPath Ruta del archivo CSS contenedor (para resolver rutas relativas).
 * @param {string} cssContent Contenido textual de la hoja de estilo.
 * @returns {string[]} Lista de rutas normalizadas de archivos a incrustar.
 */
export function extractCssImportPaths(cssPath, cssContent) {
  if (!cssContent || typeof cssContent !== "string") return [];
  const dir = getParentFolder(cssPath);
  const paths = new Set();
  const importRegex = /@import\s+(?:url\(\s*(?:["']([^"']+)["']|([^"')]+))\s*\)|["']([^"']+)["'])([^;]*);?/gi;
  let match;
  while ((match = importRegex.exec(cssContent)) !== null) {
    const importUrl = match[1] || match[2] || match[3];
    if (importUrl && !/^(https?:|data:|blob:|\/\/)/i.test(importUrl)) {
      const cleanRef = importUrl.split("?")[0].split("#")[0];
      const resolved = resolveRelativePath(dir, cleanRef);
      if (resolved) paths.add(resolved);
      const rootClean = normalizePath(cleanRef);
      if (rootClean) paths.add(rootClean);
    }
  }
  return Array.from(paths);
}

export function getSavedPreviewHtml(projectId) {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(`studio_preview_last_html:${projectId || "default"}`) || null;
  } catch (_) {
    return null;
  }
}

export function savePreviewHtml(projectId, htmlPath) {
  if (typeof localStorage === "undefined" || !htmlPath) return;
  try {
    localStorage.setItem(`studio_preview_last_html:${projectId || "default"}`, htmlPath);
  } catch (_) {}
}

/**
 * Resuelve el mejor archivo HTML de entrada cuando la pestaña activa es JS o CSS.
 */
export function findBestHtmlEntrypoint(allFiles, activeFile, preferredHtmlPath = null) {
  const htmlFiles = (allFiles || []).filter((f) => {
    if (!f || !f.path) return false;
    const clean = normalizePath(f.path);
    const parts = clean.split("/");
    for (const part of parts) {
      if (IGNORED_PREVIEW_DIRS.has(part.toLowerCase())) return false;
    }
    const ext = getFileExtension(f.path);
    return HTML_EXTENSIONS.has(ext) && typeof f.content === "string";
  });
  if (htmlFiles.length === 0) return null;

  const activePath = normalizePath(activeFile.path);
  const activeShort = activeFile.shortName || activePath.split("/").pop();
  const activeFolder = getParentFolder(activePath);
  const escapedName = activeShort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const scriptRegex = new RegExp(`<script[^>]+src=["'][^"']*${escapedName}["']`, "i");
  const linkRegex = new RegExp(`<link[^>]+href=["'][^"']*${escapedName}["']`, "i");

  const directRefs = htmlFiles.filter((f) => {
    const content = f.content || "";
    return scriptRegex.test(content) || linkRegex.test(content);
  });

  if (directRefs.length > 0) {
    const sameFolder = directRefs.find((f) => getParentFolder(f.path) === activeFolder);
    if (sameFolder) return sameFolder;
    const index = directRefs.find((f) => (f.shortName || "").toLowerCase() === "index.html");
    if (index) return index;
    return directRefs[0];
  }

  if (preferredHtmlPath) {
    const cleanPref = normalizePath(preferredHtmlPath);
    const preferred = htmlFiles.find((f) => normalizePath(f.path) === cleanPref);
    if (preferred) return preferred;
  }

  const indexInSameFolder = htmlFiles.find(
    (f) => getParentFolder(f.path) === activeFolder && (f.shortName || "").toLowerCase() === "index.html"
  );
  if (indexInSameFolder) return indexInSameFolder;

  const indexInRoot = htmlFiles.find(
    (f) => !getParentFolder(f.path) && (f.shortName || "").toLowerCase() === "index.html"
  );
  if (indexInRoot) return indexInRoot;

  const anyIndex = htmlFiles.find((f) => (f.shortName || "").toLowerCase() === "index.html");
  if (anyIndex) return anyIndex;

  const anyInSameFolder = htmlFiles.find((f) => getParentFolder(f.path) === activeFolder);
  if (anyInSameFolder) return anyInSameFolder;

  return htmlFiles[0];
}

/**
 * Resuelve el archivo HTML de destino al navegar en enlaces dentro del iframe.
 */
export function findTargetHtmlFile(allFiles, currentPreviewPath, requestedHref) {
  if (!requestedHref || typeof requestedHref !== "string") return null;

  let clean = requestedHref.trim().split("?")[0].split("#")[0];
  if (!clean) return null;

  const htmlFiles = (allFiles || []).filter((f) => {
    if (!f || !f.path) return false;
    const cleanPath = normalizePath(f.path);
    const parts = cleanPath.split("/");
    for (const part of parts) {
      if (IGNORED_PREVIEW_DIRS.has(part.toLowerCase())) return false;
    }
    const ext = getFileExtension(f.path);
    return HTML_EXTENSIONS.has(ext);
  });
  if (htmlFiles.length === 0) return null;

  const currentFolder = currentPreviewPath ? getParentFolder(currentPreviewPath) : "";

  const relResolved = resolveRelativePath(currentFolder, clean);
  const match1 = htmlFiles.find((f) => normalizePath(f.path) === normalizePath(relResolved));
  if (match1) return match1;

  if (!clean.includes(".")) {
    const relHtml = resolveRelativePath(currentFolder, `${clean}.html`);
    const match2 = htmlFiles.find((f) => normalizePath(f.path) === normalizePath(relHtml));
    if (match2) return match2;
  }

  const rootClean = clean.replace(/^\/+/, "");
  const match3 = htmlFiles.find((f) => normalizePath(f.path) === normalizePath(rootClean));
  if (match3) return match3;

  if (!rootClean.includes(".")) {
    const match4 = htmlFiles.find((f) => normalizePath(f.path) === normalizePath(`${rootClean}.html`));
    if (match4) return match4;
  }

  const targetBase = rootClean.split("/").pop();
  const match5 = htmlFiles.find(
    (f) => (f.shortName || f.path.split("/").pop()).toLowerCase() === targetBase.toLowerCase()
  );
  if (match5) return match5;

  if (!targetBase.includes(".")) {
    const match6 = htmlFiles.find(
      (f) => (f.shortName || f.path.split("/").pop()).toLowerCase() === `${targetBase.toLowerCase()}.html`
    );
    if (match6) return match6;
  }

  return null;
}

export function findSiblingHtmlInSameFolder(scopeFiles, folder, targetFile) {
  const htmlInSameDir = scopeFiles.filter((f) => {
    const ext = getFileExtension(f.path);
    return HTML_EXTENSIONS.has(ext) && getParentFolder(f.path) === folder;
  });

  if (htmlInSameDir.length === 0) return null;

  const preferred =
    htmlInSameDir.find((f) => f.shortName.toLowerCase() === "index.html") || htmlInSameDir[0];

  const escapedName = targetFile.shortName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const linksThisJs = new RegExp(`src=["'][^"']*${escapedName}["']`, "i").test(preferred.content);

  return {
    file: preferred,
    linksThisJs
  };
}

export function buildConsoleBridgeScript(mirrorOnScreen) {
  return `<script>
${buildLoopGuardRuntime()}
(function () {
  var mirror = ${mirrorOnScreen ? "true" : "false"};
  function formatArgs(args) {
    return Array.prototype.slice.call(args).map(function (item) {
      if (typeof item === "string") return item;
      try { return JSON.stringify(item, null, 2); } catch (_) { return String(item); }
    }).join(" ");
  }
  function send(level, args) {
    try {
      var msg = formatArgs(args);
      parent.postMessage({ source: "studio-ide-preview", level: level, text: msg }, "*");
      if (mirror) {
        var box = document.getElementById("__js_screen_log");
        if (box) {
          var row = document.createElement("div");
          row.className = level === "error" ? "js-line js-line-error" : level === "warn" ? "js-line js-line-warn" : "js-line";
          row.textContent = msg;
          box.appendChild(row);
        }
      }
    } catch (_) {}
  }
  var origLog = console.log, origWarn = console.warn, origErr = console.error;
  console.log = function () { send("log", arguments); origLog.apply(console, arguments); };
  console.warn = function () { send("warn", arguments); origWarn.apply(console, arguments); };
  console.error = function () { send("error", arguments); origErr.apply(console, arguments); };
  window.addEventListener("error", function (e) {
    var stErr = document.getElementById("__js_status");
    if (stErr) {
      stErr.dataset.failed = "1";
      stErr.style.color = "var(--err)";
      stErr.textContent = "Error en ejecución";
    }
    var fromLoopGuard = /Bucle detenido en la línea/.test(e.message || "");
    send("error", [e.message + (e.lineno && !fromLoopGuard ? " (línea " + e.lineno + ")" : "")]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    send("error", ["Promesa rechazada: " + (e.reason && e.reason.message ? e.reason.message : String(e.reason))]);
  });
  // Mini-REPL interactivo conectado al panel Consola JS de Studio IDE
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.source !== "studio-ide-repl" || d.action !== "eval") return;
    if (ev.source !== window.parent) return;
    var code = String(d.code || "").trim();
    if (!code) return;
    send("log", ["> " + code]);
    try {
      var res = (0, eval)(code);
      if (res !== undefined) {
        send("log", [res]);
      }
    } catch (err) {
      send("error", [err && err.message ? err.message : String(err)]);
    }
  });
  // Interceptor total de navegación local en enlaces
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#") || href.startsWith("javascript:")) return;
    if (/^(https?:|mailto:|tel:|blob:|data:)/i.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({
      source: "studio-ide-preview",
      action: "navigate",
      href: href
    }, "*");
  }, true);

  // Interceptor de envíos de formularios locales
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.getAttribute) return;
    var action = form.getAttribute("action");
    if (!action || action.startsWith("#") || action.startsWith("javascript:") || /^(https?:|mailto:|tel:)/i.test(action)) return;
    e.preventDefault();
    e.stopPropagation();
    parent.postMessage({
      source: "studio-ide-preview",
      action: "navigate",
      href: action
    }, "*");
  }, true);

  // Interceptor de llamadas programáticas de navegación
  try {
    var triggerNav = function (targetUrl) {
      if (!targetUrl || typeof targetUrl !== "string") return;
      if (targetUrl.startsWith("#") || targetUrl.startsWith("javascript:") || /^(https?:|mailto:|tel:)/i.test(targetUrl)) {
        window.open(targetUrl, "_blank");
        return;
      }
      parent.postMessage({
        source: "studio-ide-preview",
        action: "navigate",
        href: targetUrl
      }, "*");
    };
    window.navigate = triggerNav;
    if (window.location) {
      window.location.assign = triggerNav;
      window.location.replace = triggerNav;
    }
  } catch (_) {}
})();
</script>`;
}

export function bundleHtmlWithFolderAssets(
  entryPath,
  rawHtml,
  fileMap,
  ensureJsFile = null,
  transformJs = (code) => code,
  ensureCssFile = null,
  allowParentTraversal = false
) {
  const dir = getParentFolder(entryPath);

  const resolveRawEntry = (rawHref) => {
    if (!rawHref || /^(https?:|data:|blob:|\/\/)/i.test(rawHref)) {
      return null;
    }
    const cleanRef = rawHref.split("?")[0].split("#")[0];
    if (cleanRef.startsWith("../") && !allowParentTraversal) {
      return null;
    }
    const resolved = resolveRelativePath(dir, cleanRef);
    let asset = fileMap.get(resolved) || null;
    if (!asset && cleanRef.startsWith("./")) {
      asset = fileMap.get(resolveRelativePath(dir, cleanRef.slice(2))) || null;
    }
    if (!asset && !cleanRef.startsWith("/")) {
      asset = fileMap.get(normalizePath(cleanRef)) || null;
    }
    return asset || null;
  };

  const resolveAsset = (rawHref) => {
    const asset = resolveRawEntry(rawHref);
    if (!asset || asset.content == null || typeof asset.content !== "string") {
      return null;
    }
    return asset;
  };

  let inlinedActiveJs = false;
  let inlinedActiveCss = false;
  const deferredScripts = [];
  let totalInlinedCssBytes = 0;

  /**
   * Incrusta recursivamente directivas CSS `@import` locales resolviéndolas desde la memoria del bundle,
   * preservando condiciones complejas (@media, @layer, @supports) y aplicando límites estrictos de tamaño.
   *
   * @param {string} cssContent
   * @param {string} cssPath
   * @param {Set<string>} [visited]
   * @returns {string}
   */
  function inlineCssImports(cssContent, cssPath, visited = new Set()) {
    const cleanPath = normalizePath(cssPath);
    if (visited.has(cleanPath)) return "";
    visited.add(cleanPath);

    const cssDir = getParentFolder(cleanPath);
    const importRegex = /@import\s+(?:url\(\s*(?:["']([^"']+)["']|([^"')]+))\s*\)|["']([^"']+)["'])([^;]*);?/gi;

    return cssContent.replace(importRegex, (match, urlGroup1, urlGroup2, urlGroup3, rawConditions) => {
      const importUrl = urlGroup1 || urlGroup2 || urlGroup3;
      if (!importUrl || /^(https?:|data:|blob:|\/\/)/i.test(importUrl)) {
        return match;
      }
      const cleanRef = importUrl.split("?")[0].split("#")[0];
      if (cleanRef.startsWith("../") && !allowParentTraversal) {
        return match;
      }

      const resolved = resolveRelativePath(cssDir, cleanRef);
      let importedAsset = fileMap.get(resolved);
      if (!importedAsset && cleanRef.startsWith("./")) {
        importedAsset = fileMap.get(resolveRelativePath(cssDir, cleanRef.slice(2)));
      }
      if (!importedAsset && !cleanRef.startsWith("/")) {
        importedAsset = fileMap.get(normalizePath(cleanRef));
      }

      if (!importedAsset || typeof importedAsset.content !== "string") {
        return match;
      }

      // 1. Control de límite de tamaño por recurso individual
      if (importedAsset.content.length > MAX_PREVIEW_ASSET_BYTES) {
        return `/* [Studio IDE]: @import "${cleanRef}" omitido: excede el límite de tamaño individual (${importedAsset.content.length} bytes > ${MAX_PREVIEW_ASSET_BYTES} bytes) */`;
      }

      // 2. Control de presupuesto total acumulado de CSS inlined
      if (totalInlinedCssBytes + importedAsset.content.length > MAX_TOTAL_INLINED_CSS) {
        return `/* [Studio IDE]: @import "${cleanRef}" omitido: presupuesto total de CSS superado */`;
      }

      totalInlinedCssBytes += importedAsset.content.length;

      // 3. Resolución recursiva de dependencias hijas
      const inlinedChild = inlineCssImports(importedAsset.content, importedAsset.path, visited);

      // 4. Extracción y preservación de condiciones (layer, supports, media)
      const conds = parseCssImportConditions(rawConditions);
      const cleanConditionsStr = (rawConditions || "").trim();
      const headerComment = `/* @import "${cleanRef}"${cleanConditionsStr ? " " + cleanConditionsStr : ""} */`;

      return wrapCssWithConditions(inlinedChild, {
        ...conds,
        commentHeader: headerComment
      });
    });
  }

  let html = rawHtml.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) return tag;
    const asset = resolveAsset(hrefMatch[1]);
    if (!asset) return tag;
    if (ensureCssFile && normalizePath(asset.path) === normalizePath(ensureCssFile.path)) {
      inlinedActiveCss = true;
    }

    // 1. Control de límite de tamaño por recurso individual
    if (asset.content.length > MAX_PREVIEW_ASSET_BYTES) {
      return `<!-- [Studio IDE]: stylesheet "${escapeAttr(asset.path)}" omitido: excede el límite de tamaño individual (${asset.content.length} bytes > ${MAX_PREVIEW_ASSET_BYTES} bytes) -->\n${tag}`;
    }

    // 2. Control de presupuesto total acumulado de CSS inlined
    if (totalInlinedCssBytes + asset.content.length > MAX_TOTAL_INLINED_CSS) {
      return `<!-- [Studio IDE]: stylesheet "${escapeAttr(asset.path)}" omitido: presupuesto total de CSS superado -->\n${tag}`;
    }

    totalInlinedCssBytes += asset.content.length;
    const safeCss = inlineCssImports(asset.content, asset.path).replace(/<\/style>/gi, "<\\/style>");
    return `<style data-source="${escapeAttr(asset.path)}">\n${safeCss}\n</style>`;
  });

  if (ensureCssFile && !inlinedActiveCss) {
    const cssPath = ensureCssFile.path || "style.css";
    const cssContent = typeof ensureCssFile.content === "string" ? ensureCssFile.content : "";
    if (cssContent.length > MAX_PREVIEW_ASSET_BYTES) {
      const warnTag = `<!-- [Studio IDE]: stylesheet "${escapeAttr(cssPath)}" omitido: excede el límite de tamaño individual (${cssContent.length} bytes > ${MAX_PREVIEW_ASSET_BYTES} bytes) -->`;
      if (/<head\b[^>]*>/i.test(html)) {
        html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${warnTag}`);
      } else {
        html = `${warnTag}\n${html}`;
      }
    } else if (totalInlinedCssBytes + cssContent.length > MAX_TOTAL_INLINED_CSS) {
      const warnTag = `<!-- [Studio IDE]: stylesheet "${escapeAttr(cssPath)}" omitido: presupuesto total de CSS superado -->`;
      if (/<head\b[^>]*>/i.test(html)) {
        html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${warnTag}`);
      } else {
        html = `${warnTag}\n${html}`;
      }
    } else {
      totalInlinedCssBytes += cssContent.length;
      const safeExtraCss = inlineCssImports(cssContent, cssPath).replace(/<\/style>/gi, "<\\/style>");
      const styleTag = `<style data-source="${escapeAttr(cssPath)}">\n${safeExtraCss}\n</style>`;
      if (/<head\b[^>]*>/i.test(html)) {
        html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${styleTag}`);
      } else {
        html = `${styleTag}\n${html}`;
      }
    }
  }

  // Incrustar imágenes locales (<img src="...">) almacenadas en Base64 o SVG dentro del proyecto
  html = html.replace(/<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi, (fullTag, beforeSrc, quote, rawSrc, afterSrc) => {
    const entry = resolveRawEntry(rawSrc);
    if (!entry) return fullTag;
    const ext = getFileExtension(entry.path || rawSrc);
    const b64Payload = typeof entry.base64 === "string" && entry.base64.length > 0
      ? entry.base64
      : entry.isBinary && typeof entry.content === "string" && entry.content.length > 0
        ? entry.content
        : null;
    if (b64Payload) {
      const mime = getImageMimeType(entry.path || rawSrc);
      return `<img${beforeSrc}src=${quote}data:${mime};base64,${b64Payload}${quote}${afterSrc}>`;
    }
    if (ext === "svg" && typeof entry.content === "string" && entry.content.trim().length > 0) {
      return `<img${beforeSrc}src=${quote}data:image/svg+xml;charset=utf-8,${encodeURIComponent(entry.content)}${quote}${afterSrc}>`;
    }
    return fullTag;
  });

  const exactModuleMap = buildExactModuleMap(fileMap);
  let inlineScriptCounter = 0;

  function compileScriptContent(rawCode, sourcePath, explicitType = "", isModule = false) {
    const ext = getFileExtension(sourcePath || "");
    const t = String(explicitType || "").trim().toLowerCase();
    const isTsOrJsxType =
      t === "text/typescript" ||
      t === "application/typescript" ||
      t === "text/tsx" ||
      t === "text/jsx" ||
      t === "text/babel";
    const needsTranspile = TS_EXTENSIONS.has(ext) || ext === "jsx" || isTsOrJsxType;
    let executable = String(rawCode || "");
    if (needsTranspile) {
      const enableJsx = ext === "tsx" || ext === "jsx" || t === "text/tsx" || t === "text/jsx" || t === "text/babel";
      executable = transpileTypeScriptAndJsx(executable, {
        jsx: enableJsx,
        fileName: sourcePath || "inline.tsx"
      }).code;
    }
    const rendered = typeof transformJs === "function" ? transformJs(executable, isModule) : executable;
    return rendered.replace(/<\/script>/gi, "<\\/script>");
  }

  function tryBundleLocalModules(rawCode, sourcePath) {
    if (!hasLocalModuleDependencies(rawCode, sourcePath, exactModuleMap, { allowParentTraversal })) {
      return null;
    }
    const bundle = buildVirtualModuleBundle({
      entryPath: sourcePath,
      entryCode: rawCode,
      exactMap: exactModuleMap,
      transformJs,
      transformCss: (cssText, cssPath) => inlineCssImports(cssText, cssPath),
      allowParentTraversal
    });
    return formatVirtualModuleExecution(bundle);
  }

  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (fullTag, attrs, inlineCode) => {
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    if (!srcMatch) {
      const typeMatch = attrs.match(/\btype=["']([^"']*)["']/i);
      const type = typeMatch ? typeMatch[1].trim().toLowerCase() : "";
      const isJsOrTs =
        !type ||
        type === "module" ||
        type === "text/javascript" ||
        type === "application/javascript" ||
        type === "text/typescript" ||
        type === "application/typescript" ||
        type === "text/tsx" ||
        type === "text/jsx" ||
        type === "text/babel";
      if (!isJsOrTs || !inlineCode.trim()) return fullTag;
      const isMod = type === "module";
      const virtualPath = resolveRelativePath(dir, `__inline_${inlineScriptCounter++}.js`);
      const bundledExec = tryBundleLocalModules(inlineCode, virtualPath);
      if (bundledExec) {
        const modAttr = bundledExec.isModuleTag ? ' type="module"' : "";
        return `<script${modAttr}>\n${bundledExec.scriptCode}\n</script>`;
      }
      const safeInline = compileScriptContent(inlineCode, virtualPath, type, isMod);
      const outAttrs = type && type !== "module" ? attrs.replace(/\btype=["'][^"']*["']/i, "").trim() : attrs.trim();
      return `<script${outAttrs ? " " + outAttrs : ""}>${safeInline}</script>`;
    }
    const asset = resolveAsset(srcMatch[1]);
    if (!asset) return fullTag;
    if (asset.content.length > MAX_PREVIEW_ASSET_BYTES) {
      return fullTag;
    }

    if (ensureJsFile && normalizePath(asset.path) === normalizePath(ensureJsFile.path)) {
      inlinedActiveJs = true;
    }

    const isModule = /\btype=["']module["']/i.test(attrs);
    const hasDefer = /\bdefer\b/i.test(attrs);
    const bundledExec = tryBundleLocalModules(asset.content, asset.path);
    if (bundledExec) {
      const modAttr = bundledExec.isModuleTag ? ' type="module"' : "";
      const scriptTag = `<script${modAttr} data-source="${escapeAttr(asset.path)}">\n${bundledExec.scriptCode}\n</script>`;
      if (isModule || hasDefer) {
        deferredScripts.push(scriptTag);
        return "";
      }
      return scriptTag;
    }

    const safeJs = compileScriptContent(asset.content, asset.path, "", isModule);

    if (!isModule && hasDefer) {
      deferredScripts.push(`<script data-source="${escapeAttr(asset.path)}">\n${safeJs}\n</script>`);
      return "";
    }

    return `<script${isModule ? ' type="module"' : ""} data-source="${escapeAttr(asset.path)}">\n${safeJs}\n</script>`;
  });

  if (ensureJsFile && !inlinedActiveJs) {
    const bundledExtra = tryBundleLocalModules(ensureJsFile.content, ensureJsFile.path);
    if (bundledExtra) {
      const modAttr = bundledExtra.isModuleTag ? ' type="module"' : "";
      deferredScripts.push(
        `<script${modAttr} data-source="${escapeAttr(ensureJsFile.path)}">\n${bundledExtra.scriptCode}\n</script>`
      );
    } else {
      const safeExtraJs = compileScriptContent(ensureJsFile.content, ensureJsFile.path, "", false);
      deferredScripts.push(`<script data-source="${escapeAttr(ensureJsFile.path)}">\n${safeExtraJs}\n</script>`);
    }
  }

  if (deferredScripts.length > 0) {
    const deferredBlock = deferredScripts.join("\n");
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, () => `${deferredBlock}\n</body>`);
    } else {
      html = `${html}\n${deferredBlock}`;
    }
  }

  const bridge = buildConsoleBridgeScript(false);
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${bridge}`);
  }
  return `${bridge}\n${html}`;
}

export function buildStandaloneTsPreview(tsFile, transformJs = (code) => code, options = {}) {
  const exactMap = buildExactModuleMap(options?.assetMap || options?.companionFiles || null);
  const allowParentTraversal = options?.allowParentTraversal !== false;
  if (
    exactMap.size > 0 &&
    hasLocalModuleDependencies(tsFile?.content || "", tsFile?.path || "main.ts", exactMap, {
      allowParentTraversal
    })
  ) {
    return buildStandaloneJsPreview(tsFile, transformJs, options);
  }
  const ext = getFileExtension(tsFile?.path || "");
  const isJsx = ext === "tsx" || ext === "jsx";
  const compiled = transpileTypeScriptAndJsx(tsFile?.content || "", {
    jsx: isJsx,
    fileName: tsFile?.path || "main.ts"
  });
  return buildStandaloneJsPreview(
    {
      ...tsFile,
      content: compiled.code
    },
    transformJs,
    options
  );
}

export function buildStandaloneJsPreview(jsFile, transformJs = (code) => code, options = {}) {
  const bridge = buildConsoleBridgeScript(true);
  const exactMap = buildExactModuleMap(options?.assetMap || options?.companionFiles || null);
  const allowParentTraversal = options?.allowParentTraversal !== false;
  const usesLocalModules =
    exactMap.size > 0 &&
    hasLocalModuleDependencies(jsFile.content, jsFile.path, exactMap, { allowParentTraversal });

  const isModule = !usesLocalModules && /\b(import|export|await)\b/.test(jsFile.content);
  const safeName = escapeHtmlText(jsFile.path);

  let scriptSnippet = "";
  if (usesLocalModules) {
    const bundle = buildVirtualModuleBundle({
      entryPath: jsFile.path,
      entryCode: jsFile.content,
      exactMap,
      transformJs,
      allowParentTraversal
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
    const safeJs = transformJs(jsFile.content, isModule).replace(/<\/script>/gi, "<\\/script>");
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
