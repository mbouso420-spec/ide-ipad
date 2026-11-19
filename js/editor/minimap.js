/**
 * Minimap — Vista en miniatura (Bird's Eye View) para el editor de código
 * Dibuja una representación proporcional del documento y permite navegar visualmente arrastrando o haciendo clic.
 */

import { readStoredBool, saveStoredValue } from "../utils/storage.js";

const PREF_MINIMAP_KEY = "ide.editor.minimap";

const safeRequestAnim = typeof requestAnimationFrame === "function"
  ? requestAnimationFrame
  : (cb) => setTimeout(cb, 16);

const safeCancelAnim = typeof cancelAnimationFrame === "function"
  ? cancelAnimationFrame
  : (id) => clearTimeout(id);

/**
 * Crea y administra el minimapa del editor.
 * Admite muestreo directo (`getLineCount` + `getLine` o `sampleDocLines`) para evitar alocar
 * arreglos completos de todo el documento en cada cuadro, conservando `getDocLines` por compatibilidad.
 *
 * @param {{
 *   mountEl: HTMLElement,
 *   getDocLines?: () => string[],
 *   getLineCount?: () => number,
 *   getLine?: (index: number) => string,
 *   sampleDocLines?: (maxSamples: number) => { totalLines: number, samples: Array<{ index: number, text: string }> },
 *   getViewport: () => { top: number, height: number, totalHeight: number },
 *   onScrollToRatio: (ratio: number) => void
 * }} config
 */
