/**
 * Utilidades puras de formateo Markdown seguro, segmentación de código, truncamiento de contexto y tokens para IA.
 */

import { escapeHtml } from "../utils/dom.js";
import { splitMarkdownCodeFences } from "../preview/markdownPreview.js";

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Limpia anotaciones de interrupción o errores de transporte del historial antes de enviarlo a la API de IA.
 * @param {Array<{ role: string, content: string }>} rawConvo
 * @returns {Array<{ role: string, content: string }>}
 */
export function cleanHistoryForAi(rawConvo) {
  if (!Array.isArray(rawConvo)) return [];
  return rawConvo
    .map((m) => {
      let content = String(m?.content || "");
      content = content.split("\n\n*(Generación detenida)*").join("");
      const marker = "\n\n*(Respuesta interrumpida:";
      let idx = content.indexOf(marker);
      while (idx !== -1) {
        const closeIdx = content.indexOf(")*", idx + marker.length);
        if (closeIdx === -1) break;
        content = content.slice(0, idx) + content.slice(closeIdx + 2);
        idx = content.indexOf(marker, idx);
      }
      return { role: m.role, content: content.trim() };
    })
    .filter((m) => Boolean(m.content));
}

/**
 * Trunca contenido de código extenso de forma equilibrada (conservando cabecera y pie)
 * para no desbordar el presupuesto de tokens de modelos gratuitos (TPM).
 * @param {string} content
 * @param {number} [maxChars]
 * @returns {string}
 */
export function truncateCodeContent(content, maxChars = 16000) {
  if (typeof content !== "string" || content.length <= maxChars) {
    return typeof content === "string" ? content : "";
  }
  const headTarget = Math.floor(maxChars * 0.6);
  const tailTarget = maxChars - headTarget;

  const headEnd = content.lastIndexOf("\n", headTarget);
  const headSlice = headEnd > 0 ? content.slice(0, headEnd) : content.slice(0, headTarget);

  const tailStartOffset = content.length - tailTarget;
  const tailStart = content.indexOf("\n", tailStartOffset);
  const tailSlice = tailStart > 0 ? content.slice(tailStart + 1) : content.slice(tailStartOffset);

  const middleText = content.slice(headSlice.length, content.length - tailSlice.length);
  const omittedLines = Math.max(1, middleText.split("\n").length);

  return `${headSlice}\n\n// ... [${omittedLines} líneas omitidas por límite de contexto de la API gratuita] ...\n\n${tailSlice}`;
}

function sanitizeDetectedFilePath(rawCandidate) {
  if (typeof rawCandidate !== "string") return null;
  const trimmed = rawCandidate.trim();
  if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
  if (trimmed.startsWith("/") || trimmed.includes("\\") || trimmed.includes("://")) return null;
  if (/^[a-zA-Z]:/.test(trimmed)) return null;

  const rawParts = trimmed.split("/");
  const cleanParts = [];
  for (const part of rawParts) {
    if (!part || part === ".") continue;
    if (part === ".." || FORBIDDEN_PATH_SEGMENTS.has(part.toLowerCase())) {
      return null;
    }
    cleanParts.push(part);
  }
  if (cleanParts.length === 0) return null;
  const normalized = cleanParts.join("/");
  return normalized.includes(".") ? normalized : null;
}

