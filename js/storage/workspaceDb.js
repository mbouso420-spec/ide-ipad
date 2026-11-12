import { slugifyName } from "../utils/encoding.js";

const DB_NAME = "studio_ide_db";
const DB_VERSION = 1;
const STORE_PROJECTS = "projects";
const STORE_FILES = "files";
const ACTIVE_PROJECT_KEY = "ide.workspace.activeProjectId";

const SEED_PROJECT_ID = "espacio-local";
const MAX_STORED_CHAT_TURNS = 40;
const MAX_GIST_RESTORE_ENTRY_BYTES = 5 * 1024 * 1024;

const SEED_ENTRIES = [
  {
    path: "src/main.cpp",
    content: `#include <iostream>\n#include <vector>\n\nstd::size_t calcularBuffer(std::size_t bloques) {\n    return bloques * 1024ULL;\n}\n\nint main() {\n    std::vector<int> datos = {4, 8, 16, 32};\n    std::cout << "Buffer listo: " << calcularBuffer(datos.size()) << "\\n";\n    return 0;\n}\n`
  },
  {
    path: "web/index.html",
    content: `<!DOCTYPE html>\n<html lang="es">\n<head>\n  <meta charset="UTF-8" />\n  <title>Demo App</title>\n  <link rel="stylesheet" href="./styles.css" />\n</head>\n<body>\n  <main class="contenedor">\n    <h1>Hola desde el iPad</h1>\n    <p id="salida">Probando vista previa en vivo.</p>\n  </main>\n  <script src="./app.js"></script>\n</body>\n</html>\n`
  },
  {
    path: "web/styles.css",
    content: `:root {\n  --acento: oklch(52% 0.165 252);\n}\n\nbody {\n  font-family: system-ui, sans-serif;\n  margin: 0;\n  background: #11151d;\n  color: #eef2f8;\n}\n\n.contenedor {\n  max-width: 960px;\n  margin-inline: auto;\n  padding: 24px;\n}\n`
  },
  {
    path: "web/app.js",
    content: `const saludar = (nombre) => {\n  return \`Bienvenido al proyecto, \${nombre}\`;\n};\n\nconsole.log(saludar("Dev"));\n`
  },
  {
    path: "scripts/ejemplo.py",
    content: `def resumen_notas(notas):\n    promedio = sum(notas) / len(notas)\n    return round(promedio, 2)\n\nvalores = [8, 9, 10, 7, 9]\nprint("Notas:", valores)\nprint("Promedio final:", resumen_notas(valores))\n`
  },
  {
    path: "db/schema.sql",
    content: `CREATE TABLE proyectos (\n    id INTEGER PRIMARY KEY,\n    nombre TEXT NOT NULL,\n    actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n\nSELECT id, nombre\nFROM proyectos\nWHERE id = 1;\n`
  }
];

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

const INVALID_PATH_CHARS = /[:*?"<>|\u0000-\u001f\u007f]/;

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
  if (raw.includes("//") || raw.includes("\\\\")) {
    throw new Error('El nombre no puede contener barras consecutivas "//".');
  }
  const rawSegments = raw.split(/[/\\]/);
  for (const seg of rawSegments) {
    const trimmedSeg = seg.trim();
    if (trimmedSeg === "." || trimmedSeg === "..") {
      throw new Error('El nombre no puede contener referencias relativas "." o "..".');
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

function makeFileKey(projectId, path) {
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
        // Si la apertura completó después del timeout de onblocked, cerrar la conexión huérfana.
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

/**
 * Inicializa la base de datos y crea el proyecto semilla en la primera apertura.
 */
export async function ensureInitialWorkspace() {
  const db = await openDb();
  const now = Date.now();
  const seedProject = {
    id: SEED_PROJECT_ID,
    name: "espacio-local",
    kind: "local",
    github: null,
    openTabIds: ["src/main.cpp", "web/index.html", "db/schema.sql"],
    activeFileId: "src/main.cpp",
    chatHistory: [],
    updatedAt: now
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_FILES], "readwrite");
    const projectsStore = tx.objectStore(STORE_PROJECTS);
    const filesStore = tx.objectStore(STORE_FILES);
    let resultProjects = null;

    const listReq = projectsStore.getAll();
    listReq.onsuccess = () => {
      const existing = (listReq.result || []).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      if (existing.length > 0) {
        resultProjects = existing;
        return;
      }

      projectsStore.put(seedProject);
      const folders = ["src", "web", "scripts", "db"];
      for (const folderPath of folders) {
        filesStore.put({
          key: makeFileKey(SEED_PROJECT_ID, folderPath),
          projectId: SEED_PROJECT_ID,
          path: folderPath,
          isFolder: true,
          content: "",
          baseContent: "",
          deleted: false,
          updatedAt: now
        });
      }

      for (const item of SEED_ENTRIES) {
        filesStore.put({
          key: makeFileKey(SEED_PROJECT_ID, item.path),
          projectId: SEED_PROJECT_ID,
          path: item.path,
          isFolder: false,
          content: item.content,
          baseContent: item.content,
          deleted: false,
          updatedAt: now
        });
      }
      resultProjects = [seedProject];
    };
    listReq.onerror = () => reject(listReq.error);
    tx.oncomplete = () => resolve(resultProjects || [seedProject]);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción inicial de IndexedDB se canceló."));
  });
}

export function getSavedActiveProjectId() {
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_KEY) || SEED_PROJECT_ID;
  } catch {
    return SEED_PROJECT_ID;
  }
}

export function setSavedActiveProjectId(projectId) {
  try {
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
  } catch {
    // Ignorar
  }
}

export async function listProjects() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, "readonly");
    const req = tx.objectStore(STORE_PROJECTS).getAll();
    req.onsuccess = () => {
      const list = Array.isArray(req.result) ? req.result : [];
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getProject(projectId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, "readonly");
    const req = tx.objectStore(STORE_PROJECTS).get(projectId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function createLocalProject(name) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName || /[\x00-\x1f\x7f]/.test(cleanName)) {
    throw new Error("El nombre del proyecto no puede estar vacío ni contener caracteres de control.");
  }
  const slug = slugifyName(cleanName, { allowDots: false, collapse: true, fallback: "proyecto" });
  const id = `${slug}-${Date.now().toString(36)}`;
  const now = Date.now();
  const escapedCppName = cleanName
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");

  const project = {
    id,
    name: cleanName,
    kind: "local",
    github: null,
    openTabIds: ["main.cpp"],
    activeFileId: "main.cpp",
    chatHistory: [],
    updatedAt: now
  };

  const initialFile = {
    key: makeFileKey(id, "main.cpp"),
    projectId: id,
    path: "main.cpp",
    isFolder: false,
    content: `#include <iostream>\n\nint main() {\n    std::cout << "Proyecto ${escapedCppName}\\n";\n    return 0;\n}\n`,
    baseContent: "",
    deleted: false,
    updatedAt: now
  };

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_FILES], "readwrite");
    tx.objectStore(STORE_PROJECTS).put(project);
    tx.objectStore(STORE_FILES).put(initialFile);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("No se pudo crear el proyecto."));
  });

  return project;
}

