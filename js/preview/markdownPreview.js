/**
 * Renderizador seguro 100% offline de documentos Markdown (.md / README.md) para Vista Previa.
 */

import { escapeHtml } from "./previewUtils.js";

export function buildMarkdownPreview(mdFile) {
  const renderedBody = renderMarkdownDocumentHtml(mdFile.content || "");
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

export function renderMarkdownDocumentHtml(rawMd) {
  const blocks = splitMarkdownCodeFences(rawMd);

  return blocks
    .map((b) => {
      if (b.type === "code") {
        return `<pre><code>${escapeHtml(b.code)}</code></pre>`;
      }
      return b.text.trim() ? renderMarkdownProseBlock(b.text) : "";
    })
    .filter(Boolean)
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
  const links = [];
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
  safe = safe.replace(/\u0000C(\d+)\u0000/g, (_, i) => codes[Number(i)] || "");
  return safe;
}
