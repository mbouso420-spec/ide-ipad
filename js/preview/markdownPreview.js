/**
 * Renderizador seguro 100% offline de documentos Markdown (.md / README.md) para Vista Previa.
 */

import { escapeHtml, isBlockedPreviewUrlScheme, normalizePreviewUrlRef, resolveRelativePath } from "./previewUtils.js";
import { normalizePath } from "../storage/workspaceDb.js";
import { getImageMimeType } from "../storage/fileImport.js";

export function buildMarkdownPreview(mdFile, assetMap = null) {
  const baseDir = mdFile?.path ? mdFile.path.split("/").slice(0, -1).join("/") : "";
  const renderedBody = renderMarkdownDocumentHtml(mdFile.content || "", { assetMap, baseDir });
  const safeTitle = escapeHtml(mdFile.shortName);

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
    .md-image, .md-article img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      margin: 12px 0;
      border: 1px solid var(--border);
      background: repeating-conic-gradient(var(--card) 0% 25%, transparent 0% 50%) 50% / 12px 12px;
      display: block;
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

/**
 * Divide un documento Markdown en bloques alternos de prosa y cercos de código
 * con longitud variable de backticks (```, ````, etc.) para soportar bloques anidados.
 */
export function splitMarkdownCodeFences(rawMd) {
  const lines = String(rawMd || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let proseLines = [];
  let inFence = false;
  let fenceLen = 0;
  let rawHeader = "";
  let codeLines = [];

  const flushProse = () => {
    if (proseLines.length === 0) return;
    blocks.push({ type: "prose", text: proseLines.join("\n") });
    proseLines = [];
  };

  const pushCode = (unclosed) => {
    let lang = (rawHeader.split(/\s+/)[0] || "").toLowerCase();
    if (lang.includes(":")) {
      lang = lang.split(":")[0];
    }
    let code = codeLines.join("\n");
    if (unclosed) {
      code = code.replace(/\n$/, "");
    }
    blocks.push({
      type: "code",
      rawHeader,
      lang,
      code,
      unclosed
    });
  };

  for (const line of lines) {
    if (!inFence) {
      const openMatch = line.match(/^ {0,3}(`{3,})([^`]*)$/);
      if (openMatch) {
        flushProse();
        inFence = true;
        fenceLen = openMatch[1].length;
        rawHeader = openMatch[2].trim();
        codeLines = [];
        continue;
      }
      proseLines.push(line);
    } else {
      const closeMatch = line.match(/^ {0,3}(`{3,})[ \t]*$/);
      if (closeMatch && closeMatch[1].length >= fenceLen) {
        pushCode(false);
        inFence = false;
        fenceLen = 0;
        rawHeader = "";
        codeLines = [];
        continue;
      }
      codeLines.push(line);
    }
  }

  if (inFence) {
    pushCode(true);
  } else {
    flushProse();
  }

  return blocks;
}

export function renderMarkdownDocumentHtml(rawMd, options = {}) {
  const blocks = splitMarkdownCodeFences(rawMd);

  return blocks
    .map((b) => {
      if (b.type === "code") {
        return `<pre><code>${escapeHtml(b.code)}</code></pre>`;
      }
      return b.text.trim() ? renderMarkdownProseBlock(b.text, options) : "";
    })
    .filter(Boolean)
    .join("\n");
}

function renderMarkdownProseBlock(text, options = {}) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let para = [];
  let listTag = null;
  let listItems = [];
  let tableRows = [];

  const flushPara = () => {
    if (para.length > 0) {
      out.push(`<p>${para.map((line) => formatMdInline(line, options)).join("<br>")}</p>`);
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
    const thead = `<thead><tr>${head.map((h) => `<th>${formatMdInline(h, options)}</th>`).join("")}</tr></thead>`;
    const tbody =
      body.length > 0
        ? `<tbody>${body.map((row) => `<tr>${row.map((c) => `<td>${formatMdInline(c, options)}</td>`).join("")}</tr>`).join("")}</tbody>`
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
      out.push(`<h${lvl}>${formatMdInline(hMatch[2], options)}</h${lvl}>`);
      continue;
    }

    const qMatch = trimmed.match(/^>\s?(.*)$/);
    if (qMatch) {
      flushPara();
      flushList();
      out.push(`<blockquote>${formatMdInline(qMatch[1], options)}</blockquote>`);
      continue;
    }

    const ulMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushPara();
      if (listTag && listTag !== "ul") flushList();
      listTag = "ul";
      listItems.push(`<li>${formatMdInline(ulMatch[1], options)}</li>`);
      continue;
    }

    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      flushPara();
      if (listTag && listTag !== "ol") flushList();
      listTag = "ol";
      listItems.push(`<li>${formatMdInline(olMatch[1], options)}</li>`);
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

export function formatMdInline(str, options = {}) {
  const codes = [];
  const links = [];
  const images = [];
  const assetMap = options?.assetMap || null;
  const baseDir = typeof options?.baseDir === "string" ? options.baseDir : "";

  const cleanStr = String(str ?? "").replace(/\u0000/g, "");
  const masked = cleanStr.replace(/`([^`]+)`/g, (_, c) => {
    const i = codes.length;
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000C${i}\u0000`;
  });

  const applyEmphasis = (text) =>
    text
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  let safe = escapeHtml(masked);

  // Imágenes Markdown: ![alt](url "title")
  safe = safe.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"([^"]*)"|'([^']*)'|&quot;((?:(?!&quot;).)*)&quot;|&#39;((?:(?!&#39;).)*)&#39;))?\)/g,
    (_, alt, rawUrl, t1, t2, t3, t4) => {
      const title = t1 || t2 || t3 || t4 || "";
      let resolvedSrc = rawUrl;
      if (assetMap) {
        const cleanRef = rawUrl.trim().split("?")[0].split("#")[0];
        const relPath = resolveRelativePath(baseDir, cleanRef);
        const normRef = normalizePath(cleanRef);
        const entry = assetMap.get(relPath) || assetMap.get(normRef) || assetMap.get(cleanRef) || null;
        if (entry) {
          const ext = (entry.path || cleanRef).split(".").pop().toLowerCase();
          const rawB64 = typeof entry.base64 === "string" && entry.base64.length > 0
            ? entry.base64
            : entry.isBinary && typeof entry.content === "string" && entry.content.length > 0
              ? entry.content
              : null;
          const compactB64 = typeof rawB64 === "string" ? rawB64.replace(/\s+/g, "") : "";
          const b64 = compactB64 && /^[A-Za-z0-9+/_=-]+$/.test(compactB64) ? compactB64 : null;
          if (b64) {
            const mime = getImageMimeType(entry.path || cleanRef);
            resolvedSrc = `data:${mime};base64,${b64}`;
          } else if (ext === "svg" && typeof entry.content === "string") {
            const encodedSvg = encodeURIComponent(entry.content)
              .replace(/'/g, "%27")
              .replace(/"/g, "%22");
            resolvedSrc = `data:image/svg+xml;charset=utf-8,${encodedSvg}`;
          }
        }
      }
      const normCandidate = normalizePreviewUrlRef(resolvedSrc);
      const isSafeDataImage = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|ico|svg\+xml)[;,]/i.test(normCandidate);
      if (isBlockedPreviewUrlScheme(normCandidate) && !isSafeDataImage) {
        const safeLabel = escapeHtml(alt || "imagen bloqueada");
        return `<span class="md-blocked-img">[${safeLabel}]</span>`;
      }
      const safeSrc = resolvedSrc;
      const safeTitle = title ? ` title="${title}"` : "";
      const i = images.length;
      images.push(`<img src="${safeSrc}" alt="${alt}"${safeTitle} class="md-image">`);
      return `\u0000I${i}\u0000`;
    }
  );

  safe = safe.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g,
    (_, label, url) => {
      const i = links.length;
      links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${applyEmphasis(label)}</a>`);
      return `\u0000L${i}\u0000`;
    }
  );
  safe = safe.replace(
    /\[([^\]]+)\]\((#[a-zA-Z0-9_-]+)\)/g,
    (_, label, hash) => {
      const i = links.length;
      links.push(`<a href="${hash}">${applyEmphasis(label)}</a>`);
      return `\u0000L${i}\u0000`;
    }
  );
  safe = applyEmphasis(safe);
  safe = safe.replace(/\u0000L(\d+)\u0000/g, (_, i) => links[Number(i)] || "");
  safe = safe.replace(/\u0000I(\d+)\u0000/g, (_, i) => images[Number(i)] || "");
  safe = safe.replace(/\u0000C(\d+)\u0000/g, (_, i) => codes[Number(i)] || "");
  return safe;
}
