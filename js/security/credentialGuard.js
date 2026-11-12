/**
 * Módulo de seguridad para defensa contra fuerza bruta, bloqueo progresivo (Lockout / Cooldown),
 * validación de formato pre-vuelo, lista negra por huella criptográfica en sesión
 * y saneamiento estricto de credenciales en errores, DOM y logs.
 */

export const LOCKOUT_THRESHOLD = 4;
export const LOCKOUT_DURATIONS_MS = [30_000, 120_000, 300_000]; // 30s -> 2m -> 5m
export const LOCKOUT_STALE_RESET_MS = 3_600_000; // 1 hora sin incidentes reinicia historial viejo
const LOCKOUT_STORAGE_PREFIX = "ide.security.lockout.";
const MAX_REJECTED_HASHES_PER_SCOPE = 500;

/** @type {Map<string, { failedAttempts: number, lockoutUntil: number, updatedAt: number }>} */
const memoryLockoutFallback = new Map();

/** @type {Map<string, Set<string>>} */
const rejectedHashesByScope = new Map();

/** Error lanzado cuando se supera el umbral de intentos de autenticación fallidos. */
export class AuthLockoutError extends Error {
  /**
   * @param {string} scope
   * @param {number} remainingMs
   * @param {number} failedAttempts
   */
  constructor(scope, remainingMs, failedAttempts) {
    const waitLabel = formatRemainingCooldown(remainingMs);
    super(
      `Demasiados intentos fallidos de autenticación. Esperá ${waitLabel} antes de volver a intentar.`
    );
    this.name = "AuthLockoutError";
    this.code = "ERR_AUTH_LOCKOUT";
    this.scope = scope;
    this.remainingMs = Math.max(0, remainingMs);
    this.retryAfterSec = Math.ceil(this.remainingMs / 1000);
    this.failedAttempts = failedAttempts;
    this.status = 429;
  }
}

/** Error lanzado cuando una credencial falla la validación local de formato pre-vuelo. */
export class CredentialFormatError extends Error {
  /**
   * @param {string} message
   * @param {string} [code="ERR_CREDENTIAL_FORMAT"]
   */
  constructor(message, code = "ERR_CREDENTIAL_FORMAT") {
    super(message);
    this.name = "CredentialFormatError";
    this.code = code;
    this.status = 400;
  }
}

function getBrowserStorageGetters() {
  if (typeof window === "undefined") return [];
  return [() => window.localStorage, () => window.sessionStorage];
}

function readPersistedLockoutRecord(scope) {
  const key = `${LOCKOUT_STORAGE_PREFIX}${scope}`;
  for (const getStore of getBrowserStorageGetters()) {
    try {
      const store = getStore();
      const raw = store?.getItem(key) || "";
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          failedAttempts: Math.max(0, Number(parsed.failedAttempts) || 0),
          lockoutUntil: Math.max(0, Number(parsed.lockoutUntil) || 0),
          updatedAt: Math.max(0, Number(parsed.updatedAt) || 0)
        };
      }
    } catch {
      // Fall back to next storage backend or in-memory map if JSON or storage fails
    }
  }
  return memoryLockoutFallback.get(scope) || { failedAttempts: 0, lockoutUntil: 0, updatedAt: 0 };
}

function writePersistedLockoutRecord(scope, record) {
  const key = `${LOCKOUT_STORAGE_PREFIX}${scope}`;
  const clean = {
    failedAttempts: Math.max(0, Number(record?.failedAttempts) || 0),
    lockoutUntil: Math.max(0, Number(record?.lockoutUntil) || 0),
    updatedAt: Math.max(0, Number(record?.updatedAt) || Date.now())
  };

  if (clean.failedAttempts === 0 && clean.lockoutUntil === 0) {
    memoryLockoutFallback.delete(scope);
    for (const getStore of getBrowserStorageGetters()) {
      try {
        getStore()?.removeItem(key);
      } catch {
        // Ignorar entorno restringido
      }
    }
    return;
  }

  memoryLockoutFallback.set(scope, clean);
  let serialized = "";
  try {
    serialized = JSON.stringify(clean);
  } catch {
    return;
  }
  for (const getStore of getBrowserStorageGetters()) {
    try {
      getStore()?.setItem(key, serialized);
    } catch {
      // Ignorar cuota o entorno restringido: memoryLockoutFallback mantiene la protección en sesión
    }
  }
}