export async function saveProjectState(project) {
  project.updatedAt = Date.now();
  await putRecord(STORE_PROJECTS, project);
}

/**
 * Guarda el historial reciente de conversación del asistente IA asociado al proyecto activo.
 */
export async function saveProjectChatHistory(projectId, history) {
  const project = await getProject(projectId);
  if (!project) return;
  const sanitized = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .slice(-MAX_STORED_CHAT_TURNS)
        .map((m) => ({ role: m.role, content: m.content }))
    : [];
  project.chatHistory = sanitized;
  await putRecord(STORE_PROJECTS, project);
}

export async function deleteProject(projectId) {
  const entries = await getAllRawProjectEntries(projectId);
  const db = await openDb();

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_FILES], "readwrite");
    tx.objectStore(STORE_PROJECTS).delete(projectId);
    const fileStore = tx.objectStore(STORE_FILES);
    for (const entry of entries) {
      fileStore.delete(entry.key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getProjectEntries(projectId) {
  const all = await getAllRawProjectEntries(projectId);
  return all.filter((e) => !e.deleted);
}

export async function getAllRawProjectEntries(projectId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readonly");
    const idx = tx.objectStore(STORE_FILES).index("byProject");
    const req = idx.getAll(projectId);
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error);
  });
}

export async function entryExists(projectId, rawPath) {
  const cleanPath = normalizePath(rawPath);
  if (!cleanPath) return false;
  const record = await getRecord(STORE_FILES, makeFileKey(projectId, cleanPath));
  return Boolean(record && !record.deleted);
}

export async function getEntryRecord(projectId, rawPath) {
  const cleanPath = normalizePath(rawPath);
  if (!cleanPath) return null;
  const record = await getRecord(STORE_FILES, makeFileKey(projectId, cleanPath));
  return record && !record.deleted ? record : null;
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

function resolveEntryBaselineBase64(entry) {
  if (!entry) return null;
  if (Object.prototype.hasOwnProperty.call(entry, "baseBase64")) {
    return entry.baseBase64 ?? null;
  }
  return entry.trackedInGithub && entry.isBinary ? (entry.base64 ?? null) : null;
}

export async function upsertEntry(
  projectId,
  path,
  {
    isFolder = false,
    content = "",
    baseContent = null,
    fromGithub = false,
    allowOverwrite = true,
    blobSha = null,
    contentLoaded = true,
    mode = null,
    isBinary = false,
    base64 = null,
    baseBase64 = undefined,
    skipIfDeleted = false,
    silent = false
  } = {}
) {
  const cleanPath = normalizePath(path);
  if (!cleanPath) {
    throw new Error("La ruta no puede estar vacía.");
  }

  const key = makeFileKey(projectId, cleanPath);
  const parts = cleanPath.split("/");
  const db = await openDb();
  let writtenRecord = null;
  let skippedDeleted = false;
  let txErr = null;

  // Todas las validaciones, creación de carpetas padre y escritura final ocurren en una única transacción readwrite (evita TOCTOU).
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    const store = tx.objectStore(STORE_FILES);
    const abortWith = (message) => {
      txErr = new Error(message);
      tx.abort();
    };

    const writeTarget = (latestExisting) => {
      const resolvedBase =
        baseContent !== null
          ? baseContent
          : fromGithub
            ? content
            : latestExisting && typeof latestExisting.baseContent === "string"
              ? latestExisting.baseContent
              : "";

      const recreatedOverUnloaded = Boolean(
        !isFolder &&
          !fromGithub &&
          latestExisting &&
          latestExisting.trackedInGithub &&
          latestExisting.contentLoaded === false
      );

      const resolvedIsBinary = !isFolder && Boolean(isBinary);
      const resolvedBase64 = resolvedIsBinary
        ? (base64 ?? (latestExisting && !latestExisting.deleted ? latestExisting.base64 : null) ?? null)
        : null;
      const resolvedBaseBase64 = isFolder
        ? null
        : baseBase64 !== undefined
          ? baseBase64
          : fromGithub
            ? (resolvedIsBinary ? resolvedBase64 : null)
            : resolveEntryBaselineBase64(latestExisting);

      writtenRecord = {
        key,
        projectId,
        path: cleanPath,
        isFolder,
        content: isFolder ? "" : content,
        baseContent: isFolder ? "" : resolvedBase,
        blobSha: isFolder ? null : blobSha ?? latestExisting?.blobSha ?? null,
        mode: isFolder ? null : mode ?? latestExisting?.mode ?? null,
        contentLoaded: isFolder ? true : Boolean(contentLoaded),
        trackedInGithub: Boolean(fromGithub || latestExisting?.trackedInGithub),
        forceModified: recreatedOverUnloaded || Boolean(!fromGithub && latestExisting?.forceModified),
        isBinary: resolvedIsBinary,
        base64: resolvedBase64,
        baseBase64: resolvedBaseBase64,
        deleted: false,
        updatedAt: Date.now()
      };
      store.put(writtenRecord);
    };

    const ensureParentAt = (idx, prefixAcc, latestExisting) => {
      if (idx >= parts.length - 1) {
        writeTarget(latestExisting);
        return;
      }
      const nextPrefix = prefixAcc ? `${prefixAcc}/${parts[idx]}` : parts[idx];
      const folderKey = makeFileKey(projectId, nextPrefix);
      const fReq = store.get(folderKey);
      fReq.onsuccess = () => {
        const existingFolder = fReq.result || null;
        if (existingFolder && !existingFolder.deleted && !existingFolder.isFolder) {
          abortWith(`No se puede crear dentro de "${nextPrefix}" porque es un archivo.`);
          return;
        }
        if (!existingFolder || existingFolder.deleted) {
          store.put({
            key: folderKey,
            projectId,
            path: nextPrefix,
            isFolder: true,
            content: "",
            baseContent: "",
            contentLoaded: true,
            deleted: false,
            updatedAt: Date.now()
          });
        }
        ensureParentAt(idx + 1, nextPrefix, latestExisting);
      };
      fReq.onerror = () => reject(fReq.error);
    };

    const req = store.get(key);
    req.onsuccess = () => {
      const latestExisting = req.result || null;
      if (skipIfDeleted && latestExisting?.deleted) {
        writtenRecord = latestExisting;
        skippedDeleted = true;
        return;
      }
      if (!allowOverwrite && latestExisting && !latestExisting.deleted) {
        abortWith(`Ya existe "${cleanPath}" en este proyecto.`);
        return;
      }
      if (latestExisting && !latestExisting.deleted && Boolean(latestExisting.isFolder) !== Boolean(isFolder)) {
        abortWith(
          latestExisting.isFolder
            ? `Ya existe una carpeta llamada "${cleanPath}" en este proyecto.`
            : `Ya existe un archivo llamado "${cleanPath}" en este proyecto.`
        );
        return;
      }

      if (!isFolder) {
        const prefixKey = makeFileKey(projectId, `${cleanPath}/`);
        const cursorReq = store.openCursor(IDBKeyRange.bound(prefixKey, `${prefixKey}\uffff`, false, true));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) {
            ensureParentAt(0, "", latestExisting);
            return;
          }
          if (!cursor.value?.deleted) {
            abortWith(`Ya existe una carpeta llamada "${cleanPath}" con contenido adentro.`);
            return;
          }
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
        return;
      }

      ensureParentAt(0, "", latestExisting);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(txErr || tx.error);
    tx.onabort = () => reject(txErr || tx.error || new Error("La transacción de guardado se canceló."));
  });

  if (!silent && !skippedDeleted) {
    broadcastWorkspaceChange({ type: "ENTRY_UPSERTED", projectId, path: cleanPath, isFolder });
  }
  return writtenRecord;
}

