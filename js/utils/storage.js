/**
 * Helpers tolerantes a errores para leer y persistir preferencias simples en localStorage.
 */

function getLocalStorageSafe() {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch (_) {
    return null;
  }
}

/**
 * Lee una preferencia booleana ("true" / "false") desde localStorage.
 * @param {string} key
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
export function readStoredBool(key, defaultValue) {
  const storage = getLocalStorageSafe();
  if (!storage) return defaultValue;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === "true";
  } catch (_) {
    return defaultValue;
  }
}

/**
 * Lee un string crudo desde localStorage, devolviendo `fallback` si no existe o falla.
 * @param {string} key
 * @param {string|null} [fallback=null]
 * @returns {string|null}
 */
export function readStoredValue(key, fallback = null) {
  const storage = getLocalStorageSafe();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    return raw === null ? fallback : raw;
  } catch (_) {
    return fallback;
  }
}

/**
 * Guarda un valor serializado como string en localStorage sin propagar excepciones de cuota.
 * @param {string} key
 * @param {*} value
 * @returns {boolean}
 */
export function saveStoredValue(key, value) {
  const storage = getLocalStorageSafe();
  if (!storage) return false;
  try {
    storage.setItem(key, String(value));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Elimina una clave de localStorage de forma segura.
 * @param {string} key
 * @returns {boolean}
 */
export function removeStoredValue(key) {
  const storage = getLocalStorageSafe();
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch (_) {
    return false;
  }
}
