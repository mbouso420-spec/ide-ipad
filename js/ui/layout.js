import { keyboardRouter } from "./keyboardRouter.js";

const STORAGE_KEYS = {
  leftOpen: "ide.layout.leftOpen",
  rightOpen: "ide.layout.rightOpen",
  leftWidth: "ide.layout.leftWidth",
  rightWidth: "ide.layout.rightWidth"
};

const COMPACT_MEDIA = "(max-width: 74rem)";

/**
 * Inicializa el sistema de layout híbrido de 3 paneles (islas acopladas en ancho / drawers flotantes en Stage Manager o vertical),
 * divisores táctiles, atajos de teclado, gestos swipe de cierre y ajuste al teclado virtual de iPadOS.
 */
export function initLayoutController() {
  const mqCompact = window.matchMedia(COMPACT_MEDIA);
  const btnLeft = document.getElementById("btn-toggle-left");
  const btnRight = document.getElementById("btn-toggle-right");
  const btnCloseLeft = document.getElementById("btn-close-left");
  const btnCloseRight = document.getElementById("btn-close-right");
  const backdrop = document.getElementById("drawer-backdrop");
  const panelLeft = document.getElementById("panel-explorer");
  const panelRight = document.getElementById("panel-assistant");
  const resizerLeft = document.getElementById("resizer-left");
  const resizerRight = document.getElementById("resizer-right");

  const isCompact = () => mqCompact.matches;

  let leftOpen = readStoredBool(STORAGE_KEYS.leftOpen, !isCompact());
  let rightOpen = readStoredBool(STORAGE_KEYS.rightOpen, !isCompact());

  // En modo compacto inicial evitamos abrir ambos drawers superpuestos a la vez
  if (isCompact() && leftOpen && rightOpen) {
    leftOpen = false;
  }

  restorePanelWidths();
  applyState();

  function applyState() {
    const compact = isCompact();
    document.body.dataset.leftOpen = String(leftOpen);
    document.body.dataset.rightOpen = String(rightOpen);
    document.body.dataset.drawerBackdrop = String(compact && (leftOpen || rightOpen));

    if (panelLeft) {
      panelLeft.inert = compact && !leftOpen;
    }
    if (panelRight) {
      panelRight.inert = compact && !rightOpen;
    }

    if (btnLeft) {
      btnLeft.setAttribute("aria-expanded", String(leftOpen));
    }
    if (btnRight) {
      btnRight.setAttribute("aria-expanded", String(rightOpen));
    }
  }

  function setLeftOpen(next) {
    leftOpen = Boolean(next);
    if (isCompact() && leftOpen && rightOpen) {
      rightOpen = false;
    }
    persistBool(STORAGE_KEYS.leftOpen, leftOpen);
    persistBool(STORAGE_KEYS.rightOpen, rightOpen);
    if (leftOpen) {
      const storedW = Number(safeGetStorage(STORAGE_KEYS.leftWidth));
      if (!Number.isFinite(storedW) || storedW < 220) {
        document.documentElement.style.setProperty("--left-panel-w", "256px");
        safeSetStorage(STORAGE_KEYS.leftWidth, "256");
      }
    }
    applyState();
  }

  function setRightOpen(next) {
    rightOpen = Boolean(next);
    if (isCompact() && rightOpen && leftOpen) {
      leftOpen = false;
    }
    persistBool(STORAGE_KEYS.leftOpen, leftOpen);
    persistBool(STORAGE_KEYS.rightOpen, rightOpen);
    if (rightOpen) {
      const storedW = Number(safeGetStorage(STORAGE_KEYS.rightWidth));
      if (!Number.isFinite(storedW) || storedW < 260) {
        document.documentElement.style.setProperty("--right-panel-w", "340px");
        safeSetStorage(STORAGE_KEYS.rightWidth, "340");
      }
    }
    applyState();
  }

  btnLeft?.addEventListener("click", () => setLeftOpen(!leftOpen));
  btnRight?.addEventListener("click", () => setRightOpen(!rightOpen));
  btnCloseLeft?.addEventListener("click", () => setLeftOpen(false));
  btnCloseRight?.addEventListener("click", () => setRightOpen(false));
  backdrop?.addEventListener("click", () => {
    setLeftOpen(false);
    setRightOpen(false);
  });

  mqCompact.addEventListener("change", (event) => {
    if (event.matches && leftOpen && rightOpen) {
      leftOpen = false;
    }
    applyState();
    restorePanelWidths();
  });

  let restoreRaf = 0;
  const scheduleRestoreWidths = () => {
    if (restoreRaf) return;
    restoreRaf = window.requestAnimationFrame(() => {
      restoreRaf = 0;
      restorePanelWidths();
    });
  };

  window.addEventListener("resize", scheduleRestoreWidths, { passive: true });
  window.addEventListener("orientationchange", scheduleRestoreWidths, { passive: true });

  if (typeof screen !== "undefined" && screen.orientation && typeof screen.orientation.addEventListener === "function") {
    screen.orientation.addEventListener("change", scheduleRestoreWidths);
  }

  // Atajos de teclado (Cmd/Ctrl + B para Explorador, Cmd/Ctrl + J para Asistente, Escape para cerrar drawers)
  window.addEventListener("keydown", (event) => {
    const activeModal = keyboardRouter.getActiveModal();
    if (activeModal && activeModal.blockGlobalShortcuts !== false) {
      return;
    }

    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (mod && !event.shiftKey && !event.altKey && key === "b") {
      event.preventDefault();
      setLeftOpen(!leftOpen);
      return;
    }

    if (mod && !event.shiftKey && !event.altKey && key === "j") {
      event.preventDefault();
      setRightOpen(!rightOpen);
      return;
    }

    if (event.key === "Escape" && isCompact() && (leftOpen || rightOpen)) {
      if (event.defaultPrevented) {
        return;
      }
      const hasOpenDialog = Boolean(document.querySelector("dialog[open]"));
      const ctxMenu = document.getElementById("tree-context-menu");
      const hasOpenContextMenu = Boolean(
        (ctxMenu && !ctxMenu.hidden) ||
          document.querySelector(".tree-context-menu:not([hidden])")
      );
      const hasActiveRename = Boolean(document.querySelector(".inline-edit-input"));
      if (hasOpenDialog || hasOpenContextMenu || hasActiveRename) {
        return;
      }
      setLeftOpen(false);
      setRightOpen(false);
    }
  });

  // Divisores arrastrables con soporte táctil y mouse (Pointer Events)
  if (resizerLeft) {
    bindSplitter(resizerLeft, "left", {
      onCollapse: () => setLeftOpen(false),
      onExpand: () => setLeftOpen(true),
      isOpen: () => leftOpen
    });
  }
  if (resizerRight) {
    bindSplitter(resizerRight, "right", {
      onCollapse: () => setRightOpen(false),
      onExpand: () => setRightOpen(true),
      isOpen: () => rightOpen
    });
  }

  // Gestos swipe cortos sobre cada panel abierto para cerrarlo sin interferir con bordes de Safari/Stage Manager
  if (panelLeft) {
    bindSwipeToClose(panelLeft, "left", () => setLeftOpen(false));
  }
  if (panelRight) {
    bindSwipeToClose(panelRight, "right", () => setRightOpen(false));
  }

  // Sincronización con visualViewport para elevar la barra de símbolos sobre el teclado virtual de iPadOS
  bindVisualViewport();

  return {
    isLeftPanelOpen: () => leftOpen,
    isRightPanelOpen: () => rightOpen,
    toggleLeftPanel: () => setLeftOpen(!leftOpen),
    toggleRightPanel: () => setRightOpen(!rightOpen),
    setLeftOpen,
    setRightOpen,
    closeLeftOnCompactSelect() {
      if (isCompact() && leftOpen) {
        setLeftOpen(false);
      }
    },
    closeRightOnCompactAction() {
      if (isCompact() && rightOpen) {
        setRightOpen(false);
      }
    }
  };
}

