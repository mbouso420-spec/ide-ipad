import { bytesToBase64, base64ToBytes, hasNullBytes } from "../utils/encoding.js";

/**
 * Decide si un archivo elegido para importar es texto editable o un recurso binario soportado.
 * Los binarios no soportados (ZIP, ejecutables, audio masivo…) se rechazan para evitar corrupciones.
 */

function extractBaseAndExtension(filePathOrName) {
  const base = String(filePathOrName || "").split(/[/\\]/).pop() || "";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  return { base, ext };
}

/**
 * Rechaza cargas con extensión de imagen/PDF cuyo encabezado sea claramente marcado activo (HTML/SVG/script)
 * para mitigar spoofing de MIME/extensión sin bloquear binarios sintéticos de prueba.
 * @param {Uint8Array} view
 * @returns {boolean}
 */
function hasDisguisedActiveMarkup(view) {
  const probeLen = Math.min(view.length, 1024);
  if (probeLen === 0 || hasNullBytes(view, probeLen)) return false;
  let head = "";
  for (let i = 0; i < probeLen; i += 1) {
    head += String.fromCharCode(view[i]);
  }
  const normalized = head.replace(/^\uFEFF|^\xEF\xBB\xBF/, "").trimStart();
  return (
    /^(?:<!doctype\s+html\b|<html\b|<script\b|<svg\b)/i.test(normalized) ||
    /^<\?xml\b[\s\S]{0,256}<(?:svg|script)\b/i.test(normalized)
  );
}
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
  const { ext } = extractBaseAndExtension(path);
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Determina si un archivo o ruta corresponde a una imagen visualizable.
 * @param {{ path?: string, name?: string, id?: string } | string} file
 * @returns {boolean}
 */
export function isImageFile(file) {
  const path = typeof file === "string" ? file : (file?.path || file?.name || file?.id || "");
  const { ext } = extractBaseAndExtension(path);
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Devuelve el tipo MIME adecuado para un archivo de imagen.
 * @param {string} fileNameOrPath
 * @returns {string}
 */
export function getImageMimeType(fileNameOrPath) {
  const { ext } = extractBaseAndExtension(fileNameOrPath);
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
  return bytesToBase64(bytes);
}

/**
 * Convierte una cadena codificada en Base64 a su representación cruda en Uint8Array.
 * Mantiene modo tolerante (`strict: false`) por compatibilidad con utilidades tolerantes de importación.
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToUint8Array(base64) {
  return base64ToBytes(base64, { strict: false });
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
  const { base, ext } = extractBaseAndExtension(fileName);

  if (options.allowBinaryAssets && SUPPORTED_BINARY_ASSET_EXTENSIONS.has(ext)) {
    if (hasDisguisedActiveMarkup(view)) {
      return { ok: false, reason: "el contenido activo HTML/SVG no coincide con la extensión binaria" };
    }
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

  if (hasNullBytes(view, SNIFF_BYTES)) {
    return { ok: false, reason: "parece un archivo binario" };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(view);
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "no es texto UTF-8" };
  }
}
