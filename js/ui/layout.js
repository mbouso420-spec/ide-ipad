import { keyboardRouter } from "./keyboardRouter.js";
import { readStoredBool, readStoredValue, saveStoredValue } from "../utils/storage.js";

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
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const signal = controller?.signal;
  const listenOpts = signal ? { signal } : undefined;
  const passiveOpts = signal ? { passive: true, signal } : { passive: true };

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
    saveStoredValue(STORAGE_KEYS.leftOpen, leftOpen);
    saveStoredValue(STORAGE_KEYS.rightOpen, rightOpen);
    if (leftOpen) {
      const storedW = Number(readStoredValue(STORAGE_KEYS.leftWidth));
      if (!Number.isFinite(storedW) || storedW < 220) {
        document.documentElement.style.setProperty("--left-panel-w", "256px");
        saveStoredValue(STORAGE_KEYS.leftWidth, "256");
      }
    }
    applyState();
  }

  function setRightOpen(next) {
    rightOpen = Boolean(next);
    if (isCompact() && rightOpen && leftOpen) {
      leftOpen = false;
    }
    saveStoredValue(STORAGE_KEYS.leftOpen, leftOpen);
    saveStoredValue(STORAGE_KEYS.rightOpen, rightOpen);
    if (rightOpen) {
      const storedW = Number(readStoredValue(STORAGE_KEYS.rightWidth));
      if (!Number.isFinite(storedW) || storedW < 260) {
        document.documentElement.style.setProperty("--right-panel-w", "340px");
        saveStoredValue(STORAGE_KEYS.rightWidth, "340");
      }
    }
    applyState();
  }

  btnLeft?.addEventListener("click", () => setLeftOpen(!leftOpen), listenOpts);
  btnRight?.addEventListener("click", () => setRightOpen(!rightOpen), listenOpts);
  btnCloseLeft?.addEventListener("click", () => setLeftOpen(false), listenOpts);
  btnCloseRight?.addEventListener("click", () => setRightOpen(false), listenOpts);
  backdrop?.addEventListener("click", () => {
    setLeftOpen(false);
    setRightOpen(false);
  }, listenOpts);

  mqCompact.addEventListener("change", (event) => {
    if (event.matches && leftOpen && rightOpen) {
      leftOpen = false;
    }
    applyState();
    restorePanelWidths();
  }, listenOpts);

  let restoreRaf = 0;
  const scheduleRestoreWidths = () => {
    if (restoreRaf) return;
    restoreRaf = window.requestAnimationFrame(() => {
      restoreRaf = 0;
      restorePanelWidths();
    });
  };

  window.addEventListener("resize", scheduleRestoreWidths, passiveOpts);
  window.addEventListener("orientationchange", scheduleRestoreWidths, passiveOpts);

  if (typeof screen !== "undefined" && screen.orientation && typeof screen.orientation.addEventListener === "function") {
    screen.orientation.addEventListener("change", scheduleRestoreWidths, listenOpts);
  }

  // Atajos globales enrutados por KeyboardRouter (Cmd/Ctrl + B Explorador, Cmd/Ctrl + J Asistente)
  const toggleLeftShortcut = () => setLeftOpen(!leftOpen);
  const toggleRightShortcut = () => setRightOpen(!rightOpen);
  keyboardRouter.registerGlobalShortcut("ctrl+b", toggleLeftShortcut);
  keyboardRouter.registerGlobalShortcut("meta+b", toggleLeftShortcut);
  keyboardRouter.registerGlobalShortcut("ctrl+j", toggleRightShortcut);
  keyboardRouter.registerGlobalShortcut("meta+j", toggleRightShortcut);

  // Escape para cerrar drawers en modo compacto cuando no hay modales ni edición en línea
  window.addEventListener("keydown", (event) => {
    if (keyboardRouter.shouldBlockGlobalShortcuts()) {
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
  }, listenOpts);

  // Divisores arrastrables con soporte táctil y mouse (Pointer Events)
  if (resizerLeft) {
    bindSplitter(resizerLeft, "left", {
      signal,
      onCollapse: () => setLeftOpen(false),
      onExpand: () => setLeftOpen(true),
      isOpen: () => leftOpen
    });
  }
  if (resizerRight) {
    bindSplitter(resizerRight, "right", {
      signal,
      onCollapse: () => setRightOpen(false),
      onExpand: () => setRightOpen(true),
      isOpen: () => rightOpen
    });
  }

  // Gestos swipe cortos sobre cada panel abierto para cerrarlo sin interferir con bordes de Safari/Stage Manager
  if (panelLeft) {
    bindSwipeToClose(panelLeft, "left", () => setLeftOpen(false), signal);
  }
  if (panelRight) {
    bindSwipeToClose(panelRight, "right", () => setRightOpen(false), signal);
  }

  // Sincronización con visualViewport para elevar la barra de símbolos sobre el teclado virtual de iPadOS
  bindVisualViewport(signal);

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
    },
    destroy() {
      if (restoreRaf && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(restoreRaf);
      }
      restoreRaf = 0;
      controller?.abort();
      keyboardRouter.unregisterGlobalShortcut("ctrl+b");
      keyboardRouter.unregisterGlobalShortcut("meta+b");
      keyboardRouter.unregisterGlobalShortcut("ctrl+j");
      keyboardRouter.unregisterGlobalShortcut("meta+j");
    }
  };
}

