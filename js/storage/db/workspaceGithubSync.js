/**
 * Sincronización de repositorios GitHub con IndexedDB: hidratación lazy/offline, cálculo de diffs pendientes y pull.
 */

import {
  STORE_PROJECTS,
  STORE_FILES,
  openDb,
  normalizePath,
  sanitizeRemoteRepoPath,
  makeFileKey,
  putRecord,
  resolveEntryBaselineBase64
} from "./dbCore.js";
import { getAllRawProjectEntries, upsertEntry } from "./workspaceEntries.js";
import {
  getProject,
  updateProjectRecord,
  migrateProjectWithEntries
} from "./workspaceProjects.js";

export function makeGithubProjectId(owner, repo, branch) {
  return `gh-${owner}-${repo}-${branch}`.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

async function replaceAllProjectFilesFromGithub(projectId, files) {
  const oldEntries = await getAllRawProjectEntries(projectId);
  const now = Date.now();
  const records = new Map();

  for (const file of files) {
    const cleanPath = sanitizeRemoteRepoPath(file?.path) || normalizePath(file?.path);
    if (!cleanPath || cleanPath.startsWith("..") || /__proto__|constructor|prototype/.test(cleanPath.split("/").join("\0"))) continue;
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

  const validPaths = new Set();
  let allLoaded = true;
  const files = entries
    .map((item) => {
      const clean = sanitizeRemoteRepoPath(item?.path) || normalizePath(item?.path);
      if (!clean) return null;
      validPaths.add(clean);
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
    })
    .filter(Boolean);

  await replaceAllProjectFilesFromGithub(projectId, files);

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

/**
 * Persiste en una única transacción IndexedDB un lote de archivos descargados desde GitHub.
 * Reduce las barreras de fsync secuenciales de N transacciones a 1 por lote.
 */
export async function cacheBatchGithubFileContents(projectId, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const db = await openDb();
  const now = Date.now();
  const missingItems = [];
  const savedResults = new Array(items.length).fill(null);

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FILES, "readwrite");
    const store = tx.objectStore(STORE_FILES);

    items.forEach((item, idx) => {
      const cleanPath = normalizePath(item?.path);
      if (!cleanPath) return;
      const key = makeFileKey(projectId, cleanPath);
      const contentOrBlob = item?.payload;
      const blobSha = item?.blobSha || null;
      const isBlobObj = Boolean(contentOrBlob && typeof contentOrBlob === "object");

      const req = store.get(key);
      req.onsuccess = () => {
        const existing = req.result;
        if (!existing) {
          missingItems.push({ idx, cleanPath, contentOrBlob, blobSha });
          return;
        }
        if (existing.deleted || existing.contentLoaded !== false) {
          savedResults[idx] = existing;
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
        existing.updatedAt = now;
        savedResults[idx] = existing;
        store.put(existing);
      };
    });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción batch de caché se canceló."));
  });

  for (const miss of missingItems) {
    const isBlobObj = Boolean(miss.contentOrBlob && typeof miss.contentOrBlob === "object");
    const nextIsBinary = isBlobObj && Boolean(miss.contentOrBlob.isBinary);
    const nextBase64 = nextIsBinary ? (miss.contentOrBlob.base64 ?? null) : null;
    const nextText = nextIsBinary
      ? ""
      : (isBlobObj ? String(miss.contentOrBlob.content ?? "") : String(miss.contentOrBlob ?? ""));
    savedResults[miss.idx] = await upsertEntry(projectId, miss.cleanPath, {
      isFolder: false,
      content: nextText,
      baseContent: nextText,
      fromGithub: true,
      blobSha: miss.blobSha,
      isBinary: nextIsBinary,
      base64: nextBase64,
      baseBase64: nextBase64,
      contentLoaded: true,
      skipIfDeleted: true
    });
  }

  return savedResults;
}

export async function markProjectOfflineCached(projectId, isCached = true) {
  await updateProjectRecord(projectId, (project) => {
    project.offlineCached = Boolean(isCached);
    project.updatedAt = Date.now();
  });
}

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

  const filePathSet = new Set(files.map((f) => normalizePath(f.path)));
  const firstPaths = files.slice(0, 3).map((f) => normalizePath(f.path));
  const preservedTabs = existingProject?.openTabIds?.filter((p) => filePathSet.has(p));
  const openTabIds = preservedTabs && preservedTabs.length > 0 ? preservedTabs : firstPaths;
  const project = {
    id: projectId,
    name: `${owner}/${repo} (${branch})`,
    kind: "github",
    github: { owner, repo, branch, commitSha },
    offlineCached: true,
    openTabIds,
    activeFileId: existingProject?.activeFileId || openTabIds[0] || null,
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
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("La transacción countPendingGithubChanges se canceló."));
  });
}

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
        base64: item.isBinary ? (item.base64 ?? null) : null
      });
    } else {
      changes.push({
        path: item.path,
        status: "modified",
        content: item.content,
        baseContent: item.baseContent || "",
        mode: item.mode || null,
        isBinary: Boolean(item.isBinary),
        base64: item.isBinary ? (item.base64 ?? null) : null
      });
    }
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

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