/**
 * Formatea una duración en milisegundos en texto legible (p. ej. "30s", "1m 45s").
 * @param {number} ms
 * @returns {string}
 */
export function formatRemainingCooldown(ms) {
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/**
 * Obtiene el estado actual de bloqueo para un alcance ("github" o "ai:<provider>").
 * Limpia automáticamente registros expirados hace más de una hora.
 * @param {string} scope
 * @param {number} [now=Date.now()]
 * @returns {{ locked: boolean, failedAttempts: number, lockoutUntil: number, remainingMs: number }}
 */
export function checkAuthLockout(scope, now = Date.now()) {
  const rec = readPersistedLockoutRecord(scope);
  const maxAllowedDuration = LOCKOUT_DURATIONS_MS[LOCKOUT_DURATIONS_MS.length - 1] + 5_000;
  const clampedUntil =
    rec.lockoutUntil > now + maxAllowedDuration ? now + maxAllowedDuration : rec.lockoutUntil;

  if (clampedUntil > now) {
    return {
      locked: true,
      failedAttempts: rec.failedAttempts,
      lockoutUntil: clampedUntil,
      remainingMs: clampedUntil - now
    };
  }

  // Si expiró hace más de una hora y no hay bloqueo activo, reiniciar el contador
  if (rec.failedAttempts > 0 && rec.updatedAt > 0 && now - rec.updatedAt > LOCKOUT_STALE_RESET_MS) {
    writePersistedLockoutRecord(scope, { failedAttempts: 0, lockoutUntil: 0, updatedAt: 0 });
    return { locked: false, failedAttempts: 0, lockoutUntil: 0, remainingMs: 0 };
  }

  return {
    locked: false,
    failedAttempts: rec.failedAttempts,
    lockoutUntil: 0,
    remainingMs: 0
  };
}

/**
 * Lanza AuthLockoutError si el alcance se encuentra bloqueado temporalmente.
 * @param {string} scope
 * @param {number} [now=Date.now()]
 */
export function assertNotLockedOut(scope, now = Date.now()) {
  const state = checkAuthLockout(scope, now);
  if (state.locked) {
    throw new AuthLockoutError(scope, state.remainingMs, state.failedAttempts);
  }
  return state;
}

/**
 * Registra un intento de autenticación fallido y activa bloqueo exponencial si supera el umbral.
 * @param {string} scope
 * @param {number} [now=Date.now()]
 * @returns {{ locked: boolean, failedAttempts: number, lockoutUntil: number, cooldownMs: number, remainingMs: number }}
 */
export function recordAuthFailure(scope, now = Date.now()) {
  const prev = checkAuthLockout(scope, now);
  const nextAttempts = prev.failedAttempts + 1;

  let cooldownMs = 0;
  let lockoutUntil = prev.lockoutUntil || 0;

  if (nextAttempts >= LOCKOUT_THRESHOLD) {
    const tierIndex = Math.min(nextAttempts - LOCKOUT_THRESHOLD, LOCKOUT_DURATIONS_MS.length - 1);
    cooldownMs = LOCKOUT_DURATIONS_MS[tierIndex];
    lockoutUntil = Math.max(lockoutUntil, now + cooldownMs);
  }

  writePersistedLockoutRecord(scope, {
    failedAttempts: nextAttempts,
    lockoutUntil,
    updatedAt: now
  });

  const remainingMs = Math.max(0, lockoutUntil - now);
  return {
    locked: remainingMs > 0,
    failedAttempts: nextAttempts,
    lockoutUntil,
    cooldownMs,
    remainingMs
  };
}

/**
 * Reinicia los contadores de fallos tras una autenticación exitosa (HTTP 200).
 * @param {string} scope
 */
export function recordAuthSuccess(scope) {
  writePersistedLockoutRecord(scope, { failedAttempts: 0, lockoutUntil: 0, updatedAt: 0 });
}

/**
 * Calcula una huella no reversible (hash FNV-1a dual de 64 bits con longitud) para almacenar
 * claves rechazadas en memoria sin conservar ningún substring del secreto original.
 * @param {string} scope
 * @param {string} rawToken
 * @returns {string}
 */
export function computeTokenFingerprint(scope, rawToken) {
  const input = `${String(scope || "")}\x1f${String(rawToken || "")}\x1f${String(rawToken || "").length}`;
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  let h3 = 0x9e3779b9 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= ch ^ ((i + 1) * 31);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h3 ^= (ch + i * 17) >>> 0;
    h3 = Math.imul(h3 ^ (h3 >>> 15), 0xc2b2ae35) >>> 0;
  }
  return `fp_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}${h3.toString(16).padStart(8, "0")}`;
}

