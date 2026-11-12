import { icon } from "./icons.js";
import { getImageMimeType, isImageFile } from "../storage/fileImport.js";

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
    const base64Data = file.base64 || (file.isBinary && typeof file.content === "string" ? file.content : null);
    const ext = (file.path || "").split(".").pop().toLowerCase();

    let sizeFormatted = "";
    if (base64Data) {
      const bytesLen = Math.floor((base64Data.length * 3) / 4);
      if (bytesLen < 1024) {
        sizeFormatted = `${bytesLen} B`;
      } else if (bytesLen < 1024 * 1024) {
        sizeFormatted = `${(bytesLen / 1024).toFixed(1)} KB`;
      } else {
        sizeFormatted = `${(bytesLen / (1024 * 1024)).toFixed(2)} MB`;
      }
    }

    if (isImg && (base64Data || (ext === "svg" && typeof file.content === "string"))) {
      const mime = getImageMimeType(file.path);
      const imgSrc = base64Data
        ? `data:${mime};base64,${base64Data}`
        : `data:image/svg+xml;utf8,${encodeURIComponent(file.content)}`;

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
