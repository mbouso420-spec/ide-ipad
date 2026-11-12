import { icon } from "./icons.js";
import { getImageMimeType, isImageFile } from "../storage/fileImport.js";

const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function sanitizeBase64Payload(raw) {
  if (typeof raw !== "string") return null;
  const compact = raw.replace(/\s+/g, "");
  if (!compact || compact.length % 4 !== 0 || !STRICT_BASE64_RE.test(compact)) {
    return null;
  }
  return compact;
}

/**
 * Sanea SVG antes de pasarlo a `data:image/svg+xml` para neutralizar scripts embebidos,
 * `foreignObject`, manejadores de eventos `on*` y URIs `javascript:` / `vbscript:` / `data:text/html`.
 * @param {string} svgMarkup
 * @returns {string|null}
 */
export function sanitizeSvgMarkup(svgMarkup) {
  if (typeof svgMarkup !== "string" || !svgMarkup.trim()) return null;
  let cleaned = svgMarkup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "")
    .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/<foreignObject\b[^>]*\/?>/gi, "")
    .replace(/<(iframe|object|embed|applet|meta|base)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(iframe|object|embed|applet|meta|base)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href|src)\s*=\s*(?:"\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^"]*"|'\s*(?:javascript|vbscript|data\s*:\s*text\/html)[^']*'|[^\s>]*javascript:[^\s>]*)/gi, '$1="#"');
  if (!/<svg[\s>]/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

/**
 * Renderiza la tarjeta de inspección visual para imágenes y archivos binarios
 * que no deben abrirse como texto en CodeMirror.
 */
export function createBinaryPreview({ binaryPreviewEl, onDownloadFile }) {
  function hide() {
    if (binaryPreviewEl) {
      binaryPreviewEl.hidden = true;
      binaryPreviewEl.innerHTML = "";
    }
  }

  function render(file) {
    if (!binaryPreviewEl) return;
    binaryPreviewEl.hidden = false;
    binaryPreviewEl.innerHTML = "";

    const card = document.createElement("div");
    card.className = "editor-binary-card";

    const isImg = isImageFile(file);
    const rawBase64 = file.base64 || (file.isBinary && typeof file.content === "string" ? file.content : null);
    const safeBase64 = rawBase64 ? sanitizeBase64Payload(rawBase64) : null;
    const ext = (file.path || "").split(".").pop().toLowerCase();

    let sizeFormatted = "";
    if (safeBase64) {
      const bytesLen = Math.floor((safeBase64.length * 3) / 4);
      if (bytesLen < 1024) {
        sizeFormatted = `${bytesLen} B`;
      } else if (bytesLen < 1024 * 1024) {
        sizeFormatted = `${(bytesLen / 1024).toFixed(1)} KB`;
      } else {
        sizeFormatted = `${(bytesLen / (1024 * 1024)).toFixed(2)} MB`;
      }
    }

    const safeSvg = !safeBase64 && ext === "svg" && typeof file.content === "string"
      ? sanitizeSvgMarkup(file.content)
      : null;

    if (isImg && (safeBase64 || safeSvg)) {
      const mime = getImageMimeType(file.path);
      const imgSrc = safeBase64
        ? `data:${mime};base64,${safeBase64}`
        : `data:image/svg+xml;utf8,${encodeURIComponent(safeSvg)}`;

      const imgContainer = document.createElement("div");
      imgContainer.className = "editor-binary-image-container";

      const img = document.createElement("img");
      img.className = "editor-binary-image";
      img.alt = file.shortName;
      img.src = imgSrc;

      imgContainer.appendChild(img);
      card.appendChild(imgContainer);

      const info = document.createElement("div");
      info.className = "editor-binary-info";

      const title = document.createElement("h2");
      title.className = "editor-binary-title";
      title.textContent = file.shortName;
      info.appendChild(title);

      const meta = document.createElement("div");
      meta.className = "editor-binary-meta";

      const badge = document.createElement("span");
      badge.className = "editor-binary-badge";
      badge.textContent = ext.toUpperCase();
      meta.appendChild(badge);

      const sizeSpan = document.createElement("span");
      sizeSpan.textContent = sizeFormatted || "Imagen";
      meta.appendChild(sizeSpan);

      const dimSpan = document.createElement("span");
      dimSpan.className = "editor-binary-dim";
      img.addEventListener("load", () => {
        dimSpan.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
      });
      meta.appendChild(dimSpan);

      info.appendChild(meta);
      card.appendChild(info);
    } else {
      const mark = document.createElement("div");
      mark.className = "editor-empty-mark";
      mark.innerHTML = icon(file.icon || "fileText");
      card.appendChild(mark);

      const info = document.createElement("div");
      info.className = "editor-binary-info";

      const title = document.createElement("h2");
      title.className = "editor-binary-title";
      title.textContent = file.shortName;
      info.appendChild(title);

      const meta = document.createElement("div");
      meta.className = "editor-binary-meta";

      const badge = document.createElement("span");
      badge.className = "editor-binary-badge";
      badge.textContent = ext ? ext.toUpperCase() : "BIN";
      meta.appendChild(badge);

      if (sizeFormatted) {
        const sizeSpan = document.createElement("span");
        sizeSpan.textContent = sizeFormatted;
        meta.appendChild(sizeSpan);
      }

      info.appendChild(meta);

      const desc = document.createElement("p");
      desc.className = "editor-binary-desc";
      desc.textContent = "Este archivo contiene datos binarios que no pueden editarse en el editor de código para proteger su integridad.";
      info.appendChild(desc);

      card.appendChild(info);
    }

    const actions = document.createElement("div");
    actions.className = "editor-binary-actions";

    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "btn btn-secondary btn-sm";
    dlBtn.innerHTML = `${icon("download")} <span>Descargar archivo</span>`;
    dlBtn.addEventListener("click", () => {
      void onDownloadFile?.();
    });
    actions.appendChild(dlBtn);

    card.appendChild(actions);
    binaryPreviewEl.appendChild(card);
  }

  return { hide, render };
}