function bindSplitter(handle, side, callbacks = {}) {
  let activePointerId = null;
  const { signal } = callbacks;
  const listenOpts = signal ? { signal } : undefined;
  const isLeft = side === "left";
  const minW = isLeft ? 220 : 260;
  const storageKey = isLeft ? STORAGE_KEYS.leftWidth : STORAGE_KEYS.rightWidth;
  const defaultW = isLeft ? 250 : 340;
  const getMaxW = (viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200) =>
    Math.max(
      minW,
      isLeft ? Math.min(420, Math.floor(viewportWidth * 0.36)) : Math.min(540, Math.floor(viewportWidth * 0.44))
    );

  const savedInitialW = Number(readStoredValue(storageKey));
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
      saveStoredValue(STORAGE_KEYS.leftWidth, String(nextWidth));
    } else {
      document.documentElement.style.setProperty("--right-panel-w", `${nextWidth}px`);
      saveStoredValue(STORAGE_KEYS.rightWidth, String(nextWidth));
    }
    handle.setAttribute("aria-valuemax", String(getMaxW()));
    handle.setAttribute("aria-valuenow", String(nextWidth));
  };

  handle.addEventListener("keydown", (event) => {
    const step = 16;
    const viewportWidth = window.innerWidth;
    const maxW = getMaxW(viewportWidth);
    const savedW = Number(readStoredValue(storageKey));
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
  }, listenOpts);

  handle.addEventListener("pointerdown", (event) => {
    activePointerId = event.pointerId;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-dragging");
    event.preventDefault();
  }, listenOpts);

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
  }, listenOpts);

  const endDrag = (event) => {
    if (event.pointerId !== activePointerId) {
      return;
    }
    activePointerId = null;
    handle.classList.remove("is-dragging");
  };

  handle.addEventListener("pointerup", endDrag, listenOpts);
  handle.addEventListener("pointercancel", endDrag, listenOpts);
}

function bindSwipeToClose(panel, direction, onClose, signal) {
  let startX = 0;
  let startY = 0;
  let tracking = false;
  const passiveOpts = signal ? { passive: true, signal } : { passive: true };

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
    passiveOpts
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
    passiveOpts
  );
}

function bindVisualViewport(signal) {
  const vv = window.visualViewport;
  if (!vv) {
    return;
  }
  const listenOpts = signal ? { signal } : undefined;

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
  vv.addEventListener("resize", syncViewport, listenOpts);
  vv.addEventListener("scroll", syncViewport, listenOpts);
}

function restorePanelWidths() {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
  const leftW = Number(readStoredValue(STORAGE_KEYS.leftWidth));
  const rightW = Number(readStoredValue(STORAGE_KEYS.rightWidth));
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
