/**
 * Cifrado autenticado en el cliente (AES-GCM 256 + PBKDF2-HMAC-SHA256)
 * mediante Web Crypto API para exportar e importar bóvedas portables de credenciales.
 */

import { base64ToBytes, bytesToBase64 } from "../utils/encoding.js";

export const VAULT_FORMAT = "studio-ide-key-vault";
export const VAULT_VERSION = 1;
export const DEFAULT_PBKDF2_ITERATIONS = 210_000;
export const MIN_PBKDF2_ITERATIONS = 10_000;
export const MAX_PBKDF2_ITERATIONS = 2_000_000;
export const MIN_PASSPHRASE_LENGTH = 6;
export const MAX_VAULT_JSON_BYTES = 1024 * 1024; // 1 MB límite seguro antes de JSON.parse
const SALT_BYTES = 16;
const IV_BYTES = 12;

function getWebCrypto() {
  const api = typeof window !== "undefined" && window.crypto ? window.crypto : crypto;
  if (!api?.subtle || typeof api.getRandomValues !== "function") {
    throw new Error("Web Crypto API (AES-GCM / PBKDF2) no está disponible en este entorno.");
  }
  return api;
}

function decodeVaultFieldBase64(b64) {
  if (typeof b64 !== "string" || !b64.trim()) {
    throw new Error("Datos binarios Base64 faltantes o inválidos.");
  }
  return base64ToBytes(b64, { strict: true });
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
  if (typeof rawText !== "string" || !rawText.trim() || rawText.length > MAX_VAULT_JSON_BYTES) {
    return false;
  }
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

function buildVaultAad(iterations, kdf = "PBKDF2-SHA256", cipher = "AES-GCM-256") {
  return new TextEncoder().encode(
    `${VAULT_FORMAT}|${VAULT_VERSION}|${kdf}|${Math.floor(iterations)}|${cipher}`
  );
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
  if (!Number.isFinite(requestedIterations)) {
    throw new Error("Parámetros criptográficos inválidos: iteraciones PBKDF2 inválidas.");
  }
  const iterations = Math.min(
    MAX_PBKDF2_ITERATIONS,
    Math.max(MIN_PBKDF2_ITERATIONS, Math.floor(requestedIterations))
  );

  const cryptoApi = getWebCrypto();
  const salt = cryptoApi.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = cryptoApi.getRandomValues(new Uint8Array(IV_BYTES));

  const kdf = "PBKDF2-SHA256";
  const cipher = "AES-GCM-256";
  const additionalData = buildVaultAad(iterations, kdf, cipher);
  const aesKey = await deriveAesGcmKey(cryptoApi, passphrase, salt, iterations, ["encrypt"]);
  const plainBytes = new TextEncoder().encode(plainJson);
  const cipherBuffer = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData
    },
    aesKey,
    plainBytes
  );

  return JSON.stringify(
    {
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      kdf,
      iterations,
      cipher,
      aad: "metadata-v1",
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
  if (encryptedJson.length > MAX_VAULT_JSON_BYTES) {
    throw new Error("El archivo de respaldo excede el tamaño máximo permitido.");
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

  if (
    (parsed.kdf !== undefined && parsed.kdf !== "PBKDF2-SHA256") ||
    (parsed.cipher !== undefined && parsed.cipher !== "AES-GCM-256") ||
    (parsed.aad !== undefined && parsed.aad !== "metadata-v1")
  ) {
    throw new Error("Parámetros criptográficos de bóveda no compatibles o alterados.");
  }

  let salt;
  let iv;
  let ciphertext;
  try {
    salt = decodeVaultFieldBase64(parsed.salt);
    iv = decodeVaultFieldBase64(parsed.iv);
    ciphertext = decodeVaultFieldBase64(parsed.ciphertext);
  } catch {
    throw new Error("La estructura binaria de la bóveda está dañada.");
  }

  if (salt.length < 8 || iv.length !== IV_BYTES || ciphertext.length < 16) {
    throw new Error("La bóveda cifrada está incompleta o alterada.");
  }

  const cryptoApi = getWebCrypto();
  const safeIterations = Math.floor(iterations);
  const aesKey = await deriveAesGcmKey(cryptoApi, passphrase, salt, safeIterations, ["decrypt"]);
  const decryptParams = { name: "AES-GCM", iv };
  if (parsed.aad === "metadata-v1") {
    decryptParams.additionalData = buildVaultAad(safeIterations, "PBKDF2-SHA256", "AES-GCM-256");
  }

  try {
    const plainBuffer = await cryptoApi.subtle.decrypt(
      decryptParams,
      aesKey,
      ciphertext
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plainBuffer);
  } catch {
    throw new Error("Contraseña incorrecta o archivo de respaldo dañado.");
  }
}
