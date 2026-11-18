import { PROJECT_TEMPLATES } from "../storage/workspaceDb.js";
import { keyboardRouter } from "./keyboardRouter.js";

/**
 * Controlador del modal selector de plantillas para crear proyectos locales nuevos.
 */
export function initProjectModal({ onCreateProject } = {}) {
  const dialog = typeof document !== "undefined" ? document.getElementById("project-template-dialog") : null;
  const form = typeof document !== "undefined" ? document.getElementById("project-template-form") : null;
  const nameInput = typeof document !== "undefined" ? document.getElementById("project-template-name") : null;
  const gridEl = typeof document !== "undefined" ? document.getElementById("project-template-grid") : null;
  const closeBtn = typeof document !== "undefined" ? document.getElementById("btn-close-project-template") : null;
  const cancelBtn = typeof document !== "undefined" ? document.getElementById("btn-cancel-project-template") : null;
  const submitBtn = typeof document !== "undefined" ? document.getElementById("btn-submit-project-template") : null;

  const listenerController = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = listenerController ? { signal: listenerController.signal } : undefined;

  let selectedTemplateId = PROJECT_TEMPLATES[0]?.id || "web";
  let isSubmitting = false;

  const renderTemplates = () => {
    if (!gridEl) return;
    gridEl.innerHTML = "";
    for (const tpl of PROJECT_TEMPLATES) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `template-card${tpl.id === selectedTemplateId ? " is-selected" : ""}`;
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", tpl.id === selectedTemplateId ? "true" : "false");
      card.dataset.templateId = tpl.id;

      const title = document.createElement("span");
      title.className = "template-card-title";
      title.textContent = tpl.name;

      const desc = document.createElement("span");
      desc.className = "template-card-desc";
      desc.textContent = tpl.description;

      const filesWrap = document.createElement("span");
      filesWrap.className = "template-card-files code-font";
      filesWrap.textContent = Array.isArray(tpl.filesPreview) ? tpl.filesPreview.join(" · ") : "";

      card.append(title, desc, filesWrap);
      card.addEventListener("click", () => {
        selectedTemplateId = tpl.id;
        renderTemplates();
      }, listenOpts);
      gridEl.appendChild(card);
    }
  };

  const close = () => {
    keyboardRouter.popModal("project-template-dialog");
    if (dialog?.open) dialog.close();
  };

  closeBtn?.addEventListener("click", close, listenOpts);
  cancelBtn?.addEventListener("click", close, listenOpts);
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  }, listenOpts);
  dialog?.addEventListener("close", () => {
    keyboardRouter.popModal("project-template-dialog");
  }, listenOpts);

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    const cleanName = String(nameInput?.value || "").trim();
    if (!cleanName) {
      nameInput?.focus();
      return;
    }
    isSubmitting = true;
    if (submitBtn) submitBtn.disabled = true;
    try {
      await onCreateProject?.(cleanName, selectedTemplateId);
      close();
    } finally {
      isSubmitting = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  }, listenOpts);

  function open(defaultTemplateId = null) {
    if (!dialog) return;
    if (defaultTemplateId && PROJECT_TEMPLATES.some((t) => t.id === defaultTemplateId)) {
      selectedTemplateId = defaultTemplateId;
    } else if (!selectedTemplateId) {
      selectedTemplateId = PROJECT_TEMPLATES[0]?.id || "web";
    }
    if (nameInput) nameInput.value = "";
    renderTemplates();
    if (!dialog.open) {
      dialog.showModal();
    }
    keyboardRouter.pushModal({
      id: "project-template-dialog",
      blockGlobalShortcuts: true,
      onEscape: () => close()
    });
    setTimeout(() => nameInput?.focus(), 30);
  }

  return {
    open,
    close,
    destroy() {
      keyboardRouter.popModal("project-template-dialog");
      listenerController?.abort();
    }
  };
}
