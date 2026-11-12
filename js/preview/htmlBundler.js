import { normalizePath } from "../storage/workspaceDb.js";
import { getImageMimeType, IMAGE_EXTENSIONS } from "../storage/fileImport.js";
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
  inspectModuleUsage,
  isRelativeModuleSpecifier,
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
  const shortNameEntries = [];
  const shortNameCounts = new Map();

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
      if (baseName) {
        shortNameCounts.set(baseName, (shortNameCounts.get(baseName) || 0) + 1);
        shortNameEntries.push([baseName, f]);
      }
    }
  }

  // Registrar atajos `shortName` solo si no colisionan ni ocultan rutas exactas
  for (const [baseName, file] of shortNameEntries) {
    if (!map.has(baseName) && shortNameCounts.get(baseName) === 1) {
      map.set(baseName, file);
    }
  }

  return map;
}

/**
 * Extrae todas las rutas relativas de hojas CSS, scripts JS, imágenes y recursos referenciados por el HTML.
 */
export function extractReferencedAssetPaths(entryPath, rawHtml, options = {}) {
  if (!rawHtml || typeof rawHtml !== "string") return [];
  const dir = getParentFolder(entryPath);
  const paths = new Set();
  const includeMedia = Boolean(options?.includeMedia);

  const addCandidateRef = (rawRef) => {
    if (!rawRef || typeof rawRef !== "string") return;
    const clean = rawRef.trim().split("?")[0].split("#")[0];
    if (!clean || /^(https?:|data:|blob:|\/\/|#)/i.test(clean)) return;
    const resolved = resolveRelativePath(dir, clean);
    if (resolved) paths.add(resolved);
    const rootClean = normalizePath(clean);
    if (rootClean) paths.add(rootClean);
  };

  // 1. <link rel="stylesheet"> (o iconos favoritos si includeMedia es true)
  const linkRegex = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(rawHtml)) !== null) {
    const isStyle = /\brel=["']stylesheet["']/i.test(match[0]);
    const isIcon = includeMedia && /\brel=["'](?:icon|shortcut\s+icon|apple-touch-icon)["']/i.test(match[0]);
    if (isStyle || isIcon) {
      const hrefMatch = match[0].match(/href=["']([^"']+)["']/i);
      if (hrefMatch && hrefMatch[1]) addCandidateRef(hrefMatch[1]);
    }
  }

  // 2. <script src="...">
  const scriptRegex = /<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((match = scriptRegex.exec(rawHtml)) !== null) {
    if (match[1]) addCandidateRef(match[1]);
  }

  if (includeMedia) {
    // 3. <img src="...">, <source src="...">, <input src="...">
    const mediaSrcRegex = /<(?:img|source|input)\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
    while ((match = mediaSrcRegex.exec(rawHtml)) !== null) {
      if (match[1]) addCandidateRef(match[1]);
    }

    // 4. srcset="..." en <img> y <source>
    const srcsetRegex = /\bsrcset=["']([^"']+)["']/gi;
    while ((match = srcsetRegex.exec(rawHtml)) !== null) {
      const entries = match[1].split(",");
      for (const e of entries) {
        const url = e.trim().split(/\s+/)[0];
        if (url) addCandidateRef(url);
      }
    }

    // 5. <video poster="...">
    const videoRegex = /<video\b[^>]*poster=["']([^"']+)["'][^>]*>/gi;
    while ((match = videoRegex.exec(rawHtml)) !== null) {
      if (match[1]) addCandidateRef(match[1]);
    }

    // 6. <image href="..." xlink:href="..."> en SVG
    const svgImgRegex = /<image\b[^>]*\b(?:xlink:)?href=["']([^"']+)["'][^>]*>/gi;
    while ((match = svgImgRegex.exec(rawHtml)) !== null) {
      if (match[1]) addCandidateRef(match[1]);
    }

    // 7. url(...) en estilos inline o bloques <style>
    const urlRegex = /url\(\s*(?:["']([^"']+)["']|([^"')]+))\s*\)/gi;
    while ((match = urlRegex.exec(rawHtml)) !== null) {
      const url = match[1] || match[2];
      if (url) addCandidateRef(url);
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
function extractBalancedCssFunction(conditions, keyword) {
  const re = new RegExp(`\\b${keyword}\\(`, "i");
  const match = re.exec(conditions);
  if (!match) {
    return null;
  }
  const startIdx = match.index;
  const openParenIdx = startIdx + match[0].length - 1;
  let depth = 1;
  let p = openParenIdx + 1;
  let quote = null;
  while (p < conditions.length && depth > 0) {
    const ch = conditions[p];
    if (quote) {
      if (ch === "\\") {
        p += 2;
        continue;
      }
      if (ch === quote) quote = null;
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          const inner = conditions.slice(openParenIdx + 1, p).trim();
          const rest = (conditions.slice(0, startIdx) + conditions.slice(p + 1)).trim();
          return { inner, rest };
        }
      }
    }
    p += 1;
  }
  return null;
}

export function parseCssImportConditions(rawConditions) {
  let conditions = (rawConditions || "").trim();
  let layerClause = "";
  let supportsCondition = "";
  let mediaQueries = "";

  if (!conditions) {
    return { layerClause, supportsCondition, mediaQueries };
  }

  // 1. Extraer layer(...) o layer
  const extractedLayer = extractBalancedCssFunction(conditions, "layer");
  if (extractedLayer) {
    layerClause = extractedLayer.inner ? `@layer ${extractedLayer.inner}` : `@layer`;
    conditions = extractedLayer.rest;
  } else {
    const layerBareMatch = conditions.match(/\blayer\b/i);
    if (layerBareMatch) {
      layerClause = `@layer`;
      conditions = conditions.replace(layerBareMatch[0], "").trim();
    }
  }

  // 2. Extraer supports(...) soportando paréntesis anidados p. ej. supports((a) and (b))
  const extractedSupports = extractBalancedCssFunction(conditions, "supports");
  if (extractedSupports) {
    supportsCondition = extractedSupports.inner;
    conditions = extractedSupports.rest;
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
  // Ignorar comentarios /* ... */ para no extraer @import comentados
  const importRegex =
    /(\/\*[\s\S]*?\*\/)|@import\s+(?:url\(\s*(?:["']([^"']+)["']|([^"')]+))\s*\)|["']([^"']+)["'])([^;]*);?/gi;
  let match;
  while ((match = importRegex.exec(cssContent)) !== null) {
    if (match[1]) continue;
    const importUrl = match[2] || match[3] || match[4];
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
  function normalizeNavRef(ref) {
    return String(ref == null ? "" : ref).replace(/[\\u0000-\\u001f\\u007f]+/g, "").trim().toLowerCase();
  }
  function isBlockedNavScheme(normRef) {
    return /^(javascript:|vbscript:|data:)/.test(normRef);
  }
  // Interceptor total de navegación local en enlaces
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href) return;
    var normHref = normalizeNavRef(href);
    if (isBlockedNavScheme(normHref)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (normHref.startsWith("#")) return;
    if (/^(https?:|mailto:|tel:|blob:)/.test(normHref)) {
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
    if (!action) return;
    var normAction = normalizeNavRef(action);
    if (isBlockedNavScheme(normAction)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (normAction.startsWith("#") || /^(https?:|mailto:|tel:)/.test(normAction)) return;
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
      var normTarget = normalizeNavRef(targetUrl);
      if (!normTarget || isBlockedNavScheme(normTarget)) return;
      if (normTarget.startsWith("#") || /^(https?:|mailto:|tel:)/.test(normTarget)) {
        window.open(targetUrl, "_blank", "noopener,noreferrer");
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

  const escapesDirectoryScope = (rawRef) => {
    const unified = String(rawRef || "").trim().replace(/\\/g, "/");
    if (!unified || unified.startsWith("/")) return false;
    let depth = 0;
    for (const seg of unified.split("/")) {
      const part = seg.trim();
      if (!part || part === ".") continue;
      if (part === "..") {
        depth -= 1;
        if (depth < 0) return true;
      } else {
        depth += 1;
      }
    }
    return false;
  };

  const resolveEntryFromDir = (rawHref, baseDir) => {
    if (!rawHref || /^(https?:|data:|blob:|#|\/\/)/i.test(rawHref)) {
      return null;
    }
    const cleanRef = rawHref.split("?")[0].split("#")[0];
    if (!cleanRef) {
      return null;
    }
    if (escapesDirectoryScope(cleanRef) && !allowParentTraversal) {
      return null;
    }
    const resolved = resolveRelativePath(baseDir, cleanRef);
    let asset = fileMap.get(resolved) || null;
    if (!asset && cleanRef.startsWith("./")) {
      asset = fileMap.get(resolveRelativePath(baseDir, cleanRef.slice(2))) || null;
    }
    if (!asset && !cleanRef.startsWith("/") && !cleanRef.startsWith("./") && !cleanRef.startsWith("../")) {
      const candidate = fileMap.get(normalizePath(cleanRef)) || null;
      if (candidate) {
        const candPath = normalizePath(candidate.path || "");
        if (!baseDir || allowParentTraversal || candPath.startsWith(`${baseDir}/`)) {
          asset = candidate;
        }
      }
    }
    return asset || null;
  };

  const resolveRawEntry = (rawHref) => resolveEntryFromDir(rawHref, dir);

  const resolveAsset = (rawHref) => {
    const asset = resolveRawEntry(rawHref);
    if (!asset || typeof asset.content !== "string") {
      return null;
    }
    return asset;
  };

  let inlinedActiveJs = false;
  let inlinedActiveCss = false;
  const deferredScripts = [];
  let totalInlinedCssBytes = 0;

  function resolveCssAssetMime(filePath) {
    const ext = getFileExtension(filePath || "");
    if (ext === "woff2") return "font/woff2";
    if (ext === "woff") return "font/woff";
    if (ext === "ttf") return "font/ttf";
    if (ext === "otf") return "font/otf";
    if (ext === "eot") return "application/vnd.ms-fontobject";
    return getImageMimeType(filePath);
  }

  function inlineCssUrls(cssText, cssDir) {
    return String(cssText || "").replace(
      /(\/\*[\s\S]*?\*\/)|url\(\s*(?:(["'])([^"']+)\2|([^)"'\s]+))\s*\)/gi,
      (fullMatch, commentBlock, _quote, quotedUrl, bareUrl) => {
        if (commentBlock) {
          return commentBlock;
        }
        const rawUrl = (quotedUrl || bareUrl || "").trim();
        const entry = resolveEntryFromDir(rawUrl, cssDir);
        if (!entry) {
          return fullMatch;
        }
        const ext = getFileExtension(entry.path || rawUrl);
        const b64Payload =
          typeof entry.base64 === "string" && entry.base64.length > 0
            ? entry.base64
            : entry.isBinary && typeof entry.content === "string" && entry.content.length > 0
              ? entry.content
              : null;
        if (b64Payload) {
          const mime = resolveCssAssetMime(entry.path || rawUrl);
          return `url("data:${mime};base64,${b64Payload}")`;
        }
        if (ext === "svg" && typeof entry.content === "string" && entry.content.trim().length > 0) {
          const encodedSvg = encodeURIComponent(entry.content)
            .replace(/'/g, "%27")
            .replace(/"/g, "%22");
          return `url("data:image/svg+xml;charset=utf-8,${encodedSvg}")`;
        }
        return fullMatch;
      }
    );
  }

  const escapeCommentBody = (txt) => String(txt || "").replace(/\*\//g, "* /");

  /**
   * Incrusta recursivamente directivas CSS `@import` locales resolviéndolas desde la memoria del bundle,
   * preservando condiciones complejas (@media, @layer, @supports), usando pila `ancestors` para ciclos reales
   * y aplicando límites estrictos de tamaño.
   *
   * @param {string} cssContent
   * @param {string} cssPath
   * @param {Set<string>} [ancestors]
   * @returns {string}
   */
  function inlineCssImports(cssContent, cssPath, ancestors = new Set()) {
    const cleanPath = normalizePath(cssPath);
    if (ancestors.has(cleanPath)) return "";
    ancestors.add(cleanPath);

    try {
      const cssDir = getParentFolder(cleanPath);
      const importRegex =
        /(\/\*[\s\S]*?\*\/)|@import\s+(?:url\(\s*(?:["']([^"']+)["']|([^"')]+))\s*\)|["']([^"']+)["'])([^;]*);?/gi;

      const withImports = cssContent.replace(
        importRegex,
        (match, commentBlock, urlGroup1, urlGroup2, urlGroup3, rawConditions) => {
          if (commentBlock) {
            return commentBlock;
          }
          const importUrl = urlGroup1 || urlGroup2 || urlGroup3;
          if (!importUrl || /^(https?:|data:|blob:|\/\/)/i.test(importUrl)) {
            return match;
          }
          const cleanRef = importUrl.split("?")[0].split("#")[0];
          const safeRefComment = escapeCommentBody(cleanRef);
          const importedAsset = resolveEntryFromDir(importUrl, cssDir);

          if (!importedAsset || typeof importedAsset.content !== "string") {
            return match;
          }

          // 1. Control de límite de tamaño por recurso individual
          if (importedAsset.content.length > MAX_PREVIEW_ASSET_BYTES) {
            return `/* [Studio IDE]: @import "${safeRefComment}" omitido: excede el límite de tamaño individual (${importedAsset.content.length} bytes > ${MAX_PREVIEW_ASSET_BYTES} bytes) */`;
          }

          // 2. Control de presupuesto total acumulado de CSS inlined
          if (totalInlinedCssBytes + importedAsset.content.length > MAX_TOTAL_INLINED_CSS) {
            return `/* [Studio IDE]: @import "${safeRefComment}" omitido: presupuesto total de CSS superado */`;
          }

          totalInlinedCssBytes += importedAsset.content.length;

          // 3. Resolución recursiva de dependencias hijas
          const inlinedChild = inlineCssImports(importedAsset.content, importedAsset.path, ancestors);

          // 4. Extracción y preservación de condiciones (layer, supports, media)
          const conds = parseCssImportConditions(rawConditions);
          const cleanConditionsStr = escapeCommentBody((rawConditions || "").trim());
          const headerComment = `/* @import "${safeRefComment}"${cleanConditionsStr ? " " + cleanConditionsStr : ""} */`;

          return wrapCssWithConditions(inlinedChild, {
            ...conds,
            commentHeader: headerComment
          });
        }
      );

      return inlineCssUrls(withImports, cssDir);
    } finally {
      ancestors.delete(cleanPath);
    }
  }

  const escapeCloseStyle = (css) => css.replace(/<\/style(?=[\s>/]|$)/gi, "<\\/style");
  const escapeCloseScript = (js) => js.replace(/<\/script(?=[\s>/]|$)/gi, "<\\/script");

  const SCRIPT_REGEX_KEYWORDS = new Set([
    "return",
    "throw",
    "case",
    "default",
    "delete",
    "void",
    "typeof",
    "await",
    "yield",
    "in",
    "instanceof",
    "of",
    "new",
    "else",
    "do"
  ]);

  function scanScriptOpenTagEnd(src, fromIdx) {
    let p = fromIdx;
    let quote = null;
    while (p < src.length) {
      const ch = src[p];
      if (quote) {
        if (ch === quote) quote = null;
        p += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        p += 1;
        continue;
      }
      if (ch === ">") return p;
      p += 1;
    }
    return -1;
  }

  function scanScriptCloseTag(src, bodyStart, isJsLike) {
    if (!isJsLike) {
      const rest = src.slice(bodyStart);
      const m = /<\/script(?:\s[^>]*)?>/i.exec(rest);
      if (!m) return null;
      return { bodyEnd: bodyStart + m.index, tagEnd: bodyStart + m.index + m[0].length };
    }

    let p = bodyStart;
    let lastSig = { kind: "start", value: "" };
    const tplDepthStack = [];

    const skipQuoted = (start, q) => {
      let j = start + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === q) return j + 1;
        j += 1;
      }
      return src.length;
    };

    const canRegex = () => {
      if (lastSig.kind === "start") return true;
      if (lastSig.kind === "op") return lastSig.value !== "++" && lastSig.value !== "--";
      if (lastSig.kind === "ident") return SCRIPT_REGEX_KEYWORDS.has(lastSig.value);
      return false;
    };

    const skipRegex = (start) => {
      let j = start + 1;
      let inClass = false;
      while (j < src.length) {
        const rc = src[j];
        if (rc === "\\") {
          j += 2;
          continue;
        }
        if (rc === "[") inClass = true;
        else if (rc === "]") inClass = false;
        else if (rc === "/" && !inClass) {
          j += 1;
          break;
        } else if (rc === "\n") {
          break;
        }
        j += 1;
      }
      while (j < src.length && /[a-z]/i.test(src[j])) j += 1;
      return j;
    };

    while (p < src.length) {
      if (tplDepthStack.length > 0 && tplDepthStack[tplDepthStack.length - 1] === 0) {
        const tc = src[p];
        if (tc === "\\") {
          p += 2;
          continue;
        }
        if (tc === "`") {
          tplDepthStack.pop();
          lastSig = { kind: "literal", value: "`" };
          p += 1;
          continue;
        }
        if (tc === "$" && src[p + 1] === "{") {
          tplDepthStack[tplDepthStack.length - 1] = 1;
          lastSig = { kind: "op", value: "{" };
          p += 2;
          continue;
        }
        p += 1;
        continue;
      }

      const ch = src[p];
      if (ch === "<" && src[p + 1] === "/" && tplDepthStack.length === 0) {
        const closeMatch = /^<\/script(?:\s[^>]*)?>/i.exec(src.slice(p, Math.min(src.length, p + 256)));
        if (closeMatch) {
          return { bodyEnd: p, tagEnd: p + closeMatch[0].length };
        }
      }

      if (/\s/.test(ch)) {
        p += 1;
        continue;
      }
      if (ch === "/" && src[p + 1] === "/") {
        const nl = src.indexOf("\n", p + 2);
        p = nl === -1 ? src.length : nl + 1;
        continue;
      }
      if (ch === "/" && src[p + 1] === "*") {
        const endC = src.indexOf("*/", p + 2);
        p = endC === -1 ? src.length : endC + 2;
        continue;
      }
      if (ch === "'" || ch === '"') {
        p = skipQuoted(p, ch);
        lastSig = { kind: "literal", value: ch };
        continue;
      }
      if (ch === "`") {
        tplDepthStack.push(0);
        p += 1;
        continue;
      }
      if (ch === "/" && canRegex()) {
        p = skipRegex(p);
        lastSig = { kind: "literal", value: "/" };
        continue;
      }
      if (ch === "{") {
        if (tplDepthStack.length > 0) {
          tplDepthStack[tplDepthStack.length - 1] += 1;
        }
        lastSig = { kind: "op", value: "{" };
        p += 1;
        continue;
      }
      if (ch === "}") {
        if (tplDepthStack.length > 0) {
          tplDepthStack[tplDepthStack.length - 1] -= 1;
        }
        lastSig = { kind: "close", value: "}" };
        p += 1;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = p + 1;
        while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
        lastSig = { kind: "ident", value: src.slice(p, j) };
        p = j;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        let j = p + 1;
        while (j < src.length && /[0-9A-Za-z._]/.test(src[j])) j += 1;
        lastSig = { kind: "literal", value: "0" };
        p = j;
        continue;
      }
      if (ch === ")" || ch === "]") {
        lastSig = { kind: "close", value: ch };
        p += 1;
      } else if ((ch === "+" && src[p + 1] === "+") || (ch === "-" && src[p + 1] === "-")) {
        lastSig = { kind: "op", value: ch + ch };
        p += 2;
      } else {
        lastSig = { kind: "op", value: ch };
        p += 1;
      }
    }
    return null;
  }

  function maskHtmlScripts(src) {
    let prefix = "__STUDIO_SCRIPT_MASK_";
    while (src.includes(prefix)) prefix += "X";

    const entries = [];
    const chunks = [];
    let cursor = 0;

    while (cursor < src.length) {
      const commentIdx = src.indexOf("<!--", cursor);
      const scriptRe = /<script(?=[\s>])/gi;
      scriptRe.lastIndex = cursor;
      const scriptMatch = scriptRe.exec(src);
      if (!scriptMatch) break;

      if (commentIdx !== -1 && commentIdx < scriptMatch.index) {
        const endComment = src.indexOf("-->", commentIdx + 4);
        const nextPos = endComment === -1 ? src.length : endComment + 3;
        chunks.push(src.slice(cursor, nextPos));
        cursor = nextPos;
        continue;
      }

      const ltIdx = scriptMatch.index;
      const openEnd = scanScriptOpenTagEnd(src, ltIdx + 7);
      if (openEnd === -1) break;

      const attrs = src.slice(ltIdx + 7, openEnd);
      const bodyStart = openEnd + 1;
      const hasSrc = /\bsrc\s*=\s*["'][^"']+["']/i.test(attrs);
      const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']*)["']/i);
      const typeVal = typeMatch ? typeMatch[1].trim().toLowerCase() : "";
      const isJsLike =
        !hasSrc &&
        (!typeVal ||
          typeVal === "module" ||
          typeVal === "text/javascript" ||
          typeVal === "application/javascript" ||
          typeVal === "text/typescript" ||
          typeVal === "application/typescript" ||
          typeVal === "text/tsx" ||
          typeVal === "text/jsx" ||
          typeVal === "text/babel");

      const closeRes = scanScriptCloseTag(src, bodyStart, isJsLike);
      if (!closeRes) break;

      const idx = entries.length;
      entries.push({
        fullTag: src.slice(ltIdx, closeRes.tagEnd),
        attrs,
        inlineCode: src.slice(bodyStart, closeRes.bodyEnd)
      });
      chunks.push(src.slice(cursor, ltIdx), `${prefix}${idx}__`);
      cursor = closeRes.tagEnd;
    }

    chunks.push(src.slice(cursor));
    return { maskedHtml: chunks.join(""), entries, prefix };
  }

  // Enmascarar <script>...</script> antes de transformar <style>/<link>/<img> para no alterar strings JS
  const { maskedHtml, entries: scriptEntries, prefix: scriptMaskPrefix } = maskHtmlScripts(rawHtml);

  let html = maskedHtml.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_fullTag, attrs, cssBody) => {
    const safeCss = escapeCloseStyle(inlineCssImports(cssBody, entryPath));
    return `<style${attrs}>${safeCss}</style>`;
  });

  html = html.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
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
    const safeCss = escapeCloseStyle(inlineCssImports(asset.content, asset.path));
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
      const safeExtraCss = escapeCloseStyle(inlineCssImports(cssContent, cssPath));
      const styleTag = `<style data-source="${escapeAttr(cssPath)}">\n${safeExtraCss}\n</style>`;
      if (/<head\b[^>]*>/i.test(html)) {
        html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${styleTag}`);
      } else {
        html = `${styleTag}\n${html}`;
      }
    }
  }

  function resolveEntryToDataUrl(rawUrl, baseDir = dir) {
    if (!rawUrl || typeof rawUrl !== "string") return null;
    const cleanUrl = rawUrl.trim();
    if (!cleanUrl || /^(https?:|data:|blob:|#|\/\/)/i.test(cleanUrl)) return null;
    const entry = resolveEntryFromDir(cleanUrl, baseDir);
    if (!entry) return null;
    const ext = getFileExtension(entry.path || cleanUrl);
    const b64Payload = typeof entry.base64 === "string" && entry.base64.length > 0
      ? entry.base64
      : entry.isBinary && typeof entry.content === "string" && entry.content.length > 0
        ? entry.content
        : null;
    if (b64Payload) {
      const mime = getImageMimeType(entry.path || cleanUrl);
      return `data:${mime};base64,${b64Payload}`;
    }
    if (ext === "svg" && typeof entry.content === "string" && entry.content.trim().length > 0) {
      const encodedSvg = encodeURIComponent(entry.content)
        .replace(/'/g, "%27")
        .replace(/"/g, "%22");
      return `data:image/svg+xml;charset=utf-8,${encodedSvg}`;
    }
    return null;
  }

  function inlineSrcsetString(rawSrcset, baseDir = dir) {
    if (!rawSrcset || typeof rawSrcset !== "string") return rawSrcset;
    return rawSrcset.replace(/([^\s,]+)(\s+[^\s,]+)?/g, (match, url, descriptor) => {
      const dataUrl = resolveEntryToDataUrl(url, baseDir);
      if (dataUrl) {
        return descriptor ? `${dataUrl}${descriptor}` : dataUrl;
      }
      return match;
    });
  }

  // Incrustar imágenes locales (<img src="...">) almacenadas en Base64 o SVG dentro del proyecto
  html = html.replace(/<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi, (fullTag, beforeSrc, quote, rawSrc, afterSrc) => {
    const dataUrl = resolveEntryToDataUrl(rawSrc);
    if (dataUrl) {
      return `<img${beforeSrc}src=${quote}${dataUrl}${quote}${afterSrc}>`;
    }
    return fullTag;
  });

  // Incrustar srcset en <img> y <source>
  html = html.replace(/\bsrcset=(["'])([^"']+)\1/gi, (fullAttr, quote, rawSrcset) => {
    const inlined = inlineSrcsetString(rawSrcset);
    return `srcset=${quote}${inlined}${quote}`;
  });

  // Incrustar fuentes alternativas <source src="...">
  html = html.replace(/<source\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi, (fullTag, beforeSrc, quote, rawSrc, afterSrc) => {
    const dataUrl = resolveEntryToDataUrl(rawSrc);
    if (dataUrl) {
      return `<source${beforeSrc}src=${quote}${dataUrl}${quote}${afterSrc}>`;
    }
    return fullTag;
  });

  // Incrustar iconos favoritos (<link rel="icon|apple-touch-icon" href="...">)
  html = html.replace(/<link\b([^>]*?)\bhref=(["'])([^"']+)\2([^>]*)>/gi, (fullTag, beforeHref, quote, rawHref, afterHref) => {
    if (!/\brel=(["'])(?:shortcut\s+icon|icon|apple-touch-icon)\1/i.test(fullTag)) {
      return fullTag;
    }
    const dataUrl = resolveEntryToDataUrl(rawHref);
    if (dataUrl) {
      return `<link${beforeHref}href=${quote}${dataUrl}${quote}${afterHref}>`;
    }
    return fullTag;
  });

  // Incrustar posters de video (<video poster="...">)
  html = html.replace(/<video\b([^>]*?)\bposter=(["'])([^"']+)\2([^>]*)>/gi, (fullTag, beforePoster, quote, rawPoster, afterPoster) => {
    const dataUrl = resolveEntryToDataUrl(rawPoster);
    if (dataUrl) {
      return `<video${beforePoster}poster=${quote}${dataUrl}${quote}${afterPoster}>`;
    }
    return fullTag;
  });

  // Incrustar inputs de tipo imagen (<input type="image" src="...">)
  html = html.replace(/<input\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi, (fullTag, beforeSrc, quote, rawSrc, afterSrc) => {
    if (!/\btype=(["'])image\1/i.test(fullTag)) return fullTag;
    const dataUrl = resolveEntryToDataUrl(rawSrc);
    if (dataUrl) {
      return `<input${beforeSrc}src=${quote}${dataUrl}${quote}${afterSrc}>`;
    }
    return fullTag;
  });

  // Incrustar imágenes SVG (<image href="..." xlink:href="...">)
  html = html.replace(/<image\b([^>]*?)\b(?:xlink:)?href=(["'])([^"']+)\2([^>]*)>/gi, (fullTag, beforeHref, quote, rawHref, afterHref) => {
    const dataUrl = resolveEntryToDataUrl(rawHref);
    if (dataUrl) {
      return `<image${beforeHref}href=${quote}${dataUrl}${quote}${afterHref}>`;
    }
    return fullTag;
  });

  // Incrustar imágenes en atributos de estilo inline: style="...url('...')..."
  html = html.replace(/\bstyle=(["'])([\s\S]*?)\1/gi, (fullAttr, quote, styleBody) => {
    if (!styleBody || !styleBody.includes("url(")) return fullAttr;
    const inlined = inlineCssUrls(styleBody, dir);
    const safeInlined = quote === '"' ? inlined.replace(/"/g, "'") : inlined.replace(/'/g, '"');
    return `style=${quote}${safeInlined}${quote}`;
  });

  const exactModuleMap = buildExactModuleMap(fileMap);
  let inlineScriptCounter = 0;

  function compileScriptContent(rawCode, sourcePath, explicitType = "", isModule = false, pretranspiled = null) {
    let executable;
    if (typeof pretranspiled === "string") {
      executable = pretranspiled;
    } else {
      const ext = getFileExtension(sourcePath || "");
      const t = String(explicitType || "").trim().toLowerCase();
      const isTsOrJsxType =
        t === "text/typescript" ||
        t === "application/typescript" ||
        t === "text/tsx" ||
        t === "text/jsx" ||
        t === "text/babel";
      const needsTranspile = TS_EXTENSIONS.has(ext) || ext === "jsx" || isTsOrJsxType;
      executable = String(rawCode || "");
      if (needsTranspile) {
        const enableJsx = ext === "tsx" || ext === "jsx" || t === "text/tsx" || t === "text/jsx" || t === "text/babel";
        executable = transpileTypeScriptAndJsx(executable, {
          jsx: enableJsx,
          fileName: sourcePath || "inline.tsx"
        }).code;
      }
    }
    const rendered = typeof transformJs === "function" ? transformJs(executable, isModule) : executable;
    return escapeCloseScript(rendered);
  }

  function hasRelativeDepsInUsage(usage) {
    for (const spec of usage.staticImports) {
      if (isRelativeModuleSpecifier(spec)) return true;
    }
    for (const spec of usage.dynamicLocalImports) {
      if (isRelativeModuleSpecifier(spec)) return true;
    }
    return false;
  }

  function tryBundleLocalModules(rawCode, sourcePath, pretranspiled = null) {
    if (exactModuleMap.size === 0) return null;
    const ext = getFileExtension(sourcePath || "");
    let jsCode = typeof pretranspiled === "string" ? pretranspiled : String(rawCode || "");
    if (typeof pretranspiled !== "string" && (TS_EXTENSIONS.has(ext) || ext === "jsx")) {
      jsCode = transpileTypeScriptAndJsx(jsCode, {
        jsx: ext === "tsx" || ext === "jsx",
        fileName: sourcePath || "entry.tsx"
      }).code;
    }
    const usage = inspectModuleUsage(jsCode);
    if (!hasRelativeDepsInUsage(usage)) {
      return null;
    }
    const bundle = buildVirtualModuleBundle({
      entryPath: sourcePath,
      entryCode: rawCode,
      exactMap: exactModuleMap,
      transformJs,
      transformCss: (cssText, cssPath) => inlineCssImports(cssText, cssPath),
      allowParentTraversal,
      precompiledEntryCode: jsCode,
      precomputedEntryUsage: usage
    });
    return formatVirtualModuleExecution(bundle);
  }

  function processScannedScript({ fullTag, attrs, inlineCode }) {
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
      const virtualExt =
        type === "text/tsx"
          ? "tsx"
          : type === "text/typescript" || type === "application/typescript"
            ? "ts"
            : type === "text/jsx" || type === "text/babel"
              ? "jsx"
              : "js";
      const virtualPath = resolveRelativePath(dir, `__inline_${inlineScriptCounter++}.${virtualExt}`);
      const needsTs = TS_EXTENSIONS.has(virtualExt) || virtualExt === "jsx";
      const precompiled = needsTs
        ? transpileTypeScriptAndJsx(inlineCode, {
            jsx: virtualExt === "tsx" || virtualExt === "jsx",
            fileName: virtualPath
          }).code
        : inlineCode;
      const bundledExec = tryBundleLocalModules(inlineCode, virtualPath, precompiled);
      if (bundledExec) {
        const modAttr = bundledExec.isModuleTag ? ' type="module"' : "";
        return `<script${modAttr}>\n${bundledExec.scriptCode}\n</script>`;
      }
      const safeInline = compileScriptContent(inlineCode, virtualPath, type, isMod, precompiled);
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
    const ext = getFileExtension(asset.path || "");
    const precompiled =
      TS_EXTENSIONS.has(ext) || ext === "jsx"
        ? transpileTypeScriptAndJsx(asset.content || "", {
            jsx: ext === "tsx" || ext === "jsx",
            fileName: asset.path
          }).code
        : asset.content;
    const bundledExec = tryBundleLocalModules(asset.content, asset.path, precompiled);
    if (bundledExec) {
      const modAttr = bundledExec.isModuleTag ? ' type="module"' : "";
      const scriptTag = `<script${modAttr} data-source="${escapeAttr(asset.path)}">\n${bundledExec.scriptCode}\n</script>`;
      if (isModule || hasDefer) {
        deferredScripts.push(scriptTag);
        return "";
      }
      return scriptTag;
    }

    const safeJs = compileScriptContent(asset.content, asset.path, "", isModule, precompiled);

    if (!isModule && hasDefer) {
      deferredScripts.push(`<script data-source="${escapeAttr(asset.path)}">\n${safeJs}\n</script>`);
      return "";
    }

    return `<script${isModule ? ' type="module"' : ""} data-source="${escapeAttr(asset.path)}">\n${safeJs}\n</script>`;
  }

  if (scriptEntries.length > 0) {
    const maskRe = new RegExp(`${scriptMaskPrefix}(\\d+)__`, "g");
    html = html.replace(maskRe, (_, idxStr) => processScannedScript(scriptEntries[Number(idxStr)]));
  }

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
  let usesLocalModules = false;
  if (exactMap.size > 0) {
    for (const spec of moduleUsage.staticImports) {
      if (isRelativeModuleSpecifier(spec)) {
        usesLocalModules = true;
        break;
      }
    }
    if (!usesLocalModules) {
      for (const spec of moduleUsage.dynamicLocalImports) {
        if (isRelativeModuleSpecifier(spec)) {
          usesLocalModules = true;
          break;
        }
      }
    }
  }
  const isModule = Boolean(!usesLocalModules && (moduleUsage.hasModuleSyntax || moduleUsage.hasTopLevelAwait));
  const safeName = escapeHtmlText(jsFile.path);

  let scriptSnippet = "";
  if (usesLocalModules) {
    const bundle = buildVirtualModuleBundle({
      entryPath: jsFile.path,
      entryCode: jsFile.content,
      exactMap,
      transformJs,
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
    const safeJs = transformJs(jsFile.content, isModule).replace(/<\/script(?=[\s>/]|$)/gi, "<\\/script");
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

export { IMAGE_EXTENSIONS };

/**
 * Genera el documento HTML interactivo para la previsualización directa de imágenes.
 * Soporta PNG, JPEG, GIF, WebP, SVG, AVIF, BMP e ICO con cuadrícula de transparencia y controles de zoom.
 */
export function buildStandaloneImagePreview(imageFile) {
  const ext = getFileExtension(imageFile?.path || "");
  const mime = getImageMimeType(imageFile?.path || "");
  const safeName = escapeHtmlText(imageFile?.shortName || imageFile?.path || "Imagen");
  const b64 = typeof imageFile?.base64 === "string" && imageFile.base64.length > 0
    ? imageFile.base64
    : imageFile?.isBinary && typeof imageFile.content === "string" && imageFile.content.length > 0
      ? imageFile.content
      : null;

  let imgSrc = "";
  if (b64) {
    imgSrc = `data:${mime};base64,${b64}`;
  } else if (ext === "svg" && typeof imageFile?.content === "string" && imageFile.content.trim().length > 0) {
    const encodedSvg = encodeURIComponent(imageFile.content)
      .replace(/'/g, "%27")
      .replace(/"/g, "%22");
    imgSrc = `data:image/svg+xml;charset=utf-8,${encodedSvg}`;
  }

  let sizeFormatted = "";
  if (b64) {
    const bytesLen = Math.floor((b64.length * 3) / 4);
    sizeFormatted = bytesLen < 1024
      ? `${bytesLen} B`
      : bytesLen < 1024 * 1024
        ? `${(bytesLen / 1024).toFixed(1)} KB`
        : `${(bytesLen / (1024 * 1024)).toFixed(2)} MB`;
  } else if (ext === "svg" && typeof imageFile?.content === "string") {
    const bytesLen = imageFile.content.length;
    sizeFormatted = bytesLen < 1024
      ? `${bytesLen} B`
      : `${(bytesLen / 1024).toFixed(1)} KB`;
  }

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
      <span class="badge">${ext || "IMG"}</span>
      <span class="img-name">${safeName}</span>
      <span class="img-size">${sizeFormatted}</span>
      <span id="dim-text" class="img-dim"></span>
    </div>
    <div class="img-controls">
      <button type="button" class="btn-ctrl is-active" id="btn-fit">Ajustar</button>
      <button type="button" class="btn-ctrl" id="btn-100">100%</button>
      <button type="button" class="btn-ctrl" id="btn-200">200%</button>
    </div>
  </div>
  <div class="img-canvas-wrap">
    ${imgSrc ? `<img id="main-img" class="preview-img" src="${imgSrc}" alt="${safeName}">` : '<div class="empty-state">Esta imagen está vacía o no contiene datos binarios válidos.</div>'}
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
