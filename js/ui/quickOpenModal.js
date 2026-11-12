import { icon } from "./icons.js";
import { keyboardRouter } from "./keyboardRouter.js";

/**
 * Parsea una consulta de apertura rápida separando el nombre de archivo de la línea de salto opcional.
 * Admite formatos como: "app.js:42", ":42" (para el archivo activo), "src/main.py:100".
 * @param {string} rawQuery
 * @returns {{ fileQuery: string, targetLine: number | null }}
 */
export function parseQuickOpenQuery(rawQuery) {
  const text = String(rawQuery || "").trim();
  const colonIdx = text.lastIndexOf(":");
  if (colonIdx === -1) {
    return { fileQuery: text, targetLine: null };
  }
  const afterColon = text.slice(colonIdx + 1).trim();
  if (/^\d+$/.test(afterColon)) {
    const lineNum = parseInt(afterColon, 10);
    return {
      fileQuery: text.slice(0, colonIdx).trim(),
      targetLine: lineNum > 0 ? lineNum : null
    };
  }
  return { fileQuery: text, targetLine: null };
}

/**
 * Paleta de apertura rápida de archivos (Cmd/Ctrl + P y botón de búsqueda en el Explorador),
 * ideal para saltar en un toque a cualquier archivo de un repositorio grande en el iPad o PC.
 */
export function initQuickOpenModal({ getFiles, getActiveFile, onSelectFile }) {
  const openBtn = document.getElementById("btn-quick-open");
  const dialog = document.getElementById("quick-open-dialog");
  const closeBtn = document.getElementById("btn-close-quick-open");
  const input = document.getElementById("quick-open-input");
  const listEl = document.getElementById("quick-open-list");

  let filtered = [];
  let activeIndex = 0;
  let currentTargetLine = null;

  function open() {
    if (!dialog) return;
    if (input) {
      input.value = "";
    }
    activeIndex = 0;
    currentTargetLine = null;
    renderResults("");
    if (!dialog.open) {
      dialog.showModal();
    }
    keyboardRouter.pushModal({
      id: "quick-open-dialog",
      blockGlobalShortcuts: true,
      onEscape: () => close()
    });
    window.requestAnimationFrame(() => {
      input?.focus();
    });
  }

  function close() {
    keyboardRouter.popModal("quick-open-dialog");
    dialog?.close();
  }

  openBtn?.addEventListener("click", () => open());
  closeBtn?.addEventListener("click", () => close());

  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      close();
    }
  });

  input?.addEventListener("input", () => {
    activeIndex = 0;
    renderResults(input.value);
  });

  input?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length > 0) {
        activeIndex = (activeIndex + 1) % filtered.length;
        syncHighlight();
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length > 0) {
        activeIndex = (activeIndex - 1 + filtered.length) % filtered.length;
        syncHighlight();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const chosen = filtered[activeIndex];
      if (chosen) {
        pickFile(chosen.path, currentTargetLine);
      }
    }
  });

  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
      if (keyboardRouter.shouldBlockGlobalShortcuts("quick-open-dialog")) {
        return;
      }
      event.preventDefault();
      if (dialog?.open) {
        close();
      } else {
        open();
      }
    }
  });

  function pickFile(path, targetLine = currentTargetLine) {
    close();
    onSelectFile(path, targetLine);
  }

  function renderResults(rawQuery) {
    if (!listEl) return;
    const allFiles = getFiles() || [];
    const parsed = parseQuickOpenQuery(rawQuery);
    currentTargetLine = parsed.targetLine;
    const query = parsed.fileQuery.toLowerCase();
    const activeFile = getActiveFile ? getActiveFile() : null;

    if (!query) {
      if (currentTargetLine && activeFile) {
        const rest = allFiles.filter((f) => f.id !== activeFile.id);
        filtered = [activeFile, ...rest].slice(0, 50);
      } else {
        filtered = allFiles.slice(0, 50);
      }
    } else {
      const scored = [];
      for (const file of allFiles) {
        const lowerPath = file.path.toLowerCase();
        const lowerName = file.shortName.toLowerCase();
        if (lowerName === query) {
          scored.push({ file, score: 0 });
        } else if (lowerName.startsWith(query)) {
          scored.push({ file, score: 1 });
        } else if (lowerName.includes(query)) {
          scored.push({ file, score: 2 });
        } else if (lowerPath.includes(query)) {
          scored.push({ file, score: 3 });
        }
      }
      scored.sort((a, b) => a.score - b.score || a.file.path.localeCompare(b.file.path));
      filtered = scored.slice(0, 50).map((s) => s.file);
    }

    listEl.innerHTML = "";
    if (filtered.length === 0) {
      const emptyLi = document.createElement("li");
      emptyLi.className = "quick-open-empty";
      emptyLi.textContent = allFiles.length === 0
        ? "Este proyecto aún no tiene archivos."
        : "No se encontraron archivos con ese nombre.";
      listEl.appendChild(emptyLi);
      return;
    }

    filtered.forEach((file, idx) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = idx === activeIndex ? "quick-open-item is-active" : "quick-open-item";
      const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "raíz";
      const lineBadge = currentTargetLine
        ? `<span class="quick-open-line-badge code-font">:l ${currentTargetLine}</span>`
        : "";
      btn.innerHTML = `
        <span class="quick-open-main">
          ${icon(file.icon)}
          <span class="quick-open-name">${escapeHtml(file.shortName)}</span>
          <span class="quick-open-dir code-font">${escapeHtml(dir)}</span>
        </span>
        <span class="quick-open-meta">
          ${lineBadge}
          <span class="file-tree-lang">${escapeHtml(file.badge)}</span>
        </span>
      `;
      btn.addEventListener("click", () => pickFile(file.path, currentTargetLine));
      li.appendChild(btn);
      listEl.appendChild(li);
    });
  }

  function syncHighlight() {
    if (!listEl) return;
    const buttons = listEl.querySelectorAll(".quick-open-item");
    buttons.forEach((btn, idx) => {
      btn.classList.toggle("is-active", idx === activeIndex);
      if (idx === activeIndex && btn instanceof HTMLElement) {
        btn.scrollIntoView({ block: "nearest" });
      }
    });
  }

  return {
    open,
    close
  };
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
