/**
 * Utilidades DOM compartidas para escape HTML seguro y descarga diferida de Blobs.
 */

const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

/**
 * Escapa caracteres HTML especiales para prevenir XSS en plantillas HTML.
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? "").replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * Dispara la descarga de un Blob y revoca su ObjectURL de forma diferida
 * para no abortar descargas grandes en navegadores móviles/Safari/Firefox.
 * @param {Blob} blob
 * @param {string} filename
 * @param {{ revokeDelayMs?: number }} [options]
 */
export function downloadBlob(blob, filename, { revokeDelayMs = 1500 } = {}) {
  if (!blob || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return false;
  }
  if (typeof Blob !== "undefined" && !(blob instanceof Blob)) {
    return false;
  }
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return false;
  }

  let url = "";
  let anchor = null;
  const safeName =
    String(filename || "download")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .trim() || "download";
  const delayMs = Number.isFinite(Number(revokeDelayMs)) ? Math.max(0, Number(revokeDelayMs)) : 1500;

  try {
    url = URL.createObjectURL(blob);
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeName;
    if (anchor.style) {
      anchor.style.display = "none";
    }

    const container = document.body || document.documentElement;
    if (container && typeof container.appendChild === "function") {
      container.appendChild(anchor);
    }

    anchor.click();
  } finally {
    if (anchor) {
      if (anchor.parentNode && typeof anchor.parentNode.removeChild === "function") {
        anchor.parentNode.removeChild(anchor);
      } else if (typeof anchor.remove === "function") {
        anchor.remove();
      }
    }

    if (url && typeof URL.revokeObjectURL === "function") {
      const scheduleRevoke = typeof window !== "undefined" && typeof window.setTimeout === "function"
        ? window.setTimeout.bind(window)
        : setTimeout;
      scheduleRevoke(() => {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      }, delayMs);
    }
  }
  return true;
}
