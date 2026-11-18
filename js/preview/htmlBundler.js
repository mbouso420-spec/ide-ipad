/**
 * Empaquetador de documentos HTML con inlining de CSS, módulos ES/TS/JSX, medios y puente de consola.
 */

import { normalizePath } from "../storage/workspaceDb.js";
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
  hasRelativeDepsInUsage,
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
import {
  IMAGE_EXTENSIONS,
  escapeCloseStyle,
  escapeCloseScript,
  filterFolderScopeFiles,
  buildWorkspaceAssetMap,
  extractReferencedAssetPaths,
  parseCssImportConditions,
  wrapCssWithConditions,
  extractCssImportPaths,
  createProjectAssetHelpers,
  getMediaMimeType,
  buildRuntimeAssetsBridgeScript,
  extractTextAssetPaths
} from "./html/assetResolver.js";
import {
  getSavedPreviewHtml,
  savePreviewHtml,
  findBestHtmlEntrypoint,
  findTargetHtmlFile,
  findSiblingHtmlInSameFolder
} from "./html/entrypointResolver.js";
import { buildConsoleBridgeScript, rewriteProgrammaticNavigation } from "./html/consoleBridge.js";
import {
  buildStandaloneTsPreview,
  buildStandaloneJsPreview,
  buildStandaloneImagePreview
} from "./html/standalonePreviews.js";

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
  IMAGE_EXTENSIONS,
  getFileExtension,
  getParentFolder,
  resolveRelativePath,
  escapeAttr,
  escapeHtmlText,
  extractModuleDependencyPaths,
  buildStandalonePythonPreview,
  buildMarkdownPreview,
  renderMarkdownDocumentHtml,
  formatMdInline,
  filterFolderScopeFiles,
  buildWorkspaceAssetMap,
  extractReferencedAssetPaths,
  parseCssImportConditions,
  wrapCssWithConditions,
  extractCssImportPaths,
  extractTextAssetPaths,
  getSavedPreviewHtml,
  savePreviewHtml,
  findBestHtmlEntrypoint,
  findTargetHtmlFile,
  findSiblingHtmlInSameFolder,
  buildConsoleBridgeScript,
  buildStandaloneTsPreview,
  buildStandaloneJsPreview,
  buildStandaloneImagePreview
};

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
    const ltIdx = src.indexOf("<", cursor);
    if (ltIdx === -1) break;

    if (src.startsWith("<!--", ltIdx)) {
      const endComment = src.indexOf("-->", ltIdx + 4);
      const nextPos = endComment === -1 ? src.length : endComment + 3;
      chunks.push(src.slice(cursor, nextPos));
      cursor = nextPos;
      continue;
    }

    if (/^<script(?=[\s/>])/i.test(src.slice(ltIdx, ltIdx + 9))) {
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
      continue;
    }

    // Saltar etiquetas HTML normales respetando comillas para no confundir "<!--" ni "<script>" en atributos
    if (/^<[a-zA-Z!/]/.test(src.slice(ltIdx, ltIdx + 2))) {
      const tagEnd = scanScriptOpenTagEnd(src, ltIdx + 1);
      if (tagEnd === -1) {
        chunks.push(src.slice(cursor, ltIdx + 1));
        cursor = ltIdx + 1;
      } else {
        chunks.push(src.slice(cursor, tagEnd + 1));
        cursor = tagEnd + 1;
      }
      continue;
    }

    chunks.push(src.slice(cursor, ltIdx + 1));
    cursor = ltIdx + 1;
  }

  chunks.push(src.slice(cursor));
  return { maskedHtml: chunks.join(""), entries, prefix };
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
  const baseTransformJs = typeof transformJs === "function" ? transformJs : (code) => code;
  const safeTransformJs = (code, isModule) => baseTransformJs(rewriteProgrammaticNavigation(code), isModule);
  const dir = getParentFolder(entryPath);
  const {
    resolveEntryFromDir,
    buildEntryDataUrl,
    inlineCssUrls,
    inlineCssImports,
    getTotalInlinedCssBytes,
    addInlinedCssBytes
  } = createProjectAssetHelpers(dir, fileMap, allowParentTraversal);

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

    if (asset.content.length > MAX_PREVIEW_ASSET_BYTES) {
      return `<!-- [Studio IDE]: stylesheet "${escapeAttr(asset.path)}" omitido: excede el límite de tamaño individual (${asset.content.length} bytes > ${MAX_PREVIEW_ASSET_BYTES} bytes) -->\n${tag}`;
    }

    if (getTotalInlinedCssBytes() + asset.content.length > MAX_TOTAL_INLINED_CSS) {
      return `<!-- [Studio IDE]: stylesheet "${escapeAttr(asset.path)}" omitido: presupuesto total de CSS superado -->\n${tag}`;
    }

    addInlinedCssBytes(asset.content.length);
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
    } else if (getTotalInlinedCssBytes() + cssContent.length > MAX_TOTAL_INLINED_CSS) {
      const warnTag = `<!-- [Studio IDE]: stylesheet "${escapeAttr(cssPath)}" omitido: presupuesto total de CSS superado -->`;
      if (/<head\b[^>]*>/i.test(html)) {
        html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${warnTag}`);
      } else {
        html = `${warnTag}\n${html}`;
      }
    } else {
      addInlinedCssBytes(cssContent.length);
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
    return buildEntryDataUrl(entry, cleanUrl, getMediaMimeType);
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

  html = html.replace(/<img\b([^>]*?)(?<![-\w])src\s*=\s*(?:(["'])([^"']+)\2|([^\s"'=<>`]+))([^>]*)>/gi, (fullTag, beforeSrc, quote, quotedSrc, bareSrc, afterSrc) => {
    const rawSrc = quotedSrc || bareSrc || "";
    const dataUrl = resolveEntryToDataUrl(rawSrc);
    if (dataUrl) {
      const outQuote = quote || '"';
      return `<img${beforeSrc}src=${outQuote}${dataUrl}${outQuote}${afterSrc}>`;
    }
    return fullTag;
  });

  html = html.replace(/\bsrcset=(["'])([^"']+)\1/gi, (fullAttr, quote, rawSrcset) => {
    const inlined = inlineSrcsetString(rawSrcset);
    return `srcset=${quote}${inlined}${quote}`;
  });

  html = html.replace(/<(source|video|audio)\b([^>]*?)(?<![-\w])src\s*=\s*(?:(["'])([^"']+)\3|([^\s"'=<>`]+))([^>]*)>/gi, (fullTag, tagName, beforeSrc, quote, quotedSrc, bareSrc, afterSrc) => {
    const rawSrc = quotedSrc || bareSrc || "";
    const dataUrl = resolveEntryToDataUrl(rawSrc);
    if (dataUrl) {
      const outQuote = quote || '"';
      return `<${tagName}${beforeSrc}src=${outQuote}${dataUrl}${outQuote}${afterSrc}>`;
    }
    return fullTag;
  });

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

  html = html.replace(/<video\b([^>]*?)\bposter=(["'])([^"']+)\2([^>]*)>/gi, (fullTag, beforePoster, quote, rawPoster, afterPoster) => {
    const dataUrl = resolveEntryToDataUrl(rawPoster);
    if (dataUrl) {
      return `<video${beforePoster}poster=${quote}${dataUrl}${quote}${afterPoster}>`;
    }
    return fullTag;
  });

  html = html.replace(/<input\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi, (fullTag, beforeSrc, quote, rawSrc, afterSrc) => {
    if (!/\btype=(["'])image\1/i.test(fullTag)) return fullTag;
    const dataUrl = resolveEntryToDataUrl(rawSrc);
    if (dataUrl) {
      return `<input${beforeSrc}src=${quote}${dataUrl}${quote}${afterSrc}>`;
    }
    return fullTag;
  });

  html = html.replace(/<image\b([^>]*?)\b(?:xlink:)?href=(["'])([^"']+)\2([^>]*)>/gi, (fullTag, beforeHref, quote, rawHref, afterHref) => {
    const dataUrl = resolveEntryToDataUrl(rawHref);
    if (dataUrl) {
      return `<image${beforeHref}href=${quote}${dataUrl}${quote}${afterHref}>`;
    }
    return fullTag;
  });

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
    const rendered = safeTransformJs(executable, isModule);
    return escapeCloseScript(rendered);
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
      transformJs: safeTransformJs,
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

  const processedScripts = scriptEntries.length > 0
    ? scriptEntries.map((entry) => processScannedScript(entry))
    : [];

  if (ensureJsFile && !inlinedActiveJs) {
    const extraPath = ensureJsFile.path || "main.js";
    const extraExt = getFileExtension(extraPath);
    const needsExtraTranspile = TS_EXTENSIONS.has(extraExt) || extraExt === "jsx";
    const precompiledExtra = needsExtraTranspile
      ? transpileTypeScriptAndJsx(ensureJsFile.content || "", {
          jsx: extraExt === "tsx" || extraExt === "jsx",
          fileName: extraPath
        }).code
      : String(ensureJsFile.content || "");
    const bundledExtra = tryBundleLocalModules(ensureJsFile.content, extraPath, precompiledExtra);
    if (bundledExtra) {
      const modAttr = bundledExtra.isModuleTag ? ' type="module"' : "";
      deferredScripts.push(
        `<script${modAttr} data-source="${escapeAttr(extraPath)}">\n${bundledExtra.scriptCode}\n</script>`
      );
    } else {
      const usageExtra = inspectModuleUsage(precompiledExtra);
      const isExtraModule = Boolean(usageExtra.hasModuleSyntax || usageExtra.hasTopLevelAwait);
      const safeExtraJs = compileScriptContent(ensureJsFile.content, extraPath, "", isExtraModule, precompiledExtra);
      const modAttr = isExtraModule ? ' type="module"' : "";
      deferredScripts.push(`<script${modAttr} data-source="${escapeAttr(extraPath)}">\n${safeExtraJs}\n</script>`);
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

  // Neutralizar <meta http-equiv="refresh"> y <base href="..."> locales para evitar escapes fuera del srcdoc
  html = html.replace(/<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*>/gi, "");
  html = html.replace(/<base\b[^>]*href=["'](?!(?:https?:)?\/\/)[^"']*["'][^>]*>/gi, "");

  // Reescribir location.href / location.assign / location.replace en atributos on* inline (ej. onclick="location.href='index.html'")
  html = html.replace(/(\bon[a-z]+\s*=\s*)(["'])([\s\S]*?)\2/gi, (full, prefix, quote, handlerCode) => {
    if (!handlerCode.includes("location")) return full;
    const rewritten = rewriteProgrammaticNavigation(handlerCode);
    return rewritten === handlerCode ? full : `${prefix}${quote}${rewritten}${quote}`;
  });

  const bridge = buildConsoleBridgeScript(false);
  const runtimeAssetsBridge = (processedScripts.length > 0 || ensureJsFile)
    ? buildRuntimeAssetsBridgeScript(
        dir,
        fileMap,
        allowParentTraversal,
        buildEntryDataUrl,
        getMediaMimeType
      )
    : "";
  const combinedHeadBridge = runtimeAssetsBridge ? `${bridge}\n${runtimeAssetsBridge}` : bridge;
  if (/<head\b[^>]*>/i.test(html)) {
    html = html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${combinedHeadBridge}`);
  } else {
    html = `${combinedHeadBridge}\n${html}`;
  }

  if (processedScripts.length > 0) {
    const maskRe = new RegExp(`${scriptMaskPrefix}(\\d+)__`, "g");
    html = html.replace(maskRe, (_, idxStr) => processedScripts[Number(idxStr)] ?? "");
  }

  return html;
}