export function detectFilePathFromCodeSegment(rawHeader, code, precedingProse = "") {
  if (rawHeader) {
    if (rawHeader.includes(":")) {
      const parts = rawHeader.split(":");
      if (parts[1] && parts[1].trim()) {
        const candidate = sanitizeDetectedFilePath(parts[1].trim().split(/\s+/)[0]);
        if (candidate) return candidate;
      }
    }
    const fileParamMatch = rawHeader.match(/(?:file|filepath|path)=["']?([^"'\s]+)["']?/i);
    if (fileParamMatch) {
      const candidate = sanitizeDetectedFilePath(fileParamMatch[1]);
      if (candidate) return candidate;
    }
    const headerParts = rawHeader.split(/\s+/);
    if (headerParts.length > 1) {
      const candidate = sanitizeDetectedFilePath(headerParts[1]);
      if (candidate) return candidate;
    }
  }

  const firstLine = (code || "").trim().split(/\r?\n/)[0] || "";
  const commentMatch = firstLine.match(/^(?:\/\/|#|\/\*|<!--)\s*(?:file(?:path)?|archivo):\s*([^\s]+)/i);
  if (commentMatch) {
    const cleaned = commentMatch[1].replace(/(?:\*\/|-->)+$/g, "");
    const candidate = sanitizeDetectedFilePath(cleaned);
    if (candidate) {
      return candidate;
    }
  }

  if (precedingProse) {
    const lines = precedingProse.trim().split(/\r?\n/);
    const lastProseLine = lines[lines.length - 1] || "";
    const proseMatch = lastProseLine.match(/(?:archivo|file|filepath):\s*[`*_]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`*_]?/i);
    if (proseMatch) {
      const candidate = sanitizeDetectedFilePath(proseMatch[1]);
      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
}

function buildSegmentsFromBlocks(blocks, initialProse = "", baseOffset = 0, segmentOffsets = null) {
  const segments = [];
  let lastProseContent = initialProse;
  for (const block of blocks) {
    if (block.type === "prose") {
      const prose = block.text.trim();
      if (prose) {
        lastProseContent = prose;
        segments.push({ type: "prose", content: prose });
        if (segmentOffsets) segmentOffsets.push(baseOffset + (block.startOffset || 0));
      } else if (segments.length > 0 && segments[segments.length - 1].type === "prose") {
        lastProseContent = segments[segments.length - 1].content;
      } else if (segments.length > 0) {
        lastProseContent = "";
      }
    } else {
      const filePath = detectFilePathFromCodeSegment(block.rawHeader, block.code, lastProseContent);
      const segment = {
        type: "code",
        lang: block.lang,
        code: block.code
      };
      if (filePath) {
        segment.filePath = filePath;
      }
      segments.push(segment);
      if (segmentOffsets) segmentOffsets.push(baseOffset + (block.startOffset || 0));
    }
  }
  return segments;
}

/**
 * Segmenta Markdown respetando longitud y cierre de fences por línea para soportar bloques anidados.
 * @param {string} raw
 */
export function parseMarkdownSegments(raw) {
  const source = String(raw || "");
  if (!source) {
    return [];
  }
  const blocks = splitMarkdownCodeFences(source);
  return buildSegmentsFromBlocks(blocks);
}

/**
 * Segmenta de forma incremental únicamente el sufijo no cerrado durante streaming SSE.
 * @param {string} raw
 * @param {number} [startOffset=0]
 * @param {string} [initialProse=""]
 */
export function parseMarkdownSegmentsIncremental(raw, startOffset = 0, initialProse = "") {
  const source = String(raw || "");
  const safeOffset = startOffset > 0 && startOffset <= source.length ? startOffset : 0;
  const tail = safeOffset > 0 ? source.slice(safeOffset) : source;
  if (!tail) {
    return { segments: [], segmentOffsets: [] };
  }
  const blocks = splitMarkdownCodeFences(tail, { includeOffsets: true });
  const segmentOffsets = [];
  const segments = buildSegmentsFromBlocks(blocks, safeOffset > 0 ? initialProse : "", safeOffset, segmentOffsets);
  return { segments, segmentOffsets };
}

export function formatProseHtml(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let paragraphLines = [];
  let listType = null;
  let listItems = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      out.push(`<p>${paragraphLines.map(formatInlineMarkdown).join("<br>")}</p>`);
      paragraphLines = [];
    }
  };

  const flushList = () => {
    if (listType && listItems.length > 0) {
      out.push(`<${listType}>${listItems.join("")}</${listType}>`);
      listType = null;
      listItems = [];
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const hrMatch = trimmed.match(/^(-{3,}|\*{3,}|_{3,})$/);
    if (hrMatch) {
      flushParagraph();
      flushList();
      out.push('<hr class="chat-md-hr">');
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      out.push(`<h3 class="chat-md-heading">${formatInlineMarkdown(headingMatch[2])}</h3>`);
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      out.push(`<blockquote class="chat-md-quote">${formatInlineMarkdown(quoteMatch[1])}</blockquote>`);
      continue;
    }

    const ulMatch = rawLine.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listItems.push(`<li>${formatInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = rawLine.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listItems.push(`<li>${formatInlineMarkdown(olMatch[1])}</li>`);
      continue;
    }

    flushList();
    paragraphLines.push(rawLine);
  }

  flushParagraph();
  flushList();
  return out.join("");
}

/**
 * Estima la cantidad de tokens según la cantidad de caracteres (regla estándar de ~4 caracteres por token).
 * @param {number} charCount
 * @returns {number}
 */
export function estimateTokens(charCount) {
  const count = Math.max(0, Number(charCount) || 0);
  return Math.ceil(count / 4);
}

export function formatInlineMarkdown(str) {
  const codeTokens = [];
  const linkTokens = [];
  const cleanStr = String(str ?? "").replace(/\u0000/g, "");
  const withPlaceholders = cleanStr.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code class="chat-inline-code">${escapeHtml(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  const applyEmphasis = (text) =>
    text
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  let safe = escapeHtml(withPlaceholders);
  safe = safe.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g,
    (_, label, url) => {
      const idx = linkTokens.length;
      linkTokens.push(
        `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${applyEmphasis(label)}</a>`
      );
      return `\u0000LINK${idx}\u0000`;
    }
  );
  safe = applyEmphasis(safe);
  safe = safe.replace(/\u0000LINK(\d+)\u0000/g, (_, idx) => linkTokens[Number(idx)] || "");
  safe = safe.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeTokens[Number(idx)] || "");
  return safe;
}

export async function copyToClipboardSafe(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Respaldo con textarea temporal
    }
  }
  try {
    const temp = document.createElement("textarea");
    temp.value = text;
    temp.setAttribute("readonly", "");
    temp.style.position = "fixed";
    temp.style.opacity = "0";
    temp.style.pointerEvents = "none";
    document.body.appendChild(temp);
    temp.select();
    const ok = document.execCommand("copy");
    temp.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}
