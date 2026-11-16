/**
 * Constantes, utilidades de rutas y escapado HTML compartidas entre los empaquetadores de vista previa.
 */

import { normalizePath } from "../storage/workspaceDb.js";
import { escapeHtml } from "../utils/dom.js";

export { normalizePath, escapeHtml };

export const HTML_EXTENSIONS = new Set(["html", "htm"]);
export const JS_EXTENSIONS = new Set(["js", "mjs", "cjs"]);
export const CSS_EXTENSIONS = new Set(["css"]);
export const PYTHON_EXTENSIONS = new Set(["py", "pyw"]);
export const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
export const SQL_EXTENSIONS = new Set(["sql"]);
export const C_EXTENSIONS = new Set(["c", "h"]);
export const CPP_EXTENSIONS = new Set(["cpp", "cxx", "cc", "hpp", "hxx", "hh"]);
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
  const base = String(path || "").split(/[/\\]/).pop() || "";
  if (!base.includes(".")) return "";
  return base.split(".").pop().toLowerCase();
}

export function getParentFolder(path) {
  const clean = normalizePath(path);
  return clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
}

export function resolveRelativePath(baseDir, relPath) {
  const safeBase = String(baseDir ?? "").replace(/\\/g, "/");
  const safeRel = String(relPath ?? "").replace(/\\/g, "/");
  if (safeRel.startsWith("/")) {
    return normalizePath(safeRel);
  }
  const stack = safeBase ? safeBase.split("/").filter(Boolean) : [];
  const parts = safeRel.split("/");
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
  return escapeHtml(str ?? "");
}

export function escapeHtmlText(str) {
  return escapeHtml(str ?? "");
}

/**
 * Normaliza una referencia URL antes de evaluar esquemas peligrosos en previews.
 * Elimina caracteres de control ASCII que podrían evadir regex simples en navegadores.
 */
export function normalizePreviewUrlRef(ref) {
  return String(ref ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .trim()
    .toLowerCase();
}

export function isBlockedPreviewUrlScheme(ref) {
  const normalized = normalizePreviewUrlRef(ref);
  return (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("data:") ||
    normalized.startsWith("file:") ||
    normalized.startsWith("filesystem:")
  );
}

/**
 * Codifica con encodeURIComponent sustituyendo pares subrogados huérfanos por U+FFFD para evitar URIError.
 * @param {string} value
 * @returns {string}
 */
export function safeEncodeURIComponent(value) {
  const safe = String(value ?? "").replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD"
  );
  return encodeURIComponent(safe);
}

const SVG_DANGEROUS_TAG_NAMES = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "applet",
  "meta",
  "base",
  "set",
  "animate",
  "animatetransform",
  "animatemotion",
  "handler",
  "listener"
]);

const SVG_URI_ATTR_NAMES = new Set(["href", "xlink:href", "src", "action", "formaction"]);

function decodeSvgAttrValue(val) {
  let out = String(val || "");
  for (let pass = 0; pass < 2; pass += 1) {
    out = out
      .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
        const cp = Number.parseInt(hex, 16);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
      })
      .replace(/&#(\d+);?/g, (_, dec) => {
        const cp = Number.parseInt(dec, 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
      })
      .replace(/&colon;/gi, ":")
      .replace(/&tab;/gi, "\t")
      .replace(/&newline;/gi, "\n")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&amp;/gi, "&");
  }
  return out.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
}

function isDangerousSvgUri(rawVal) {
  const normVal = decodeSvgAttrValue(rawVal);
  if (!normVal) return false;
  if (/^(?:javascript|vbscript|file|filesystem):/i.test(normVal)) return true;
  if (normVal.startsWith("data:")) {
    return !/^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)[;,]/i.test(normVal);
  }
  return false;
}

function unescapeCssText(css) {
  return decodeSvgAttrValue(css).replace(/\\([0-9a-f]{1,6})\s?|\\([^\n\r])/gi, (_, hex, ch) => {
    if (ch) return ch;
    const cp = Number.parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
  });
}

