import { normalizePath } from "../storage/workspaceDb.js";
import { getImageMimeType } from "../storage/fileImport.js";
import { buildLoopGuardRuntime } from "./loopGuard.js";
import { transpileTypeScriptAndJsx } from "./tsTranspiler.js";

export const HTML_EXTENSIONS = new Set(["html", "htm"]);
export const JS_EXTENSIONS = new Set(["js", "mjs", "cjs"]);
export const CSS_EXTENSIONS = new Set(["css"]);
export const PYTHON_EXTENSIONS = new Set(["py", "pyw"]);
export const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
export const SQL_EXTENSIONS = new Set(["sql"]);
export const C_EXTENSIONS = new Set(["c", "h"]);
export const CPP_EXTENSIONS = new Set(["cpp", "cxx", "cc", "hpp"]);
export const RUST_EXTENSIONS = new Set(["rs"]);
export const GO_EXTENSIONS = new Set(["go"]);
export const JAVA_EXTENSIONS = new Set(["java"]);
export const CSHARP_EXTENSIONS = new Set(["cs"]);
export const TS_EXTENSIONS = new Set(["ts", "tsx"]);

export const MAX_PREVIEW_ASSET_BYTES = 512 * 1024; // 512 KB por recurso individual
export const MAX_TOTAL_INLINED_CSS = 2 * 1024 * 1024; // 2 MB presupuesto total acumulado de CSS

export const IGNORED_PREVIEW_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "venv",
  ".venv",
  "target",
  "bin",
  "obj",
  ".turbo",
  "out"
]);

export function getFileExtension(path) {
  const base = String(path || "").split("/").pop() || "";
  if (!base.includes(".")) return "";
  return base.split(".").pop().toLowerCase();
}

export function getParentFolder(path) {
  const clean = normalizePath(path);
  return clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
}

