import { icon } from "./icons.js";
import { keyboardRouter } from "./keyboardRouter.js";
import { escapeHtml } from "../utils/dom.js";

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
export function initQuickOpenModal({
  getFiles,
  getActiveFile,
  onSelectFile,
  getCommands
}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = controller ? { signal: controller.signal } : undefined;
  const openBtn = document.getElementById("btn-quick-open");
  const dialog = document.getElementById("quick-open-dialog");
  const closeBtn = document.getElementById("btn-close-quick-open");
  const input = document.getElementById("quick-open-input");
  const listEl = document.getElementById("quick-open-list");

  let filtered = [];
  let activeIndex = 0;
  let currentTargetLine = null;

  function open(initialPrefix = "") {
    if (!dialog) return;
    if (input) {
      input.value = initialPrefix;
    }
    activeIndex = 0;
    currentTargetLine = null;
    renderResults(initialPrefix);
    if (!dialog.open) {
      dialog.showModal();
    }
    keyboardRouter.pushModal({
      id: "quick-open-dialog",
      blockGlobalShortcuts: true,
      onEscape: () => close(),
      onKey: (event) => {
        const key = typeof event?.key === "string" ? event.key.toLowerCase() : "";
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && (key === "p" || key === "k")) {
          event.preventDefault();
          close();
          return true;
        }
        return false;
      }
    });
    const scheduleFocus = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? (cb) => window.requestAnimationFrame(cb)
      : (cb) => setTimeout(cb, 0);
    scheduleFocus(() => {
      input?.focus();
      if (initialPrefix && typeof input?.setSelectionRange === "function") {
        input.setSelectionRange(initialPrefix.length, initialPrefix.length);
      }
    });
  }

  function close() {
    keyboardRouter.popModal("quick-open-dialog");
    dialog?.close();
  }

  openBtn?.addEventListener("click", () => open(""), listenOpts);
  closeBtn?.addEventListener("click", () => close(), listenOpts);

  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      close();
    }
  }, listenOpts);

  input?.addEventListener("input", () => {
    activeIndex = 0;
    renderResults(input.value);
  }, listenOpts);

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
        if (chosen.kind === "command") {
          close();
          try {
            chosen.cmd.run?.();
          } catch (err) {
            console.error("[CommandPalette] Error al ejecutar comando:", err);
          }
        } else {
          pickFile(chosen.file.path, currentTargetLine);
        }
      }
    }
  }, listenOpts);

  const handleShortcutToggle = (prefix = "") => {
    if (dialog?.open) {
      close();
    } else {
      open(prefix);
    }
  };
  keyboardRouter.registerGlobalShortcut("ctrl+p", () => handleShortcutToggle(""));
  keyboardRouter.registerGlobalShortcut("meta+p", () => handleShortcutToggle(""));
  keyboardRouter.registerGlobalShortcut("ctrl+k", () => handleShortcutToggle(">"));
  keyboardRouter.registerGlobalShortcut("meta+k", () => handleShortcutToggle(">"));

  function pickFile(path, targetLine = currentTargetLine) {
    close();
    onSelectFile(path, targetLine);
  }

  function renderResults(rawQuery) {
    if (!listEl) return;
    const titleEl = document.getElementById("quick-open-title");
    const isCommandMode = rawQuery.trim().startsWith(">");

    if (titleEl) {
      titleEl.textContent = isCommandMode ? "Paleta de comandos" : "Ir al archivo";
    }
    if (input) {
      input.placeholder = isCommandMode
        ? "Escribí una acción o comando del editor…"
        : "Escribí el nombre del archivo o '>' para comandos…";
    }

    if (isCommandMode) {
      const cmdQuery = rawQuery.trim().slice(1).trim().toLowerCase();
      const allCommands = typeof getCommands === "function" ? getCommands() || [] : [];
      let matches = [];
      if (!cmdQuery) {
        matches = allCommands;
      } else {
        matches = allCommands.filter((cmd) => {
          const t = cmd.title.toLowerCase();
          const c = (cmd.category || "").toLowerCase();
          const s = (cmd.shortcut || "").toLowerCase();
          return t.includes(cmdQuery) || c.includes(cmdQuery) || s.includes(cmdQuery);
        });
      }
      filtered = matches.map((cmd) => ({
        kind: "command",
        cmd,
        shortName: cmd.title,
        path: cmd.category || "Comando",
        icon: cmd.icon || "sparkles",
        badge: cmd.shortcut || ""
      }));
    } else {
      const allFiles = getFiles() || [];
      const parsed = parseQuickOpenQuery(rawQuery);
      currentTargetLine = parsed.targetLine;
      const query = parsed.fileQuery.toLowerCase();
      const activeFile = getActiveFile ? getActiveFile() : null;

      let fileList = [];
      if (!query) {
        if (currentTargetLine && activeFile) {
          const rest = allFiles.filter((f) => f.id !== activeFile.id);
          fileList = [activeFile, ...rest].slice(0, 50);
        } else {
          fileList = allFiles.slice(0, 50);
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
        fileList = scored.slice(0, 50).map((s) => s.file);
      }

      filtered = fileList.map((file) => ({
        kind: "file",
        file,
        shortName: file.shortName,
        path: file.path,
        icon: file.icon,
        badge: file.badge
      }));
    }

    listEl.innerHTML = "";
    if (filtered.length === 0) {
      const emptyLi = document.createElement("li");
      emptyLi.className = "quick-open-empty";
      emptyLi.textContent = isCommandMode
        ? "No se encontraron comandos coincidentes."
        : (getFiles() || []).length === 0
          ? "Este proyecto aún no tiene archivos."
          : "No se encontraron archivos con ese nombre.";
      listEl.appendChild(emptyLi);
      return;
    }

    filtered.forEach((item, idx) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = idx === activeIndex ? "quick-open-item is-active" : "quick-open-item";

      const isCmd = item.kind === "command";
      const dir = isCmd
        ? item.path
        : item.path.includes("/")
          ? item.path.slice(0, item.path.lastIndexOf("/"))
          : "raíz";

      const lineBadge = !isCmd && currentTargetLine
        ? `<span class="quick-open-line-badge code-font">:l ${currentTargetLine}</span>`
        : "";

      const metaBadge = isCmd
        ? (item.badge ? `<span class="quick-open-kbd-badge code-font">${escapeHtml(item.badge)}</span>` : "")
        : `<span class="file-tree-lang">${escapeHtml(item.badge || "")}</span>`;

      btn.innerHTML = `
        <span class="quick-open-main">
          ${icon(item.icon)}
          <span class="quick-open-name">${escapeHtml(item.shortName)}</span>
          <span class="quick-open-dir code-font">${escapeHtml(dir)}</span>
        </span>
        <span class="quick-open-meta">
          ${lineBadge}
          ${metaBadge}
        </span>
      `;

      btn.addEventListener("click", () => {
        if (item.kind === "command") {
          close();
          try {
            item.cmd.run?.();
          } catch (err) {
            console.error("[CommandPalette] Error al ejecutar comando:", err);
          }
        } else {
          pickFile(item.file.path, currentTargetLine);
        }
      });
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
    close,
    destroy() {
      controller?.abort();
      keyboardRouter.unregisterGlobalShortcut("ctrl+p");
      keyboardRouter.unregisterGlobalShortcut("meta+p");
      keyboardRouter.unregisterGlobalShortcut("ctrl+k");
      keyboardRouter.unregisterGlobalShortcut("meta+k");
    }
  };
}