export function createMinimapController({
  mountEl,
  getDocLines,
  getLineCount,
  getLine,
  sampleDocLines,
  getViewport,
  onScrollToRatio
}) {
  let isVisible = readStoredBool(PREF_MINIMAP_KEY, true);
  let canvas = null;
  let ctx = null;
  let sliderEl = null;
  let containerEl = null;
  let isDragging = false;
  let activePointerId = null;
  let dragRect = null;
  let pendingDragClientY = null;
  let dragRaf = null;
  let animFrameId = null;
  let sliderRaf = null;
  let resizeObserver = null;
  let pendingRenderWhileHidden = false;
  let pendingSliderWhileHidden = false;
  let lastSliderTop = null;
  let lastSliderHeight = null;

  const isDocumentHidden = () => typeof document !== "undefined" && Boolean(document.hidden);

  const measureLineSpan = (line) => {
    const len = line.length;
    let start = 0;
    while (start < len && line.charCodeAt(start) <= 32) start += 1;
    if (start >= len) return null;
    let end = len - 1;
    while (end > start && line.charCodeAt(end) <= 32) end -= 1;
    return { indent: start, trimmedLen: end - start + 1 };
  };

  const applyDragScroll = (clientY) => {
    const rect = dragRect || containerEl?.getBoundingClientRect?.();
    if (!rect || rect.height <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    onScrollToRatio?.(ratio);
  };

  const handlePointerMove = (e) => {
    if (!isDragging) return;
    if (activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId) return;
    e.preventDefault();
    pendingDragClientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    if (dragRaf) return;
    dragRaf = safeRequestAnim(() => {
      dragRaf = null;
      if (!isDragging || pendingDragClientY === null) return;
      applyDragScroll(pendingDragClientY);
    });
  };

  const handlePointerUp = (e) => {
    if (e && activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId) return;
    isDragging = false;
    dragRect = null;
    pendingDragClientY = null;
    if (dragRaf) {
      safeCancelAnim(dragRaf);
      dragRaf = null;
    }
    if (activePointerId !== null) {
      try {
        containerEl?.releasePointerCapture?.(activePointerId);
      } catch (_) {
        /* captura ya liberada o elemento desconectado */
      }
      activePointerId = null;
    }
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    isDragging = true;
    activePointerId = e.pointerId ?? null;
    dragRect = containerEl?.getBoundingClientRect?.() || null;
    if (activePointerId !== null) {
      try {
        containerEl?.setPointerCapture?.(activePointerId);
      } catch (_) {
        /* entorno sin setPointerCapture */
      }
    }
    updateScrollFromPointer(e);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const handleVisibilityChange = () => {
    if (isDocumentHidden() || !isVisible) return;
    if (pendingRenderWhileHidden) {
      pendingRenderWhileHidden = false;
      pendingSliderWhileHidden = false;
      requestRender();
    } else if (pendingSliderWhileHidden) {
      pendingSliderWhileHidden = false;
      updateSlider();
    }
  };

  function observeResizeTargets() {
    if (!resizeObserver || !containerEl) return;
    resizeObserver.observe(containerEl);
    if (mountEl && mountEl !== containerEl) {
      resizeObserver.observe(mountEl);
    }
  }

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
        if (isVisible && !isDocumentHidden()) {
          requestRender();
        }
      });
      if (isVisible) {
        observeResizeTargets();
      }
    }

    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    setupEvents();
  }

  let cachedCssHidden = false;

  function isElementHidden(el, { skipStyleCheck = false } = {}) {
    if (!el || el.hidden || el.isConnected === false) return true;
    if (skipStyleCheck) {
      return cachedCssHidden;
    }
    if (typeof getComputedStyle === "function") {
      try {
        const style = getComputedStyle(el);
        if (style && (style.display === "none" || style.visibility === "hidden")) {
          return true;
        }
      } catch (_) {
        /* elemento desconectado o entorno sin getComputedStyle */
      }
    }
    return false;
  }

  function getRenderDimensions({ skipStyleCheck = false } = {}) {
    if (!isVisible || !canvas || !ctx || !containerEl) return null;
    if (!skipStyleCheck) {
      cachedCssHidden = isElementHidden(containerEl) || isElementHidden(mountEl);
      if (cachedCssHidden) return null;
    } else if (isElementHidden(containerEl, { skipStyleCheck: true }) || isElementHidden(mountEl, { skipStyleCheck: true })) {
      return null;
    }
    if (!skipStyleCheck && typeof window !== "undefined" && typeof window.matchMedia === "function") {
      try {
        if (window.matchMedia("(max-width: 48rem)").matches) {
          cachedCssHidden = true;
          return null;
        }
      } catch (_) {
        /* matchMedia no disponible */
      }
    }
    const width = Number(containerEl.clientWidth) || 0;
    const height = Number(containerEl.clientHeight) || 0;
    if (width <= 0 || height <= 1) return null;
    return { width, height };
  }

  function setupEvents() {
    if (!containerEl) return;
    containerEl.addEventListener("pointerdown", handlePointerDown);
    containerEl.addEventListener("lostpointercapture", handlePointerUp);
  }

  function updateScrollFromPointer(e) {
    if (!containerEl) return;
    const clientY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    applyDragScroll(clientY);
  }

  function applySliderPosition(containerH) {
    if (!sliderEl || containerH <= 1) return;
    const viewport = typeof getViewport === "function" ? getViewport() : { top: 0, height: 100, totalHeight: 100 };
    const totalH = Math.max(1, viewport.totalHeight);
    const topRatio = Math.max(0, Math.min(1, viewport.top / totalH));
    const heightRatio = Math.max(0.05, Math.min(1, viewport.height / totalH));

    const sliderHeight = Math.round(
      Math.min(
        containerH,
        Math.max(Math.min(20, containerH), heightRatio * containerH)
      ) * 2
    ) / 2;
    const sliderTop = Math.round(
      Math.min(
        Math.max(0, topRatio * containerH),
        Math.max(0, containerH - sliderHeight)
      ) * 2
    ) / 2;

    if (sliderTop !== lastSliderTop) {
      lastSliderTop = sliderTop;
      sliderEl.style.transform = `translateY(${sliderTop}px)`;
    }
    if (sliderHeight !== lastSliderHeight) {
      lastSliderHeight = sliderHeight;
      sliderEl.style.height = `${sliderHeight}px`;
    }
  }

  function render() {
    if (isDocumentHidden()) {
      pendingRenderWhileHidden = true;
      return;
    }
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

    let totalLines = 1;
    let lines = null;
    if (typeof sampleDocLines === "function") {
      const sampled = sampleDocLines(Math.max(1, Math.round(height)));
      totalLines = Math.max(1, sampled?.totalLines || 1);
      const lineHeight = Math.min(3, Math.max(1, height / totalLines));
      const effectiveHeight = Math.min(height, totalLines * (lineHeight + 3));
      const maxChars = 80;
      const barHeight = Math.max(0.8, lineHeight - 0.5);
      ctx.fillStyle = "rgba(180, 190, 210, 0.4)";

      for (const sample of sampled?.samples || []) {
        const line = sample?.text || "";
        const span = measureLineSpan(line);
        if (!span) continue;
        const y = (sample.index / totalLines) * effectiveHeight;
        const startX = Math.min(width - 6, span.indent * 1.5);
        const textLen = Math.min(maxChars, span.trimmedLen);
        const lineWidth = Math.max(2, Math.min(width - startX - 2, textLen * 0.8));
        ctx.fillRect(startX, y, lineWidth, barHeight);
      }
      if (sliderRaf) {
        safeCancelAnim(sliderRaf);
        sliderRaf = null;
      }
      applySliderPosition(height);
      return;
    }

    const useIndexed = typeof getLineCount === "function" && typeof getLine === "function";
    if (useIndexed) {
      totalLines = Math.max(1, getLineCount());
    } else {
      lines = typeof getDocLines === "function" ? getDocLines() : [];
      totalLines = Math.max(1, lines.length);
    }

    // Altura por línea proporcional acotada para archivos cortos
    const lineHeight = Math.min(3, Math.max(1, height / totalLines));
    const effectiveHeight = Math.min(height, totalLines * (lineHeight + 3));
    const maxChars = 80;
    const barHeight = Math.max(0.8, lineHeight - 0.5);

    ctx.fillStyle = "rgba(180, 190, 210, 0.4)";

    const step = totalLines > height * 2 ? Math.max(1, Math.floor(totalLines / height)) : 1;

    for (let i = 0; i < totalLines; i += step) {
      const line = (useIndexed ? getLine(i) : lines[i]) || "";
      const span = measureLineSpan(line);
      if (!span) continue;

      const y = (i / totalLines) * effectiveHeight;
      const startX = Math.min(width - 6, span.indent * 1.5);
      const textLen = Math.min(maxChars, span.trimmedLen);
      const lineWidth = Math.max(2, Math.min(width - startX - 2, textLen * 0.8));

      ctx.fillRect(startX, y, lineWidth, barHeight);
    }

    if (sliderRaf) {
      safeCancelAnim(sliderRaf);
      sliderRaf = null;
    }
    applySliderPosition(height);
  }

  function updateSlider() {
    if (!sliderEl || !containerEl || !isVisible) return;
    if (isDocumentHidden()) {
      pendingSliderWhileHidden = true;
      return;
    }
    if (sliderRaf) return;
    sliderRaf = safeRequestAnim(() => {
      sliderRaf = null;
      if (!sliderEl || isDocumentHidden() || !getRenderDimensions({ skipStyleCheck: true })) return;
      const containerH = containerEl.clientHeight || 0;
      applySliderPosition(containerH);
    });
  }

  function requestRender() {
    if (!isVisible) return;
    if (isDocumentHidden()) {
      pendingRenderWhileHidden = true;
      return;
    }
    if (animFrameId) return;
    animFrameId = safeRequestAnim(() => {
      animFrameId = null;
      render();
    });
  }

  function toggle(forcedValue) {
    isVisible = forcedValue !== undefined ? Boolean(forcedValue) : !isVisible;
    saveStoredValue(PREF_MINIMAP_KEY, String(isVisible));

    if (containerEl) {
      containerEl.hidden = !isVisible;
    }
    if (!isVisible) {
      pendingRenderWhileHidden = false;
      pendingSliderWhileHidden = false;
      if (animFrameId) {
        safeCancelAnim(animFrameId);
        animFrameId = null;
      }
      if (sliderRaf) {
        safeCancelAnim(sliderRaf);
        sliderRaf = null;
      }
      if (dragRaf) {
        safeCancelAnim(dragRaf);
        dragRaf = null;
      }
      resizeObserver?.disconnect();
    } else {
      observeResizeTargets();
      requestRender();
    }
    return isVisible;
  }

  function destroy() {
    if (animFrameId) {
      safeCancelAnim(animFrameId);
      animFrameId = null;
    }
    if (sliderRaf) {
      safeCancelAnim(sliderRaf);
      sliderRaf = null;
    }
    if (dragRaf) {
      safeCancelAnim(dragRaf);
      dragRaf = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
    containerEl?.removeEventListener("pointerdown", handlePointerDown);
    containerEl?.removeEventListener("lostpointercapture", handlePointerUp);
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
