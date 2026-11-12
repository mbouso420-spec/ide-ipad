import { sanitizeErrorCause } from "../security/credentialGuard.js";

/**
 * Traduce los errores de red crudos del navegador ("Failed to fetch" en Chrome, "Load failed" en Safari,
 * "NetworkError when attempting to fetch resource." en Firefox) a un mensaje claro en español.
 * Los errores de la API (401, 404, límites, etc.) y las cancelaciones del usuario no se tocan.
 */
const NETWORK_MESSAGE_RE =
  /failed to fetch|load failed|networkerror|network request failed|network error|fetch failed|err_internet|err_network|the internet connection appears to be offline/i;

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNetworkFailure(error) {
  if (!error) return false;
  const name = /** @type {any} */ (error).name;
  if (name === "AbortError") return false;
  const message = String(/** @type {any} */ (error).message || "");
  const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (
    error instanceof TypeError &&
    (NETWORK_MESSAGE_RE.test(message) || (message.trim() === "" && isOffline))
  ) {
    return true;
  }
  return NETWORK_MESSAGE_RE.test(message) && !(/** @type {any} */ (error).httpStatus);
}

/**
 * @param {unknown} error
 * @param {string} serviceLabel p. ej. "GitHub" o "Google Gemini"
 * @returns {unknown} un Error en español si fue un fallo de red; si no, el error original
 */
export function toFriendlyNetworkError(error, serviceLabel) {
  if (!isNetworkFailure(error)) {
    return error;
  }
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const friendly = new Error(
    offline
      ? `Estás sin conexión a internet: no se pudo contactar a ${serviceLabel}. Conectate y volvé a intentar.`
      : `Sin conexión con ${serviceLabel}. Revisá tu internet e intentá de nuevo.`
  );
  /** @type {any} */ (friendly).cause = sanitizeErrorCause(error);
  /** @type {any} */ (friendly).isNetworkFailure = true;
  return friendly;
}
