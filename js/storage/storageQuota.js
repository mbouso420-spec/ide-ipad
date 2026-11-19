/**
 * Consulta de almacenamiento persistente, estimación de cuota en el navegador
 * y evicción inteligente de caché limpia de GitHub cuando sube la presión de cuota.
 */

import {
  STORE_FILES,
  STORE_PROJECTS,
  openDbTransaction,
  resolveTxError,
  resolveEntryBaselineBase64
} from "./db/dbCore.js";

/**
 * Formatea un tamaño en bytes a una representación legible (B, KB, MB, GB).
 * @param {number} bytes
 * @returns {string}
 */
export function formatStorageBytes(bytes) {
  const num = Number(bytes);
  const n = Number.isFinite(num) ? Math.max(0, num) : 0;
  if (n < 1024) return `${Math.round(n)} B`;
  const kb = n / 1024;
  if (kb < 1023.95) return `${kb.toFixed(1)} KB`;
  const mb = n / (1024 * 1024);
  if (mb < 1023.95) return `${mb.toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Consulta de forma segura la cuota y uso actual de almacenamiento en el origen.
 * @returns {Promise<{
 *   supported: boolean,
 *   usageBytes: number,
 *   quotaBytes: number,
 *   usageFormatted: string,
 *   quotaFormatted: string,
 *   percentage: number,
 *   pressure: "ok" | "warning" | "critical"
 * }>}
 */
export async function getStorageQuotaEstimate() {
  try {
    const storageApi = typeof navigator !== "undefined" ? navigator.storage : null;
    if (storageApi && typeof storageApi.estimate === "function") {
      const estimate = await storageApi.estimate();
      const rawUsage = Number(estimate?.usage);
      const rawQuota = Number(estimate?.quota);
      const usage = Number.isFinite(rawUsage) ? Math.max(0, rawUsage) : 0;
      const quota = Number.isFinite(rawQuota) ? Math.max(0, rawQuota) : 0;
      const percentage = quota > 0 ? Math.min(100, Math.round((usage / quota) * 100)) : 0;
      const pressure = percentage >= 90 ? "critical" : percentage >= 75 ? "warning" : "ok";
      return {
        supported: true,
        usageBytes: usage,
        quotaBytes: quota,
        usageFormatted: formatStorageBytes(usage),
        quotaFormatted: formatStorageBytes(quota),
        percentage,
        pressure
      };
    }
  } catch {
    // Entornos donde navigator.storage o estimate() estén restringidos por permisos de iframe/sandbox
  }

  return {
    supported: false,
    usageBytes: 0,
    quotaBytes: 0,
    usageFormatted: "—",
    quotaFormatted: "—",
    percentage: 0,
    pressure: "ok"
  };
}

function estimateCachedEntryBytes(entry) {
  if (!entry) return 0;
  let bytes = 0;
  if (typeof entry.content === "string") bytes += entry.content.length * 2;
  if (typeof entry.baseContent === "string") bytes += entry.baseContent.length * 2;
  if (typeof entry.base64 === "string") bytes += entry.base64.length;
  if (typeof entry.baseBase64 === "string") bytes += entry.baseBase64.length;
  return bytes;
}

function isCleanEvictableGithubEntry(entry, excludeProjectId) {
  if (!entry || entry.isFolder || entry.deleted) return false;
  if (entry.projectId === "__system__") return false;
  if (excludeProjectId && entry.projectId === excludeProjectId) return false;
  if (!entry.trackedInGithub || !entry.blobSha || entry.contentLoaded === false) return false;
  if (entry.forceModified) return false;
  if (entry.content !== entry.baseContent) return false;
  const curBase64 = entry.isBinary ? (entry.base64 ?? null) : null;
  if (curBase64 !== resolveEntryBaselineBase64(entry)) return false;
  return estimateCachedEntryBytes(entry) > 0;
}

/**
 * Libera contenido en caché de archivos de GitHub sin cambios locales pendientes
 * (evicción LRU por `updatedAt`), marcándolos como `contentLoaded = false` para re-descarga bajo demanda.
 * Nunca toca ediciones sin sincronizar ni proyectos locales.
 * @param {{ excludeProjectId?: string | null, targetBytes?: number }} [options]
 * @returns {Promise<{ evictedCount: number, freedBytes: number }>}
 */
export async function evictCleanGithubCache({ excludeProjectId = null, targetBytes = 0 } = {}) {
  const candidates = await openDbTransaction(
    STORE_FILES,
    "readonly",
    (tx) =>
      new Promise((resolve, reject) => {
        const list = [];
        const req = tx.objectStore(STORE_FILES).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(list);
            return;
          }
          const entry = cursor.value;
          if (isCleanEvictableGithubEntry(entry, excludeProjectId)) {
            list.push({
              key: entry.key,
              updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
              bytes: estimateCachedEntryBytes(entry)
            });
          }
          cursor.continue();
        };
        req.onerror = (ev) => reject(resolveTxError(ev, tx, "Error escaneando caché de GitHub."));
        tx.onerror = (ev) => reject(resolveTxError(ev, tx, "Error en escaneo de caché."));
        tx.onabort = (ev) => reject(resolveTxError(ev, tx, "Escaneo de caché cancelado."));
      })
  );

  if (candidates.length === 0) {
    return { evictedCount: 0, freedBytes: 0, affectedProjectIds: [] };
  }

  candidates.sort((a, b) => a.updatedAt - b.updatedAt);

  const selectedKeys = [];
  let plannedBytes = 0;
  for (const item of candidates) {
    selectedKeys.push(item.key);
    plannedBytes += item.bytes;
    if (targetBytes > 0 && plannedBytes >= targetBytes) {
      break;
    }
  }

  let evictedCount = 0;
  let freedBytes = 0;
  const affectedProjectIds = new Set();

  await openDbTransaction(
    [STORE_FILES, STORE_PROJECTS],
    "readwrite",
    (tx) =>
      new Promise((resolve, reject) => {
        const fileStore = tx.objectStore(STORE_FILES);
        const projectStore = tx.objectStore(STORE_PROJECTS);
        let remainingGets = selectedKeys.length;

        const invalidateAffectedProjects = () => {
          for (const pid of affectedProjectIds) {
            const pReq = projectStore.get(pid);
            pReq.onsuccess = () => {
              const proj = pReq.result;
              if (proj && proj.offlineCached) {
                proj.offlineCached = false;
                projectStore.put(proj);
              }
            };
            pReq.onerror = (ev) =>
              reject(resolveTxError(ev, tx, "Error actualizando estado offline del proyecto tras evicción."));
          }
        };

        for (const key of selectedKeys) {
          const req = fileStore.get(key);
          req.onsuccess = () => {
            const latest = req.result;
            if (isCleanEvictableGithubEntry(latest, excludeProjectId)) {
              const bytes = estimateCachedEntryBytes(latest);
              latest.content = "";
              latest.baseContent = "";
              latest.base64 = null;
              latest.baseBase64 = null;
              latest.contentLoaded = false;
              fileStore.put(latest);
              evictedCount += 1;
              freedBytes += bytes;
              if (latest.projectId) {
                affectedProjectIds.add(latest.projectId);
              }
            }
            remainingGets -= 1;
            if (remainingGets === 0 && affectedProjectIds.size > 0) {
              invalidateAffectedProjects();
            }
          };
          req.onerror = (ev) => reject(resolveTxError(ev, tx, "Error leyendo entrada durante evicción."));
        }
        tx.oncomplete = () => resolve();
        tx.onerror = (ev) => reject(resolveTxError(ev, tx, "Error durante evicción de caché."));
        tx.onabort = (ev) => reject(resolveTxError(ev, tx, "Evicción de caché cancelada."));
      })
  );

  return { evictedCount, freedBytes, affectedProjectIds: [...affectedProjectIds] };
}
