const DB_NAME = "studio_ide_db";
const DB_VERSION = 1;
const STORE_PROJECTS = "projects";
const STORE_FILES = "files";
const ACTIVE_PROJECT_KEY = "ide.workspace.activeProjectId";

const SEED_PROJECT_ID = "espacio-local";
const MAX_STORED_CHAT_TURNS = 40;

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

const INVALID_PATH_CHARS = /[:*?"<>|\u0000-\u001f]/;

/**
 * Valida una ruta escrita por el usuario (crear, renombrar, importar).
 * Devuelve la ruta normalizada o lanza un Error con un mensaje claro en español.
 */
export function validateUserPath(rawPath) {
  const raw = String(rawPath || "").trim();
  if (!raw) {
    throw new Error("Escribí un nombre válido.");
  }
  if (raw.includes("//") || raw.includes("\\\\")) {
    throw new Error('El nombre no puede contener barras consecutivas "//".');
  }
  const rawSegments = raw.split(/[/\\]/);
  for (const seg of rawSegments) {
    if (seg === "." || seg === "..") {
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
    const shown = badChar[0].charCodeAt(0) < 32 ? "caracteres de control" : `"${badChar[0]}"`;
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

    req.onsuccess = () => {
      const db = req.result;
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
  const projects = await listProjects();
  if (projects.length > 0) {
    return projects;
  }

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

  await putRecord(STORE_PROJECTS, seedProject);

  const folders = ["src", "web", "scripts", "db"];
  for (const folderPath of folders) {
    await putRecord(STORE_FILES, {
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
    await putRecord(STORE_FILES, {
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

  return [seedProject];
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
  const cleanName = name.trim();
  const slug = cleanName
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id = `${slug || "proyecto"}-${Date.now().toString(36)}`;
  const now = Date.now();

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

  await putRecord(STORE_PROJECTS, project);
  await putRecord(STORE_FILES, {
    key: makeFileKey(id, "main.cpp"),
    projectId: id,
    path: "main.cpp",
    isFolder: false,
    content: `#include <iostream>\n\nint main() {\n    std::cout << "Proyecto ${cleanName}\\n";\n    return 0;\n}\n`,
    baseContent: "",
    deleted: false,
    updatedAt: now
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
    silent = false
  } = {}
) {
  const cleanPath = normalizePath(path);
  if (!cleanPath) {
    throw new Error("La ruta no puede estar vacía.");
  }

  const key = makeFileKey(projectId, cleanPath);
  const existing = await getRecord(STORE_FILES, key);
  if (!allowOverwrite && existing && !existing.deleted) {
    throw new Error(`Ya existe "${cleanPath}" en este proyecto.`);
  }
  if (existing && !existing.deleted && Boolean(existing.isFolder) !== Boolean(isFolder)) {
    throw new Error(
      existing.isFolder
        ? `Ya existe una carpeta llamada "${cleanPath}" en este proyecto.`
        : `Ya existe un archivo llamado "${cleanPath}" en este proyecto.`
    );
  }
  if (!isFolder) {
    const allCurrent = await getAllRawProjectEntries(projectId);
    const hasChildEntries = allCurrent.some(
      (e) => !e.deleted && e.path.startsWith(`${cleanPath}/`)
    );
    if (hasChildEntries) {
      throw new Error(`Ya existe una carpeta llamada "${cleanPath}" con contenido adentro.`);
    }
  }

  // Asegurar carpetas padre implícitas si se escribe p. ej. "src/utils/math.cpp"
  const parts = cleanPath.split("/");
  if (parts.length > 1) {
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      const folderKey = makeFileKey(projectId, prefix);
      const existingFolder = await getRecord(STORE_FILES, folderKey);
      if (existingFolder && !existingFolder.deleted && !existingFolder.isFolder) {
        throw new Error(`No se puede crear dentro de "${prefix}" porque es un archivo.`);
      }
      if (!existingFolder || existingFolder.deleted) {
        await putRecord(STORE_FILES, {
          key: folderKey,
          projectId,
          path: prefix,
          isFolder: true,
          content: "",
          baseContent: "",
          contentLoaded: true,
          deleted: false,
          updatedAt: Date.now()
        });
      }
    }
  }

  const resolvedBase =
    baseContent !== null
      ? baseContent
      : fromGithub
        ? content
        : existing && typeof existing.baseContent === "string"
          ? existing.baseContent
          : "";

  const recreatedOverUnloaded = Boolean(
    !isFolder &&
      !fromGithub &&
      existing &&
      existing.trackedInGithub &&
      existing.contentLoaded === false
  );

  const record = {
    key,
    projectId,
    path: cleanPath,
    isFolder,
    content: isFolder ? "" : content,
    baseContent: isFolder ? "" : resolvedBase,
    blobSha: isFolder ? null : blobSha ?? existing?.blobSha ?? null,
    mode: isFolder ? null : mode ?? existing?.mode ?? null,
    contentLoaded: isFolder ? true : Boolean(contentLoaded),
    trackedInGithub: Boolean(fromGithub || existing?.trackedInGithub),
    forceModified: recreatedOverUnloaded || Boolean(!fromGithub && existing?.forceModified),
    isBinary: Boolean(isBinary ?? existing?.isBinary),
    base64: base64 ?? existing?.base64 ?? null,
    deleted: false,
    updatedAt: Date.now()
  };

  await putRecord(STORE_FILES, record);
  if (!silent) {
    broadcastWorkspaceChange({ type: "ENTRY_UPSERTED", projectId, path: cleanPath, isFolder });
  }
  return record;
}

export async function updateFileContent(projectId, path, newContent) {
  const cleanPath = normalizePath(path);
  const key = makeFileKey(projectId, cleanPath);
  const existing = await getRecord(STORE_FILES, key);
  if (!existing) {
    return upsertEntry(projectId, cleanPath, { isFolder: false, content: newContent });
  }
  existing.content = newContent;
  existing.contentLoaded = true;
  existing.deleted = false;
  existing.updatedAt = Date.now();
  await putRecord(STORE_FILES, existing);
  broadcastWorkspaceChange({ type: "FILE_UPDATED", projectId, path: cleanPath });
  return existing;
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

  const all = await getAllRawProjectEntries(projectId);
  const targetConflict = all.find(
    (e) =>
      !e.deleted &&
      e.path !== fromPath &&
      !(isFolder && e.path.startsWith(`${fromPath}/`)) &&
      (e.path === toPath || e.path.startsWith(`${toPath}/`) || (!e.isFolder && toPath.startsWith(`${e.path}/`)))
  );
  if (targetConflict) {
    throw new Error(`Ya existe "${targetConflict.path}" en esa ubicación.`);
  }

  const rawByPath = new Map(all.map((e) => [e.path, e]));
  const affected = all.filter(
    (e) => !e.deleted && (e.path === fromPath || (isFolder && e.path.startsWith(`${fromPath}/`)))
  );

  for (const item of affected) {
    const suffix = item.path.slice(fromPath.length);
    const targetPath = `${toPath}${suffix}`;
    const prevTarget = rawByPath.get(targetPath);
    const preserveTargetBase =
      prevTarget && prevTarget.trackedInGithub ? prevTarget.baseContent : item.trackedInGithub ? "" : item.baseContent;

    await upsertEntry(projectId, targetPath, {
      isFolder: item.isFolder,
      content: item.content,
      baseContent: preserveTargetBase,
      fromGithub: false,
      allowOverwrite: true,
      mode: item.mode ?? null,
      isBinary: Boolean(item.isBinary),
      base64: item.base64 ?? null,
      silent: true
    });

    await removeOrSoftDeleteRecord(item);
  }
  broadcastWorkspaceChange({ type: "ENTRY_RENAMED", projectId, oldPath: fromPath, newPath: toPath, isFolder });
}

export async function deleteProjectEntry(projectId, targetPath, isFolder) {
  const cleanPath = normalizePath(targetPath);
  const all = await getAllRawProjectEntries(projectId);
  const affected = all.filter(
    (e) => !e.deleted && (e.path === cleanPath || (isFolder && e.path.startsWith(`${cleanPath}/`)))
  );

  if (affected.length === 0) return;

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    const store = tx.objectStore(STORE_FILES);
    const now = Date.now();
    for (const item of affected) {
      if (item.trackedInGithub && !item.isFolder) {
        item.deleted = true;
        item.updatedAt = now;
        store.put(item);
      } else {
        store.delete(item.key);
      }
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción de borrado se canceló."));
  });

  broadcastWorkspaceChange({ type: "ENTRY_DELETED", projectId, path: cleanPath, isFolder });
}

async function removeOrSoftDeleteRecord(item) {
  if (item.trackedInGithub && !item.isFolder) {
    item.deleted = true;
    item.updatedAt = Date.now();
    await putRecord(STORE_FILES, item);
  } else {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FILES, "readwrite");
      tx.objectStore(STORE_FILES).delete(item.key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
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
    records.set(cleanPath, {
      key: makeFileKey(projectId, cleanPath),
      projectId,
      path: cleanPath,
      isFolder: false,
      content: file.content,
      baseContent: file.baseContent,
      blobSha: file.blobSha || null,
      mode: file.mode || null,
      contentLoaded: Boolean(file.contentLoaded),
      trackedInGithub: true,
      forceModified: false,
      isBinary: Boolean(file.isBinary),
      base64: file.base64 ?? null,
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
    const canReuse = Boolean(prev && prev.blobSha === item.blobSha && prev.content === prev.baseContent);
    if (!canReuse) {
      allLoaded = false;
    }
    return {
      path: clean,
      content: canReuse ? prev.content : "",
      baseContent: canReuse ? prev.baseContent : "",
      blobSha: item.blobSha,
      mode: item.mode || null,
      isBinary: Boolean(canReuse ? prev.isBinary : item.isBinary),
      base64: canReuse ? (prev.base64 ?? null) : (item.base64 ?? null),
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
export async function cacheSingleGithubFileContent(projectId, path, content, blobSha = null) {
  const cleanPath = normalizePath(path);
  const key = makeFileKey(projectId, cleanPath);
  const existing = await getRecord(STORE_FILES, key);
  if (!existing) {
    return upsertEntry(projectId, cleanPath, {
      isFolder: false,
      content,
      baseContent: content,
      fromGithub: true,
      blobSha,
      contentLoaded: true
    });
  }
  if (existing.contentLoaded !== false && !existing.deleted) {
    // Ya tiene contenido local (descargado antes o recreado/editado mientras esta descarga viajaba):
    // nunca pisar el trabajo del usuario con la versión remota.
    return existing;
  }
  existing.content = content;
  existing.baseContent = content;
  existing.contentLoaded = true;
  if (blobSha) {
    existing.blobSha = blobSha;
  }
  existing.updatedAt = Date.now();
  await putRecord(STORE_FILES, existing);
  return existing;
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
    files.map((file) => ({
      path: file.path,
      content: file.content,
      baseContent: file.content,
      blobSha: file.blobSha || null,
      mode: file.mode || null,
      isBinary: Boolean(file.isBinary),
      base64: file.base64 ?? null,
      contentLoaded: true
    }))
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

/**
 * Calcula los cambios pendientes frente al repositorio de GitHub (creados, modificados y borrados),
 * incluyendo baseContent para poder previsualizar el Diff línea por línea antes del commit.
 */
export async function getPendingGithubChanges(projectId) {
  const all = await getAllRawProjectEntries(projectId);
  const changes = [];

  for (const item of all) {
    if (item.isFolder) continue;
    if (item.contentLoaded === false && !item.deleted) continue;

    if (item.deleted && item.trackedInGithub) {
      changes.push({
        path: item.path,
        status: "deleted",
        content: "",
        baseContent: item.baseContent || ""
      });
    } else if (!item.deleted && !item.trackedInGithub) {
      changes.push({
        path: item.path,
        status: "added",
        content: item.content,
        baseContent: "",
        mode: item.mode || null,
        isBinary: Boolean(item.isBinary),
        base64: item.base64 || (item.isBinary ? item.content : null)
      });
    } else if (!item.deleted && (item.forceModified || item.content !== item.baseContent)) {
      changes.push({
        path: item.path,
        status: "modified",
        content: item.content,
        baseContent: item.baseContent || "",
        mode: item.mode || null,
        isBinary: Boolean(item.isBinary),
        base64: item.base64 || (item.isBinary ? item.content : null)
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
  const project = await getProject(projectId);
  if (project && project.github) {
    project.github.commitSha = newCommitSha;
    project.updatedAt = Date.now();
    await putRecord(STORE_PROJECTS, project);
  }

  const all = await getAllRawProjectEntries(projectId);
  const db = await openDb();
  const pushedByPath = Array.isArray(pushedChanges)
    ? new Map(pushedChanges.map((c) => [normalizePath(c.path), c]))
    : null;

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    const store = tx.objectStore(STORE_FILES);
    const now = Date.now();

    for (const item of all) {
      if (item.isFolder) continue;

      if (!pushedByPath) {
        if (item.deleted) {
          store.delete(item.key);
        } else if (item.contentLoaded !== false) {
          item.baseContent = item.content;
          item.trackedInGithub = true;
          item.forceModified = false;
          item.contentLoaded = true;
          item.updatedAt = now;
          store.put(item);
        }
        continue;
      }

      const pushed = pushedByPath.get(item.path);
      if (!pushed) continue;

      if (pushed.status === "deleted") {
        if (item.deleted) {
          store.delete(item.key);
        } else {
          // Se volvió a crear durante el push: en GitHub ya no existe, así que ahora es un archivo nuevo.
          item.trackedInGithub = false;
          item.baseContent = "";
          item.blobSha = null;
          item.forceModified = false;
          item.updatedAt = now;
          store.put(item);
        }
        continue;
      }

      // Alta o modificación: la versión remota pasa a ser exactamente la que se envió.
      item.baseContent = typeof pushed.content === "string" ? pushed.content : "";
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
        store.put({
          key: makeFileKey(projectId, path),
          projectId,
          path,
          isFolder: false,
          content: "",
          baseContent: typeof pushed.content === "string" ? pushed.content : "",
          blobSha: null,
          mode: pushed.mode || null,
          contentLoaded: true,
          trackedInGithub: true,
          forceModified: false,
          deleted: true,
          updatedAt: now
        });
      }
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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
  const cleanName = String(projectName || "proyecto-restaurado").trim();
  const slug = cleanName
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id = `${slug || "proyecto"}-gist-${Date.now().toString(36)}`;
  const now = Date.now();

  const fileEntries = (entries || []).filter((e) => !e.isFolder && e.path);
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

  await putRecord(STORE_PROJECTS, project);

  for (const entry of fileEntries) {
    await upsertEntry(id, entry.path, {
      isFolder: false,
      content: entry.content || "",
      isBinary: Boolean(entry.isBinary),
      base64: entry.base64 || null,
      allowOverwrite: true,
      mode: entry.mode || null,
      silent: true
    });
  }

  return project;
}

/**
 * Convierte un proyecto local a un proyecto vinculado con un repositorio de GitHub.
 * @param {string} projectId
 * @param {{ owner: string, repo: string, branch: string }} githubMeta
 */
export async function convertLocalProjectToGithub(projectId, githubMeta) {
  const project = await getProject(projectId);
  if (!project) throw new Error("Proyecto no encontrado.");
  project.kind = "github";
  project.github = {
    owner: githubMeta.owner,
    repo: githubMeta.repo,
    branch: githubMeta.branch || "main"
  };
  project.updatedAt = Date.now();
  await putRecord(STORE_PROJECTS, project);

  const entries = await getAllRawProjectEntries(projectId);
  const filesToUpdate = entries.filter((entry) => !entry.isFolder);
  if (filesToUpdate.length > 0) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FILES, "readwrite");
      const store = tx.objectStore(STORE_FILES);
      for (const entry of filesToUpdate) {
        entry.trackedInGithub = true;
        entry.baseContent = entry.content;
        entry.deleted = false;
        store.put(entry);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("No se pudieron actualizar las entradas de GitHub."));
      tx.onabort = () => reject(tx.error || new Error("Transacción abortada al convertir el proyecto a GitHub."));
    });
  }

  return project;
}
