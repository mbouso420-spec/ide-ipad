/**
 * Cifrado autenticado en el cliente (AES-GCM 256 + PBKDF2-HMAC-SHA256)
 * mediante Web Crypto API para exportar e importar bóvedas portables de credenciales.
 */

export const VAULT_FORMAT = "studio-ide-key-vault";
export const VAULT_VERSION = 1;
export const DEFAULT_PBKDF2_ITERATIONS = 210_000;
export const MIN_PBKDF2_ITERATIONS = 10_000;
export const MAX_PBKDF2_ITERATIONS = 2_000_000;
export const MIN_PASSPHRASE_LENGTH = 6;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function getWebCrypto() {
  const api = typeof window !== "undefined" && window.crypto ? window.crypto : crypto;
  if (!api?.subtle || typeof api.getRandomValues !== "function") {
    throw new Error("Web Crypto API (AES-GCM / PBKDF2) no está disponible en este entorno.");
  }
  return api;
}

function bytesToBase64(bytes) {
  const chunk = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  if (typeof b64 !== "string" || !b64.trim()) {
    throw new Error("Datos binarios Base64 faltantes o inválidos.");
  }
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function validatePassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `La contraseña maestra debe tener al menos ${MIN_PASSPHRASE_LENGTH} caracteres.`
    );
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(passphrase)) {
    throw new Error("La contraseña contiene caracteres de control no válidos.");
  }
}

async function deriveAesGcmKey(cryptoApi, passphrase, saltBytes, iterations, usages) {
  const encoder = new TextEncoder();
  const baseKey = await cryptoApi.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256"
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    usages
  );
}

/**
 * Comprueba si un texto JSON corresponde a una bóveda cifrada de Studio IDE.
 * @param {string} rawText
 * @returns {boolean}
 */
export function isEncryptedKeyVault(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) return false;
  try {
    const parsed = JSON.parse(rawText);
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        parsed.format === VAULT_FORMAT &&
        Number(parsed.version) === VAULT_VERSION &&
        typeof parsed.ciphertext === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Cifra una carga JSON de credenciales usando PBKDF2-SHA256 + AES-GCM-256.
 * @param {string} plainJson
 * @param {string} passphrase
 * @param {{ iterations?: number }} [options]
 * @returns {Promise<string>}
 */
export async function encryptKeysPayload(plainJson, passphrase, options = {}) {
  if (typeof plainJson !== "string" || !plainJson.trim()) {
    throw new Error("No hay credenciales para cifrar.");
  }
  validatePassphrase(passphrase);

  const requestedIterations = Number(options.iterations ?? DEFAULT_PBKDF2_ITERATIONS);
  const iterations = Math.min(
    MAX_PBKDF2_ITERATIONS,
    Math.max(MIN_PBKDF2_ITERATIONS, Math.floor(requestedIterations))
  );

  const cryptoApi = getWebCrypto();
  const salt = cryptoApi.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = cryptoApi.getRandomValues(new Uint8Array(IV_BYTES));

  const aesKey = await deriveAesGcmKey(cryptoApi, passphrase, salt, iterations, ["encrypt"]);
  const plainBytes = new TextEncoder().encode(plainJson);
  const cipherBuffer = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    aesKey,
    plainBytes
  );

  return JSON.stringify(
    {
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      kdf: "PBKDF2-SHA256",
      iterations,
      cipher: "AES-GCM-256",
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(cipherBuffer)),
      createdAt: new Date().toISOString()
    },
    null,
    2
  );
}

/**
 * Descifra y verifica autenticidad de una bóveda cifrada de Studio IDE.
 * @param {string} encryptedJson
 * @param {string} passphrase
 * @returns {Promise<string>}
 */
export async function decryptKeysPayload(encryptedJson, passphrase) {
  if (typeof encryptedJson !== "string" || !encryptedJson.trim()) {
    throw new Error("El archivo de respaldo está vacío.");
  }
  validatePassphrase(passphrase);

  let parsed;
  try {
    parsed = JSON.parse(encryptedJson);
  } catch {
    throw new Error("El archivo seleccionado no contiene JSON válido.");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.format !== VAULT_FORMAT ||
    Number(parsed.version) !== VAULT_VERSION
  ) {
    throw new Error("El archivo no tiene el formato de bóveda cifrada de Studio IDE.");
  }

  const iterations = Number(parsed.iterations);
  if (
    !Number.isFinite(iterations) ||
    iterations < MIN_PBKDF2_ITERATIONS ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error("Parámetros criptográficos fuera de rango seguro.");
  }

  let salt;
  let iv;
  let ciphertext;
  try {
    salt = base64ToBytes(parsed.salt);
    iv = base64ToBytes(parsed.iv);
    ciphertext = base64ToBytes(parsed.ciphertext);
  } catch {
    throw new Error("La estructura binaria de la bóveda está dañada.");
  }

  if (salt.length < 8 || iv.length !== IV_BYTES || ciphertext.length < 16) {
    throw new Error("La bóveda cifrada está incompleta o alterada.");
  }

  const cryptoApi = getWebCrypto();
  const aesKey = await deriveAesGcmKey(cryptoApi, passphrase, salt, Math.floor(iterations), ["decrypt"]);

  try {
    const plainBuffer = await cryptoApi.subtle.decrypt(
      {
        name: "AES-GCM",
        iv
      },
      aesKey,
      ciphertext
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plainBuffer);
  } catch {
    throw new Error("Contraseña incorrecta o archivo de respaldo dañado.");
  }
}