export async function updateFileContent(projectId, path, newContent) {
  const cleanPath = normalizePath(path);
  if (!cleanPath) {
    throw new Error("La ruta no puede estar vacía.");
  }
  const key = makeFileKey(projectId, cleanPath);
  const db = await openDb();
  let updatedRecord = null;
  let needsUpsert = false;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    const store = tx.objectStore(STORE_FILES);
    const req = store.get(key);
    req.onsuccess = () => {
      const existing = req.result;
      if (!existing) {
        if (!cleanPath.includes("/")) {
          updatedRecord = {
            key,
            projectId,
            path: cleanPath,
            isFolder: false,
            content: newContent,
            baseContent: "",
            blobSha: null,
            mode: null,
            contentLoaded: true,
            trackedInGithub: false,
            forceModified: false,
            isBinary: false,
            base64: null,
            baseBase64: null,
            deleted: false,
            updatedAt: Date.now()
          };
          store.put(updatedRecord);
          return;
        }
        needsUpsert = true;
        return;
      }
      if (existing.deleted || existing.isFolder) {
        updatedRecord = existing;
        return;
      }
      existing.content = newContent;
      existing.contentLoaded = true;
      existing.deleted = false;
      existing.updatedAt = Date.now();
      updatedRecord = existing;
      store.put(existing);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción de guardado se canceló."));
  });

  if (needsUpsert) {
    return upsertEntry(projectId, cleanPath, {
      isFolder: false,
      content: newContent,
      skipIfDeleted: true
    });
  }
  if (updatedRecord && !updatedRecord.deleted && !updatedRecord.isFolder) {
    broadcastWorkspaceChange({ type: "FILE_UPDATED", projectId, path: cleanPath });
  }
  return updatedRecord;
}

export async function renameProjectEntry(projectId, oldPath, newPath, isFolder) {
  const fromPath = normalizePath(oldPath);
  const toPath = normalizePath(newPath);
  if (!fromPath || !toPath || fromPath === toPath) {
    return;
  }

  if (isFolder && toPath.startsWith(`${fromPath}/`)) {
    throw new Error("No se puede mover una carpeta dentro de sí misma.");
  }

  const db = await openDb();
  let didRename = false;
  let txErr = null;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    const store = tx.objectStore(STORE_FILES);
    const abortWith = (message) => {
      txErr = new Error(message);
      tx.abort();
    };

    const req = store.index("byProject").getAll(projectId);
    req.onsuccess = () => {
      const all = Array.isArray(req.result) ? req.result : [];
      const targetConflict = all.find(
        (e) =>
          !e.deleted &&
          e.path !== fromPath &&
          !(isFolder && e.path.startsWith(`${fromPath}/`)) &&
          (e.path === toPath || e.path.startsWith(`${toPath}/`) || (!e.isFolder && toPath.startsWith(`${e.path}/`)))
      );
      if (targetConflict) {
        abortWith(`Ya existe "${targetConflict.path}" en esa ubicación.`);
        return;
      }

      const rawByPath = new Map(all.map((e) => [e.path, e]));
      const affected = all.filter(
        (e) => !e.deleted && (e.path === fromPath || (isFolder && e.path.startsWith(`${fromPath}/`)))
      );

      if (affected.length === 0) {
        return;
      }

      // Validar colisiones con ancestros archivo dentro de la misma transacción.
      for (const item of affected) {
        const suffix = item.path.slice(fromPath.length);
        const targetPath = `${toPath}${suffix}`;
        const parts = targetPath.split("/");
        if (parts.length > 1) {
          let prefix = "";
          for (let i = 0; i < parts.length - 1; i += 1) {
            prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
            const existingFolder = rawByPath.get(prefix);
            if (existingFolder && !existingFolder.deleted && !existingFolder.isFolder) {
              abortWith(`No se puede crear dentro de "${prefix}" porque es un archivo.`);
              return;
            }
          }
        }
      }

      didRename = true;
      const now = Date.now();
      const ensuredFolders = new Set();

      for (const item of affected) {
        const suffix = item.path.slice(fromPath.length);
        const targetPath = `${toPath}${suffix}`;
        const parts = targetPath.split("/");
        if (parts.length > 1) {
          let prefix = "";
          for (let i = 0; i < parts.length - 1; i += 1) {
            prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
            if (ensuredFolders.has(prefix)) continue;
            const existingFolder = rawByPath.get(prefix);
            if (!existingFolder || existingFolder.deleted) {
              const folderKey = makeFileKey(projectId, prefix);
              store.put({
                key: folderKey,
                projectId,
                path: prefix,
                isFolder: true,
                content: "",
                baseContent: "",
                contentLoaded: true,
                deleted: false,
                updatedAt: now
              });
            }
            ensuredFolders.add(prefix);
          }
        }

        const prevTarget = rawByPath.get(targetPath);
        const preserveTargetBase =
          prevTarget && prevTarget.trackedInGithub ? prevTarget.baseContent : item.trackedInGithub ? "" : item.baseContent;
        const preserveTargetBaseBase64 =
          !item.isFolder && prevTarget && prevTarget.trackedInGithub
            ? resolveEntryBaselineBase64(prevTarget)
            : null;
        const recreatedOverUnloaded = Boolean(
          !item.isFolder && prevTarget && prevTarget.trackedInGithub && prevTarget.contentLoaded === false
        );
        const targetKey = makeFileKey(projectId, targetPath);
        const targetIsBinary = !item.isFolder && Boolean(item.isBinary);
        const targetBase64 = targetIsBinary ? (item.base64 ?? null) : null;

        store.put({
          key: targetKey,
          projectId,
          path: targetPath,
          isFolder: item.isFolder,
          content: item.isFolder ? "" : item.content,
          baseContent: item.isFolder ? "" : preserveTargetBase,
          blobSha: item.isFolder ? null : prevTarget?.blobSha ?? null,
          mode: item.isFolder ? null : item.mode ?? prevTarget?.mode ?? null,
          contentLoaded: item.isFolder ? true : Boolean(item.contentLoaded ?? true),
          trackedInGithub: Boolean(prevTarget?.trackedInGithub),
          forceModified: recreatedOverUnloaded || Boolean(prevTarget?.forceModified),
          isBinary: targetIsBinary,
          base64: targetBase64,
          baseBase64: preserveTargetBaseBase64,
          deleted: false,
          updatedAt: now
        });

        if (item.trackedInGithub && !item.isFolder) {
          item.deleted = true;
          item.content = "";
          item.base64 = null;
          item.updatedAt = now;
          store.put(item);
        } else {
          store.delete(item.key);
        }
      }
    };

    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(txErr || tx.error);
    tx.onabort = () => reject(txErr || tx.error || new Error("La transacción de renombrado se canceló."));
  });

  if (didRename) {
    broadcastWorkspaceChange({ type: "ENTRY_RENAMED", projectId, oldPath: fromPath, newPath: toPath, isFolder });
  }
}

