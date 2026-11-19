/**
 * Núcleo de IndexedDB, validación de rutas, metadatos de archivos, canal BroadcastChannel y respaldo de credenciales.
 */

import { readStoredValue, saveStoredValue } from "../../utils/storage.js";

const DB_NAME = "studio_ide_db";
const DB_VERSION = 1;
export const STORE_PROJECTS = "projects";
export const STORE_FILES = "files";
const ACTIVE_PROJECT_KEY = "ide.workspace.activeProjectId";

export const SEED_PROJECT_ID = "espacio-local";
export const MAX_STORED_CHAT_TURNS = 40;
export const MAX_GIST_RESTORE_ENTRY_BYTES = 5 * 1024 * 1024;

const INVALID_PATH_CHARS = /[:*?"<>|\u0000-\u001f\u007f]/;
const INVALID_REMOTE_CONTROL_CHARS = /[\u0080-\u009f\u2028\u2029]/;
const FLAT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Solicita almacenamiento persistente al navegador (evita el borrado automático tras 7 días en Safari iPadOS).
 */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage && typeof navigator.storage.persist === "function") {
      await navigator.storage.persist();
    }
  } catch {
    // Entornos sin permiso explícito continúan operando con IndexedDB estándar
  }
}

/**
 * Infiere lenguaje de CodeMirror, etiqueta corta e icono Lucide a partir del nombre o ruta del archivo.
 * @param {string} path
 */
export function inferFileMeta(path) {
  const baseName = String(path || "").split("/").pop().toLowerCase();
  const ext = baseName.includes(".") ? baseName.split(".").pop() : "";

  switch (ext) {
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hh":
      return { lang: "cpp", badge: "C++", icon: "fileCode" };
    case "c":
    case "h":
      return { lang: "c", badge: "C", icon: "fileCode" };
    case "rs":
      return { lang: "rust", badge: "RS", icon: "fileCode" };
    case "go":
      return { lang: "go", badge: "GO", icon: "fileCode" };
    case "html":
    case "htm":
      return { lang: "html", badge: "HTML", icon: "fileText" };
    case "css":
      return { lang: "css", badge: "CSS", icon: "fileCode" };
    case "sql":
      return { lang: "sql", badge: "SQL", icon: "database" };
    case "py":
    case "pyw":
      return { lang: "python", badge: "PY", icon: "fileCode" };
    case "md":
    case "markdown":
      return { lang: "markdown", badge: "MD", icon: "fileText" };
    case "java":
      return { lang: "java", badge: "JAVA", icon: "fileCode" };
    case "cs":
      return { lang: "csharp", badge: "C#", icon: "fileCode" };
    case "ts":
      return { lang: "ts", badge: "TS", icon: "fileCode" };
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
    case "tsx":
      return { lang: "js", badge: ext.toUpperCase(), icon: "fileCode" };
    case "json":
      return { lang: "json", badge: "JSON", icon: "fileCode" };
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "avif":
    case "ico":
    case "bmp":
      return { lang: "image", badge: ext.slice(0, 4).toUpperCase(), icon: "image" };
    default:
      return { lang: "text", badge: ext ? ext.slice(0, 4).toUpperCase() : "TXT", icon: "fileText" };
  }
}

/**
 * Normaliza una ruta del proyecto: barras unificadas, sin barras al inicio/fin
 * y con los segmentos "." y ".." resueltos (nunca sale de la raíz del proyecto).
 */
