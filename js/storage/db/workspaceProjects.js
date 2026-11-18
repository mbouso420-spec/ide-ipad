/**
 * Gestión de proyectos en IndexedDB: semilla inicial, creación con plantillas, historial IA y migraciones.
 */

import { slugifyName } from "../../utils/encoding.js";
import {
  STORE_PROJECTS,
  STORE_FILES,
  SEED_PROJECT_ID,
  MAX_STORED_CHAT_TURNS,
  MAX_GIST_RESTORE_ENTRY_BYTES,
  openDb,
  validateUserPath,
  makeFileKey,
  putRecord,
  isValidBase64String
} from "./dbCore.js";
import { SEED_ENTRIES, buildProjectTemplatePayload } from "./projectTemplates.js";

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
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción listProjects se canceló."));
  });
}

export async function getProject(projectId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, "readonly");
    const req = tx.objectStore(STORE_PROJECTS).get(projectId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción getProject se canceló."));
  });
}

export async function createLocalProject(name, templateId = null) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName || /[\x00-\x1f\x7f]/.test(cleanName)) {
    throw new Error("El nombre del proyecto no puede estar vacío ni contener caracteres de control.");
  }
  const slug = slugifyName(cleanName, { allowDots: false, collapse: true, fallback: "proyecto" });
  const id = `${slug}-${Date.now().toString(36)}`;
  const now = Date.now();
  const tpl = buildProjectTemplatePayload(id, cleanName, templateId, now);

  const project = {
    id,
    name: cleanName,
    kind: "local",
    github: null,
    openTabIds: tpl.openTabIds,
    activeFileId: tpl.activeFileId,
    chatHistory: [],
    updatedAt: now
  };

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_FILES], "readwrite");
    tx.objectStore(STORE_PROJECTS).put(project);
    const fileStore = tx.objectStore(STORE_FILES);
    for (const rec of tpl.records) {
      fileStore.put(rec);
    }
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

export async function saveProjectTabsState(projectId, openTabIds, activeFileId) {
  if (!projectId) return;
  await updateProjectRecord(projectId, (project) => {
    project.openTabIds = Array.isArray(openTabIds) ? [...openTabIds] : [];
    project.activeFileId = activeFileId ?? null;
    project.updatedAt = Date.now();
  });
}

export async function saveProjectGistId(projectId, gistId) {
  if (!projectId) return;
  await updateProjectRecord(projectId, (project) => {
    project.gistId = gistId || null;
    project.updatedAt = Date.now();
  });
}

export async function updateProjectRecord(projectId, mutatorFn) {
  const db = await openDb();
  let txErr = null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, "readwrite");
    const store = tx.objectStore(STORE_PROJECTS);
    const req = store.get(projectId);
    req.onsuccess = () => {
      const project = req.result;
      if (!project) return;
      try {
        mutatorFn(project);
        store.put(project);
      } catch (err) {
        txErr = err;
        try { tx.abort(); } catch (_) {}
      }
    };
    req.onerror = () => reject(req.error || new Error("Error leyendo el registro del proyecto."));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(txErr || tx.error || new Error("Error guardando el registro del proyecto."));
    tx.onabort = () => reject(txErr || tx.error || new Error("La transacción sobre el proyecto se canceló."));
  });
}

/**
 * Guarda el historial reciente de conversación del asistente IA asociado al proyecto activo.
 */
export async function saveProjectChatHistory(projectId, history) {
  const sanitized = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .slice(-MAX_STORED_CHAT_TURNS)
        .map((m) => ({ role: m.role, content: m.content }))
    : [];
  await updateProjectRecord(projectId, (project) => {
    project.chatHistory = sanitized;
  });
}

export async function deleteProject(projectId) {
  const db = await openDb();

  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_FILES], "readwrite");
    tx.objectStore(STORE_PROJECTS).delete(projectId);
    const fileIdx = tx.objectStore(STORE_FILES).index("byProject");
    const req = fileIdx.openCursor(projectId);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("No se pudo eliminar el proyecto."));
  });
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
      validPath = validateUserPath(e.path);
    } catch {
      continue;
    }

    const isBinary = Boolean(e.isBinary);
    let cleanBase64 = null;
    if (isBinary) {
      if (e.base64 !== undefined && e.base64 !== null && typeof e.base64 !== "string") continue;
      if (typeof e.base64 === "string") {
        if (e.base64.length > Math.ceil((MAX_GIST_RESTORE_ENTRY_BYTES * 4) / 3) + 16) {
          continue;
        }
        if (!isValidBase64String(e.base64)) {
          continue;
        }
        cleanBase64 = e.base64.replace(/\s+/g, "");
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
      base64: isBinary ? cleanBase64 : null,
      mode: typeof e.mode === "string" ? e.mode : null
    });
  }

  const records = new Map();
  let firstStoredFilePath = null;
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

    if (!firstStoredFilePath) {
      firstStoredFilePath = cleanPath;
    }
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

  const firstFile = firstStoredFilePath || null;

  const project = {
    id,
    name: cleanName,
    kind: "local",
    github: null,
    openTabIds: firstFile ? [firstFile] : [],
    activeFileId: firstFile,
    chatHistory: [],
    updatedAt: now
  };

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

export async function migrateProjectWithEntries(sourceProjectId, transformFn) {
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