export async function deleteProjectEntry(projectId, targetPath, isFolder) {
  const cleanPath = normalizePath(targetPath);
  if (!cleanPath) return;

  const db = await openDb();
  let deletedAny = false;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    const store = tx.objectStore(STORE_FILES);
    const idx = store.index("byProject");
    const req = idx.getAll(projectId);
    req.onsuccess = () => {
      const all = Array.isArray(req.result) ? req.result : [];
      const affected = all.filter(
        (e) => !e.deleted && (e.path === cleanPath || (isFolder && e.path.startsWith(`${cleanPath}/`)))
      );
      if (affected.length === 0) return;

      deletedAny = true;
      const now = Date.now();
      for (const item of affected) {
        if (!item.isFolder) {
          item.deleted = true;
          item.content = "";
          item.base64 = null;
          item.updatedAt = now;
          store.put(item);
        } else {
          store.delete(item.key);
        }
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción de borrado se canceló."));
  });

  if (deletedAny) {
    broadcastWorkspaceChange({ type: "ENTRY_DELETED", projectId, path: cleanPath, isFolder });
  }
}

export function makeGithubProjectId(owner, repo, branch) {
  return `gh-${owner}-${repo}-${branch}`.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

/**
 * Reemplaza TODAS las entradas de un proyecto en una única transacción de IndexedDB
 * (atómica: si algo falla no queda el proyecto a medio borrar) y en O(n) en lugar de O(n²).
 * @param {string} projectId
 * @param {Array<{path: string, content: string, baseContent: string, blobSha: string|null, contentLoaded: boolean, mode?: string|null}>} files
 */
async function replaceAllProjectFilesFromGithub(projectId, files) {
  const oldEntries = await getAllRawProjectEntries(projectId);
  const now = Date.now();
  const records = new Map();

  for (const file of files) {
    const cleanPath = normalizePath(file.path);
    if (!cleanPath) continue;
    const parts = cleanPath.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      if (!records.has(prefix)) {
        records.set(prefix, {
          key: makeFileKey(projectId, prefix),
          projectId,
          path: prefix,
          isFolder: true,
          content: "",
          baseContent: "",
          contentLoaded: true,
          deleted: false,
          updatedAt: now
        });
      }
    }
    const fileIsBinary = Boolean(file.isBinary);
    const fileLoaded = Boolean(file.contentLoaded);
    const fileBase64 = fileIsBinary ? (file.base64 ?? null) : null;
    const fileBaseBase64 = fileIsBinary
      ? (file.baseBase64 !== undefined ? file.baseBase64 : (fileLoaded ? fileBase64 : null))
      : null;
    records.set(cleanPath, {
      key: makeFileKey(projectId, cleanPath),
      projectId,
      path: cleanPath,
      isFolder: false,
      content: fileIsBinary ? "" : file.content,
      baseContent: fileIsBinary ? "" : file.baseContent,
      blobSha: file.blobSha || null,
      mode: file.mode || null,
      contentLoaded: fileLoaded,
      trackedInGithub: true,
      forceModified: false,
      isBinary: fileIsBinary,
      base64: fileBase64,
      baseBase64: fileBaseBase64,
      deleted: false,
      updatedAt: now
    });
  }

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    const store = tx.objectStore(STORE_FILES);
    for (const old of oldEntries) {
      store.delete(old.key);
    }
    for (const record of records.values()) {
      store.put(record);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción de IndexedDB se canceló."));
  });
}

/**
 * Hidrata el árbol de carpetas y archivos de un repositorio de GitHub bajo demanda (sin descargar los archivos),
 * conservando en caché los archivos que ya hubieran sido abiertos antes si su SHA remoto no cambió.
 */
export async function hydrateLazyGithubProject({ owner, repo, branch, commitSha, entries }) {
  const projectId = makeGithubProjectId(owner, repo, branch);
  const existingProject = await getProject(projectId);

  const oldEntries = await getAllRawProjectEntries(projectId);
  const reusableByPath = new Map();
  for (const old of oldEntries) {
    if (!old.isFolder && !old.deleted && old.contentLoaded !== false && old.blobSha) {
      reusableByPath.set(old.path, old);
    }
  }

  let allLoaded = true;
  const files = entries.map((item) => {
    const clean = normalizePath(item.path);
    const prev = reusableByPath.get(clean);
    const prevClean = Boolean(
      prev &&
        prev.blobSha === item.blobSha &&
        prev.content === prev.baseContent &&
        (prev.isBinary ? (prev.base64 ?? null) : null) === resolveEntryBaselineBase64(prev)
    );
    const canReuse = prevClean;
    if (!canReuse) {
      allLoaded = false;
    }
    const nextIsBinary = Boolean(canReuse ? prev.isBinary : item.isBinary);
    const nextBase64 = canReuse ? (prev.base64 ?? null) : (item.base64 ?? null);
    return {
      path: clean,
      content: canReuse ? prev.content : "",
      baseContent: canReuse ? prev.baseContent : "",
      blobSha: item.blobSha,
      mode: item.mode || null,
      isBinary: nextIsBinary,
      base64: nextBase64,
      baseBase64: canReuse ? resolveEntryBaselineBase64(prev) : null,
      contentLoaded: canReuse
    };
  });

  await replaceAllProjectFilesFromGithub(projectId, files);

  const validPaths = new Set(entries.map((e) => normalizePath(e.path)));
  const keptTabs = (existingProject?.openTabIds || []).filter((p) => validPaths.has(p));

  const project = {
    id: projectId,
    name: `${owner}/${repo} (${branch})`,
    kind: "github",
    github: { owner, repo, branch, commitSha },
    offlineCached: entries.length === 0 || allLoaded,
    openTabIds: keptTabs,
    activeFileId:
      existingProject?.activeFileId && keptTabs.includes(existingProject.activeFileId)
        ? existingProject.activeFileId
        : keptTabs[0] || null,
    chatHistory: Array.isArray(existingProject?.chatHistory) ? existingProject.chatHistory : [],
    updatedAt: Date.now()
  };

  await putRecord(STORE_PROJECTS, project);
  return project;
}

/**
 * Guarda en IndexedDB el contenido recién descargado de un único archivo bajo demanda (sin marcarlo como editado).
 */
