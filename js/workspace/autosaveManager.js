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
  /** @type {Map<string, { timerId: number, projectId: string, filePath: string, content: string }>} */
  const saveTimers = new Map();
  const tabInstanceId = getTabInstanceId();
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = controller ? { signal: controller.signal } : undefined;

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
          window.clearTimeout(item.timerId);
        }
        saveTimers.delete(key);
      }
    }
  }

  function scheduleAutosave(projectId, filePath, content) {
    const delay = getAutosaveDelay();
    const timerKey = `${projectId}::${filePath}`;
    const prev = saveTimers.get(timerKey);
    if (prev && prev.timerId) {
      window.clearTimeout(prev.timerId);
    }

    if (delay < 0) {
      saveTimers.set(timerKey, { timerId: 0, projectId, filePath, content });
      setAutosaveStatus?.("Modificado (Guardar con Cmd+S)");
      return;
    }

    setAutosaveStatus?.("Guardando…");
    const item = { timerId: 0, projectId, filePath, content };
    item.timerId = window.setTimeout(async () => {
      item.timerId = 0;
      try {
        await updateFileContent(projectId, filePath, content);
        if (saveTimers.get(timerKey) === item) {
          saveTimers.delete(timerKey);
        }
        clearProjectEmergencyBackupIfIdle(projectId);
        setAutosaveStatus?.("Autoguardado en IndexedDB");
        refreshStorageIndicator?.();
        await refreshTopbarBadge?.();
      } catch (err) {
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
    if (!pending) return;
    if (pending.timerId) {
      window.clearTimeout(pending.timerId);
      pending.timerId = 0;
    }
    await updateFileContent(pending.projectId, pending.filePath, pending.content);
    if (saveTimers.get(timerKey) === pending) {
      saveTimers.delete(timerKey);
    }
    clearProjectEmergencyBackupIfIdle(pending.projectId);
  }

  async function flushPendingSaves() {
    if (saveTimers.size === 0) return;
    const entries = [...saveTimers.entries()];
    const flushedProjectIds = new Set();
    for (const [key, item] of entries) {
      if (item && item.timerId) {
        window.clearTimeout(item.timerId);
        item.timerId = 0;
      }
      if (item && item.projectId && item.filePath && typeof item.content === "string") {
        await updateFileContent(item.projectId, item.filePath, item.content);
        flushedProjectIds.add(item.projectId);
      }
      if (saveTimers.get(key) === item) {
        saveTimers.delete(key);
      }
    }
    for (const pid of flushedProjectIds) {
      clearProjectEmergencyBackupIfIdle(pid);
    }
    setAutosaveStatus?.("Autoguardado en IndexedDB");
  }

  function backupAndFlush() {
    if (saveTimers.size === 0) return;
    const currentPid = getActiveProjectId?.() || null;
    if (typeof window !== "undefined" && window.localStorage) {
      writeEmergencyBackup([...saveTimers.values()], window.localStorage, currentPid, tabInstanceId);
    }
    void flushPendingSaves().then(() => {
      if (saveTimers.size === 0 && typeof window !== "undefined" && window.localStorage) {
        clearEmergencyBackup(window.localStorage, currentPid, tabInstanceId);
      }
    });
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        backupAndFlush();
      }
    }, listenOpts);
  }
  if (typeof window !== "undefined") {
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
      controller?.abort();
      for (const item of saveTimers.values()) {
        if (item?.timerId) {
          window.clearTimeout(item.timerId);
        }
      }
      saveTimers.clear();
    }
  };
}
