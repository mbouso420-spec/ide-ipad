import { icon } from "../ui/icons.js";
import { escapeHtml } from "../utils/dom.js";

/**
 * Gestiona la tira de pestañas abiertas, actualización incremental del indicador dirty,
 * desplazamiento del tab activo y persistencia de pestañas en el proyecto activo.
 */
export function createTabManager({
  tabStripEl,
  emptyQuickListEl,
  getFilesOnly,
  getOpenTabIds,
  getActiveFileId,
  getActiveProject,
  saveProjectState,
  isFileDirtyForProject,
  onOpenFile,
  onRequestCloseTab,
  onAfterRenderTabs
}) {
  /** @type {Map<string, { wrapper: HTMLElement, selectBtn: HTMLButtonElement }>} */
  const tabElementsById = new Map();

  async function persistTabsState() {
    const activeProject = getActiveProject?.();
    if (!activeProject) return;
    activeProject.openTabIds = [...(getOpenTabIds?.() || [])];
    activeProject.activeFileId = getActiveFileId?.() ?? null;
    await saveProjectState(activeProject);
  }

  function revealActiveTab() {
    if (!tabStripEl) return;
    const activeEl = tabStripEl.querySelector(".editor-tab-item.is-active");
    if (!(activeEl instanceof HTMLElement)) return;
    const strip = tabStripEl.getBoundingClientRect();
    const tab = activeEl.getBoundingClientRect();
    if (tab.width >= strip.width) {
      tabStripEl.scrollLeft += tab.left - strip.left;
    } else if (tab.left < strip.left) {
      tabStripEl.scrollLeft -= strip.left - tab.left + 8;
    } else if (tab.right > strip.right) {
      tabStripEl.scrollLeft += tab.right - strip.right + 8;
    }
  }

  function updateTabDirtyBadge(fileId, isDirty) {
    const ref = tabElementsById.get(fileId);
    if (!ref) {
      renderTabs({ refreshSplit: false });
      return;
    }
    const existingBadge = ref.selectBtn.querySelector(".editor-tab-dirty");
    if (isDirty && !existingBadge) {
      const badge = document.createElement("span");
      badge.className = "editor-tab-dirty";
      badge.title = "Modificado frente al repositorio";
      badge.setAttribute("aria-label", "Modificado");
      ref.selectBtn.appendChild(badge);
    } else if (!isDirty && existingBadge) {
      existingBadge.remove();
    }
  }

  function renderTabs({ refreshSplit = true } = {}) {
    if (!tabStripEl) return;
    tabStripEl.innerHTML = "";
    tabElementsById.clear();

    const filesOnly = getFilesOnly?.() || [];
    const filesById = new Map(filesOnly.map((f) => [f.id, f]));
    const openTabIds = getOpenTabIds?.() || [];
    const activeFileId = getActiveFileId?.() ?? null;
    const fragment = document.createDocumentFragment();

    for (const tabId of openTabIds) {
      const file = filesById.get(tabId);
      if (!file) continue;

      const isActive = file.id === activeFileId;
      const dirty = Boolean(isFileDirtyForProject?.(file));

      const wrapper = document.createElement("div");
      wrapper.className = isActive ? "editor-tab-item is-active" : "editor-tab-item";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.role = "tab";
      selectBtn.className = "editor-tab-trigger";
      selectBtn.title = file.path;
      selectBtn.setAttribute("aria-selected", String(isActive));
      selectBtn.innerHTML = `
        ${icon(file.icon)}
        <span>${escapeHtml(file.shortName)}</span>
        ${dirty ? '<span class="editor-tab-dirty" title="Modificado frente al repositorio" aria-label="Modificado"></span>' : ""}
      `;
      selectBtn.addEventListener("click", () => onOpenFile?.(file.id));

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "editor-tab-close";
      closeBtn.setAttribute("aria-label", `Cerrar pestaña ${file.shortName}`);
      closeBtn.innerHTML = icon("x");
      closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        onRequestCloseTab?.(file.id);
      });

      wrapper.addEventListener("auxclick", (event) => {
        if (event.button === 1) {
          event.preventDefault();
          event.stopPropagation();
          onRequestCloseTab?.(file.id);
        }
      });

      wrapper.append(selectBtn, closeBtn);
      tabElementsById.set(file.id, { wrapper, selectBtn });
      fragment.appendChild(wrapper);
    }

    tabStripEl.appendChild(fragment);
    revealActiveTab();
    onAfterRenderTabs?.({ refreshSplit });
  }

  function renderEmptyQuickList() {
    if (!emptyQuickListEl) return;
    emptyQuickListEl.innerHTML = "";
    const filesOnly = getFilesOnly?.() || [];
    const fragment = document.createDocumentFragment();
    for (const file of filesOnly.slice(0, 6)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.innerHTML = `${icon(file.icon)}<span>${escapeHtml(file.shortName)}</span>`;
      btn.addEventListener("click", () => onOpenFile?.(file.id));
      fragment.appendChild(btn);
    }
    emptyQuickListEl.appendChild(fragment);
  }

  return {
    persistTabsState,
    renderTabs,
    updateTabDirtyBadge,
    revealActiveTab,
    renderEmptyQuickList
  };
}