export async function cacheSingleGithubFileContent(projectId, path, contentOrBlob, blobSha = null) {
  const cleanPath = normalizePath(path);
  const key = makeFileKey(projectId, cleanPath);
  const isBlobObj = Boolean(contentOrBlob && typeof contentOrBlob === "object");

  const db = await openDb();
  let resultRecord = null;
  let needsUpsert = false;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    const store = tx.objectStore(STORE_FILES);
    const req = store.get(key);
    req.onsuccess = () => {
      const existing = req.result;
      if (!existing) {
        needsUpsert = true;
        return;
      }
      if (existing.deleted || existing.contentLoaded !== false) {
        // Si fue eliminado localmente o ya tiene contenido cargado/editado, nunca pisar el estado local.
        resultRecord = existing;
        return;
      }
      const nextIsBinary = isBlobObj ? Boolean(contentOrBlob.isBinary) : Boolean(existing.isBinary);
      const nextBase64 = nextIsBinary
        ? (isBlobObj
          ? (contentOrBlob.base64 ?? null)
          : (typeof contentOrBlob === "string" ? contentOrBlob : null))
        : null;
      const nextText = nextIsBinary
        ? ""
        : (isBlobObj ? String(contentOrBlob.content ?? "") : String(contentOrBlob ?? ""));

      existing.isBinary = nextIsBinary;
      existing.content = nextText;
      existing.baseContent = nextText;
      existing.base64 = nextBase64;
      existing.baseBase64 = nextBase64;
      existing.contentLoaded = true;
      if (blobSha) {
        existing.blobSha = blobSha;
      }
      existing.updatedAt = Date.now();
      resultRecord = existing;
      store.put(existing);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción de caché se canceló."));
  });

  if (needsUpsert) {
    const nextIsBinary = isBlobObj && Boolean(contentOrBlob.isBinary);
    const nextBase64 = nextIsBinary ? (contentOrBlob.base64 ?? null) : null;
    const nextText = nextIsBinary
      ? ""
      : (isBlobObj ? String(contentOrBlob.content ?? "") : String(contentOrBlob ?? ""));
    return upsertEntry(projectId, cleanPath, {
      isFolder: false,
      content: nextText,
      baseContent: nextText,
      fromGithub: true,
      blobSha,
      isBinary: nextIsBinary,
      base64: nextBase64,
      baseBase64: nextBase64,
      contentLoaded: true,
      skipIfDeleted: true
    });
  }

  return resultRecord;
}

export async function markProjectOfflineCached(projectId, isCached = true) {
  const project = await getProject(projectId);
  if (!project) return;
  project.offlineCached = Boolean(isCached);
  project.updatedAt = Date.now();
  await putRecord(STORE_PROJECTS, project);
}

/**
 * Reemplaza o sincroniza un proyecto completo proveniente de un repositorio de GitHub (modo copia offline completa).
 */
export async function hydrateGithubProject({ owner, repo, branch, commitSha, files }) {
  const projectId = makeGithubProjectId(owner, repo, branch);
  const existingProject = await getProject(projectId);

  await replaceAllProjectFilesFromGithub(
    projectId,
    files.map((file) => {
      const isBin = Boolean(file.isBinary);
      const b64 = isBin ? (file.base64 ?? null) : null;
      return {
        path: file.path,
        content: isBin ? "" : file.content,
        baseContent: isBin ? "" : file.content,
        blobSha: file.blobSha || null,
        mode: file.mode || null,
        isBinary: isBin,
        base64: b64,
        baseBase64: b64,
        contentLoaded: true
      };
    })
  );

  const firstPaths = files.slice(0, 3).map((f) => normalizePath(f.path));
  const project = {
    id: projectId,
    name: `${owner}/${repo} (${branch})`,
    kind: "github",
    github: { owner, repo, branch, commitSha },
    offlineCached: true,
    openTabIds: existingProject?.openTabIds?.filter((p) => files.some((f) => normalizePath(f.path) === p)) || firstPaths,
    activeFileId: firstPaths[0] || null,
    chatHistory: Array.isArray(existingProject?.chatHistory) ? existingProject.chatHistory : [],
    updatedAt: Date.now()
  };

  if (project.openTabIds.length > 0 && !project.openTabIds.includes(project.activeFileId)) {
    project.activeFileId = project.openTabIds[0];
  }

  await putRecord(STORE_PROJECTS, project);
  return project;
}

function classifyPendingChangeStatus(item) {
  if (!item || item.isFolder) return null;
  if (item.contentLoaded === false && !item.deleted) return null;

  if (item.deleted && item.trackedInGithub) {
    return "deleted";
  }
  if (!item.deleted && !item.trackedInGithub) {
    return "added";
  }
  if (!item.deleted) {
    const curBase64 = item.isBinary ? (item.base64 ?? null) : null;
    const origBase64 = resolveEntryBaselineBase64(item);
    if (item.forceModified || item.content !== item.baseContent || curBase64 !== origBase64) {
      return "modified";
    }
  }
  return null;
}

/**
 * Cuenta de forma streaming vía cursor IndexedDB los cambios pendientes frente a GitHub
 * sin cargar ni retener todos los contenidos/Base64 en RAM (usado por badges de UI).
 * @param {string} projectId
 * @returns {Promise<number>}
 */
