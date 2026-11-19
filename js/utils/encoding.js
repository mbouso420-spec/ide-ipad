/**
 * Utilidades compartidas de codificación Base64, detección de bytes nulos y normalización de slugs.
 * Centraliza codecs y validaciones para evitar duplicación entre almacenamiento, criptografía y GitHub.
 */

const BASE64_FROM_CHAR_CHUNK = 8192;
const BASE64_ENCODE_BLOCK_BYTES = 24576; // 3 * 8192: múltiplo exacto de 3 bytes (cero padding intermedio)
const BASE64_DECODE_BLOCK_CHARS = 32768; // 4 * 8192: múltiplo exacto de 4 chars Base64
const FLAT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function getBtoa() {
  if (typeof btoa === "function") return btoa;
  if (typeof globalThis !== "undefined" && typeof globalThis.btoa === "function") return globalThis.btoa;
  if (typeof window !== "undefined" && typeof window.btoa === "function") return window.btoa;
  return null;
}

function getAtob() {
  if (typeof atob === "function") return atob;
  if (typeof globalThis !== "undefined" && typeof globalThis.atob === "function") return globalThis.atob;
  if (typeof window !== "undefined" && typeof window.atob === "function") return window.atob;
  return null;
}

/**
 * Codifica un buffer binario (Uint8Array) a Base64 estándar por bloques para evitar
 * picos de memoria en cadenas intermedias y stack overflow en Safari/WebKit.
 * @param {Uint8Array | ArrayLike<number>} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  if (!bytes || bytes.length === 0) return "";
  let view;
  if (bytes instanceof Uint8Array) {
    view = bytes;
  } else if (ArrayBuffer.isView(bytes)) {
    view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else {
    view = new Uint8Array(bytes);
  }
  const btoaFn = getBtoa();
  if (!btoaFn) {
    const nodeBuf = typeof globalThis !== "undefined" ? globalThis.Buffer : null;
    if (nodeBuf && typeof nodeBuf.from === "function") {
      return nodeBuf.from(view).toString("base64");
    }
    throw new Error("Codificador Base64 no disponible en este entorno.");
  }

  const encodeSlice = (slice) => {
    let binary = "";
    for (let j = 0; j < slice.length; j += BASE64_FROM_CHAR_CHUNK) {
      const sub = slice.subarray(j, j + BASE64_FROM_CHAR_CHUNK);
      binary += String.fromCharCode.apply(null, sub);
    }
    return btoaFn(binary);
  };

  if (view.length <= BASE64_ENCODE_BLOCK_BYTES) {
    return encodeSlice(view);
  }

  const chunks = [];
  for (let i = 0; i < view.length; i += BASE64_ENCODE_BLOCK_BYTES) {
    chunks.push(encodeSlice(view.subarray(i, i + BASE64_ENCODE_BLOCK_BYTES)));
  }
  return chunks.join("");
}

/**
 * Decodifica una cadena Base64 estándar a Uint8Array por bloques.
 * En modo estricto (`strict = true`, por defecto) lanza Error ante cadenas Base64 corruptas o mal formadas.
 * @param {string} base64
 * @param {{ strict?: boolean }} [options]
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64, { strict = true } = {}) {
  if (typeof base64 !== "string") {
    if (strict) {
      throw new Error("Datos Base64 faltantes o inválidos.");
    }
    return new Uint8Array(0);
  }

  const clean = base64.replace(/\s+/g, "");
  if (!clean) {
    return new Uint8Array(0);
  }

  if (clean.length % 4 !== 0 || !FLAT_BASE64_RE.test(clean)) {
    if (strict) {
      throw new Error("La cadena Base64 está corrupta o tiene un formato inválido.");
    }
    return new Uint8Array(0);
  }

  const atobFn = getAtob();
  if (!atobFn) {
    const nodeBuf = typeof globalThis !== "undefined" ? globalThis.Buffer : null;
    if (nodeBuf && typeof nodeBuf.from === "function") {
      try {
        return new Uint8Array(nodeBuf.from(clean, "base64"));
      } catch (err) {
        if (strict) throw err;
        return new Uint8Array(0);
      }
    }
    if (strict) {
      throw new Error("Decodificador Base64 no disponible en este entorno.");
    }
    return new Uint8Array(0);
  }

  try {
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    const totalLen = (clean.length / 4) * 3 - padding;
    const out = new Uint8Array(totalLen);
    let writeOffset = 0;
    for (let i = 0; i < clean.length; i += BASE64_DECODE_BLOCK_CHARS) {
      const binary = atobFn(clean.slice(i, i + BASE64_DECODE_BLOCK_CHARS));
      for (let j = 0; j < binary.length; j += 1) {
        out[writeOffset++] = binary.charCodeAt(j);
      }
    }
    return out;
  } catch (err) {
    if (strict) {
      throw err instanceof Error ? err : new Error("La cadena Base64 está corrupta.");
    }
    return new Uint8Array(0);
  }
}

const sharedTextEncoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

/**
 * Codifica texto UTF-8 a Base64 estándar.
 * @param {string} text
 * @returns {string}
 */
export function utf8ToBase64(text) {
  const encoder = sharedTextEncoder || new TextEncoder();
  const bytes = encoder.encode(String(text ?? ""));
  return bytesToBase64(bytes);
}

/**
 * Detecta presencia de bytes NUL (0x00) en la cabecera de un buffer para identificar contenido binario.
 * @param {Uint8Array} bytes
 * @param {number} [maxScanBytes=8000]
 * @returns {boolean}
 */
export function hasNullBytes(bytes, maxScanBytes = 8000) {
  if (!bytes || typeof bytes.length !== "number") return false;
  const limit = Math.min(bytes.length, maxScanBytes);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * Genera un identificador slug seguro para nombres de proyectos o repositorios.
 * @param {string} name
 * @param {{ allowDots?: boolean, collapse?: boolean, fallback?: string }} [options]
 * @returns {string}
 */
export function slugifyName(name, { allowDots = false, collapse = true, fallback = "" } = {}) {
  const cleaned = String(name ?? "").trim().toLowerCase();
  const pattern = allowDots
    ? (collapse ? /[^a-z0-9._-]+/g : /[^a-z0-9._-]/g)
    : (collapse ? /[^a-z0-9-_]+/g : /[^a-z0-9-_]/g);
  const slug = cleaned.replace(pattern, "-").replace(/^-+|-+$/g, "");
  if (!slug || /^\.+$/.test(slug)) {
    return fallback;
  }
  return slug;
}
