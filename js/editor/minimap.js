/**
 * Minimap — Vista en miniatura (Bird's Eye View) para el editor de código
 * Dibuja una representación proporcional del documento y permite navegar visualmente arrastrando o haciendo clic.
 */

const PREF_MINIMAP_KEY = "ide.editor.minimap";

const safeRequestAnim = typeof requestAnimationFrame === "function"
  ? requestAnimationFrame
  : (cb) => setTimeout(cb, 16);

const safeCancelAnim = typeof cancelAnimationFrame === "function"
  ? cancelAnimationFrame
  : (id) => clearTimeout(id);

/**
 * Crea y administra el minimapa del editor.
 *
 * @param {{
 *   mountEl: HTMLElement,
 *   getDocLines: () => string[],
 *   getViewport: () => { top: number, height: number, totalHeight: number },
 *   onScrollToRatio: (ratio: number) => void
 * }} config
 */
export function createMinimapController({ mountEl, getDocLines, getViewport, onScrollToRatio }) {
  let isVisible = readStoredBool(PREF_MINIMAP_KEY, true);
  let canvas = null;
  let ctx = null;
  let sliderEl = null;
  let containerEl = null;
  let isDragging = false;
  let activePointerId = null;
  let animFrameId = null;
  let sliderRaf = null;
  let resizeObserver = null;

  const handlePointerMove = (e) => {
    if (!isDragging) return;
    e.preventDefault();
    updateScrollFromPointer(e);
  };

  const handlePointerUp = () => {
    isDragging = false;
    if (activePointerId !== null) {
      try {
        containerEl?.releasePointerCapture?.(activePointerId);
      } catch (_) {}
      activePointerId = null;
    }
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  };

  function initDOM() {
    if (!mountEl) return;

    containerEl = document.createElement("div");
    containerEl.className = "editor-minimap-container";
    containerEl.setAttribute("aria-hidden", "true");
    if (!isVisible) containerEl.hidden = true;

    canvas = document.createElement("canvas");
    canvas.className = "editor-minimap-canvas";
    ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;

    sliderEl = document.createElement("div");
    sliderEl.className = "editor-minimap-slider";

    containerEl.appendChild(canvas);
    containerEl.appendChild(sliderEl);
    mountEl.appendChild(containerEl);

    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => {
        if (isVisible) {
          requestRender();
        }
      });
      resizeObserver.observe(containerEl);
      if (mountEl && mountEl !== containerEl) {
        resizeObserver.observe(mountEl);
      }
    }

    setupEvents();
  }

  function isElementHidden(el) {
    if (!el || el.hidden || el.isConnected === false) return true;
    if (typeof getComputedStyle === "function") {
      try {
        const style = getComputedStyle(el);
        if (style && (style.display === "none" || style.visibility === "hidden")) {
          return true;
        }
      } catch (_) {}
    }
    return false;
  }

  function getRenderDimensions() {
    if (!isVisible || !canvas || !ctx || !containerEl) return null;
    if (isElementHidden(containerEl) || isElementHidden(mountEl)) return null;
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      try {
        if (window.matchMedia("(max-width: 48rem)").matches) {
          return null;
        }
      } catch (_) {}
    }
    const width = Number(containerEl.clientWidth) || 0;
    const height = Number(containerEl.clientHeight) || 0;
    if (width <= 0 || height <= 1) return null;
    return { width, height };
  }

  function setupEvents() {
    if (!containerEl) return;

    const handlePointerDown = (e) => {
      e.preventDefault();
      isDragging = true;
      activePointerId = e.pointerId ?? null;
      if (activePointerId !== null) {
        try {
          containerEl.setPointerCapture?.(activePointerId);
        } catch (_) {}
      }
      updateScrollFromPointer(e);
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    };

    containerEl.addEventListener("pointerdown", handlePointerDown);
  }

  function updateScrollFromPointer(e) {
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    if (rect.height <= 0) return;
    const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    onScrollToRatio?.(ratio);
  }

  function render() {
    const dims = getRenderDimensions();
    if (!dims) return;

    const { width, height } = dims;
    const rawDpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
    const dpr = Math.max(1, Math.min(3, Number(rawDpr) || 1));
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    if (typeof ctx.setTransform === "function") {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, width, height);

    const lines = typeof getDocLines === "function" ? getDocLines() : [];
    const totalLines = Math.max(1, lines.length);

    // Altura por línea proporcional
    const lineHeight = Math.min(3, Math.max(1, height / totalLines));
    const maxChars = 80;

    ctx.fillStyle = "rgba(180, 190, 210, 0.4)";

    const step = totalLines > height * 2 ? Math.max(1, Math.floor(totalLines / height)) : 1;

    for (let i = 0; i < totalLines; i += step) {
      const line = lines[i] || "";
      if (!line.trim()) continue;

      const y = (i / totalLines) * height;
      const indent = line.search(/\S|$/);
      const startX = Math.min(width - 6, indent * 1.5);
      const textLen = Math.min(maxChars, line.trim().length);
      const lineWidth = Math.max(2, Math.min(width - startX - 2, textLen * 0.8));

      ctx.fillRect(startX, y, lineWidth, Math.max(0.8, lineHeight - 0.5));
    }

    updateSlider();
  }

  function updateSlider() {
    if (!sliderEl || !containerEl || !isVisible) return;
    if (sliderRaf) return;
    sliderRaf = safeRequestAnim(() => {
      sliderRaf = null;
      if (!sliderEl || !getRenderDimensions()) return;
      const viewport = typeof getViewport === "function" ? getViewport() : { top: 0, height: 100, totalHeight: 100 };
      const containerH = containerEl.clientHeight || 0;
      if (containerH <= 1) return;

      const totalH = Math.max(1, viewport.totalHeight);
      const topRatio = Math.max(0, Math.min(1, viewport.top / totalH));
      const heightRatio = Math.max(0.05, Math.min(1, viewport.height / totalH));

      const sliderTop = topRatio * containerH;
      const sliderHeight = heightRatio * containerH;

      sliderEl.style.transform = `translateY(${sliderTop}px)`;
      sliderEl.style.height = `${sliderHeight}px`;
    });
  }

  function requestRender() {
    if (animFrameId) safeCancelAnim(animFrameId);
    animFrameId = safeRequestAnim(() => {
      render();
    });
  }

  function toggle(forcedValue) {
    isVisible = forcedValue !== undefined ? Boolean(forcedValue) : !isVisible;
    try {
      localStorage.setItem(PREF_MINIMAP_KEY, String(isVisible));
    } catch (_) {}

    if (containerEl) {
      containerEl.hidden = !isVisible;
    }
    if (isVisible) {
      requestRender();
    }
    return isVisible;
  }

  function destroy() {
    if (animFrameId) safeCancelAnim(animFrameId);
    if (sliderRaf) safeCancelAnim(sliderRaf);
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
    containerEl?.remove();
  }

  initDOM();

  return {
    render: requestRender,
    updateSlider,
    toggle,
    isVisible: () => isVisible,
    destroy
  };
}

function readStoredBool(key, fallback) {
  try {
    const val = localStorage.getItem(key);
    if (val === null) return fallback;
    return val === "true";
  } catch (_) {
    return fallback;
  }
}