export async function countPendingGithubChanges(projectId) {
  if (!projectId) return 0;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readonly");
    const req = tx.objectStore(STORE_FILES).index("byProject").openCursor(projectId);
    let count = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(count);
        return;
      }
      if (classifyPendingChangeStatus(cursor.value) !== null) {
        count += 1;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Calcula los cambios pendientes frente al repositorio de GitHub (creados, modificados y borrados),
 * incluyendo baseContent para poder previsualizar el Diff línea por línea antes del commit.
 */
export async function getPendingGithubChanges(projectId) {
  const all = await getAllRawProjectEntries(projectId);
  const changes = [];

  for (const item of all) {
    const status = classifyPendingChangeStatus(item);
    if (!status) continue;

    if (status === "deleted") {
      changes.push({
        path: item.path,
        status: "deleted",
        content: "",
        baseContent: item.baseContent || ""
      });
    } else if (status === "added") {
      changes.push({
        path: item.path,
        status: "added",
        content: item.content,
        baseContent: "",
        mode: item.mode || null,
        isBinary: Boolean(item.isBinary),
        base64: item.isBinary ? (item.base64 ?? item.content ?? null) : null
      });
    } else {
      changes.push({
        path: item.path,
        status: "modified",
        content: item.content,
        baseContent: item.baseContent || "",
        mode: item.mode || null,
        isBinary: Boolean(item.isBinary),
        base64: item.isBinary ? (item.base64 ?? item.content ?? null) : null
      });
    }
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

/**
 * Marca como sincronizado el proyecto tras un push exitoso.
 * Si se indica pushedChanges (la instantánea exacta enviada en el commit), solo se consolidan esas
 * versiones: cualquier edición, alta o borrado hecho mientras el push viajaba sigue pendiente.
 * @param {string} projectId
 * @param {string} newCommitSha
 * @param {Array<{path: string, status: string, content: string}> | null} [pushedChanges]
 */
export async function markProjectSynced(projectId, newCommitSha, pushedChanges = null) {
  const db = await openDb();
  const pushedByPath = Array.isArray(pushedChanges)
    ? new Map(pushedChanges.map((c) => [normalizePath(c.path), c]))
    : null;

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_FILES], "readwrite");
    const projectsStore = tx.objectStore(STORE_PROJECTS);
    const store = tx.objectStore(STORE_FILES);
    const now = Date.now();

    const projReq = projectsStore.get(projectId);
    projReq.onsuccess = () => {
      const project = projReq.result;
      if (project && project.github) {
        project.github.commitSha = newCommitSha;
        project.updatedAt = now;
        projectsStore.put(project);
      }
    };

    const filesReq = store.index("byProject").getAll(projectId);
    filesReq.onsuccess = () => {
      const all = Array.isArray(filesReq.result) ? filesReq.result : [];

      for (const item of all) {
        if (item.isFolder) continue;

        if (!pushedByPath) {
          if (item.deleted) {
            store.delete(item.key);
          } else if (item.contentLoaded !== false) {
            item.baseContent = item.content;
            item.baseBase64 = item.isBinary ? (item.base64 ?? null) : null;
            item.trackedInGithub = true;
            item.forceModified = false;
            item.contentLoaded = true;
            item.updatedAt = now;
            store.put(item);
          }
          continue;
        }

        const pushed = pushedByPath.get(item.path);
        if (!pushed) {
          if (item.deleted && !item.trackedInGithub) {
            store.delete(item.key);
          }
          continue;
        }

        if (pushed.status === "deleted") {
          if (item.deleted) {
            store.delete(item.key);
          } else {
            // Se volvió a crear durante el push: en GitHub ya no existe, así que ahora es un archivo nuevo.
            item.trackedInGithub = false;
            item.baseContent = "";
            item.baseBase64 = null;
            item.blobSha = null;
            item.forceModified = false;
            item.updatedAt = now;
            store.put(item);
          }
          continue;
        }

        // Alta o modificación: la versión remota pasa a ser exactamente la que se envió.
        const pushedIsBinary = Boolean(pushed.isBinary);
        item.baseContent = pushedIsBinary ? "" : (typeof pushed.content === "string" ? pushed.content : "");
        item.baseBase64 = pushedIsBinary ? (pushed.base64 ?? null) : null;
        item.trackedInGithub = true;
        item.forceModified = false;
        if (!item.deleted) {
          item.contentLoaded = true;
        }
        item.updatedAt = now;
        store.put(item);
      }

      if (pushedByPath) {
        // Lo publicado que ya no existe localmente (p. ej. un archivo nuevo borrado o renombrado mientras viajaba
        // el push) ahora sí existe en GitHub: se registra como borrado pendiente para no divergir en silencio.
        const presentPaths = new Set(all.map((e) => e.path));
        for (const [path, pushed] of pushedByPath) {
          if (pushed.status === "deleted" || presentPaths.has(path)) continue;
          const pushedIsBinary = Boolean(pushed.isBinary);
          store.put({
            key: makeFileKey(projectId, path),
            projectId,
            path,
            isFolder: false,
            content: "",
            baseContent: pushedIsBinary ? "" : (typeof pushed.content === "string" ? pushed.content : ""),
            blobSha: null,
            mode: pushed.mode || null,
            contentLoaded: true,
            trackedInGithub: true,
            forceModified: false,
            isBinary: pushedIsBinary,
            base64: null,
            baseBase64: pushedIsBinary ? (pushed.base64 ?? null) : null,
            deleted: true,
            updatedAt: now
          });
        }
      }
    };

    projReq.onerror = () => reject(projReq.error);
    filesReq.onerror = () => reject(filesReq.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción de sincronización se canceló."));
  });
}

/**
 * Aplica un plan transaccional de Pull e integración remota en IndexedDB:
 * actualiza archivos no conflictivos, elimina archivos borrados en remoto,
 * reancla archivos locales conservados al nuevo commit base y actualiza commitSha.
 *
 * @param {string} projectId
 * @param {{
 *   newCommitSha: string,
 *   updates?: Array<{ path: string, blobSha?: string | null, content?: string, contentLoaded?: boolean, mode?: string | null, isBinary?: boolean, base64?: string | null }>,
 *   deletions?: Array<string>,
 *   keepLocalRebases?: Array<{ path: string, remoteRemoved?: boolean, remoteBlobSha?: string | null, remoteContent?: string | null }>
 * }} plan
 */