function bindSplitter(handle, side, callbacks = {}) {
  let activePointerId = null;
  const isLeft = side === "left";
  const minW = isLeft ? 220 : 260;
  const storageKey = isLeft ? STORAGE_KEYS.leftWidth : STORAGE_KEYS.rightWidth;
  const defaultW = isLeft ? 250 : 340;
  const getMaxW = (viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200) =>
    Math.max(
      minW,
      isLeft ? Math.min(420, Math.floor(viewportWidth * 0.36)) : Math.min(540, Math.floor(viewportWidth * 0.44))
    );

  const savedInitialW = Number(safeGetStorage(storageKey));
  const initialW = clamp(Number.isFinite(savedInitialW) && savedInitialW > 0 ? savedInitialW : defaultW, minW, getMaxW());

  handle.setAttribute("role", "separator");
  handle.setAttribute("tabindex", "0");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-valuemin", String(minW));
  handle.setAttribute("aria-valuemax", String(getMaxW()));
  handle.setAttribute("aria-valuenow", String(initialW));
  handle.setAttribute(
    "aria-label",
    isLeft ? "Divisor de ancho del explorador de archivos" : "Divisor de ancho del panel de asistente"
  );

  const applyWidth = (nextWidth) => {
    if (isLeft) {
      document.documentElement.style.setProperty("--left-panel-w", `${nextWidth}px`);
      safeSetStorage(STORAGE_KEYS.leftWidth, String(nextWidth));
    } else {
      document.documentElement.style.setProperty("--right-panel-w", `${nextWidth}px`);
      safeSetStorage(STORAGE_KEYS.rightWidth, String(nextWidth));
    }
    handle.setAttribute("aria-valuemax", String(getMaxW()));
    handle.setAttribute("aria-valuenow", String(nextWidth));
  };

  handle.addEventListener("keydown", (event) => {
    const step = 16;
    const viewportWidth = window.innerWidth;
    const maxW = getMaxW(viewportWidth);
    const savedW = Number(safeGetStorage(storageKey));
    const currentW = Number.isFinite(savedW) && savedW > 0 ? savedW : defaultW;

    let targetW = currentW;
    if (event.key === "ArrowLeft") {
      targetW = isLeft ? currentW - step : currentW + step;
    } else if (event.key === "ArrowRight") {
      targetW = isLeft ? currentW + step : currentW - step;
    } else if (event.key === "Home") {
      targetW = minW;
    } else if (event.key === "End") {
      targetW = maxW;
    } else {
      return;
    }

    event.preventDefault();
    applyWidth(clamp(targetW, minW, maxW));
  });

  handle.addEventListener("pointerdown", (event) => {
    activePointerId = event.pointerId;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    event.preventDefault();
  });

  handle.addEventListener("pointermove", (event) => {
    if (event.pointerId !== activePointerId) {
      return;
    }

    const viewportWidth = window.innerWidth;
    const maxW = getMaxW(viewportWidth);
    if (isLeft) {
      const rawWidth = Math.round(event.clientX - 8);
      if (rawWidth < 140) {
        callbacks.onCollapse?.();
        return;
      }
      if (callbacks.isOpen && !callbacks.isOpen()) {
        callbacks.onExpand?.();
      }
      applyWidth(clamp(rawWidth, minW, maxW));
    } else {
      const rawWidth = Math.round(viewportWidth - event.clientX - 8);
      if (rawWidth < 160) {
        callbacks.onCollapse?.();
        return;
      }
      if (callbacks.isOpen && !callbacks.isOpen()) {
        callbacks.onExpand?.();
      }
      applyWidth(clamp(rawWidth, minW, maxW));
    }
  });

  const endDrag = (event) => {
    if (event.pointerId !== activePointerId) {
      return;
    }
    activePointerId = null;
    handle.classList.remove("is-dragging");
  };

  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

function bindSwipeToClose(panel, direction, onClose) {
  let startX = 0;
  let startY = 0;
  let tracking = false;

  panel.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const target = event.target;
      // No interceptar gestos sobre campos editables, scroll del editor, pestañas o tablas
      if (
        target instanceof Element &&
        target.closest("pre, code, input, textarea, .cm-scroller, .cm-editor, .tabs-strip, table")
      ) {
        tracking = false;
        return;
      }
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      tracking = true;
    },
    { passive: true }
  );

  panel.addEventListener(
    "touchend",
    (event) => {
      if (!tracking || event.changedTouches.length !== 1) {
        return;
      }
      tracking = false;
      const dx = event.changedTouches[0].clientX - startX;
      const dy = event.changedTouches[0].clientY - startY;

      if (Math.abs(dx) < 54 || Math.abs(dx) < Math.abs(dy) * 1.35) {
        return;
      }

      if (direction === "left" && dx < 0) {
        onClose();
      } else if (direction === "right" && dx > 0) {
        onClose();
      }
    },
    { passive: true }
  );
}

function bindVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) {
    return;
  }

  const syncViewport = () => {
    const vHeight = Math.round(vv.height);
    const offsetTop = Math.max(0, Math.round(vv.offsetTop));
    const keyboardOpen = window.innerHeight - vHeight > 110;

    document.documentElement.style.setProperty("--vvh", `${vHeight}px`);
    document.documentElement.style.setProperty("--vv-offset-top", `${offsetTop}px`);
    document.body.dataset.keyboardOpen = String(keyboardOpen);

    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }

    if (keyboardOpen) {
      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLElement &&
        (activeEl.matches("input, textarea") || activeEl.closest(".ide-dialog"))
      ) {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }
  };

  syncViewport();
  vv.addEventListener("resize", syncViewport);
  vv.addEventListener("scroll", syncViewport);
}

function restorePanelWidths() {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
  const leftW = Number(safeGetStorage(STORAGE_KEYS.leftWidth));
  const rightW = Number(safeGetStorage(STORAGE_KEYS.rightWidth));
  const maxLeft = Math.min(420, Math.floor(viewportWidth * 0.36));
  const maxRight = Math.min(540, Math.floor(viewportWidth * 0.44));

  if (Number.isFinite(leftW) && leftW >= 220) {
    const clampedL = clamp(leftW, 220, Math.max(220, maxLeft));
    document.documentElement.style.setProperty("--left-panel-w", `${clampedL}px`);
  } else {
    document.documentElement.style.setProperty("--left-panel-w", "250px");
  }
  if (Number.isFinite(rightW) && rightW >= 260) {
    const clampedR = clamp(rightW, 260, Math.max(260, maxRight));
    document.documentElement.style.setProperty("--right-panel-w", `${clampedR}px`);
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readStoredBool(key, fallback) {
  const raw = safeGetStorage(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function persistBool(key, value) {
  safeSetStorage(key, String(value));
}

function safeGetStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignorar en navegación privada estricta
  }
}