/**
 * Registra la huella criptográfica de una credencial rechazada (401/403) en la sesión actual
 * para evitar reenvíos repetidos del mismo secreto inválido.
 * @param {string} scope
 * @param {string} rawToken
 */
export function markTokenRejectedInSession(scope, rawToken) {
  const clean = String(rawToken || "").trim();
  if (!clean) return;
  let set = rejectedHashesByScope.get(scope);
  if (!set) {
    set = new Set();
    rejectedHashesByScope.set(scope, set);
  }
  if (set.size >= MAX_REJECTED_HASHES_PER_SCOPE) {
    const oldest = set.values().next().value;
    if (oldest) set.delete(oldest);
  }
  set.add(computeTokenFingerprint(scope, clean));
}

/**
 * Comprueba si la huella del token ya fue rechazada en la sesión actual.
 * @param {string} scope
 * @param {string} rawToken
 * @returns {boolean}
 */
export function isTokenRejectedInSession(scope, rawToken) {
  const clean = String(rawToken || "").trim();
  if (!clean) return false;
  const set = rejectedHashesByScope.get(scope);
  if (!set || set.size === 0) return false;
  return set.has(computeTokenFingerprint(scope, clean));
}

/**
 * Valida localmente formato, longitud mínima, ausencia de caracteres de control/espacios,
 * prefijo y entropía mínima ANTES de disparar cualquier petición HTTP.
 *
 * @param {"github" | "gemini" | "groq" | "openrouter" | "mistral" | string} kindOrProvider
 * @param {string} rawToken
 * @returns {{ valid: true, clean: string } | { valid: false, reason: string, code: string }}
 */