export async function applyRemotePullPlan(
  projectId,
  { newCommitSha, updates = [], deletions = [], keepLocalRebases = [] }
) {
  const db = await openDb();
  let updatedProject = null;
  let deletionsCount = 0;
  let txErr = null;

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FILES, STORE_PROJECTS], "readwrite");
    const fileStore = tx.objectStore(STORE_FILES);
    const projectStore = tx.objectStore(STORE_PROJECTS);

    const projReq = projectStore.get(projectId);
    projReq.onsuccess = () => {
      const project = projReq.result || null;
      if (!project || !project.github) {
        txErr = new Error("Proyecto GitHub no encontrado.");
        tx.abort();
        return;
      }

      const filesReq = fileStore.index("byProject").getAll(projectId);
      filesReq.onsuccess = () => {
        const allRaw = Array.isArray(filesReq.result) ? filesReq.result : [];
        const rawByPath = new Map(allRaw.map((entry) => [entry.path, entry]));
        const deletedSet = new Set(deletions.map((p) => normalizePath(p)).filter(Boolean));
        const now = Date.now();
        const recordsToPut = new Map();
        const keysToDelete = new Set();

        function ensureFolderParents(cleanPath) {
          const parts = cleanPath.split("/");
          let prefix = "";
          for (let i = 0; i < parts.length - 1; i += 1) {
            prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
            const prevFolder = rawByPath.get(prefix);
            const prevKey = prevFolder?.key || makeFileKey(projectId, prefix);
            if (prevFolder && !prevFolder.deleted && !prevFolder.isFolder && !keysToDelete.has(prevKey)) {
              txErr = new Error(`No se puede aplicar "${cleanPath}" porque "${prefix}" existe como archivo.`);
              tx.abort();
              return false;
            }
            if ((!prevFolder || prevFolder.deleted || keysToDelete.has(prevKey)) && !recordsToPut.has(prefix)) {
              keysToDelete.delete(prevKey);
              recordsToPut.set(prefix, {
                key: makeFileKey(projectId, prefix),
                projectId,
                path: prefix,
                isFolder: true,
                content: "",
                baseContent: "",
                contentLoaded: true,
                deleted: false,
                updatedAt: now
              });
            }
          }
          return true;
        }

        for (const delPath of deletedSet) {
          const existing = rawByPath.get(delPath);
          keysToDelete.add(existing?.key || makeFileKey(projectId, delPath));
        }

        for (const upd of updates) {
          const cleanPath = normalizePath(upd?.path);
          if (!cleanPath) continue;
          deletedSet.delete(cleanPath);
          keysToDelete.delete(makeFileKey(projectId, cleanPath));
          if (!ensureFolderParents(cleanPath)) return;

          const existing = rawByPath.get(cleanPath);
          if (existing && !existing.deleted && existing.isFolder) {
            const hasRemainingChildren = allRaw.some(
              (e) =>
                !e.deleted &&
                e.path.startsWith(`${cleanPath}/`) &&
                !deletedSet.has(e.path) &&
                !keysToDelete.has(e.key)
            );
            if (hasRemainingChildren) {
              txErr = new Error(
                `No se puede reemplazar la carpeta "${cleanPath}" con un archivo mientras conserve hijos activos.`
              );
              tx.abort();
              return;
            }
          }

          const loaded = upd.contentLoaded !== false;
          const updIsBinary = Boolean(upd.isBinary);
          const textContent = loaded && !updIsBinary ? String(upd.content ?? "") : "";
          const updBase64 = loaded && updIsBinary ? (upd.base64 ?? null) : null;
          recordsToPut.set(cleanPath, {
            key: makeFileKey(projectId, cleanPath),
            projectId,
            path: cleanPath,
            isFolder: false,
            content: textContent,
            baseContent: textContent,
            blobSha: upd.blobSha || null,
            mode: upd.mode || existing?.mode || null,
            contentLoaded: loaded,
            trackedInGithub: true,
            forceModified: false,
            isBinary: updIsBinary,
            base64: updBase64,
            baseBase64: updBase64,
            deleted: false,
            updatedAt: now
          });
        }

        for (const rebase of keepLocalRebases) {
          const cleanPath = normalizePath(rebase?.path);
          if (!cleanPath) continue;
          const existing = rawByPath.get(cleanPath);
          if (!existing || existing.isFolder) continue;

          if (rebase.remoteRemoved) {
            if (existing.deleted) {
              keysToDelete.add(existing.key);
            } else {
              recordsToPut.set(cleanPath, {
                ...existing,
                trackedInGithub: false,
                baseContent: "",
                baseBase64: null,
                blobSha: null,
                forceModified: false,
                updatedAt: now
              });
            }
            continue;
          }

          const remoteIsBinary = Boolean(rebase.remoteIsBinary);
          let nextBase = existing.baseContent || "";
          let nextBaseBase64 = resolveEntryBaselineBase64(existing);
          if (remoteIsBinary) {
            nextBase = "";
            nextBaseBase64 = rebase.remoteBase64 ?? null;
          } else if (typeof rebase.remoteContent === "string") {
            nextBase = rebase.remoteContent;
            nextBaseBase64 = null;
          }

          const curBase64 = existing.isBinary ? (existing.base64 ?? null) : null;
          recordsToPut.set(cleanPath, {
            ...existing,
            baseContent: nextBase,
            baseBase64: nextBaseBase64,
            blobSha: rebase.remoteBlobSha || existing.blobSha || null,
            trackedInGithub: true,
            forceModified:
              !existing.deleted && (existing.content !== nextBase || curBase64 !== nextBaseBase64),
            updatedAt: now
          });
        }

        for (const key of keysToDelete) {
          fileStore.delete(key);
        }
        for (const rec of recordsToPut.values()) {
          fileStore.put(rec);
        }

        if (newCommitSha) {
          project.github.commitSha = newCommitSha;
        }
        const nextTabs = (project.openTabIds || []).filter((id) => !deletedSet.has(normalizePath(id)));
        project.openTabIds = nextTabs;
        if (project.activeFileId && deletedSet.has(normalizePath(project.activeFileId))) {
          project.activeFileId = nextTabs[0] || null;
        }
        project.updatedAt = now;
        projectStore.put(project);
        updatedProject = project;
        deletionsCount = deletedSet.size;
      };
      filesReq.onerror = () => {
        txErr = filesReq.error;
        tx.abort();
      };
    };
    projReq.onerror = () => {
      txErr = projReq.error;
      tx.abort();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(txErr || tx.error);
    tx.onabort = () => reject(txErr || tx.error || new Error("La transacción de IndexedDB se canceló."));
  });

  return {
    project: updatedProject,
    updatesCount: updates.length,
    deletionsCount,
    keptLocalCount: keepLocalRebases.length
  };
}

function getRecord(storeName, key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      })
  );
}

function putRecord(storeName, value) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

/**
 * Guarda un respaldo persistente de las credenciales (claves IA y token GitHub) en IndexedDB
 * para protegerlas si Safari / iPadOS vacía el localStorage durante recargas o suspensión de memoria.
 * @param {string} rawJson
 */
export async function saveCredentialsBackup(rawJson) {
  try {
    const key = makeFileKey("__system__", "credentials");
    await putRecord(STORE_FILES, {
      key,
      projectId: "__system__",
      path: "credentials",
      isFolder: false,
      content: rawJson || "",
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

/**
 * Crea un proyecto local en IndexedDB a partir de un respaldo de Gist de GitHub.
 * @param {{ projectName: string, entries: Array<{ path: string, content: string, mode?: string|null }> }} options
 */
export async function createProjectFromGistBackup({ projectName, entries }) {
  const rawName = String(projectName || "proyecto-restaurado").replace(/[\x00-\x1f\x7f]/g, "").trim();
  const cleanName = rawName || "proyecto-restaurado";
  const slug = slugifyName(cleanName, { allowDots: false, collapse: true, fallback: "proyecto" });
  const id = `${slug}-gist-${Date.now().toString(36)}`;
  const now = Date.now();

  const fileEntries = [];
  for (const e of entries || []) {
    if (!e || e.isFolder || typeof e.path !== "string" || !e.path) continue;
    let validPath;
    try {
      // Validación estricta sin degradar a regex laxa (protege contra traversal '..' y DEL 0x7f).
      validPath = validateUserPath(e.path);
    } catch {
      continue;
    }

    const isBinary = Boolean(e.isBinary);
    if (isBinary) {
      if (e.base64 !== undefined && e.base64 !== null && typeof e.base64 !== "string") continue;
      if (typeof e.base64 === "string" && e.base64.length > Math.ceil((MAX_GIST_RESTORE_ENTRY_BYTES * 4) / 3) + 16) {
        continue;
      }
    } else {
      if (e.content !== undefined && e.content !== null && typeof e.content !== "string") continue;
      if (typeof e.content === "string" && e.content.length > MAX_GIST_RESTORE_ENTRY_BYTES) {
        continue;
      }
    }

    fileEntries.push({
      path: validPath,
      isBinary,
      content: isBinary ? "" : (typeof e.content === "string" ? e.content : ""),
      base64: isBinary ? (typeof e.base64 === "string" ? e.base64 : null) : null,
      mode: typeof e.mode === "string" ? e.mode : null
    });
  }
  const firstFile = fileEntries[0]?.path || "main.cpp";

  const project = {
    id,
    name: cleanName,
    kind: "local",
    github: null,
    openTabIds: [firstFile],
    activeFileId: firstFile,
    chatHistory: [],
    updatedAt: now
  };

  const records = new Map();
  for (const entry of fileEntries) {
    const cleanPath = entry.path;
    if (!cleanPath) continue;
    const parts = cleanPath.split("/");
    let prefix = "";
    let ancestorBlocked = false;
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      const existingAncestor = records.get(prefix);
      if (existingAncestor && !existingAncestor.isFolder) {
        ancestorBlocked = true;
        break;
      }
      if (!existingAncestor) {
        records.set(prefix, {
          key: makeFileKey(id, prefix),
          projectId: id,
          path: prefix,
          isFolder: true,
          content: "",
          baseContent: "",
          contentLoaded: true,
          trackedInGithub: false,
          forceModified: false,
          isBinary: false,
          base64: null,
          deleted: false,
          updatedAt: now
        });
      }
    }
    if (ancestorBlocked) continue;
    const existingTarget = records.get(cleanPath);
    if (existingTarget && existingTarget.isFolder) continue;

    records.set(cleanPath, {
      key: makeFileKey(id, cleanPath),
      projectId: id,
      path: cleanPath,
      isFolder: false,
      content: entry.content,
      baseContent: "",
      blobSha: null,
      mode: entry.mode,
      contentLoaded: true,
      trackedInGithub: false,
      forceModified: false,
      isBinary: entry.isBinary,
      base64: entry.base64,
      deleted: false,
      updatedAt: now
    });
  }

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_FILES], "readwrite");
    tx.objectStore(STORE_PROJECTS).put(project);
    const store = tx.objectStore(STORE_FILES);
    for (const record of records.values()) {
      store.put(record);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción de restauración de Gist se canceló."));
  });

  return project;
}