function sanitizeSvgStyleBlock(css) {
  let safe = String(css || "")
    .replace(/@import\b[^;]*(?:;|$)/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/(?:-moz-binding|behavior)\s*:[^;}]*/gi, "");

  safe = safe.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (full, q1, q2, bare) => {
    const raw = q1 ?? q2 ?? bare ?? "";
    const decodedCss = unescapeCssText(raw);
    if (isDangerousSvgUri(decodedCss) || /^(?:javascript|vbscript|file|filesystem|data\s*:(?!image\/(?:png|jpeg|jpg|gif|webp|avif|bmp)\b))/i.test(decodedCss)) {
      return "url(#)";
    }
    return full;
  });

  if (/(?:javascript|vbscript)\s*:|expression\s*\(|-moz-binding|@import/i.test(unescapeCssText(safe))) {
    safe = safe.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, "");
    safe = safe
      .replace(/@import\b[^;]*(?:;|$)/gi, "")
      .replace(/expression\s*\([^)]*\)/gi, "")
      .replace(/(?:-moz-binding|behavior)\s*:[^;}]*/gi, "")
      .replace(/(?:javascript|vbscript)\s*:/gi, "");
  }
  return safe;
}

function sanitizeSvgOpeningTag(tagSource) {
  // Parse tag name and attributes sequentially (handling quotes and slash separators)
  const len = tagSource.length;
  let i = 1;
  let isClose = false;
  if (tagSource[i] === "/") {
    isClose = true;
    i += 1;
  }
  const nameStart = i;
  while (i < len && !/[\s/>]/.test(tagSource[i])) i += 1;
  const tagName = tagSource.slice(nameStart, i);
  const tagLower = tagName.toLowerCase();
  const isTagSelfClosing = !isClose && /\/\s*>$/.test(tagSource);
  if (!tagName || SVG_DANGEROUS_TAG_NAMES.has(tagLower)) {
    return { removed: true, tagLower, isClose, isSelfClosing: isTagSelfClosing, html: "" };
  }
  if (isClose) {
    return { removed: false, tagLower, isClose: true, isSelfClosing: false, html: `</${tagName}>` };
  }

  let selfClosing = false;
  const keptAttrs = [];
  while (i < len) {
    while (i < len && (tagSource[i] === "/" || /\s/.test(tagSource[i]))) {
      if (tagSource[i] === "/" && i + 1 < len && tagSource[i + 1] === ">") {
        selfClosing = true;
      }
      i += 1;
    }
    if (i >= len || tagSource[i] === ">") {
      if (i > 0 && tagSource[i - 1] === "/") selfClosing = true;
      break;
    }
    const attrStart = i;
    while (i < len && !/[\s=/>]/.test(tagSource[i])) i += 1;
    const attrName = tagSource.slice(attrStart, i);
    if (!attrName) {
      i += 1;
      continue;
    }
    while (i < len && /\s/.test(tagSource[i])) i += 1;
    let rawAttrVal = null;
    let quote = "";
    if (i < len && tagSource[i] === "=") {
      i += 1;
      while (i < len && /\s/.test(tagSource[i])) i += 1;
      if (i < len && (tagSource[i] === '"' || tagSource[i] === "'")) {
        quote = tagSource[i];
        i += 1;
        const valStart = i;
        while (i < len && tagSource[i] !== quote) i += 1;
        rawAttrVal = tagSource.slice(valStart, i);
        if (i < len && tagSource[i] === quote) i += 1;
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(tagSource[i])) {
          if (tagSource[i] === "/" && i + 1 < len && tagSource[i + 1] === ">") break;
          i += 1;
        }
        rawAttrVal = tagSource.slice(valStart, i);
      }
    }

    const attrLower = attrName.toLowerCase();
    if (attrLower.startsWith("on")) {
      continue;
    }
    if (rawAttrVal !== null && SVG_URI_ATTR_NAMES.has(attrLower) && isDangerousSvgUri(rawAttrVal)) {
      keptAttrs.push(`${attrName}="#"`);
      continue;
    }
    if (rawAttrVal === null) {
      keptAttrs.push(attrName);
    } else if (quote) {
      keptAttrs.push(`${attrName}=${quote}${rawAttrVal}${quote}`);
    } else {
      keptAttrs.push(`${attrName}="${rawAttrVal.replace(/"/g, "&quot;")}"`);
    }
  }

  const attrStr = keptAttrs.length > 0 ? ` ${keptAttrs.join(" ")}` : "";
  const closeSlash = selfClosing ? " /" : "";
  return {
    removed: false,
    tagLower,
    isClose: false,
    isSelfClosing: selfClosing,
    html: `<${tagName}${attrStr}${closeSlash}>`
  };
}