export function validateCredentialFormat(kindOrProvider, rawToken) {
  if (typeof rawToken !== "string") {
    return { valid: false, reason: "Credencial vacía o inválida.", code: "ERR_EMPTY" };
  }

  // Detectar caracteres de control o saltos de línea incluso en los bordes (inyección CRLF en cabeceras HTTP)
  if (/[\x00-\x1f\x7f]/.test(rawToken)) {
    return {
      valid: false,
      reason: "La credencial contiene caracteres de control o saltos de línea no permitidos.",
      code: "ERR_CONTROL_CHARS"
    };
  }

  const clean = rawToken.trim();
  if (!clean) {
    return { valid: false, reason: "Falta la credencial.", code: "ERR_EMPTY" };
  }

  if (/\s/.test(clean)) {
    return {
      valid: false,
      reason: "La credencial no debe contener espacios internos.",
      code: "ERR_WHITESPACE"
    };
  }

  if (clean.length > 512) {
    return {
      valid: false,
      reason: "La credencial excede la longitud máxima permitida (512 caracteres).",
      code: "ERR_TOO_LONG"
    };
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(clean)) {
    return {
      valid: false,
      reason: "La credencial contiene caracteres inválidos.",
      code: "ERR_INVALID_CHARS"
    };
  }

  const kind = String(kindOrProvider || "").toLowerCase();

  if (kind === "github") {
    if (clean.length < 20) {
      return {
        valid: false,
        reason: "El token de GitHub es demasiado corto (mínimo 20 caracteres).",
        code: "ERR_TOO_SHORT"
      };
    }
    const matchesGhPrefix =
      /^(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{18,}|[a-f0-9]{40})$/i.test(clean);
    if (!matchesGhPrefix) {
      return {
        valid: false,
        reason: "Formato de token de GitHub inválido (se espera prefijo ghp_, github_pat_, gho_, o 40 dígitos hexadecimales).",
        code: "ERR_INVALID_PREFIX"
      };
    }
    const payloadPart = clean.replace(/^(?:github_pat_|gh[pousr]_)/i, "");
    if (new Set(payloadPart).size < 6) {
      return {
        valid: false,
        reason: "El token de GitHub no tiene suficiente entropía (caracteres repetitivos).",
        code: "ERR_LOW_ENTROPY"
      };
    }
    return { valid: true, clean };
  }

  // Validación para proveedores de IA
  if (kind === "gemini") {
    if (clean.length < 20 || !clean.startsWith("AIza")) {
      return {
        valid: false,
        reason: "La API Key de Google Gemini es inválida (debe comenzar con 'AIza' y tener al menos 20 caracteres).",
        code: "ERR_INVALID_PREFIX"
      };
    }
    if (new Set(clean.slice(4)).size < 6) {
      return {
        valid: false,
        reason: "La API Key de Gemini carece de entropía válida.",
        code: "ERR_LOW_ENTROPY"
      };
    }
    return { valid: true, clean };
  }

  if (kind === "groq") {
    if (clean.length < 20 || !clean.startsWith("gsk_")) {
      return {
        valid: false,
        reason: "La API Key de Groq es inválida (debe comenzar con 'gsk_' y tener al menos 20 caracteres).",
        code: "ERR_INVALID_PREFIX"
      };
    }
    if (new Set(clean.slice(4)).size < 6) {
      return {
        valid: false,
        reason: "La API Key de Groq carece de entropía válida.",
        code: "ERR_LOW_ENTROPY"
      };
    }
    return { valid: true, clean };
  }

  if (kind === "openrouter") {
    if (clean.length < 20 || !clean.startsWith("sk-or-")) {
      return {
        valid: false,
        reason: "La API Key de OpenRouter es inválida (debe comenzar con 'sk-or-' y tener al menos 20 caracteres).",
        code: "ERR_INVALID_PREFIX"
      };
    }
    if (new Set(clean.slice(6)).size < 6) {
      return {
        valid: false,
        reason: "La API Key de OpenRouter carece de entropía válida.",
        code: "ERR_LOW_ENTROPY"
      };
    }
    return { valid: true, clean };
  }

  // Mistral u otros proveedores genéricos (sin prefijo fijo, mínimo 16 caracteres y entropía mínima)
  if (clean.length < 16) {
    return {
      valid: false,
      reason: "La API Key es demasiado corta (mínimo 16 caracteres).",
      code: "ERR_TOO_SHORT"
    };
  }
  if (new Set(clean).size < 6) {
    return {
      valid: false,
      reason: "La API Key carece de entropía mínima válida.",
      code: "ERR_LOW_ENTROPY"
    };
  }
  return { valid: true, clean };
}

/**
 * Enmascara un token para previsualización segura sin exponer el secreto completo.
 * @param {string} secret
 * @returns {string}
 */
