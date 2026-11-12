/**
 * Decide si un archivo elegido para importar es texto editable o un recurso binario soportado.
 * Los binarios no soportados (ZIP, ejecutables, audio masivo…) se rechazan para evitar corrupciones.
 */
export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tif", "tiff", "heic", "psd",
  "pdf", "zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "wav", "ogg", "m4a", "flac", "mp4", "webm", "mov", "avi", "mkv",
  "exe", "dll", "so", "dylib", "o", "a", "obj", "bin", "wasm", "class", "jar", "pyc",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "sqlite", "db"
]);

export const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "svg"
]);

// SVG es texto XML editable (htmlBundler/CodeMirror lo requieren como texto), mientras avif/bmp sí son binarios soportados.
export const SUPPORTED_BINARY_ASSET_EXTENSIONS = new Set([
  ...[...IMAGE_EXTENSIONS].filter((ext) => ext !== "svg"),
  "pdf"
]);

/**
 * Determina si un archivo o ruta corresponde a un recurso binario.
 * @param {{ path?: string, name?: string, id?: string, isBinary?: boolean, base64?: string, encoding?: string } | string} file
 * @returns {boolean}
 */
export function isBinaryFile(file) {
  if (!file) return false;
  if (typeof file === "object") {
    if (file.isBinary) return true;
    if (file.base64 && typeof file.base64 === "string") return true;
    if (file.encoding === "base64") return true;
  }
  const path = typeof file === "string" ? file : (file.path || file.name || file.id || "");
  const base = String(path || "").split("/").pop() || "";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Determina si un archivo o ruta corresponde a una imagen visualizable.
 * @param {{ path?: string, name?: string, id?: string } | string} file
 * @returns {boolean}
 */
export function isImageFile(file) {
  const path = typeof file === "string" ? file : (file?.path || file?.name || file?.id || "");
  const base = String(path || "").split("/").pop() || "";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Devuelve el tipo MIME adecuado para un archivo de imagen.
 * @param {string} fileNameOrPath
 * @returns {string}
 */
export function getImageMimeType(fileNameOrPath) {
  const ext = String(fileNameOrPath || "").split(".").pop().toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "ico": return "image/x-icon";
    case "bmp": return "image/bmp";
    case "avif": return "image/avif";
    default: return "image/png";
  }
}

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const SNIFF_BYTES = 8000;

export function uint8ArrayToBase64(bytes) {
  if (!bytes || bytes.length === 0) return "";
  let binary = "";
  const chunkSize = 8192;
  const len = bytes.length;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  const btoaFn = typeof btoa === "function" ? btoa : (globalThis.btoa || (typeof window !== "undefined" ? window.btoa : null));
  return btoaFn(binary);
}

/**
 * Convierte una cadena codificada en Base64 a su representación cruda en Uint8Array.
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToUint8Array(base64) {
  if (!base64 || typeof base64 !== "string") return new Uint8Array(0);
  const clean = base64.replace(/\s+/g, "");
  if (!clean) return new Uint8Array(0);
  const atobFn = typeof atob === "function" ? atob : (globalThis.atob || (typeof window !== "undefined" ? window.atob : null));
  if (!atobFn) {
    const nodeBuf = typeof globalThis !== "undefined" ? globalThis.Buffer : null;
    if (nodeBuf && typeof nodeBuf.from === "function") {
      try {
        return new Uint8Array(nodeBuf.from(clean, "base64"));
      } catch {
        return new Uint8Array(0);
      }
    }
    return new Uint8Array(0);
  }
  try {
    const binary = atobFn(clean);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @param {{ allowBinaryAssets?: boolean }} [options]
 * @returns {{ ok: true, text?: string, isBinary?: boolean, base64?: string } | { ok: false, reason: string }}
 */
export function decodeImportedFile(bytes, fileName, options = {}) {
  let view;
  if (bytes instanceof Uint8Array) {
    view = bytes;
  } else if (bytes instanceof ArrayBuffer) {
    view = new Uint8Array(bytes);
  } else if (ArrayBuffer.isView(bytes)) {
    view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else if (Array.isArray(bytes)) {
    view = new Uint8Array(bytes);
  } else {
    return { ok: false, reason: "contenido de archivo inválido" };
  }

  if (view.length > MAX_IMPORT_FILE_BYTES) {
    return { ok: false, reason: "supera el límite de 5 MB por archivo" };
  }
  const base = String(fileName || "").split("/").pop() || "";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";

  if (options.allowBinaryAssets && SUPPORTED_BINARY_ASSET_EXTENSIONS.has(ext)) {
    return {
      ok: true,
      isBinary: true,
      base64: uint8ArrayToBase64(view),
      fileName: base
    };
  }

  if (BINARY_EXTENSIONS.has(ext)) {
    return { ok: false, reason: "es un archivo binario: imagen, documento o comprimido" };
  }

  const limit = Math.min(view.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (view[i] === 0) {
      return { ok: false, reason: "parece un archivo binario" };
    }
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(view);
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "no es texto UTF-8" };
  }
}