/**
 * Sanea SVG antes de pasarlo a `data:image/svg+xml` para neutralizar scripts embebidos,
 * `foreignObject`, animaciones SVG activas, entidades XML, cualquier cantidad de `on*` y URIs peligrosas.
 * @param {string} svgMarkup
 * @returns {string|null}
 */
export function sanitizeSvgMarkup(svgMarkup) {
  if (typeof svgMarkup !== "string" || !svgMarkup.trim()) return null;

  const stripPass = (input) => {
    const out = [];
    let i = 0;
    const len = input.length;
    let skipDepthTag = null;

    while (i < len) {
      const lt = input.indexOf("<", i);
      if (lt === -1) {
        if (!skipDepthTag) out.push(input.slice(i));
        break;
      }
      if (!skipDepthTag && lt > i) {
        out.push(input.slice(i, lt));
      }
      if (input.startsWith("<!--", lt)) {
        const endComment = input.indexOf("-->", lt + 4);
        i = endComment === -1 ? len : endComment + 3;
        continue;
      }
      if (/^<!(?:doctype|entity)/i.test(input.slice(lt, lt + 12))) {
        let j = lt + 2;
        let q = "";
        let bracketDepth = 0;
        while (j < len) {
          const c = input[j];
          if (q) {
            if (c === q) q = "";
          } else if (c === '"' || c === "'") {
            q = c;
          } else if (c === "[") {
            bracketDepth += 1;
          } else if (c === "]" && bracketDepth > 0) {
            bracketDepth -= 1;
          } else if (c === ">" && bracketDepth === 0) {
            j += 1;
            break;
          }
          j += 1;
        }
        i = j;
        continue;
      }

      // Buscar fin del tag respetando comillas; si hay otro '<' sin comillas antes de '>',
      // neutralizar el fragmento incompleto como '&lt;' para evitar recomposición de tags peligrosos.
      let j = lt + 1;
      let quote = "";
      let brokenByLt = false;
      while (j < len) {
        const ch = input[j];
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === "<") {
          brokenByLt = true;
          break;
        } else if (ch === ">") {
          j += 1;
          break;
        }
        j += 1;
      }
      if (brokenByLt || j > len || (j === len && input[len - 1] !== ">")) {
        if (!skipDepthTag) {
          out.push("&lt;", input.slice(lt + 1, j));
        }
        i = j;
        continue;
      }
      const rawTag = input.slice(lt, j);
      const parsed = sanitizeSvgOpeningTag(rawTag);

      if (skipDepthTag) {
        if (parsed.isClose && parsed.tagLower === skipDepthTag) {
          skipDepthTag = null;
        }
        i = j;
        continue;
      }

      if (parsed.removed) {
        if (!parsed.isClose && !parsed.isSelfClosing) {
          skipDepthTag = parsed.tagLower;
        }
        i = j;
        continue;
      }

      if (parsed.tagLower === "style" && !parsed.isClose && !parsed.isSelfClosing) {
        const restAfterStyle = input.slice(j);
        const closeStyleMatch = /<\/style\s*>/i.exec(restAfterStyle);
        const cssBody = closeStyleMatch ? restAfterStyle.slice(0, closeStyleMatch.index) : restAfterStyle;
        out.push(parsed.html, sanitizeSvgStyleBlock(cssBody), "</style>");
        i = closeStyleMatch ? j + closeStyleMatch.index + closeStyleMatch[0].length : len;
        continue;
      }

      out.push(parsed.html);
      i = j;
    }

    return out.join("");
  };

  let cleaned = svgMarkup;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = stripPass(cleaned);
    if (next === cleaned) break;
    cleaned = next;
  }

  if (!/<svg[\s>/]/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}