export function resolveRelativePath(baseDir, relPath) {
  if (relPath.startsWith("/")) {
    return normalizePath(relPath);
  }
  const stack = baseDir ? baseDir.split("/").filter(Boolean) : [];
  const parts = relPath.split("/");
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

export function escapeAttr(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeHtmlText(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
    return transformJs(executable, isModule).replace(/<\/script>/gi, "<\\/script>");
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
      const safeInline = compileScriptContent(inlineCode, "inline.js", type, isMod);
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
    const safeJs = compileScriptContent(asset.content, asset.path, "", isModule);

    if (!isModule && hasDefer) {
      deferredScripts.push(`<script data-source="${escapeAttr(asset.path)}">\n${safeJs}\n</script>`);
      return "";
    }

    return `<script${isModule ? ' type="module"' : ""} data-source="${escapeAttr(asset.path)}">\n${safeJs}\n</script>`;
  });

  if (ensureJsFile && !inlinedActiveJs) {
    const safeExtraJs = compileScriptContent(ensureJsFile.content, ensureJsFile.path, "", false);
    deferredScripts.push(`<script data-source="${escapeAttr(ensureJsFile.path)}">\n${safeExtraJs}\n</script>`);
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

export function buildStandaloneTsPreview(tsFile, transformJs = (code) => code) {
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
    transformJs
  );
}

export function buildStandaloneJsPreview(jsFile, transformJs = (code) => code) {
  const bridge = buildConsoleBridgeScript(true);
  const isModule = /\b(import|export|await)\b/.test(jsFile.content);
  const safeJs = transformJs(jsFile.content, isModule).replace(/<\/script>/gi, "<\\/script>");
  const safeName = escapeHtmlText(jsFile.path);

  const scriptSnippet = isModule
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

export function buildStandalonePythonPreview(pyFile, sameFolderFiles = [], baseFolder = "") {
  const prefix = baseFolder ? `${baseFolder}/` : "";
  const modules = [];
  const modPrefixes = new Set();
  const TEXT_OR_DATA_EXTENSIONS = new Set([
    "json", "txt", "csv", "tsv", "sql", "xml", "yaml", "yml", "md"
  ]);

  for (const candidate of sameFolderFiles) {
    const ext = getFileExtension(candidate.path);
    const isPy = PYTHON_EXTENSIONS.has(ext);
    const isData = TEXT_OR_DATA_EXTENSIONS.has(ext);
    if (!isPy && !isData) continue;
    const cleanPath = normalizePath(candidate.path);
    if (cleanPath === normalizePath(pyFile.path)) continue;
    const relPath = prefix && cleanPath.startsWith(prefix) ? cleanPath.slice(prefix.length) : cleanPath;
    if (relPath && !relPath.startsWith("..")) {
      modules.push({ path: relPath, content: candidate.content });
      if (isPy) {
        const topMod = relPath.split("/")[0].replace(/\.(py|pyw)$/i, "");
        if (topMod) modPrefixes.add(topMod);
      }
    }
  }

  const pythonBootstrap = [
    "import builtins, json, random, sys, traceback",
    "if '.' not in sys.path:",
    "    sys.path.insert(0, '.')",
    "class _StudioPauseForInput(BaseException):",
    "    def __init__(self, prompt_text):",
    "        self.prompt_text = prompt_text",
    "for _mod_prefix in json.loads(__studio_mod_prefixes_json):",
    "    for _loaded in list(sys.modules.keys()):",
    "        if _loaded == _mod_prefix or _loaded.startswith(_mod_prefix + '.'):",
    "            sys.modules.pop(_loaded, None)",
    "random.seed(int(__studio_seed))",
    "_inputs = json.loads(__studio_inputs_json)",
    "_idx = 0",
    "def __studio_input(prompt=''):",
    "    global _idx",
    "    texto = str(prompt) if prompt is not None else ''",
    "    if _idx < len(_inputs):",
    "        item = _inputs[_idx]",
    "        _idx += 1",
    "        if item.get('cancelled'):",
    "            print(f'{texto}(cancelado)')",
    "            raise EOFError('Entrada cancelada por el usuario.')",
    "        val = str(item.get('value', ''))",
    "        print(f'{texto}{val}')",
    "        return val",
    "    raise _StudioPauseForInput(texto)",
    "builtins.input = __studio_input",
    "_result = {'status': 'ok'}",
    "global _studio_repl_ns",
    "_studio_repl_ns = {'__name__': '__main__', '__file__': __studio_entry_name}",
    "try:",
    "    exec(compile(__studio_entry_code, __studio_entry_name, 'exec'), _studio_repl_ns)",
    "except _StudioPauseForInput as _pause:",
    "    _result = {'status': 'need_input', 'prompt': _pause.prompt_text}",
    "except SystemExit:",
    "    pass",
    "except Exception as _exc:",
    "    _result = {'status': 'error'}",
    "    _tb = traceback.extract_tb(_exc.__traceback__)",
    "    _clean = [f for f in _tb if f.filename == __studio_entry_name or not f.filename.startswith('<')]",
    "    _lines = ['Traceback (most recent call last):']",
    "    for _f in _clean:",
    "        _lines.append(f'  Archivo \"{_f.filename}\", línea {_f.lineno}, en {_f.name}')",
    "    _lines.extend([l.rstrip('\\n') for l in traceback.format_exception_only(type(_exc), _exc)])",
    "    print('\\n'.join(_lines), file=sys.stderr)",
    "finally:",
    "    sys.stdout.flush()",
    "    sys.stderr.flush()",
    "json.dumps(_result)"
  ].join("\n");

  const payloadJson = JSON.stringify({
    entryName: pyFile.shortName,
    entryPath: pyFile.path,
    code: pyFile.content,
    modules,
    modPrefixes: [...modPrefixes],
    bootstrap: pythonBootstrap
  }).replace(/</g, "\\u003c");

  const safePathLabel = escapeHtmlText(pyFile.path);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <style>
    :root {
      --bg: oklch(15% 0.011 255);
      --card: oklch(20.5% 0.014 255);
      --surface-input: oklch(16.5% 0.012 255);
      --border: oklch(33% 0.016 255 / 0.65);
      --ink: oklch(94.5% 0.007 255);
      --muted: oklch(67% 0.014 255);
      --accent: oklch(74% 0.13 252);
      --accent-solid: oklch(52% 0.165 252);
      --accent-ink: oklch(98% 0.005 252);
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
    .py-runner-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      overflow: hidden;
    }
    .py-runner-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .py-runner-file {
      font-family: var(--font-mono);
      color: var(--accent);
      font-weight: 500;
    }
    .py-runner-status {
      color: var(--warn);
      font-size: 12px;
    }
    .py-runner-output {
      padding: 12px 14px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.6;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .py-line {
      white-space: pre-wrap;
      word-break: break-word;
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--surface-input);
    }
    .py-line-error { color: var(--err); }
    .py-empty { color: var(--muted); font-style: italic; }
    .py-input-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-top: 1px solid var(--border);
      background: var(--surface-input);
    }
    .py-input-bar[hidden] { display: none; }
    .py-input-prompt {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--accent);
      font-weight: 500;
    }
    .py-input-field {
      flex: 1;
      min-width: 160px;
      min-height: 36px;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--ink);
      font-family: var(--font-mono);
      font-size: 16px;
    }
    .py-input-field:focus {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .py-btn {
      min-height: 36px;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--ink);
      font-family: var(--font-ui);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .py-btn-primary {
      background: var(--accent-solid);
      border-color: var(--accent-solid);
      color: var(--accent-ink);
    }
    .py-runner-controls {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .py-btn-stop {
      min-height: 30px;
      padding: 4px 12px;
      border-color: var(--err);
      color: var(--err);
    }
    .py-btn-stop[hidden] { display: none; }
  </style>
</head>
<body>
  <section class="py-runner-card">
    <div class="py-runner-head">
      <span class="py-runner-file">${safePathLabel}</span>
      <span class="py-runner-controls">
        <span id="__py_status" class="py-runner-status">Iniciando motor Python 3 (WebAssembly)…</span>
        <button type="button" id="__py_stop" class="py-btn py-btn-stop" hidden>Detener</button>
      </span>
    </div>
    <div id="__py_screen_log" class="py-runner-output"></div>
    <form id="__py_input_form" class="py-input-bar" hidden>
      <label id="__py_input_prompt" for="__py_input_field" class="py-input-prompt">input():</label>
      <input id="__py_input_field" type="text" class="py-input-field" autocomplete="off" spellcheck="false" placeholder="Escribí un valor y tocá Enviar…">
      <button type="submit" class="py-btn py-btn-primary">Enviar</button>
      <button type="button" id="__py_input_cancel" class="py-btn">Cancelar</button>
    </form>
  </section>

  <script id="__py_payload" type="application/json">${payloadJson}</script>
  <script id="__py_runner_src" type="text/plain">
    var PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.3/full/";
    var pyodide = null;
    var loading = null;
    function send(msg) { self.postMessage(msg); }
    function ensurePyodide() {
      if (pyodide) return Promise.resolve(pyodide);
      if (!loading) {
        send({ type: "status", text: "loading" });
        loading = (async function () {
          await __loadScript(PYODIDE_URL + "pyodide.js");
          var py = await loadPyodide({ indexURL: PYODIDE_URL });
          py.setStdout({ batched: function (line) { send({ type: "out", level: "log", text: line }); } });
          py.setStderr({ batched: function (line) { send({ type: "out", level: "error", text: line }); } });
          pyodide = py;
          return py;
        })();
      }
      return loading;
    }
    function ensureParentDirs(FS, filePath) {
      var parts = filePath.split("/");
      var current = "";
      for (var i = 0; i < parts.length - 1; i += 1) {
        current = current ? current + "/" + parts[i] : parts[i];
        try { FS.mkdir(current); } catch (_) {}
      }
    }
    function writeFiles(py, job) {
      ensureParentDirs(py.FS, job.entryName);
      try { py.FS.writeFile(job.entryName, job.code, { encoding: "utf8" }); } catch (_) {}
      if (job.entryPath && job.entryPath !== job.entryName) {
        ensureParentDirs(py.FS, job.entryPath);
        try { py.FS.writeFile(job.entryPath, job.code, { encoding: "utf8" }); } catch (_) {}
      }
      for (var i = 0; i < job.modules.length; i += 1) {
        var mod = job.modules[i];
        ensureParentDirs(py.FS, mod.path);
        py.FS.writeFile(mod.path, mod.content, { encoding: "utf8" });
      }
    }
    self.onmessage = async function (event) {
      var job = event.data;
      if (!job) return;
      if (job.type === "eval") {
        try {
          var pyEval = await ensurePyodide();
          pyEval.globals.set("__studio_eval_code", String(job.code || ""));
          var evalScript = [
            "import json, sys, traceback",
            "_er = {'status': 'ok'}",
            "try:",
            "    _v = eval(compile(__studio_eval_code, '<repl>', 'eval'), _studio_repl_ns)",
            "    if _v is not None:",
            "        print(repr(_v))",
            "except SyntaxError:",
            "    try:",
            "        exec(compile(__studio_eval_code, '<repl>', 'exec'), _studio_repl_ns)",
            "    except Exception as _ex:",
            "        _er = {'status': 'error'}",
            "        print(''.join(traceback.format_exception_only(type(_ex), _ex)).rstrip(), file=sys.stderr)",
            "except Exception as _ex:",
            "    _er = {'status': 'error'}",
            "    print(''.join(traceback.format_exception_only(type(_ex), _ex)).rstrip(), file=sys.stderr)",
            "sys.stdout.flush()",
            "sys.stderr.flush()",
            "json.dumps(_er)"
          ].join("\\n");
          var evalRaw = await pyEval.runPythonAsync(evalScript);
          send({ type: "eval_done", outcome: JSON.parse(String(evalRaw || '{"status":"ok"}')) });
        } catch (err) {
          send({ type: "out", level: "error", text: err && err.message ? String(err.message) : String(err) });
          send({ type: "eval_done", outcome: { status: "error" } });
        }
        return;
      }
      if (job.type !== "run") return;
      try {
        var py = await ensurePyodide();
        send({ type: "status", text: "running" });
        writeFiles(py, job);
        py.globals.set("__studio_entry_name", job.entryName);
        py.globals.set("__studio_entry_code", job.code);
        py.globals.set("__studio_seed", job.seed);
        py.globals.set("__studio_inputs_json", JSON.stringify(job.inputs));
        py.globals.set("__studio_mod_prefixes_json", JSON.stringify(job.modPrefixes));
        var raw = await py.runPythonAsync(job.bootstrap);
        send({ type: "result", outcome: JSON.parse(String(raw || '{"status":"ok"}')) });
      } catch (err) {
        send({ type: "fatal", message: err && err.message ? String(err.message) : String(err) });
      }
    };
  </script>
  <script>
    (function () {
      var statusEl = document.getElementById("__py_status");
      var stopBtn = document.getElementById("__py_stop");
      var screenBox = document.getElementById("__py_screen_log");
      var inputForm = document.getElementById("__py_input_form");
      var inputPromptEl = document.getElementById("__py_input_prompt");
      var inputField = document.getElementById("__py_input_field");
      var cancelBtn = document.getElementById("__py_input_cancel");
      var payload = JSON.parse(document.getElementById("__py_payload").textContent);
      var runnerSrc = document.getElementById("__py_runner_src").textContent;

      var sessionSeed = Math.floor(Math.random() * 1000000000);
      var submittedInputs = [];
      var MAX_INPUT_STEPS = 200;
      var runner = null;
      var running = false;
      var runStartedAt = 0;
      var ticker = 0;
      var sawWorkerMessage = false;

      function clearOutputs() {
        if (screenBox) screenBox.innerHTML = "";
        try {
          parent.postMessage({ source: "studio-ide-preview", action: "clear" }, "*");
        } catch (_) {}
      }

      function emit(level, text) {
        var msg = String(text == null ? "" : text);
        try {
          parent.postMessage({ source: "studio-ide-preview", level: level, text: msg }, "*");
        } catch (_) {}
        if (screenBox) {
          var row = document.createElement("div");
          row.className = level === "error" ? "py-line py-line-error" : "py-line";
          row.textContent = msg;
          screenBox.appendChild(row);
        }
      }

      function setStatus(label, colorVar) {
        if (!statusEl) return;
        statusEl.textContent = label;
        statusEl.style.color = colorVar;
      }

      function setRunning(next) {
        running = next;
        window.clearInterval(ticker);
        if (stopBtn) stopBtn.hidden = !(next && runner && runner.canStop);
        if (next) {
          runStartedAt = Date.now();
          ticker = window.setInterval(function () {
            var secs = Math.floor((Date.now() - runStartedAt) / 1000);
            if (secs >= 1) {
              setStatus(
                secs >= 5
                  ? "Ejecutando… " + secs + " s (¿bucle infinito? Tocá Detener)"
                  : "Ejecutando… " + secs + " s",
                secs >= 5 ? "var(--warn)" : "var(--accent)"
              );
            }
          }, 1000);
        }
      }

      function loadScriptTag(url) {
        return new Promise(function (resolve, reject) {
          var s = document.createElement("script");
          s.src = url;
          s.onload = function () { resolve(); };
          s.onerror = function () { reject(new Error("No se pudo descargar el motor Python 3 (Pyodide). Conectate a internet al menos una vez para almacenarlo en caché.")); };
          document.head.appendChild(s);
        });
      }

      function createMainThreadRunner() {
        var fakeSelf = {
          postMessage: function (msg) { window.setTimeout(function () { handle(msg); }, 0); },
          onmessage: null
        };
        new Function("self", "__loadScript", runnerSrc)(fakeSelf, loadScriptTag);
        return {
          canStop: false,
          post: function (msg) { fakeSelf.onmessage({ data: msg }); },
          stop: function () {}
        };
      }

      function createRunner() {
        try {
          var prefix = "var __loadScript = function (url) { importScripts(url); return Promise.resolve(); };\\n";
          var blobUrl = URL.createObjectURL(new Blob([prefix + runnerSrc], { type: "text/javascript" }));
          var worker = new Worker(blobUrl);
          var revoked = false;
          function revokeBlobUrl() {
            if (!revoked) {
              revoked = true;
              try { URL.revokeObjectURL(blobUrl); } catch (_) {}
            }
          }
          var r = {
            canStop: true,
            post: function (msg) { worker.postMessage(msg); },
            stop: function () {
              window.removeEventListener("pagehide", onPageHide);
              revokeBlobUrl();
              worker.terminate();
            }
          };
          function onPageHide() {
            r.stop();
          }
          worker.onmessage = function (event) {
            sawWorkerMessage = true;
            revokeBlobUrl();
            handle(event.data);
          };
          worker.onerror = function (event) {
            if (event && event.preventDefault) event.preventDefault();
            if (!sawWorkerMessage && runner === r) {
              r.stop();
              runner = createMainThreadRunner();
              executePass();
              return;
            }
            handle({ type: "fatal", message: event && event.message ? event.message : "Error en el motor Python." });
          };
          window.addEventListener("pagehide", onPageHide, { once: true });
          return r;
        } catch (_) {
          return createMainThreadRunner();
        }
      }

      function handle(msg) {
        if (!msg) return;
        if (msg.type === "out") {
          emit(msg.level, msg.text);
          return;
        }
        if (msg.type === "status") {
          if (msg.text === "loading") setStatus("Iniciando motor Python 3 (WebAssembly)…", "var(--warn)");
          if (msg.text === "running") setStatus("Ejecutando script…", "var(--accent)");
          return;
        }
        if (msg.type === "fatal") {
          setRunning(false);
          setStatus("Error al iniciar Python", "var(--err)");
          emit("error", msg.message);
          return;
        }
        if (msg.type === "eval_done") {
          return;
        }
        if (msg.type === "result") {
          setRunning(false);
          var outcome = msg.outcome || { status: "ok" };
          if (outcome.status === "need_input") {
            setStatus("Esperando entrada en consola…", "var(--warn)");
            if (inputPromptEl) inputPromptEl.textContent = outcome.prompt || "Entrada (input):";
            if (inputForm && inputField) {
              inputField.value = "";
              inputForm.hidden = false;
              inputField.focus();
            }
            return;
          }
          if (outcome.status === "error") {
            setStatus("Error en ejecución", "var(--err)");
          } else {
            setStatus("Ejecutado correctamente", "var(--ok)");
            if (screenBox && screenBox.children.length === 0) {
              var note = document.createElement("div");
              note.className = "py-empty";
              note.textContent = "El script Python finalizó sin errores. Usá print(...) para mostrar resultados acá.";
              screenBox.appendChild(note);
            }
          }
        }
      }

      function executePass() {
        if (inputForm) inputForm.hidden = true;
        if (submittedInputs.length > MAX_INPUT_STEPS) {
          emit("error", "Se superó el límite de 200 lecturas input() consecutivas.");
          setStatus("Detenido por límite de entradas", "var(--err)");
          return;
        }
        if (!runner) runner = createRunner();
        clearOutputs();
        setRunning(true);
        runner.post({
          type: "run",
          entryName: payload.entryName,
          entryPath: payload.entryPath,
          code: payload.code,
          modules: payload.modules,
          modPrefixes: payload.modPrefixes,
          bootstrap: payload.bootstrap,
          inputs: submittedInputs,
          seed: sessionSeed
        });
      }

      if (stopBtn) {
        stopBtn.addEventListener("click", function () {
          if (!running || !runner || !runner.canStop) return;
          runner.stop();
          runner = null;
          setRunning(false);
          if (inputForm) inputForm.hidden = true;
          setStatus("Ejecución detenida", "var(--err)");
          emit("error", "Ejecución detenida por el usuario. Tocá Recargar para volver a ejecutar.");
        });
      }

      if (inputForm) {
        inputForm.addEventListener("submit", function (ev) {
          ev.preventDefault();
          submittedInputs.push({ value: inputField ? inputField.value : "" });
          executePass();
        });
      }

      if (cancelBtn) {
        cancelBtn.addEventListener("click", function () {
          submittedInputs.push({ cancelled: true });
          executePass();
        });
      }

      window.addEventListener("message", function (ev) {
        var d = ev.data;
        if (!d || d.source !== "studio-ide-repl" || d.action !== "eval") return;
        if (ev.source !== window.parent) return;
        var code = String(d.code || "").trim();
        if (!code) return;
        emit("log", ">>> " + code);
        if (running) {
          emit("error", "Esperá a que termine la ejecución actual antes de evaluar en el REPL.");
          return;
        }
        if (!runner) runner = createRunner();
        runner.post({ type: "eval", code: code });
      });

      executePass();
    })();
  </script>
</body>
</html>`;
}

export function buildMarkdownPreview(mdFile) {
  const renderedBody = renderMarkdownDocumentHtml(mdFile.content || "");
  const safeTitle = escapeHtmlText(mdFile.shortName);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle}</title>
  <style>
    :root {
      --bg: oklch(15% 0.011 255);
      --card: oklch(20.5% 0.014 255);
      --code-bg: oklch(18% 0.013 255);
      --border: oklch(33% 0.016 255 / 0.65);
      --ink: oklch(94.5% 0.007 255);
      --ink-2: oklch(83% 0.011 255);
      --muted: oklch(67% 0.014 255);
      --accent: oklch(74% 0.13 252);
      --font-body: "Plus Jakarta Sans", system-ui, -apple-system, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px 24px 48px;
      background: var(--bg);
      color: var(--ink-2);
      font-family: var(--font-body);
      font-size: 15px;
      line-height: 1.68;
    }
    .md-article {
      max-width: 760px;
      margin: 0 auto;
    }
    h1, h2, h3, h4, h5, h6 {
      color: var(--ink);
      margin: 1.4em 0 0.55em;
      line-height: 1.3;
      overflow-wrap: break-word;
    }
    h1 { font-size: 1.75rem; border-bottom: 1px solid var(--border); padding-bottom: 0.35em; margin-top: 0; }
    h2 { font-size: 1.35rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25em; }
    h3 { font-size: 1.12rem; }
    p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
    ul, ol { padding-left: 1.5em; }
    li + li { margin-top: 0.28em; }
    a { color: var(--accent); text-underline-offset: 0.18em; }
    code {
      font-family: var(--font-mono);
      font-size: 0.86em;
      padding: 0.15em 0.4em;
      border-radius: 5px;
      background: var(--card);
      color: var(--ink);
    }
    pre {
      padding: 14px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--code-bg);
      overflow-x: auto;
    }
    pre code {
      padding: 0;
      background: transparent;
      font-size: 13px;
      line-height: 1.6;
    }
    blockquote {
      padding: 8px 14px;
      border-left: 3px solid var(--accent);
      background: var(--card);
      border-radius: 0 6px 6px 0;
      color: var(--ink-2);
    }
    hr {
      border: 0;
      border-top: 1px solid var(--border);
      margin: 1.6em 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 12px;
      text-align: left;
    }
    th {
      background: var(--card);
      color: var(--ink);
      font-weight: 600;
    }
    .md-empty {
      color: var(--muted);
      font-style: italic;
    }
  </style>
</head>
<body>
  <article class="md-article">
    ${renderedBody || '<p class="md-empty">Este archivo Markdown está vacío.</p>'}
  </article>
</body>
</html>`;
}

export function renderMarkdownDocumentHtml(rawMd) {
  const blocks = [];
  const fenceRe = /```([^\r\n]*)\r?\n?([\s\S]*?)```/g;
  let cursor = 0;
  let m;

  while ((m = fenceRe.exec(rawMd)) !== null) {
    if (m.index > cursor) {
      blocks.push({ type: "prose", text: rawMd.slice(cursor, m.index) });
    }
    const rawHeader = (m[1] || "").trim();
    const lang = (rawHeader.split(/\s+/)[0] || "").toLowerCase();
    blocks.push({ type: "code", lang, code: m[2].replace(/\n$/, "") });
    cursor = fenceRe.lastIndex;
  }
  if (cursor < rawMd.length) {
    blocks.push({ type: "prose", text: rawMd.slice(cursor) });
  }

  return blocks
    .map((b) => {
      if (b.type === "code") {
        return `<pre><code>${escapeHtmlText(b.code)}</code></pre>`;
      }
      return renderMarkdownProseBlock(b.text);
    })
    .join("\n");
}

function renderMarkdownProseBlock(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [];
  let listTag = null;
  let listItems = [];
  let tableRows = [];

  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${para.map(formatMdInline).join("<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listTag && listItems.length > 0) {
      out.push(`<${listTag}>${listItems.join("")}</${listTag}>`);
      listTag = null;
      listItems = [];
    }
  };
  const flushTable = () => {
    if (tableRows.length === 0) return;
    const parsed = tableRows.map((r) =>
      r
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
    );
    const hasSep = parsed.length >= 2 && parsed[1].every((c) => /^:?-{2,}:?$/.test(c));
    const head = parsed[0];
    const body = hasSep ? parsed.slice(2) : parsed.slice(1);
    const thead = `<thead><tr>${head.map((h) => `<th>${formatMdInline(h)}</th>`).join("")}</tr></thead>`;
    const tbody =
      body.length > 0
        ? `<tbody>${body.map((row) => `<tr>${row.map((c) => `<td>${formatMdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`
        : "";
    out.push(`<table>${thead}${tbody}</table>`);
    tableRows = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      flushList();
      flushTable();
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushPara();
      flushList();
      tableRows.push(trimmed);
      continue;
    }
    flushTable();

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      flushList();
      out.push("<hr>");
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      flushPara();
      flushList();
      const lvl = hMatch[1].length;
      out.push(`<h${lvl}>${formatMdInline(hMatch[2])}</h${lvl}>`);
      continue;
    }

    const qMatch = trimmed.match(/^>\s?(.*)$/);
    if (qMatch) {
      flushPara();
      flushList();
      out.push(`<blockquote>${formatMdInline(qMatch[1])}</blockquote>`);
      continue;
    }

    const ulMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushPara();
      if (listTag && listTag !== "ul") flushList();
      listTag = "ul";
      listItems.push(`<li>${formatMdInline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      flushPara();
      if (listTag && listTag !== "ol") flushList();
      listTag = "ol";
      listItems.push(`<li>${formatMdInline(olMatch[1])}</li>`);
      continue;
    }

    flushList();
    para.push(line);
  }

  flushPara();
  flushList();
  flushTable();
  return out.join("\n");
}

export function formatMdInline(str) {
  const codes = [];
  const cleanStr = String(str ?? "").replace(/\u0000/g, "");
  const masked = cleanStr.replace(/`([^`]+)`/g, (_, c) => {
    const i = codes.length;
    codes.push(`<code>${escapeHtmlText(c)}</code>`);
    return `\u0000C${i}\u0000`;
  });

  let safe = escapeHtmlText(masked);
  safe = safe.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  safe = safe.replace(/\[([^\]]+)\]\((#[a-zA-Z0-9_-]+)\)/g, '<a href="$2">$1</a>');
  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  safe = safe.replace(/\u0000C(\d+)\u0000/g, (_, i) => codes[Number(i)] || "");
  return safe;
}
