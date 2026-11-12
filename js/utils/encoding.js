/**
 * Utilidades compartidas de codificación Base64, detección de bytes nulos y normalización de slugs.
 * Centraliza codecs y validaciones para evitar duplicación entre almacenamiento, criptografía y GitHub.
 */

const BASE64_CHUNK_SIZE = 8192;
const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

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
 * Codifica un buffer binario (Uint8Array) a Base64 estándar por bloques para evitar stack overflow.
 * @param {Uint8Array | ArrayLike<number>} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  if (!bytes || bytes.length === 0) return "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const btoaFn = getBtoa();
  if (!btoaFn) {
    const nodeBuf = typeof globalThis !== "undefined" ? globalThis.Buffer : null;
    if (nodeBuf && typeof nodeBuf.from === "function") {
      return nodeBuf.from(view).toString("base64");
    }
    throw new Error("Codificador Base64 no disponible en este entorno.");
  }

  let binary = "";
  for (let i = 0; i < view.length; i += BASE64_CHUNK_SIZE) {
    const slice = view.subarray(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoaFn(binary);
}

/**
 * Decodifica una cadena Base64 estándar a Uint8Array.
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

  if (!STRICT_BASE64_RE.test(clean)) {
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
    const binary = atobFn(clean);
    const len = binary.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch (err) {
    if (strict) {
      throw err instanceof Error ? err : new Error("La cadena Base64 está corrupta.");
    }
    return new Uint8Array(0);
  }
}

/**
 * Codifica texto UTF-8 a Base64 estándar.
 * @param {string} text
 * @returns {string}
 */
export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
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
  return slug || fallback;
}
