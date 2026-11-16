import {
  clearEmergencyBackup,
  writeEmergencyBackup,
  getTabInstanceId
} from "../storage/emergencyBackup.js";
import { readStoredValue } from "../utils/storage.js";

const AUTOSAVE_STORAGE_KEY = "studio_autosave_delay";

/**
 * Administra temporizadores de autoguardado por archivo, volcado síncrono de emergencia
 * en `visibilitychange`/`pagehide`/`beforeunload` y descarga pendiente a IndexedDB.
 */
export function createAutosaveManager({
  getActiveProjectId,
  updateFileContent,
  setAutosaveStatus,
  refreshStorageIndicator,
  refreshTopbarBadge
}) {
  /** @type {Map<string, { timerId: number, projectId: string, filePath: string, content: string, inFlight: Promise<unknown> | null }>} */
  const saveTimers = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const inFlightByKey = new Map();
  const tabInstanceId = getTabInstanceId();
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = controller ? { signal: controller.signal } : undefined;
  let destroyed = false;
  const setTimer = typeof window !== "undefined" && typeof window.setTimeout === "function"
    ? window.setTimeout.bind(window)
    : setTimeout;
  const clearTimer = typeof window !== "undefined" && typeof window.clearTimeout === "function"
    ? window.clearTimeout.bind(window)
    : clearTimeout;

  function getAutosaveDelay() {
    const stored = readStoredValue(AUTOSAVE_STORAGE_KEY);
    if (stored === "manual") return -1;
    if (stored === "1000") return 1000;
    return 240;
  }

  function hasPendingSavesForProject(projectId) {
    if (!projectId) return false;
    for (const item of saveTimers.values()) {
      if (item && item.projectId === projectId) {
        return true;
      }
    }
    return false;
  }

  function clearProjectEmergencyBackupIfIdle(projectId) {
    if (!projectId || hasPendingSavesForProject(projectId)) return;
    if (typeof window !== "undefined" && window.localStorage) {
      clearEmergencyBackup(window.localStorage, projectId, tabInstanceId);
    }
  }

  function hasPendingTimer(projectId, filePath) {
    if (!projectId || !filePath) return false;
    return saveTimers.has(`${projectId}::${filePath}`);
  }

  function clearTimersForProject(projectId, predicate) {
    for (const [key, item] of [...saveTimers.entries()]) {
      if (item && item.projectId === projectId && predicate(item.filePath)) {
        if (item.timerId) {
          clearTimer(item.timerId);
        }
        saveTimers.delete(key);
      }
    }
  }

  async function runSaveItem(key, item) {
    if (item.inFlight) {
      return item.inFlight;
    }
    const prior = inFlightByKey.get(key) || null;
    const task = (async () => {
      if (prior) {
        try {
          await prior;
        } catch {
          // Continuar intentando persistir la versión más reciente
        }
      }
      await updateFileContent(item.projectId, item.filePath, item.content);
      if (saveTimers.get(key) === item) {
        saveTimers.delete(key);
      }
    })();
    item.inFlight = task;
    inFlightByKey.set(key, task);
    try {
      await task;
    } finally {
      if (item.inFlight === task) {
        item.inFlight = null;
      }
      if (inFlightByKey.get(key) === task) {
        inFlightByKey.delete(key);
      }
    }
  }

  function scheduleAutosave(projectId, filePath, content) {
    if (destroyed) return;
    const delay = getAutosaveDelay();
    const timerKey = `${projectId}::${filePath}`;
    const prev = saveTimers.get(timerKey);
    if (prev && prev.timerId) {
      clearTimer(prev.timerId);
    }

    if (delay < 0) {
      saveTimers.set(timerKey, { timerId: 0, projectId, filePath, content, inFlight: null });
      setAutosaveStatus?.("Modificado (Guardar con Cmd+S)");
      return;
    }

    setAutosaveStatus?.("Guardando…");
    const item = { timerId: 0, projectId, filePath, content, inFlight: null };
    item.timerId = setTimer(async () => {
      item.timerId = 0;
      if (destroyed) return;
      try {
        await runSaveItem(timerKey, item);
        clearProjectEmergencyBackupIfIdle(projectId);
        if (destroyed) return;
        setAutosaveStatus?.("Autoguardado en IndexedDB");
        refreshStorageIndicator?.();
        await refreshTopbarBadge?.();
      } catch (err) {
        if (destroyed) return;
        const isQuota = err && err.name === "QuotaExceededError";
        setAutosaveStatus?.(
          isQuota ? "Error: Almacenamiento local lleno" : "Error al guardar en IndexedDB"
        );
      }
    }, delay);

    saveTimers.set(timerKey, item);
  }

  async function flushFile(projectId, filePath) {
    const timerKey = `${projectId}::${filePath}`;
    const pending = saveTimers.get(timerKey);
    if (!pending) {
      const residual = inFlightByKey.get(timerKey);
      if (residual) {
        try {
          await residual;
          return true;
        } catch {
          return false;
        }
      }
      return true;
    }
    if (pending.timerId) {
      clearTimer(pending.timerId);
      pending.timerId = 0;
    }
    try {
      await runSaveItem(timerKey, pending);
      clearProjectEmergencyBackupIfIdle(pending.projectId);
      refreshStorageIndicator?.();
      await refreshTopbarBadge?.();
      return true;
    } catch (err) {
      const isQuota = err && err.name === "QuotaExceededError";
      setAutosaveStatus?.(
        isQuota
          ? "Almacenamiento lleno (QuotaExceededError). Exportá tu proyecto o liberá espacio."
          : "Error al guardar en IndexedDB"
      );
      return false;
    }
  }

  async function flushPendingSaves() {
    if (saveTimers.size === 0 && inFlightByKey.size === 0) return true;
    const entries = [...saveTimers.entries()];
    const flushedProjectIds = new Set();
    const failedProjectIds = new Set();
    let hadQuotaError = false;
    let hadError = false;

    for (const [key, item] of entries) {
      if (item && item.timerId) {
        clearTimer(item.timerId);
        item.timerId = 0;
      }
      if (item && item.projectId && item.filePath && typeof item.content === "string") {
        try {
          await runSaveItem(key, item);
          flushedProjectIds.add(item.projectId);
        } catch (err) {
          hadError = true;
          if (err && err.name === "QuotaExceededError") {
            hadQuotaError = true;
          }
          failedProjectIds.add(item.projectId);
        }
      } else if (saveTimers.get(key) === item) {
        saveTimers.delete(key);
      }
    }

    for (const pid of flushedProjectIds) {
      if (!failedProjectIds.has(pid)) {
        clearProjectEmergencyBackupIfIdle(pid);
      }
    }

    if (inFlightByKey.size > 0) {
      await Promise.allSettled([...inFlightByKey.values()]);
    }

    if (hadError) {
      if (!destroyed) {
        setAutosaveStatus?.(
          hadQuotaError
            ? "Almacenamiento lleno (QuotaExceededError). Exportá tu proyecto o liberá espacio."
            : "Error al guardar en IndexedDB"
        );
      }
      return false;
    }
    if (saveTimers.size === 0 && !destroyed) {
      setAutosaveStatus?.("Autoguardado en IndexedDB");
      refreshStorageIndicator?.();
      await refreshTopbarBadge?.();
    }
    return true;
  }

  let isFlushingBackup = false;

  function backupAndFlush() {
    if (destroyed || saveTimers.size === 0) return;
    const storage = typeof window !== "undefined" ? window.localStorage : null;
    if (storage) {
      const byProject = new Map();
      for (const item of saveTimers.values()) {
        if (!item || !item.projectId || !item.filePath || typeof item.content !== "string") continue;
        let list = byProject.get(item.projectId);
        if (!list) {
          list = [];
          byProject.set(item.projectId, list);
        }
        list.push(item);
      }
      for (const [pid, items] of byProject.entries()) {
        writeEmergencyBackup(items, storage, pid, tabInstanceId);
      }
    }
    if (isFlushingBackup) return;
    isFlushingBackup = true;
    const currentPid = getActiveProjectId?.() || null;
    void flushPendingSaves()
      .then((ok) => {
        if (ok && saveTimers.size === 0 && storage) {
          if (currentPid) {
            clearEmergencyBackup(storage, currentPid, tabInstanceId);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        isFlushingBackup = false;
      });
  }

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        backupAndFlush();
      }
    }, listenOpts);
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", backupAndFlush, listenOpts);
    window.addEventListener("beforeunload", backupAndFlush, listenOpts);
  }

  return {
    scheduleAutosave,
    flushPendingSaves,
    flushFile,
    backupAndFlush,
    hasPendingTimer,
    clearTimersForProject,
    destroy() {
      destroyed = true;
      controller?.abort();
      for (const item of saveTimers.values()) {
        if (item?.timerId) {
          clearTimer(item.timerId);
        }
      }
      saveTimers.clear();
    }
  };
}