export function normalizePath(rawPath) {
  const unified = String(rawPath || "")
    .trim()
    .replace(/\\/g, "/");
  const stack = [];
  for (const segment of unified.split("/")) {
    const part = segment.trim();
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

/**
 * Valida una ruta escrita por el usuario (crear, renombrar, importar).
 * Devuelve la ruta normalizada o lanza un Error con un mensaje claro en español.
 */
export function validateUserPath(rawPath) {
  const rawStr = String(rawPath || "");
  const rawBadChar = rawStr.match(INVALID_PATH_CHARS);
  if (rawBadChar) {
    const code = rawBadChar[0].charCodeAt(0);
    const shown = code < 32 || code === 127 ? "caracteres de control" : `"${rawBadChar[0]}"`;
    throw new Error(`El nombre no puede contener ${shown}. Evitá : * ? " < > |`);
  }

  const raw = rawStr.trim();
  if (!raw) {
    throw new Error("Escribí un nombre válido.");
  }
  if (raw.includes("::") || /[/\\]{2,}/.test(raw)) {
    throw new Error('El nombre no puede contener barras consecutivas "//" ni "::".');
  }
  const rawSegments = raw.split(/[/\\]/);
  for (const seg of rawSegments) {
    const trimmedSeg = seg.trim();
    if (seg !== "" && !trimmedSeg) {
      throw new Error("El nombre no puede contener carpetas o segmentos vacíos.");
    }
    if (trimmedSeg === "." || trimmedSeg === "..") {
      throw new Error('El nombre no puede contener referencias relativas "." o "..".');
    }
    if (trimmedSeg === "__proto__" || trimmedSeg === "constructor" || trimmedSeg === "prototype") {
      throw new Error(`El nombre reservado "${trimmedSeg}" no está permitido.`);
    }
    if (seg.length > 255) {
      throw new Error("El nombre de archivo o carpeta no puede superar los 255 caracteres.");
    }
  }

  const clean = normalizePath(raw);
  if (!clean) {
    throw new Error("Escribí un nombre válido.");
  }
  const badChar = clean.match(INVALID_PATH_CHARS);
  if (badChar) {
    const code = badChar[0].charCodeAt(0);
    const shown = code < 32 || code === 127 ? "caracteres de control" : `"${badChar[0]}"`;
    throw new Error(`El nombre no puede contener ${shown}. Evitá : * ? " < > |`);
  }
  return clean;
}

const FORBIDDEN_REMOTE_SEGMENTS = new Set(["..", ".", "__proto__", "constructor", "prototype"]);

/**
 * Sanea una ruta entrante proveniente de APIs remotas (GitHub Trees/Compare/Gists),
 * rechazando traversal `..`, nombres reservados de prototipo y caracteres de control o inválidos.
 * @param {string} rawPath
 * @returns {string}
 */
export function sanitizeRemoteRepoPath(rawPath) {
  if (typeof rawPath !== "string") return "";
  const raw = rawPath.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (
    !raw ||
    raw.includes("::") ||
    /^[A-Za-z]:\//.test(raw) ||
    INVALID_PATH_CHARS.test(raw) ||
    INVALID_REMOTE_CONTROL_CHARS.test(raw)
  ) {
    return "";
  }
  const segs = raw.split("/");
  if (segs.some((s) => !s || s.trim() !== s || FORBIDDEN_REMOTE_SEGMENTS.has(s) || s.length > 255)) {
    return "";
  }
  return segs.join("/");
}

export function makeFileKey(projectId, path) {
  return `${projectId}::${path}`;
}

let dbPromise = null;

function openDb() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const idb = typeof indexedDB !== "undefined" ? indexedDB : (typeof window !== "undefined" ? window.indexedDB : null);
    if (!idb) {
      dbPromise = null;
      return reject(new Error("IndexedDB no está disponible en este entorno."));
    }
    const req = idb.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        const fileStore = db.createObjectStore(STORE_FILES, { keyPath: "key" });
        fileStore.createIndex("byProject", "projectId", { unique: false });
      }
    };

    let blockTimer = null;
    let timedOut = false;
    const clearBlockTimer = () => {
      if (blockTimer !== null) {
        clearTimeout(blockTimer);
        blockTimer = null;
      }
    };

    req.onblocked = () => {
      if (blockTimer !== null || timedOut) return;
      blockTimer = setTimeout(() => {
        timedOut = true;
        blockTimer = null;
        dbPromise = null;
        reject(new Error("IndexedDB bloqueada por otra pestaña abierta. Cerrá las demás pestañas o recargá la página."));
      }, 5000);
    };

    req.onsuccess = () => {
      clearBlockTimer();
      const db = req.result;
      if (timedOut) {
        try { db.close(); } catch (_) {}
        return;
      }
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        try { db.close(); } catch (_) {}
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      clearBlockTimer();
      if (timedOut) return;
      dbPromise = null;
      reject(req.error || new Error("No se pudo abrir IndexedDB."));
    };
  });

  return dbPromise;
}

export function getSavedActiveProjectId() {
  return readStoredValue(ACTIVE_PROJECT_KEY, SEED_PROJECT_ID) || SEED_PROJECT_ID;
}

export function setSavedActiveProjectId(projectId) {
  saveStoredValue(ACTIVE_PROJECT_KEY, projectId);
}

let syncChannel = null;
function getSyncChannel() {
  if (!syncChannel && typeof BroadcastChannel !== "undefined") {
    try {
      syncChannel = new BroadcastChannel("studio_ide_workspace_sync");
      syncChannel.unref?.();
    } catch (_) {}
  }
  return syncChannel;
}

export function closeWorkspaceBroadcast() {
  if (syncChannel) {
    try {
      syncChannel.close();
    } catch (_) {}
    syncChannel = null;
  }
}

export function broadcastWorkspaceChange(event) {
  const channel = getSyncChannel();
  if (channel && event) {
    try {
      channel.postMessage(event);
    } catch (_) {}
  }
}

