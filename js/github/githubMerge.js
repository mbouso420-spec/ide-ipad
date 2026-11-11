import { normalizePath } from "../storage/workspaceDb.js";

/**
 * Clasifica los cambios remotos (entre base y HEAD remoto) frente a los cambios
 * locales pendientes en Studio IDE para permitir un Pull inteligente sin sobrescribir
 * ediciones locales no conflictivas.
 *
 * @param {{
 *   localEntries?: Array<{ path: string, contentLoaded?: boolean }>,
 *   localPendingChanges?: Array<{ path: string, status: string, content?: string, baseContent?: string }>,
 *   remoteDiffFiles?: Array<{ path: string, previousPath?: string | null, status: string, blobSha?: string | null }>
 * }} params
 * @returns {{
 *   safeUpdates: Array<{ path: string, status: string, blobSha: string | null }>,
 *   safeDeletions: Array<{ path: string, status: string }>,
 *   conflicts: Array<{
 *     path: string,
 *     remoteStatus: string,
 *     localStatus: string,
 *     blobSha: string | null,
 *     resolution: "keep-local" | "take-remote"
 *   }>
 * }}
 */
export function classifyRemotePullChanges({
  localEntries = [],
  localPendingChanges = [],
  remoteDiffFiles = []
}) {
  const localPendingByPath = new Map();
  for (const ch of localPendingChanges) {
    const p = normalizePath(ch?.path);
    if (p) localPendingByPath.set(p, ch);
  }

  const localEntryByPath = new Map();
  for (const entry of localEntries) {
    if (!entry || entry.isFolder) continue;
    const p = normalizePath(entry.path);
    if (p) localEntryByPath.set(p, entry);
  }

  const safeUpdates = [];
  const safeDeletions = [];
  const conflicts = [];
  const seenConflictPaths = new Set();

  function recordConflict(path, remoteStatus, localStatus, blobSha = null) {
    if (seenConflictPaths.has(path)) return;
    seenConflictPaths.add(path);
    conflicts.push({
      path,
      remoteStatus,
      localStatus,
      blobSha: blobSha || null,
      resolution: "keep-local"
    });
  }

  for (const file of remoteDiffFiles) {
    if (!file || !file.path) continue;
    const status = String(file.status || "").toLowerCase();
    const cleanPath = normalizePath(file.path);
    if (!cleanPath) continue;

    if (status === "renamed") {
      const prevPath = normalizePath(file.previousPath || "");
      if (prevPath) {
        const localPrev = localPendingByPath.get(prevPath);
        if (localPrev) {
          recordConflict(prevPath, "removed", localPrev.status, null);
        } else if (localEntryByPath.has(prevPath)) {
          safeDeletions.push({ path: prevPath, status: "removed" });
        }
      }

      const localDest = localPendingByPath.get(cleanPath);
      if (localDest) {
        recordConflict(cleanPath, "added", localDest.status, file.blobSha || null);
      } else {
        safeUpdates.push({
          path: cleanPath,
          status: "added",
          blobSha: file.blobSha || null
        });
      }
      continue;
    }

    if (status === "removed") {
      const localPending = localPendingByPath.get(cleanPath);
      if (localPending) {
        if (localPending.status === "deleted") {
          // Ambos borraron el mismo archivo: limpiar registro sin conflicto
          safeDeletions.push({ path: cleanPath, status: "removed" });
        } else {
          recordConflict(cleanPath, "removed", localPending.status, null);
        }
      } else {
        safeDeletions.push({ path: cleanPath, status: "removed" });
      }
      continue;
    }

    // added / modified / changed
    const localPending = localPendingByPath.get(cleanPath);
    if (localPending) {
      recordConflict(cleanPath, status || "modified", localPending.status, file.blobSha || null);
    } else {
      safeUpdates.push({
        path: cleanPath,
        status: status || "modified",
        blobSha: file.blobSha || null
      });
    }
  }

  safeUpdates.sort((a, b) => a.path.localeCompare(b.path));
  safeDeletions.sort((a, b) => a.path.localeCompare(b.path));
  conflicts.sort((a, b) => a.path.localeCompare(b.path));

  return {
    safeUpdates,
    safeDeletions,
    conflicts
  };
}

/**
 * Construye el plan transaccional de Pull e integración descargando únicamente
 * los blobs remotos necesarios (respeta proyectos lazy para archivos no abiertos).
 *
 * @param {{
 *   project: { offlineCached?: boolean },
 *   localEntries: Array<{ path: string, contentLoaded?: boolean }>,
 *   classification: ReturnType<typeof classifyRemotePullChanges>,
 *   newCommitSha: string,
 *   fetchBlob: (blobSha: string, path: string) => Promise<string>
 * }} params
 */
export async function buildRemotePullPlan({
  project,
  localEntries = [],
  classification,
  newCommitSha,
  fetchBlob
}) {
  const localByPath = new Map();
  for (const entry of localEntries) {
    if (!entry || entry.isFolder) continue;
    const p = normalizePath(entry.path);
    if (p) localByPath.set(p, entry);
  }

  const updates = [];
  const deletions = (classification?.safeDeletions || []).map((d) => d.path);
  const keepLocalRebases = [];
  const offlineFull = Boolean(project?.offlineCached);

  for (const item of classification?.safeUpdates || []) {
    const existing = localByPath.get(item.path);
    const shouldFetchContent = Boolean(
      item.blobSha &&
        typeof fetchBlob === "function" &&
        (offlineFull || (existing && existing.contentLoaded !== false))
    );

    if (shouldFetchContent) {
      const content = await fetchBlob(item.blobSha, item.path);
      updates.push({
        path: item.path,
        blobSha: item.blobSha,
        content,
        contentLoaded: true
      });
    } else if (item.blobSha) {
      updates.push({
        path: item.path,
        blobSha: item.blobSha,
        content: "",
        contentLoaded: false
      });
    }
  }

  for (const conflict of classification?.conflicts || []) {
    const choice = conflict.resolution === "take-remote" ? "take-remote" : "keep-local";
    if (choice === "take-remote") {
      if (conflict.remoteStatus === "removed") {
        deletions.push(conflict.path);
      } else if (conflict.blobSha && typeof fetchBlob === "function") {
        const remoteContent = await fetchBlob(conflict.blobSha, conflict.path);
        updates.push({
          path: conflict.path,
          blobSha: conflict.blobSha,
          content: remoteContent,
          contentLoaded: true
        });
      }
      continue;
    }

    // Conservar edición local: reanclar baseContent / estado de tracking al nuevo commit remoto
    if (conflict.remoteStatus === "removed") {
      keepLocalRebases.push({
        path: conflict.path,
        remoteRemoved: true,
        remoteBlobSha: null,
        remoteContent: null
      });
    } else {
      let remoteContent = null;
      if (
        conflict.blobSha &&
        conflict.localStatus !== "deleted" &&
        typeof fetchBlob === "function"
      ) {
        remoteContent = await fetchBlob(conflict.blobSha, conflict.path);
      }
      keepLocalRebases.push({
        path: conflict.path,
        remoteRemoved: false,
        remoteBlobSha: conflict.blobSha || null,
        remoteContent
      });
    }
  }

  return {
    newCommitSha,
    updates,
    deletions: Array.from(new Set(deletions)),
    keepLocalRebases
  };
}
