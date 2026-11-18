/**
 * Popover táctil y por teclado `@archivo` para adjuntar cualquier archivo de texto del proyecto
 * al contexto de la IA (hasta 8 archivos adjuntos por consulta).
 */

import { icon } from "../ui/icons.js";
import { escapeHtml } from "../utils/dom.js";
import { isIgnoredPreviewPath } from "../preview/previewUtils.js";

export const MAX_AI_ATTACHMENTS = 8;

/**
 * Extrae una consulta `@archivo` activa justo antes de la posición del cursor.
 * Ignora correos (`usuario@dominio`) exigiendo inicio de línea, espacio o delimitador previo.
 *
 * @param {string} text
 * @param {number} caretIndex
 * @returns {{ query: string, startIndex: number, endIndex: number } | null}
 */
export function extractMentionQuery(text, caretIndex) {
  const src = String(text ?? "");
  const pos = Math.max(0, Math.min(src.length, Number(caretIndex) || 0));
  const before = src.slice(0, pos);
  const match = before.match(/(?:^|[\s(\[{,"'`])@([^\s@"'`]*)$/);
  if (!match) return null;
  const query = match[1] || "";
  const startIndex = pos - query.length - 1;
  return {
    query,
    startIndex,
    endIndex: pos
  };
}

/**
 * Filtra y ordena los archivos candidatos del proyecto para el autocompletado `@archivo`.
 * @param {Array<{ id: string, path: string, shortName?: string, isBinary?: boolean }>} files
 * @param {string} query
 * @param {string | null} [excludeFileId]
 * @param {number} [limit]
 */
export function filterMentionCandidates(files, query, excludeFileId = null, limit = 14) {
  const cleanQuery = String(query || "").trim().toLowerCase();
  const candidates = [];

  for (const f of files || []) {
    if (!f || !f.path || f.isBinary || f.isFolder) continue;
    if (excludeFileId && f.id === excludeFileId) continue;
    if (isIgnoredPreviewPath(f.path)) continue;

    const pathLower = f.path.toLowerCase();
    const shortName = (f.shortName || f.path.split("/").pop() || f.path).toLowerCase();

    let score = 0;
    if (!cleanQuery) {
      score = 1;
    } else if (shortName.startsWith(cleanQuery)) {
      score = 100;
    } else if (pathLower.startsWith(cleanQuery)) {
      score = 80;
    } else if (shortName.includes(cleanQuery)) {
      score = 60;
    } else if (pathLower.includes(cleanQuery)) {
      score = 40;
    } else {
      continue;
    }

    candidates.push({ file: f, score });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.file.path.localeCompare(b.file.path);
  });

  return candidates.slice(0, limit).map((c) => c.file);
}

/**
 * Crea y conecta el popover `@archivo` sobre el textarea del compositor de IA.
 */
export function createMentionPopover({
  promptInput,
  composerForm,
  getProjectFiles,
  getActiveFileId,
  onSelectFile,
  listenOpts
}) {
  if (
    !promptInput ||
    !composerForm ||
    typeof document === "undefined" ||
    (typeof composerForm.insertBefore !== "function" && typeof composerForm.appendChild !== "function") ||
    typeof promptInput.addEventListener !== "function" ||
    typeof document.createElement !== "function"
  ) {
    return {
      isOpen: () => false,
      close: () => {},
      refresh: () => {},
      destroy: () => {}
    };
  }

  let popoverEl = document.getElementById("chat-mention-popover");
  if (!popoverEl) {
    popoverEl = document.createElement("div");
    popoverEl.id = "chat-mention-popover";
    popoverEl.className = "chat-mention-popover";
    popoverEl.setAttribute("role", "listbox");
    popoverEl.setAttribute("aria-label", "Adjuntar archivo del proyecto");
    popoverEl.hidden = true;
    if (typeof composerForm.insertBefore === "function") {
      composerForm.insertBefore(popoverEl, composerForm.firstChild);
    } else {
      composerForm.appendChild(popoverEl);
    }
  }

  let activeMention = null;
  let items = [];
  let activeIndex = 0;

  function close() {
    activeMention = null;
    items = [];
    activeIndex = 0;
    popoverEl.hidden = true;
    popoverEl.innerHTML = "";
    promptInput.removeAttribute("aria-expanded");
  }

  function render() {
    if (!activeMention || items.length === 0) {
      close();
      return;
    }
    popoverEl.hidden = false;
    popoverEl.innerHTML = "";
    promptInput.setAttribute("aria-expanded", "true");

    const head = document.createElement("div");
    head.className = "chat-mention-head";
    head.textContent = "Mencionar archivo (@) — máx. 8 adjuntos";
    popoverEl.appendChild(head);

    items.forEach((file, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `chat-mention-item${idx === activeIndex ? " is-selected" : ""}`;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(idx === activeIndex));
      const short = file.shortName || file.path.split("/").pop() || file.path;
      const folderPart = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      btn.innerHTML = `
        <span class="chat-mention-icon">${icon("fileCode")}</span>
        <span class="chat-mention-name">${escapeHtml(short)}</span>
        ${folderPart ? `<span class="chat-mention-path code-font">${escapeHtml(folderPart)}</span>` : ""}
      `;
      btn.addEventListener("pointerdown", (event) => {
        // Evita perder el foco del teclado en iPadOS al tocar una opción
        event.preventDefault();
      });
      btn.addEventListener("click", () => {
        void commitSelection(idx);
      });
      popoverEl.appendChild(btn);
    });
  }

  async function commitSelection(idx) {
    const file = items[idx];
    const mention = activeMention;
    if (!file || !mention) {
      close();
      return;
    }
    const text = promptInput.value || "";
    const replacement = `@${file.path} `;
    const nextVal = text.slice(0, mention.startIndex) + replacement + text.slice(mention.endIndex);
    const nextCaret = mention.startIndex + replacement.length;
    promptInput.value = nextVal;
    try {
      promptInput.setSelectionRange(nextCaret, nextCaret);
    } catch (_) {}
    close();
    promptInput.focus();
    await onSelectFile?.(file);
  }

  function refresh() {
    const caret = typeof promptInput.selectionStart === "number" ? promptInput.selectionStart : (promptInput.value || "").length;
    const mention = extractMentionQuery(promptInput.value || "", caret);
    if (!mention) {
      close();
      return;
    }
    const candidates = filterMentionCandidates(
      typeof getProjectFiles === "function" ? getProjectFiles() : [],
      mention.query,
      typeof getActiveFileId === "function" ? getActiveFileId() : null
    );
    if (candidates.length === 0) {
      close();
      return;
    }
    activeMention = mention;
    items = candidates;
    activeIndex = 0;
    render();
  }

  promptInput.addEventListener("input", refresh, listenOpts);
  promptInput.addEventListener("click", refresh, listenOpts);
  promptInput.addEventListener("keydown", (event) => {
    if (popoverEl.hidden || items.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      render();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      render();
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      void commitSelection(activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }, listenOpts);

  promptInput.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (typeof document !== "undefined" && document.activeElement && popoverEl.contains(document.activeElement)) {
        return;
      }
      close();
    }, 120);
  }, listenOpts);

  return {
    isOpen: () => !popoverEl.hidden,
    close,
    refresh,
    destroy: () => {
      close();
      if (popoverEl.parentNode === composerForm) {
        popoverEl.remove();
      }
    }
  };
}