/**
 * Convierte un proyecto local a un proyecto vinculado con un repositorio de GitHub.
 * @param {string} projectId
 * @param {{ owner: string, repo: string, branch: string }} githubMeta
 */
async function migrateProjectWithEntries(sourceProjectId, transformFn) {
  const db = await openDb();
  let migratedProject = null;
  let txErr = null;

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_FILES], "readwrite");
    const projectStore = tx.objectStore(STORE_PROJECTS);
    const fileStore = tx.objectStore(STORE_FILES);

    const projReq = projectStore.get(sourceProjectId);
    projReq.onsuccess = () => {
      const project = projReq.result || null;
      if (!project) {
        txErr = new Error("Proyecto no encontrado.");
        tx.abort();
        return;
      }

      const entriesReq = fileStore.index("byProject").getAll(sourceProjectId);
      entriesReq.onsuccess = () => {
        const entries = Array.isArray(entriesReq.result) ? entriesReq.result : [];
        let transformed;
        try {
          transformed = transformFn(project, entries);
        } catch (err) {
          txErr = err;
          tx.abort();
          return;
        }
        const { nextProject, nextEntries } = transformed;

        const applyWrites = () => {
          if (nextProject.id !== sourceProjectId) {
            projectStore.delete(sourceProjectId);
            for (const old of entries) {
              fileStore.delete(old.key);
            }
          }
          projectStore.put(nextProject);
          for (const nextEntry of nextEntries) {
            fileStore.put(nextEntry);
          }
          migratedProject = nextProject;
        };

        if (nextProject.id !== sourceProjectId) {
          const targetOldReq = fileStore.index("byProject").getAll(nextProject.id);
          targetOldReq.onsuccess = () => {
            const targetOld = Array.isArray(targetOldReq.result) ? targetOldReq.result : [];
            for (const oldTargetEntry of targetOld) {
              fileStore.delete(oldTargetEntry.key);
            }
            applyWrites();
          };
          targetOldReq.onerror = () => {
            txErr = targetOldReq.error;
            tx.abort();
          };
        } else {
          applyWrites();
        }
      };
      entriesReq.onerror = () => {
        txErr = entriesReq.error;
        tx.abort();
      };
    };
    projReq.onerror = () => {
      txErr = projReq.error;
      tx.abort();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(txErr || tx.error);
    tx.onabort = () => reject(txErr || tx.error || new Error("La transacción de migración se canceló."));
  });

  return migratedProject;
}

export async function migrateGithubProjectBranch(projectId, branchName, commitSha = null) {
  const targetBranch = String(branchName || "").trim();
  if (!targetBranch) {
    throw new Error("El nombre de la rama no puede estar vacío.");
  }

  return migrateProjectWithEntries(projectId, (project, entries) => {
    if (project.kind !== "github" || !project.github) {
      throw new Error("Proyecto GitHub no encontrado.");
    }
    const { owner, repo } = project.github;
    const targetId = makeGithubProjectId(owner, repo, targetBranch);
    const now = Date.now();

    const nextProject = {
      ...project,
      id: targetId,
      name: `${owner}/${repo} (${targetBranch})`,
      github: {
        owner,
        repo,
        branch: targetBranch,
        commitSha: commitSha || project.github.commitSha || null
      },
      updatedAt: now
    };

    const nextEntries = entries.map((entry) => ({
      ...entry,
      key: makeFileKey(targetId, entry.path),
      projectId: targetId
    }));

    return { nextProject, nextEntries };
  });
}

export async function convertLocalProjectToGithub(projectId, githubMeta) {
  return migrateProjectWithEntries(projectId, (project, entries) => {
    const targetBranch = githubMeta.branch || "main";
    const targetId = makeGithubProjectId(githubMeta.owner, githubMeta.repo, targetBranch);
    const now = Date.now();
    const activeFiles = entries.filter((entry) => !entry.isFolder && !entry.deleted);
    const resolvedOfflineCached =
      githubMeta.offlineCached !== undefined
        ? Boolean(githubMeta.offlineCached)
        : activeFiles.every((entry) => entry.contentLoaded !== false);

    const nextProject = {
      ...project,
      id: targetId,
      kind: "github",
      github: {
        owner: githubMeta.owner,
        repo: githubMeta.repo,
        branch: targetBranch,
        commitSha: githubMeta.commitSha ?? project.github?.commitSha ?? null
      },
      offlineCached: resolvedOfflineCached,
      updatedAt: now
    };

    const nextEntries = entries.map((entry) => {
      const nextKey = makeFileKey(targetId, entry.path);
      if (entry.deleted) {
        // Nunca resucitar tombstones locales ni marcarlos como trackedInGithub sobre borrados locales.
        return {
          ...entry,
          key: nextKey,
          projectId: targetId
        };
      }
      if (entry.isFolder) {
        return {
          ...entry,
          key: nextKey,
          projectId: targetId,
          updatedAt: now
        };
      }
      const isBin = Boolean(entry.isBinary);
      const curBase64 = isBin ? (entry.base64 ?? null) : null;
      return {
        ...entry,
        key: nextKey,
        projectId: targetId,
        trackedInGithub: true,
        baseContent: entry.content,
        baseBase64: curBase64,
        forceModified: false,
        deleted: false,
        updatedAt: now
      };
    });

    return { nextProject, nextEntries };
  });
}
