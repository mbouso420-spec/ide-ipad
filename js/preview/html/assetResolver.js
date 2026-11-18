/**
 * Resolución de assets HTML/CSS/media/JSON del proyecto y puente runtime de assets dinámicos.
 */

import { normalizePath } from "../../storage/workspaceDb.js";
import { getImageMimeType, IMAGE_EXTENSIONS } from "../../storage/fileImport.js";
import {
  MAX_PREVIEW_ASSET_BYTES,
  MAX_TOTAL_INLINED_CSS,
  getFileExtension,
  getParentFolder,
  isIgnoredPreviewPath,
  resolveRelativePath,
  buildSafeImageDataUrl,
  escapeCloseScript,
  escapeJsonForInlineScript
} from "../previewUtils.js";

export { IMAGE_EXTENSIONS, escapeCloseScript };

export const escapeCloseStyle = (css) => css.replace(/<\/style(?=[\s>/]|$)/gi, "<\\/style");

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
    if (isIgnoredPreviewPath(clean)) return false;
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
    if (!isIgnoredPreviewPath(clean)) {
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

function decodePreviewPathRef(rawRef) {
  const stripped = String(rawRef || "")
    .trim()
    .split("?")[0]
    .split("#")[0]
    .replace(/\\/g, "/");
  if (!stripped || !stripped.includes("%")) {
    return stripped;
  }
  try {
    return decodeURIComponent(stripped).replace(/\\/g, "/");
  } catch {
    return stripped;
  }
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
    const rawTrimmed = rawRef.trim().split("?")[0].split("#")[0];
    if (!rawTrimmed || /^(https?:|data:|blob:|\/\/|#)/i.test(rawTrimmed)) return;
    const candidates = [rawTrimmed.replace(/\\/g, "/")];
    const decoded = decodePreviewPathRef(rawRef);
    if (decoded && decoded !== candidates[0]) {
      candidates.push(decoded);
    }
    for (const clean of candidates) {
      const resolved = resolveRelativePath(dir, clean);
      if (resolved) paths.add(resolved);
      const rootClean = normalizePath(clean);
      if (rootClean) paths.add(rootClean);
    }
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
    // 3. <img src="...">, <source src="...">, <input src="...">, <video src="...">, <audio src="...">
    const mediaSrcRegex = /<(?:img|source|input|video|audio)\b[^>]*?(?<![-\w])src\s*=\s*(?:(["'])([^"']+)\1|([^\s"'=<>`]+))[^>]*>/gi;
    while ((match = mediaSrcRegex.exec(rawHtml)) !== null) {
      const ref = match[2] || match[3];
      if (ref) addCandidateRef(ref);
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
export function extractCssImportPaths(cssPath, cssContent, options = {}) {
  if (!cssContent || typeof cssContent !== "string") return [];
  const dir = getParentFolder(cssPath);
  const paths = new Set();
  const addCssCandidate = (rawUrl) => {
    if (!rawUrl || /^(https?:|data:|blob:|\/\/|#)/i.test(rawUrl.trim())) return;
    const cleanRef = decodePreviewPathRef(rawUrl);
    if (!cleanRef) return;
    const resolved = resolveRelativePath(dir, cleanRef);
    if (resolved) paths.add(resolved);
    const rootClean = normalizePath(cleanRef);
    if (rootClean) paths.add(rootClean);
  };
  // Ignorar comentarios /* ... */ para no extraer @import comentados
  const importRegex =
    /(\/\*[\s\S]*?\*\/)|@import\s+(?:url\(\s*(?:["']([^"']+)["']|([^"')]+))\s*\)|["']([^"']+)["'])([^;]*);?/gi;
  let match;
  while ((match = importRegex.exec(cssContent)) !== null) {
    if (match[1]) continue;
    const importUrl = match[2] || match[3] || match[4];
    addCssCandidate(importUrl);
  }
  if (options?.includeMedia) {
    const urlRegex = /(\/\*[\s\S]*?\*\/)|url\(\s*(?:["']([^"']+)["']|([^"')]+))\s*\)/gi;
    while ((match = urlRegex.exec(cssContent)) !== null) {
      if (match[1]) continue;
      addCssCandidate(match[2] || match[3]);
    }
  }
  return Array.from(paths);
}

export function getMediaMimeType(filePath) {
  const ext = getFileExtension(filePath || "");
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "avi":
      return "video/x-msvideo";
    case "mkv":
      return "video/x-matroska";
    case "ogv":
      return "video/ogg";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "m4a":
      return "audio/mp4";
    case "flac":
      return "audio/flac";
    default:
      return getImageMimeType(filePath);
  }
}

export function createProjectAssetHelpers(scopeDir, fileMap, allowParentTraversal = false) {
  const safeFileMap = fileMap instanceof Map ? fileMap : new Map();
  const scopeDepth = scopeDir ? scopeDir.split("/").filter(Boolean).length : 0;

  const escapesDirectoryScope = (rawRef, baseDir = scopeDir) => {
    const unified = String(rawRef || "").trim().replace(/\\/g, "/");
    if (!unified) return false;
    if (unified.startsWith("/") && scopeDir) return true;
    let depth = baseDir ? baseDir.split("/").filter(Boolean).length : 0;
    for (const seg of unified.split("/")) {
      const part = seg.trim();
      if (!part || part === ".") continue;
      if (part === "..") {
        depth -= 1;
        if (depth < scopeDepth) return true;
      } else {
        depth += 1;
      }
    }
    return false;
  };

  const normalizeLookupKey = (raw) => {
    const str = String(raw || "");
    return typeof str.normalize === "function" ? str.normalize("NFC") : str;
  };

  let lowerFileMap = null;
  const lookupEntry = (key) => {
    if (!key) return null;
    const direct = safeFileMap.get(key);
    if (direct) return direct;
    const nfcKey = normalizeLookupKey(key);
    if (nfcKey !== key) {
      const nfcDirect = safeFileMap.get(nfcKey);
      if (nfcDirect) return nfcDirect;
    }
    if (!lowerFileMap) {
      lowerFileMap = new Map();
      for (const [k, v] of safeFileMap.entries()) {
        const lowerKey = normalizeLookupKey(k).toLowerCase();
        if (lowerKey && !lowerFileMap.has(lowerKey)) {
          lowerFileMap.set(lowerKey, v);
        }
      }
    }
    return lowerFileMap.get(nfcKey.toLowerCase()) || null;
  };

  const resolveEntryFromDir = (rawHref, baseDir) => {
    if (!rawHref || /^(https?:|data:|blob:|#|\/\/)/i.test(rawHref.trim())) {
      return null;
    }
    const cleanRef = decodePreviewPathRef(rawHref);
    if (!cleanRef) {
      return null;
    }
    if (!allowParentTraversal && escapesDirectoryScope(cleanRef, baseDir)) {
      return null;
    }
    const resolved = resolveRelativePath(baseDir, cleanRef);
    if (!allowParentTraversal && scopeDir && resolved !== scopeDir && !resolved.startsWith(`${scopeDir}/`)) {
      return null;
    }
    let asset = lookupEntry(resolved);
    if (!asset && cleanRef.startsWith("./")) {
      asset = lookupEntry(resolveRelativePath(baseDir, cleanRef.slice(2)));
    }
    if (!asset && cleanRef.startsWith("/") && baseDir && (allowParentTraversal || !scopeDir)) {
      asset = lookupEntry(resolveRelativePath(baseDir, cleanRef.replace(/^\/+/, "")));
    }
    if (!asset && !cleanRef.startsWith("/") && !cleanRef.startsWith("./") && !cleanRef.startsWith("../")) {
      const candidate = lookupEntry(normalizePath(cleanRef));
      if (candidate) {
        const candPath = normalizePath(candidate.path || "");
        if (!scopeDir || allowParentTraversal || candPath.startsWith(`${scopeDir}/`)) {
          asset = candidate;
        }
      }
    }
    return asset || null;
  };

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

  function buildEntryDataUrl(entry, refPath, mimeResolver = getImageMimeType, { enforceCssBudget = false } = {}) {
    const built = buildSafeImageDataUrl(entry, refPath, {
      mimeResolver,
      budgetCheck: enforceCssBudget
        ? (size, isSvg) => {
            const singleCap = isSvg ? MAX_PREVIEW_ASSET_BYTES : MAX_PREVIEW_ASSET_BYTES * 2;
            const totalCap = isSvg ? MAX_TOTAL_INLINED_CSS : MAX_TOTAL_INLINED_CSS * 2;
            if (size > singleCap || totalInlinedCssBytes + size > totalCap) return false;
            totalInlinedCssBytes += size;
            return true;
          }
        : null
    });
    return built ? built.src : null;
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
        const dataUrl = buildEntryDataUrl(entry, rawUrl, resolveCssAssetMime, { enforceCssBudget: true });
        if (dataUrl) {
          return `url("${dataUrl}")`;
        }
        return fullMatch;
      }
    );
  }

  const escapeCommentBody = (txt) => String(txt || "").replace(/\*\//g, "* /");
  const MAX_CSS_IMPORT_DEPTH = 64;

  function inlineCssImports(cssContent, cssPath, ancestors = new Set(), depth = 0) {
    if (depth > MAX_CSS_IMPORT_DEPTH) return "";
    const cleanPath = normalizePath(cssPath);
    if (ancestors.has(cleanPath)) return "";
    ancestors.add(cleanPath);

    try {
      const cssDir = getParentFolder(cleanPath);
      const importRegex =
        /(\/\*[\s\S]*?\*\/)|@import\s+(?:url\(\s*(?:["']([^"']+)["']|([^"')]+))\s*\)|["']([^"']+)["'])([^;]*);?/gi;

      const withImports = String(cssContent || "").replace(
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
          const inlinedChild = inlineCssImports(importedAsset.content, importedAsset.path, ancestors, depth + 1);

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

  return {
    resolveEntryFromDir,
    buildEntryDataUrl,
    inlineCssUrls,
    inlineCssImports,
    getTotalInlinedCssBytes: () => totalInlinedCssBytes,
    addInlinedCssBytes: (n) => {
      totalInlinedCssBytes += n;
    }
  };
}

const TEXT_REFERENCED_ASSET_RE =
  /(["'`])([^"'`\r\n]{1,320}\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|json|mp4|webm|ogg|mp3|wav|m4a|flac|woff2?|ttf|otf)(?:[?#][^"'`\r\n]*)?)\1/gi;

const RUNTIME_DATA_EXT_MIMES = {
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8"
};
const MAX_RUNTIME_ASSET_MAP_CHARS = 16 * 1024 * 1024;

export function buildRuntimeAssetsBridgeScript(dir, fileMap, allowParentTraversal, buildEntryDataUrl, mimeResolver = getMediaMimeType) {
  if (!fileMap || fileMap.size === 0) return "";
  const scopeDir = dir ? normalizePath(dir) : "";
  const urlEntries = Object.create(null);
  const textEntries = Object.create(null);
  let totalChars = 0;
  let hasEntries = false;

  for (const [rawKey, entry] of fileMap.entries()) {
    if (!entry || !entry.path) continue;
    const normPath = normalizePath(entry.path || rawKey);
    if (!normPath) continue;
    if (!allowParentTraversal && scopeDir && normPath !== scopeDir && !normPath.startsWith(`${scopeDir}/`)) {
      continue;
    }
    const ext = getFileExtension(normPath);
    if (Object.prototype.hasOwnProperty.call(RUNTIME_DATA_EXT_MIMES, ext) && typeof entry.content === "string") {
      if (entry.content.length <= MAX_PREVIEW_ASSET_BYTES && totalChars + entry.content.length <= MAX_RUNTIME_ASSET_MAP_CHARS) {
        textEntries[normPath] = { content: entry.content, mime: RUNTIME_DATA_EXT_MIMES[ext] };
        totalChars += entry.content.length;
        hasEntries = true;
      }
      continue;
    }
    if (IMAGE_EXTENSIONS.has(ext) || entry.isBinary) {
      const dataUrl = buildEntryDataUrl(entry, normPath, mimeResolver);
      if (dataUrl && totalChars + dataUrl.length <= MAX_RUNTIME_ASSET_MAP_CHARS) {
        urlEntries[normPath] = dataUrl;
        totalChars += dataUrl.length;
        hasEntries = true;
      }
    }
  }

  if (!hasEntries) return "";

  const payloadJson = escapeJsonForInlineScript({
    baseDir: scopeDir,
    allowParent: Boolean(allowParentTraversal),
    urls: urlEntries,
    texts: textEntries
  });

  return `<script>
(function () {
  var cfg = ${payloadJson};
  var normNfc = function (s) {
    var str = String(s == null ? "" : s);
    return typeof str.normalize === "function" ? str.normalize("NFC") : str;
  };
  var urlLower = Object.create(null);
  var textLower = Object.create(null);
  Object.keys(cfg.urls).forEach(function (k) { urlLower[normNfc(k).toLowerCase()] = cfg.urls[k]; });
  Object.keys(cfg.texts).forEach(function (k) { textLower[normNfc(k).toLowerCase()] = cfg.texts[k]; });

  function cleanNormPath(p) {
    var parts = String(p || "").replace(/\\\\/g, "/").split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].trim();
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        if (out.length > 0) out.pop();
      } else {
        out.push(seg);
      }
    }
    return out.join("/");
  }

  function decodeRef(raw) {
    var noHash = String(raw || "").trim().split("#")[0].split("?")[0].replace(/\\\\/g, "/");
    try { return decodeURIComponent(noHash); } catch (_) { return noHash; }
  }

  function lookupFromMap(exactMap, lowerMap, rawRef) {
    if (!rawRef || typeof rawRef !== "string") return null;
    var trimmed = rawRef.trim();
    if (!trimmed || /^(https?:|data:|blob:|#|javascript:|vbscript:|file:)/i.test(trimmed)) return null;
    var clean = decodeRef(trimmed);
    if (!clean) return null;

    var candidates = [];
    if (clean.charAt(0) === "/") {
      var rootPart = cleanNormPath(clean.replace(/^\\/+/, ""));
      if (cfg.baseDir && (cfg.allowParent || !cfg.baseDir)) {
        candidates.push(cleanNormPath(cfg.baseDir + "/" + rootPart));
      }
      candidates.push(rootPart);
    } else {
      if (cfg.baseDir) {
        candidates.push(cleanNormPath(cfg.baseDir + "/" + clean));
      }
      candidates.push(cleanNormPath(clean));
    }

    for (var i = 0; i < candidates.length; i++) {
      var cand = candidates[i];
      if (!cand) continue;
      if (!cfg.allowParent && cfg.baseDir && cand !== cfg.baseDir && cand.indexOf(cfg.baseDir + "/") !== 0) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(exactMap, cand)) return exactMap[cand];
      var nfcLower = normNfc(cand).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(lowerMap, nfcLower)) return lowerMap[nfcLower];
    }
    return null;
  }

  function resolveUrl(rawRef) {
    return lookupFromMap(cfg.urls, urlLower, rawRef);
  }

  function resolveSrcset(rawSrcset) {
    if (!rawSrcset || typeof rawSrcset !== "string") return rawSrcset;
    return rawSrcset.replace(/([^\\s,]+)(\\s+[^\\s,]+)?/g, function (m, u, desc) {
      var resolved = resolveUrl(u);
      return resolved ? (desc ? resolved + desc : resolved) : m;
    });
  }

  function patchElementMedia(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute) return;
    var tag = el.tagName;
    if (tag === "IMG" || tag === "SOURCE" || tag === "VIDEO" || tag === "AUDIO" || tag === "INPUT") {
      var curSrc = el.getAttribute("src");
      if (curSrc) {
        var resolvedSrc = resolveUrl(curSrc);
        if (resolvedSrc && curSrc !== resolvedSrc) {
          origSetAttr.call(el, "src", resolvedSrc);
        }
      }
    }
    if (tag === "IMG" || tag === "SOURCE") {
      var curSrcset = el.getAttribute("srcset");
      if (curSrcset) {
        var resolvedSet = resolveSrcset(curSrcset);
        if (resolvedSet && resolvedSet !== curSrcset) {
          origSetAttr.call(el, "srcset", resolvedSet);
        }
      }
    }
    if (tag === "VIDEO") {
      var curPoster = el.getAttribute("poster");
      if (curPoster) {
        var resolvedPoster = resolveUrl(curPoster);
        if (resolvedPoster && curPoster !== resolvedPoster) {
          origSetAttr.call(el, "poster", resolvedPoster);
        }
      }
    }
    var st = el.getAttribute("style");
    if (st && st.indexOf("url(") !== -1) {
      var nextSt = st.replace(/url\\(\\s*(?:["']([^"']+)["']|([^)"'\\s]+))\\s*\\)/gi, function (fm, qUrl, bUrl) {
        var r = resolveUrl(qUrl || bUrl || "");
        return r ? 'url("' + r + '")' : fm;
      });
      if (nextSt !== st) origSetAttr.call(el, "style", nextSt);
    }
  }

  function scanSubtree(root) {
    if (!root || root.nodeType !== 1) return;
    patchElementMedia(root);
    if (typeof root.querySelectorAll === "function") {
      var nodes = root.querySelectorAll("img[src],source[src],video[src],audio[src],input[type='image'][src],img[srcset],source[srcset],video[poster],[style*='url(']");
      for (var i = 0; i < nodes.length; i++) patchElementMedia(nodes[i]);
    }
  }

  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var lowerName = String(name || "").toLowerCase();
    if (lowerName === "src" && (this.tagName === "IMG" || this.tagName === "SOURCE" || this.tagName === "VIDEO" || this.tagName === "AUDIO" || this.tagName === "INPUT")) {
      var r = resolveUrl(String(value));
      if (r) value = r;
    } else if (lowerName === "srcset" && (this.tagName === "IMG" || this.tagName === "SOURCE")) {
      value = resolveSrcset(String(value));
    } else if (lowerName === "poster" && this.tagName === "VIDEO") {
      var rp = resolveUrl(String(value));
      if (rp) value = rp;
    }
    return origSetAttr.call(this, name, value);
  };

  function wrapUrlProp(proto, prop) {
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc && desc.configurable && typeof desc.set === "function") {
        Object.defineProperty(proto, prop, {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set: function (val) {
            var r = resolveUrl(String(val == null ? "" : val));
            return desc.set.call(this, r || val);
          }
        });
      }
    } catch (_) {}
  }
  if (typeof HTMLImageElement !== "undefined") wrapUrlProp(HTMLImageElement.prototype, "src");
  if (typeof HTMLSourceElement !== "undefined") wrapUrlProp(HTMLSourceElement.prototype, "src");
  if (typeof HTMLVideoElement !== "undefined") wrapUrlProp(HTMLVideoElement.prototype, "poster");

  try {
    var innerDesc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    if (innerDesc && innerDesc.configurable && typeof innerDesc.set === "function") {
      Object.defineProperty(Element.prototype, "innerHTML", {
        configurable: true,
        enumerable: innerDesc.enumerable,
        get: innerDesc.get,
        set: function (htmlStr) {
          innerDesc.set.call(this, htmlStr);
          scanSubtree(this);
        }
      });
    }
  } catch (_) {}

  if (typeof MutationObserver === "function") {
    try {
      var obs = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (m.type === "attributes") {
            patchElementMedia(m.target);
          } else if (m.addedNodes) {
            for (var j = 0; j < m.addedNodes.length; j++) {
              scanSubtree(m.addedNodes[j]);
            }
          }
        }
      });
      obs.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "poster", "style"]
      });
    } catch (_) {}
  }

  if (typeof window.fetch === "function") {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var reqUrl = typeof input === "string" ? input : (input && typeof input.url === "string" ? input.url : "");
      var textAsset = lookupFromMap(cfg.texts, textLower, reqUrl);
      if (textAsset) {
        return Promise.resolve(new Response(textAsset.content, {
          status: 200,
          headers: { "Content-Type": textAsset.mime }
        }));
      }
      var dataUrl = resolveUrl(reqUrl);
      if (dataUrl) {
        return origFetch(dataUrl, init);
      }
      return origFetch(input, init);
    };
  }

  if (typeof XMLHttpRequest === "function") {
    var origXhrOpen = XMLHttpRequest.prototype.open;
    var origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__studioReqUrl = url;
      return origXhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var textAsset = lookupFromMap(cfg.texts, textLower, this.__studioReqUrl);
      if (textAsset) {
        var xhr = this;
        Promise.resolve().then(function () {
          try {
            Object.defineProperty(xhr, "readyState", { configurable: true, value: 4 });
            Object.defineProperty(xhr, "status", { configurable: true, value: 200 });
            Object.defineProperty(xhr, "responseText", { configurable: true, value: textAsset.content });
            Object.defineProperty(xhr, "response", { configurable: true, value: textAsset.content });
          } catch (_) {}
          if (typeof xhr.onreadystatechange === "function") xhr.onreadystatechange();
          if (typeof xhr.onload === "function") xhr.onload();
          xhr.dispatchEvent(new Event("load"));
        });
        return;
      }
      var dataUrl = resolveUrl(this.__studioReqUrl);
      if (dataUrl) {
        origXhrOpen.call(this, "GET", dataUrl, true);
      }
      return origXhrSend.apply(this, arguments);
    };
  }
})();
</script>`;
}

/**
 * Extrae posibles rutas locales a imágenes, media o datos JSON referenciadas dentro de archivos JS/TS/JSON
 * para asegurar su descarga bajo demanda en proyectos lazy de GitHub antes de construir la vista previa.
 */
export function extractTextAssetPaths(entryPath, rawText, allFiles = []) {
  if (!rawText || typeof rawText !== "string") return [];
  const dir = getParentFolder(entryPath);
  const paths = new Set();

  const knownByBase = new Map();
  if (Array.isArray(allFiles)) {
    for (const f of allFiles) {
      if (!f || !f.path) continue;
      const clean = normalizePath(f.path);
      const base = clean.split("/").pop()?.toLowerCase();
      if (!base) continue;
      if (!knownByBase.has(base)) {
        knownByBase.set(base, [clean]);
      } else {
        knownByBase.get(base).push(clean);
      }
    }
  }

  let match;
  TEXT_REFERENCED_ASSET_RE.lastIndex = 0;
  while ((match = TEXT_REFERENCED_ASSET_RE.exec(rawText)) !== null) {
    const rawRef = match[2];
    if (!rawRef || rawRef.includes("${")) continue;
    const trimmed = rawRef.trim().split("?")[0].split("#")[0];
    if (!trimmed || /^(https?:|data:|blob:|\/\/|#)/i.test(trimmed)) continue;

    const candidates = [trimmed.replace(/\\/g, "/")];
    const decoded = decodePreviewPathRef(rawRef);
    if (decoded && decoded !== candidates[0]) {
      candidates.push(decoded);
    }
    for (const clean of candidates) {
      const resolved = resolveRelativePath(dir, clean);
      if (resolved) paths.add(resolved);
      const rootClean = normalizePath(clean);
      if (rootClean) paths.add(rootClean);
      const baseName = rootClean.split("/").pop()?.toLowerCase();
      const sameBase = baseName ? knownByBase.get(baseName) : null;
      if (sameBase && sameBase.length > 0 && sameBase.length <= 4) {
        for (const candidatePath of sameBase) {
          if (candidatePath.endsWith(`/${rootClean}`) || candidatePath === rootClean) {
            paths.add(candidatePath);
          }
        }
      }
    }
  }

  return Array.from(paths);
}
