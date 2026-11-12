/**
 * KeyboardRouter — Gestor centralizado de eventos de teclado y pila de modales (Focus Stack)
 * Evita colisiones de atajos globales y garantiza que 'Escape' o 'Enter' solo afecten al modal superior activo.
 */

export class KeyboardRouter {
  constructor() {
    this.modalStack = [];
    this.globalShortcuts = new Map();
    this.boundListener = this.handleKeyDown.bind(this);
    this.attached = false;
  }

  attach() {
    if (!this.attached && typeof window !== "undefined") {
      window.addEventListener("keydown", this.boundListener, { capture: true });
      this.attached = true;
      if (typeof document !== "undefined") {
        this.observeDialogs(document);
      }
    }
  }

  /**
   * Vincula automáticamente diálogos HTML5 estándar a la pila de modales.
   * @param {HTMLElement | Document} root
   */
  observeDialogs(root = (typeof document !== "undefined" ? document : null)) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    const dialogs = root.querySelectorAll("dialog");
    dialogs.forEach((dialog) => {
      if (dialog.__kr_hooked) return;
      dialog.__kr_hooked = true;
      const resolvedModalId = dialog.id || `dialog_${Math.random().toString(36).slice(2, 7)}`;
      dialog.__kr_modalId = resolvedModalId;

      dialog.addEventListener("close", () => {
        this.popModal(dialog.__kr_modalId);
      });

      const originalShowModal = dialog.showModal;
      if (typeof originalShowModal === "function") {
        dialog.showModal = (...args) => {
          const res = originalShowModal.apply(dialog, args);
          const modalId = dialog.id || dialog.__kr_modalId;
          dialog.__kr_modalId = modalId;
          const existing = this.modalStack.find((m) => m.id === modalId);
          this.pushModal({
            blockGlobalShortcuts: true,
            onEscape: () => {
              if (dialog.open) dialog.close();
            },
            ...existing,
            id: modalId
          });
          return res;
        };
      }
    });
  }

  detach() {
    if (this.attached && typeof window !== "undefined") {
      window.removeEventListener("keydown", this.boundListener, { capture: true });
      this.attached = false;
    }
  }

  /**
   * Apila un controlador de modal en la cima de la pila.
   * @param {{ id: string, onEscape?: () => boolean | void, onEnter?: (e: KeyboardEvent) => boolean | void, onKey?: (e: KeyboardEvent) => boolean | void }} handler
   */
  pushModal(handler) {
    if (!handler || !handler.id) return;
    this.modalStack = this.modalStack.filter((m) => m.id !== handler.id);
    this.modalStack.push(handler);
  }

  /**
   * Desapila un controlador de modal por su ID.
   * @param {string} id
   */
  popModal(id) {
    if (!id) {
      return this.modalStack.pop();
    }
    const idx = this.modalStack.findIndex((m) => m.id === id);
    if (idx !== -1) {
      return this.modalStack.splice(idx, 1)[0];
    }
    return null;
  }

  /**
   * Retorna el modal superior activo.
   */
  getActiveModal() {
    return this.modalStack[this.modalStack.length - 1] || null;
  }

  /**
   * Indica si hay algún modal o <dialog> abierto bloqueando atajos globales.
   * @param {string | null} [allowedModalId]
   * @returns {boolean}
   */
  shouldBlockGlobalShortcuts(allowedModalId = null) {
    const activeModal = this.getActiveModal();
    if (activeModal && activeModal.blockGlobalShortcuts !== false) {
      if (!allowedModalId || activeModal.id !== allowedModalId) {
        return true;
      }
    }
    if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
      const openDialogs = document.querySelectorAll("dialog[open]");
      for (const dlg of openDialogs) {
        if (!allowedModalId || dlg.id !== allowedModalId) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Registra un atajo de teclado global.
   * @param {string} keyCombo - Ej: "ctrl+s", "meta+p", "alt+w"
   * @param {(e: KeyboardEvent) => void} callback
   */
  registerGlobalShortcut(keyCombo, callback) {
    this.globalShortcuts.set(keyCombo.toLowerCase().trim(), callback);
  }

  /**
   * Desregistra un atajo global.
   * @param {string} keyCombo
   */
  unregisterGlobalShortcut(keyCombo) {
    this.globalShortcuts.delete(keyCombo.toLowerCase().trim());
  }

  /**
   * Procesador principal de eventos keydown.
   * @param {KeyboardEvent} event
   */
  handleKeyDown(event) {
    if (!event || typeof event.key !== "string") return;

    // 1. Si hay modales en la pila, el modal superior tiene máxima prioridad
    const activeModal = this.getActiveModal();
    if (activeModal) {
      if (event.key === "Escape" && typeof activeModal.onEscape === "function") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const shouldClose = activeModal.onEscape(event);
        if (shouldClose !== false) {
          this.popModal(activeModal.id);
        }
        return;
      }

      if (event.key === "Enter" && typeof activeModal.onEnter === "function") {
        const handled = activeModal.onEnter(event);
        if (handled !== false) {
          event.stopImmediatePropagation();
          return;
        }
      }

      if (typeof activeModal.onKey === "function") {
        const handled = activeModal.onKey(event);
        if (handled === true) {
          event.stopImmediatePropagation();
          return;
        }
      }

      if (activeModal.blockGlobalShortcuts !== false) {
        return;
      }
    }

    if (this.shouldBlockGlobalShortcuts()) {
      return;
    }

    // 2. Atajos globales cuando no son bloqueados por el modal o diálogo abierto
    const modParts = [];
    if (event.ctrlKey) modParts.push("ctrl");
    if (event.metaKey) modParts.push("meta");
    if (event.altKey) modParts.push("alt");
    if (event.shiftKey) modParts.push("shift");
    modParts.push(event.key.toLowerCase());
    const combo = modParts.join("+");

    const shortcut = this.globalShortcuts.get(combo);
    if (typeof shortcut === "function") {
      event.preventDefault();
      shortcut(event);
    }
  }

  destroy() {
    this.detach();
    this.modalStack = [];
    this.globalShortcuts.clear();
  }
}

export const keyboardRouter = new KeyboardRouter();