export function onWorkspaceBroadcast(listener) {
  const channel = getSyncChannel();
  if (!channel || typeof listener !== "function") return () => {};
  const handler = (ev) => {
    if (ev && ev.data) {
      listener(ev.data);
    }
  };
  channel.addEventListener("message", handler);
  return () => {
    try {
      channel.removeEventListener("message", handler);
    } catch (_) {}
  };
}

export function resolveEntryBaselineBase64(entry) {
  if (!entry) return null;
  if (Object.prototype.hasOwnProperty.call(entry, "baseBase64")) {
    return entry.baseBase64 ?? null;
  }
  return entry.trackedInGithub && entry.isBinary ? (entry.base64 ?? null) : null;
}

export function resolveTxError(ev, tx, fallbackMsg = "Error en transacción de IndexedDB.") {
  return tx?.error || ev?.target?.error || new Error(fallbackMsg);
}

/**
 * Abre una transacción de IndexedDB y ejecuta `setupFn(tx)` sincrónicamente en el mismo turno
 * (evitando auto-commit en Safari/WebKit). Si la conexión en caché se cerró (`InvalidStateError`),
 * reabre la base y reintenta una vez automáticamente.
 * @template T
 * @param {string|string[]} stores
 * @param {"readonly"|"readwrite"} mode
 * @param {(tx: IDBTransaction) => Promise<T>|T} setupFn
 * @returns {Promise<T>}
 */
export async function openDbTransaction(stores, mode, setupFn) {
  let db = await openDb();
  let tx;
  try {
    tx = db.transaction(stores, mode);
  } catch (err) {
    if (err && (err.name === "InvalidStateError" || /closing|closed/i.test(String(err.message || "")))) {
      dbPromise = null;
      db = await openDb();
      tx = db.transaction(stores, mode);
    } else {
      throw err;
    }
  }
  return setupFn(tx);
}

export function getRecord(storeName, key) {
  return openDbTransaction(
    storeName,
    "readonly",
    (tx) =>
      new Promise((resolve, reject) => {
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (ev) => reject(resolveTxError(ev, tx, "Error leyendo registro en IndexedDB."));
        tx.onerror = (ev) => reject(resolveTxError(ev, tx, "La transacción getRecord falló."));
        tx.onabort = (ev) => reject(resolveTxError(ev, tx, "La transacción getRecord se canceló."));
      })
  );
}

export function putRecord(storeName, value) {
  return openDbTransaction(
    storeName,
    "readwrite",
    (tx) =>
      new Promise((resolve, reject) => {
        tx.objectStore(storeName).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = (ev) => reject(resolveTxError(ev, tx, "La transacción putRecord falló."));
        tx.onabort = (ev) => reject(resolveTxError(ev, tx, "La transacción putRecord se canceló."));
      })
  );
}

function deleteRecord(storeName, key) {
  return openDbTransaction(
    storeName,
    "readwrite",
    (tx) =>
      new Promise((resolve, reject) => {
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = (ev) => reject(resolveTxError(ev, tx, "La transacción deleteRecord falló."));
        tx.onabort = (ev) => reject(resolveTxError(ev, tx, "La transacción deleteRecord se canceló."));
      })
  );
}

export function isValidBase64String(raw) {
  if (typeof raw !== "string") return false;
  const compact = raw.replace(/\s+/g, "");
  if (compact.length % 4 !== 0) return false;
  if (compact.length === 0) return true;
  return FLAT_BASE64_RE.test(compact);
}

/**
 * Guarda un respaldo persistente de las credenciales (claves IA y token GitHub) en IndexedDB
 * para protegerlas si Safari / iPadOS vacía el localStorage durante recargas o suspensión de memoria.
 * @param {string} rawJson
 */
export async function saveCredentialsBackup(rawJson) {
  try {
    const key = makeFileKey("__system__", "credentials");
    if (!rawJson) {
      await deleteRecord(STORE_FILES, key);
      return;
    }
    await putRecord(STORE_FILES, {
      key,
      projectId: "__system__",
      path: "credentials",
      isFolder: false,
      content: rawJson,
      baseContent: "",
      deleted: false,
      updatedAt: Date.now()
    });
  } catch {
    // Entorno restringido o sin soporte
  }
}

/**
 * Lee el respaldo persistente de credenciales desde IndexedDB.
 * @returns {Promise<string>}
 */
export async function readCredentialsBackup() {
  try {
    const key = makeFileKey("__system__", "credentials");
    const record = await getRecord(STORE_FILES, key);
    return record && typeof record.content === "string" ? record.content : "";
  } catch {
    return "";
  }
}
