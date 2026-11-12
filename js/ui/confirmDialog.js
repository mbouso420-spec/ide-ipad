import { keyboardRouter } from "./keyboardRouter.js";

let activeConfirmCleanup = null;

/**
 * Muestra un diálogo de confirmación accesible (#confirm-dialog) sin popups nativos bloqueantes,
 * con respaldo a `window.confirm` si el diálogo no existe en el DOM.
 */
export function showConfirmDialog({
  title,
  message,
  confirmText = "Confirmar",
  confirmVariant = "btn-primary",
  onConfirm
}) {
  const dialog = typeof document !== "undefined" ? document.getElementById("confirm-dialog") : null;
  const titleEl = typeof document !== "undefined" ? document.getElementById("confirm-dialog-title") : null;
  const msgEl = typeof document !== "undefined" ? document.getElementById("confirm-dialog-message") : null;
  const cancelBtn = typeof document !== "undefined" ? document.getElementById("btn-confirm-cancel") : null;
  const actionBtn = typeof document !== "undefined" ? document.getElementById("btn-confirm-action") : null;
  const closeBtn = typeof document !== "undefined" ? document.getElementById("btn-close-confirm") : null;

  if (!dialog) {
    if (typeof window !== "undefined" && typeof window.confirm === "function" && window.confirm(message)) {
      onConfirm?.();
    }
    return;
  }

  activeConfirmCleanup?.();
  if (dialog.open) {
    dialog.close();
  }

  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  if (actionBtn) {
    actionBtn.textContent = confirmText;
    actionBtn.className = `btn ${confirmVariant}`;
  }

  let cleaned = false;
  const listenerController = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = listenerController ? { signal: listenerController.signal } : undefined;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (activeConfirmCleanup === cleanup) {
      activeConfirmCleanup = null;
    }
    keyboardRouter.popModal("confirm-dialog");
    if (listenerController) {
      listenerController.abort();
    } else {
      cancelBtn?.removeEventListener("click", onCancel);
      closeBtn?.removeEventListener("click", onCancel);
      actionBtn?.removeEventListener("click", onProceed);
      dialog.removeEventListener("close", onDialogClose);
    }
  };
  activeConfirmCleanup = cleanup;

  const onCancel = () => {
    cleanup();
    if (dialog.open) dialog.close();
  };

  const onProceed = () => {
    cleanup();
    if (dialog.open) dialog.close();
    onConfirm?.();
  };

  const onDialogClose = () => {
    cleanup();
  };

  cancelBtn?.addEventListener("click", onCancel, listenOpts);
  closeBtn?.addEventListener("click", onCancel, listenOpts);
  actionBtn?.addEventListener("click", onProceed, listenOpts);
  dialog.addEventListener("close", onDialogClose, listenOpts);

  dialog.showModal();
  keyboardRouter.pushModal({
    id: "confirm-dialog",
    blockGlobalShortcuts: true,
    onEscape: () => onCancel(),
    onEnter: () => {
      onProceed();
      return true;
    }
  });
}
