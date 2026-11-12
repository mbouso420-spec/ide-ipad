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
export function createBinaryPreview({ binaryPreviewEl, onDownloadFile, onUpdateFileContent }) {
  let currentActiveFile = null;

  function hide() {
    currentActiveFile = null;
    if (binaryPreviewEl) {
      binaryPreviewEl.hidden = true;
      binaryPreviewEl.innerHTML = "";
    }
  }

  function handleFileSelected(file, selectedFileBlob) {
    if (!selectedFileBlob || !onUpdateFileContent) return;
    const ext = (file.path || "").split(".").pop().toLowerCase();
    if (ext === "svg") {
      const reader = new FileReader();
      reader.onload = () => {
        void onUpdateFileContent(file, { text: String(reader.result || "") });
      };
      reader.readAsText(selectedFileBlob, "utf-8");
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        const res = String(reader.result || "");
        const commaIdx = res.indexOf(",");
        const base64 = commaIdx !== -1 ? res.slice(commaIdx + 1) : res;
        void onUpdateFileContent(file, { base64 });
      };
      reader.readAsDataURL(selectedFileBlob);
    }
  }

  // Listener para pegar imágenes desde el portapapeles (Ctrl+V / Cmd+V)
  if (typeof window !== "undefined") {
    window.addEventListener("paste", (event) => {
      if (!binaryPreviewEl || binaryPreviewEl.hidden || !currentActiveFile) return;
      if (!isImageFile(currentActiveFile) || typeof onUpdateFileContent !== "function") return;
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (blob) {
            event.preventDefault();
            handleFileSelected(currentActiveFile, blob);
            break;
          }
        }
      }
    });
  }

  function render(file) {
    if (!binaryPreviewEl) return;
    currentActiveFile = file;
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

    const safeSvg = !safeBase64 && ext === "svg" && typeof file.content === "string" && file.content.trim().length > 0
      ? sanitizeSvgMarkup(file.content)
      : null;

    // Soporte de Drag & Drop sobre la tarjeta
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      card.classList.add("is-drag-over");
    });

    card.addEventListener("dragleave", (event) => {
      if (event.target === card || !card.contains(event.relatedTarget)) {
        card.classList.remove("is-drag-over");
      }
    });

    card.addEventListener("drop", (event) => {
      event.preventDefault();
      card.classList.remove("is-drag-over");
      const droppedFile = event.dataTransfer?.files?.[0];
      if (droppedFile && isImg) {
        handleFileSelected(file, droppedFile);
      }
    });

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = isImg ? "image/*" : "*/*";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const selected = fileInput.files?.[0];
      if (selected) {
        handleFileSelected(file, selected);
      }
      fileInput.value = "";
    });
    card.appendChild(fileInput);

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
    } else if (isImg && !safeBase64 && !safeSvg) {
      // Imagen vacía: asistente para cargar o pegar imagen
      const mark = document.createElement("div");
      mark.className = "editor-empty-mark";
      mark.innerHTML = icon("image");
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
      badge.textContent = ext ? ext.toUpperCase() : "IMG";
      meta.appendChild(badge);

      const stateSpan = document.createElement("span");
      stateSpan.textContent = "Archivo vacío";
      meta.appendChild(stateSpan);

      info.appendChild(meta);

      const desc = document.createElement("p");
      desc.className = "editor-binary-desc";
      desc.textContent = "Este archivo de imagen todavía no contiene datos. Podés cargar un archivo desde tu dispositivo, arrastrar una imagen aquí o pegarla con Ctrl+V.";
      info.appendChild(desc);

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

    if (isImg && typeof onUpdateFileContent === "function") {
      const uploadBtn = document.createElement("button");
      uploadBtn.type = "button";
      uploadBtn.className = (safeBase64 || safeSvg) ? "btn btn-secondary btn-sm" : "btn btn-primary btn-sm";
      uploadBtn.innerHTML = `${icon("upload")} <span>${(safeBase64 || safeSvg) ? "Reemplazar imagen" : "Cargar imagen"}</span>`;
      uploadBtn.addEventListener("click", () => {
        fileInput.click();
      });
      actions.appendChild(uploadBtn);
    }

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
