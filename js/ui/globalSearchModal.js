import { searchInFiles } from "../search/projectSearch.js";
import { hydrateIcons } from "./icons.js";
import { keyboardRouter } from "./keyboardRouter.js";

/**
 * Controlador del Diálogo de Búsqueda Global en Archivos (Cmd/Ctrl + Shift + F)
 */
export function initGlobalSearchModal({ getFiles, onSelectMatch }) {
  const dialog = document.getElementById("global-search-dialog");
  const openBtn = document.getElementById("btn-global-search");
  const closeBtn = document.getElementById("btn-close-global-search");
  const input = document.getElementById("global-search-input");
  const statsEl = document.getElementById("global-search-stats");
  const resultsEl = document.getElementById("global-search-results");

  const btnCase = document.getElementById("btn-search-case");
  const btnWord = document.getElementById("btn-search-word");
  const btnRegex = document.getElementById("btn-search-regex");

  let isCaseSensitive = false;
  let isMatchWholeWord = false;
  let isRegex = false;
  let debounceTimer = null;
  let currentResults = [];
  let flatMatchItems = [];
  let selectedIndex = 0;

  function open() {
    if (!dialog) return;
    if (input) {
      input.value = "";
    }
    currentResults = [];
    flatMatchItems = [];
    selectedIndex = 0;
    renderEmptyState("Escribí un texto o expresión regular para buscar en todo el proyecto.");
    if (!dialog.open) {
      dialog.showModal();
    }
    keyboardRouter.pushModal({
      id: "global-search-dialog",
      blockGlobalShortcuts: true,
      onEscape: () => close()
    });
    window.requestAnimationFrame(() => {
      input?.focus();
    });
  }

  function close() {
    keyboardRouter.popModal("global-search-dialog");
    if (dialog?.open) {
      dialog.close();
    }
  }

  function performSearch() {
    const query = input ? input.value : "";
    if (!query.trim()) {
      currentResults = [];
      flatMatchItems = [];
      selectedIndex = 0;
      renderEmptyState("Escribí un texto o expresión regular para buscar en todo el proyecto.");
      return;
    }

    const files = typeof getFiles === "function" ? getFiles() : [];
    const searchRes = searchInFiles(files, query, {
      caseSensitive: isCaseSensitive,
      matchWholeWord: isMatchWholeWord,
      isRegex
    });

    if (searchRes.error) {
      renderErrorState(searchRes.error);
      return;
    }

    currentResults = searchRes.results;
    flatMatchItems = [];
    for (const fileRes of currentResults) {
      for (const m of fileRes.matches) {
        flatMatchItems.push({
          path: fileRes.path,
          line: m.line,
          column: m.column
        });
      }
    }

    selectedIndex = 0;
    renderResults(searchRes, query);
  }

  function renderEmptyState(message) {
    if (statsEl) statsEl.textContent = "";
    if (resultsEl) {
      resultsEl.innerHTML = `<div class="search-empty-state"><p>${escapeHtml(message)}</p></div>`;
    }
  }

  function renderErrorState(err) {
    if (statsEl) statsEl.textContent = "Error en la búsqueda";
    if (resultsEl) {
      resultsEl.innerHTML = `<div class="search-error-state"><p>${escapeHtml(err)}</p></div>`;
    }
  }

  function renderResults({ results, totalMatches, filesMatched }, query) {
    if (!resultsEl || !statsEl) return;

    if (totalMatches === 0) {
      statsEl.textContent = "Sin coincidencias";
      resultsEl.innerHTML = `
        <div class="search-empty-state">
          <p>No se encontraron coincidencias para "<strong>${escapeHtml(query)}</strong>"</p>
        </div>
      `;
      return;
    }

    const matchText = totalMatches === 1 ? "1 coincidencia" : `${totalMatches} coincidencias`;
    const filesText = filesMatched === 1 ? "1 archivo" : `${filesMatched} archivos`;
    statsEl.textContent = `${matchText} en ${filesText}`;

    const container = document.createElement("div");
    container.className = "search-results-list";

    let flatIdx = 0;

    for (const fileItem of results) {
      const fileGroup = document.createElement("div");
      fileGroup.className = "search-file-group";

      const fileHeader = document.createElement("div");
      fileHeader.className = "search-file-header";
      fileHeader.innerHTML = `
        <span class="search-file-icon" data-icon="fileCode"></span>
        <span class="search-file-path" title="${escapeHtml(fileItem.path)}">${escapeHtml(fileItem.path)}</span>
        <span class="search-file-count">${fileItem.totalMatches}</span>
      `;
      fileGroup.appendChild(fileHeader);

      const matchesList = document.createElement("div");
      matchesList.className = "search-matches-list";

      for (const m of fileItem.matches) {
        const itemIdx = flatIdx++;
        const matchRow = document.createElement("button");
        matchRow.type = "button";
        matchRow.className = "search-match-row";
        if (itemIdx === selectedIndex) {
          matchRow.classList.add("is-selected");
        }
        matchRow.dataset.flatIndex = String(itemIdx);
        matchRow.dataset.path = fileItem.path;
        matchRow.dataset.line = String(m.line);
        matchRow.dataset.column = String(m.column);

        const highlightedSnippet = highlightSnippet(m.lineText, m.start, m.end);

        matchRow.innerHTML = `
          <span class="search-line-num code-font">${m.line}</span>
          <span class="search-snippet code-font">${highlightedSnippet}</span>
        `;

        matchRow.addEventListener("click", () => {
          onSelectMatch?.({
            path: fileItem.path,
            line: m.line,
            column: m.column
          });
          close();
        });

        matchesList.appendChild(matchRow);
      }

      fileGroup.appendChild(matchesList);
      container.appendChild(fileGroup);
    }

    resultsEl.innerHTML = "";
    resultsEl.appendChild(container);
    hydrateIcons(container);
  }

  function highlightSnippet(text, start, end) {
    const before = escapeHtml(text.slice(0, start));
    const matched = escapeHtml(text.slice(start, end));
    const after = escapeHtml(text.slice(end));
    return `${before}<mark class="search-highlight">${matched}</mark>${after}`;
  }

  function updateSelection(newIdx) {
    if (flatMatchItems.length === 0) return;
    selectedIndex = Math.max(0, Math.min(newIdx, flatMatchItems.length - 1));

    const rows = resultsEl?.querySelectorAll(".search-match-row");
    rows?.forEach((row) => {
      const isSel = Number(row.dataset.flatIndex) === selectedIndex;
      row.classList.toggle("is-selected", isSel);
      if (isSel) {
        row.scrollIntoView({ block: "nearest" });
      }
    });
  }

  // Eventos de interfaz
  openBtn?.addEventListener("click", () => open());
  closeBtn?.addEventListener("click", () => close());

  dialog?.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  input?.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      performSearch();
    }, 150);
  });

  input?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      updateSelection(selectedIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      updateSelection(selectedIndex - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flatMatchItems[selectedIndex]) {
        const item = flatMatchItems[selectedIndex];
        onSelectMatch?.(item);
        close();
      }
    }
  });

  btnCase?.addEventListener("click", () => {
    isCaseSensitive = !isCaseSensitive;
    btnCase.setAttribute("aria-pressed", String(isCaseSensitive));
    btnCase.classList.toggle("is-active", isCaseSensitive);
    performSearch();
  });

  btnWord?.addEventListener("click", () => {
    isMatchWholeWord = !isMatchWholeWord;
    btnWord.setAttribute("aria-pressed", String(isMatchWholeWord));
    btnWord.classList.toggle("is-active", isMatchWholeWord);
    performSearch();
  });

  btnRegex?.addEventListener("click", () => {
    isRegex = !isRegex;
    btnRegex.setAttribute("aria-pressed", String(isRegex));
    btnRegex.classList.toggle("is-active", isRegex);
    performSearch();
  });

  return {
    open,
    close,
    search: performSearch
  };
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