export function maskCredentialPreview(secret) {
  const clean = String(secret || "").trim();
  if (!clean) return "";
  if (clean.length <= 8) return "••••";
  const prefixMatch = clean.match(/^(github_pat_|gh[pousr]_|AIza|sk-or-v1-|sk-or-|gsk_|sk-)/i);
  const prefix = prefixMatch ? prefixMatch[0] : "";
  const tail = clean.slice(-4);
  return `${prefix}••••${tail}`;
}

/**
 * Redacta tokens de GitHub, API Keys de IA, cabeceras Authorization y query strings sensibles
 * de cualquier mensaje de error, pila o registro de consola.
 * @param {unknown} input
 * @param {Array<string>} [extraKnownSecrets=[]]
 * @returns {string}
 */
export function redactSensitiveTokens(input, extraKnownSecrets = []) {
  let out = typeof input === "string" ? input : String(input ?? "");
  if (!out) return "";

  out = out
    .replace(/\b(?:github_pat|gh[pousr])_[A-Za-z0-9_]{6,}\b/gi, "[REDACTED_GH_TOKEN]")
    .replace(/\bAIza[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_AI_KEY]")
    .replace(/\b(?:sk-or-v1-|sk-or-|sk-ant-|sk-proj-|sk-|gsk_)[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED_AI_KEY]")
    .replace(/((?:Bearer|token|Basic)\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1[REDACTED]")
    .replace(/((?:x-goog-api-key|x-api-key)\s*[:=]\s*)[^\s"'<>]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:key|token|api_key|apikey|access_token)=)[^&\s"'<>]+/gi, "$1[REDACTED]");

  if (Array.isArray(extraKnownSecrets)) {
    for (const secret of extraKnownSecrets) {
      const s = typeof secret === "string" ? secret.trim() : "";
      if (s && s.length >= 8 && out.includes(s)) {
        out = out.split(s).join("[REDACTED_SECRET]");
      }
    }
  }

  return out;
}

const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
  "x-auth-token",
  "cookie",
  "set-cookie"
]);

function scrubSensitiveHeaders(headers, extraKnownSecrets = []) {
  if (!headers || typeof headers !== "object") return headers;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const clean = {};
    headers.forEach((value, key) => {
      if (!SENSITIVE_HEADER_KEYS.has(String(key).toLowerCase())) {
        clean[key] = redactSensitiveTokens(value, extraKnownSecrets);
      }
    });
    return clean;
  }
  const clean = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_KEYS.has(String(key).toLowerCase())) {
      continue;
    }
    clean[key] = typeof value === "string" ? redactSensitiveTokens(value, extraKnownSecrets) : value;
  }
  return clean;
}

/**
 * Elimina cabeceras sensibles (Authorization, API keys, cookies) y redacta secretos
 * en cadenas/causas anidadas antes de adjuntar `error.cause` en errores propagados.
 * @param {unknown} error
 * @param {Array<string>} [extraKnownSecrets=[]]
 * @param {number} [depth=0]
 * @param {WeakSet<object>} [seen=new WeakSet()]
 * @returns {unknown}
 */
export function sanitizeErrorCause(error, extraKnownSecrets = [], depth = 0, seen = new WeakSet()) {
  if (!error || typeof error !== "object") {
    return typeof error === "string" ? redactSensitiveTokens(error, extraKnownSecrets) : error;
  }
  if (seen.has(error) || depth > 4) {
    return undefined;
  }
  seen.add(error);

  if (error instanceof Error) {
    const safeMsg = redactSensitiveTokens(error.message || "", extraKnownSecrets);
    const safeErr = new Error(safeMsg);
    safeErr.name = error.name || "Error";
    if (error.status !== undefined) safeErr.status = error.status;
    if (error.code !== undefined) safeErr.code = error.code;
    if (error.isNetworkFailure !== undefined) safeErr.isNetworkFailure = error.isNetworkFailure;
    if (error.credentialRejected !== undefined) safeErr.credentialRejected = error.credentialRejected;
    if (typeof error.stack === "string") {
      safeErr.stack = redactSensitiveTokens(error.stack, extraKnownSecrets);
    }
    if (error.headers && typeof error.headers === "object") {
      safeErr.headers = scrubSensitiveHeaders(error.headers, extraKnownSecrets);
    }
    if (error.request && typeof error.request === "object") {
      const reqCopy = { ...error.request };
      if (reqCopy.headers) {
        reqCopy.headers = scrubSensitiveHeaders(reqCopy.headers, extraKnownSecrets);
      }
      if (typeof reqCopy.url === "string") {
        reqCopy.url = redactSensitiveTokens(reqCopy.url, extraKnownSecrets);
      }
      safeErr.request = reqCopy;
    }
    if (error.config && typeof error.config === "object") {
      const cfgCopy = { ...error.config };
      if (cfgCopy.headers) {
        cfgCopy.headers = scrubSensitiveHeaders(cfgCopy.headers, extraKnownSecrets);
      }
      safeErr.config = cfgCopy;
    }
    if (error.cause !== undefined) {
      safeErr.cause = sanitizeErrorCause(error.cause, extraKnownSecrets, depth + 1, seen);
    }
    return safeErr;
  }

  const out = {};
  for (const [k, v] of Object.entries(error)) {
    if (k === "headers") {
      out.headers = scrubSensitiveHeaders(v, extraKnownSecrets);
    } else if (k === "cause" || k === "request" || k === "response" || k === "config") {
      out[k] = sanitizeErrorCause(v, extraKnownSecrets, depth + 1, seen);
    } else if (typeof v === "string") {
      out[k] = redactSensitiveTokens(v, extraKnownSecrets);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Formatea un mensaje de error seguro para mostrar en UI/DOM, redactando secretos conocidos.
 * @param {unknown} err
 * @param {Array<string>} [extraKnownSecrets=[]]
 * @param {string} [fallback="Ocurrió un error inesperado."]
 * @returns {string}
 */
export function formatSafeErrorMessage(err, extraKnownSecrets = [], fallback = "Ocurrió un error inesperado.") {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : err && typeof err === "object" && typeof (/** @type {any} */ (err).message) === "string"
          ? /** @type {any} */ (err).message
          : "";
  const safe = redactSensitiveTokens(raw, extraKnownSecrets).trim();
  return safe || fallback;
}

/**
 * Reinicia todo el estado de bloqueo y huellas rechazadas en memoria y almacenamiento
 * (útil para aislamiento entre suites de pruebas unitarias o cierre explícito).
 */
export function resetAuthSecurityState() {
  memoryLockoutFallback.clear();
  rejectedHashesByScope.clear();
  for (const getStore of getBrowserStorageGetters()) {
    try {
      const store = getStore();
      if (!store) continue;
      const keysToRemove = [];
      if (typeof store.length === "number" && typeof store.key === "function") {
        for (let i = 0; i < store.length; i += 1) {
          const k = store.key(i);
          if (k && k.startsWith(LOCKOUT_STORAGE_PREFIX)) {
            keysToRemove.push(k);
          }
        }
      } else {
        for (const k of Object.keys(store)) {
          if (k && k.startsWith(LOCKOUT_STORAGE_PREFIX)) {
            keysToRemove.push(k);
          }
        }
        if (store.map instanceof Map) {
          for (const k of store.map.keys()) {
            if (k && k.startsWith(LOCKOUT_STORAGE_PREFIX)) {
              keysToRemove.push(k);
            }
          }
        }
      }
      for (const k of keysToRemove) {
        try {
          store.removeItem(k);
        } catch {
          // Ignorar fallo individual de borrado
        }
      }
    } catch {
      // Ignorar entorno restringido por storage independiente
    }
  }
}
