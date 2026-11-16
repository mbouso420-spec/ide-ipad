/**
 * Respaldo de emergencia para no perder lo último escrito si la página se cierra o recarga
 * antes de que el autoguardado asíncrono en IndexedDB termine (Safari en iPadOS puede matar la pestaña).
 *
 * localStorage es síncrono: lo que se escribe en pagehide/visibilitychange queda guardado aunque
 * el navegador destruya la página en el instante siguiente. Al abrir la app se vuelca a IndexedDB.
 *
 * Soporta particionamiento por proyecto e instancia de pestaña:
 * studio_ide_emergency_backup_${projectId}_${tabInstanceId}
 * Evita colisiones si el usuario mantiene múltiples pestañas abiertas simultáneamente,
 * incluso sobre el mismo proyecto.
 */
export const EMERGENCY_BACKUP_KEY = "ide.emergencyBackup.v1";
export const EMERGENCY_BACKUP_PREFIX = "studio_ide_emergency_backup_";

let memoryTabId = null;

/**
 * Obtiene o inicializa un identificador único para la pestaña/instancia actual.
 * En navegador utiliza sessionStorage para sobrevivir a recargas en la misma pestaña
 * mientras aísla pestañas concurrentes.
 * @returns {string}
 */
export function getTabInstanceId() {
  if (typeof window !== "undefined" && window.sessionStorage) {
    try {
      let id = window.sessionStorage.getItem("studio_ide_tab_instance_id");
      if (!id) {
        id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID().slice(0, 8)
          : Math.random().toString(36).slice(2, 10);
        window.sessionStorage.setItem("studio_ide_tab_instance_id", id);
      }
      return id;
    } catch (_) {}
  }
  if (!memoryTabId) {
    memoryTabId = Math.random().toString(36).slice(2, 10);
  }
  return memoryTabId;
}

/**
 * Obtiene la clave de almacenamiento para un proyecto e instancia o la clave por defecto.
 * @param {string|null} [projectId]
 * @param {string|null} [instanceId]
 * @returns {string}
 */
export function getEmergencyBackupKey(projectId = null, instanceId = null) {
  if (!projectId) return EMERGENCY_BACKUP_KEY;
  return instanceId
    ? `${EMERGENCY_BACKUP_PREFIX}${projectId}_${instanceId}`
    : `${EMERGENCY_BACKUP_PREFIX}${projectId}`;
}

function getAllStorageKeys(storage) {
  if (!storage) return [];
  try {
    if (typeof storage.length === "number") {
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k) keys.push(k);
      }
      if (keys.length > 0) return keys;
    }
  } catch (_) {}

  try {
    return Object.keys(storage);
  } catch (_) {
    return [];
  }
}

function getDefaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function doesBackupKeyBelongToProject(storage, key, projectId) {
  if (!key || !projectId) return false;
  if (key === getEmergencyBackupKey(projectId)) return true;
  if (!key.startsWith(`${EMERGENCY_BACKUP_PREFIX}${projectId}_`)) return false;
  const payload = parseBackupPayload(storage.getItem(key));
  if (payload.projectId) {
    return payload.projectId === projectId;
  }
  return payload.items.some((it) => it.projectId === projectId);
}

function parseBackupPayload(raw) {
  if (!raw) return { savedAt: 0, projectId: null, items: [] };
  try {
    const parsed = JSON.parse(raw);
    const savedAt = typeof parsed?.savedAt === "number" && Number.isFinite(parsed.savedAt) && parsed.savedAt > 0
      ? parsed.savedAt
      : 0;
    const projectId = typeof parsed?.projectId === "string" && parsed.projectId ? parsed.projectId : null;
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return {
      savedAt,
      projectId,
      items: items.filter(
        (it) => it && typeof it.projectId === "string" && typeof it.filePath === "string" && typeof it.content === "string"
      )
    };
  } catch {
    return { savedAt: 0, projectId: null, items: [] };
  }
}

function parseBackupItems(raw) {
  return parseBackupPayload(raw).items;
}

const MAX_EMERGENCY_BACKUP_CHARS = 2 * 1024 * 1024;

/**
 * @param {Array<{ projectId: string, filePath: string, content: string }>} items
 * @param {Storage} [storage]
 * @param {string|null} [projectId]
 * @param {string|null} [instanceId]
 * @returns {boolean} true si quedó escrito
 */
export function writeEmergencyBackup(items, storage = getDefaultStorage(), projectId = null, instanceId = null) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    return false;
  }
  const clean = (Array.isArray(items) ? items : []).filter(
    (it) => it && typeof it.projectId === "string" && typeof it.filePath === "string" && typeof it.content === "string"
  );
  const targetKey = getEmergencyBackupKey(projectId, instanceId);

  try {
    if (clean.length === 0) {
      storage.removeItem(targetKey);
      return true;
    }

    // Evita serializar respaldos masivos en localStorage (~5 MB por origen); el autoguardado en IDB cubre archivos grandes.
    let estimatedChars = 128;
    for (const it of clean) {
      estimatedChars += it.projectId.length + it.filePath.length + it.content.length + 64;
      if (estimatedChars > MAX_EMERGENCY_BACKUP_CHARS) {
        return false;
      }
    }

    const payloadStr = JSON.stringify({
      savedAt: Date.now(),
      projectId: projectId || null,
      instanceId: instanceId || null,
      items: clean.map(({ projectId: p, filePath, content }) => ({ projectId: p, filePath, content }))
    });
    if (payloadStr.length > MAX_EMERGENCY_BACKUP_CHARS) {
      return false;
    }
    try {
      storage.setItem(targetKey, payloadStr);
      return true;
    } catch {
      const staleCandidates = getAllStorageKeys(storage)
        .filter((k) => k && k.startsWith(EMERGENCY_BACKUP_PREFIX) && k !== targetKey)
        .map((k) => ({ key: k, savedAt: parseBackupPayload(storage.getItem(k)).savedAt }))
        .sort((a, b) => a.savedAt - b.savedAt);

      for (const stale of staleCandidates) {
        try {
          storage.removeItem(stale.key);
          storage.setItem(targetKey, payloadStr);
          return true;
        } catch (_) {
          // Seguir liberando particiones antiguas hasta recuperar espacio
        }
      }
      return false;
    }
  } catch {
    // Almacenamiento completamente bloqueado: queda el autoguardado normal como única vía.
    return false;
  }
}

/**
 * @param {Storage} [storage]
 * @param {string|null} [projectId]
 * @param {string|null} [instanceId]
 * @returns {Array<{ projectId: string, filePath: string, content: string }>}
 */
export function readEmergencyBackup(storage = getDefaultStorage(), projectId = null, instanceId = null) {
  if (!storage || typeof storage.getItem !== "function") return [];
  const dedupByKey = new Map();
  const collect = (raw, filterPid = null) => {
    const payload = parseBackupPayload(raw);
    for (const item of payload.items) {
      if (filterPid && item.projectId !== filterPid) continue;
      const k = `${item.projectId}::${item.filePath}`;
      const prev = dedupByKey.get(k);
      if (!prev || payload.savedAt >= prev.savedAt) {
        dedupByKey.set(k, { savedAt: payload.savedAt, item });
      }
    }
  };

  if (projectId && instanceId) {
    const targetKey = getEmergencyBackupKey(projectId, instanceId);
    collect(storage.getItem(targetKey), projectId);
    if (dedupByKey.size === 0) {
      collect(storage.getItem(getEmergencyBackupKey(projectId)), projectId);
    }
    if (dedupByKey.size === 0) {
      collect(storage.getItem(EMERGENCY_BACKUP_KEY), projectId);
    }
    return [...dedupByKey.values()].map((v) => v.item);
  }

  if (projectId && !instanceId) {
    collect(storage.getItem(getEmergencyBackupKey(projectId)), projectId);

    const keys = getAllStorageKeys(storage);
    for (const k of keys) {
      if (doesBackupKeyBelongToProject(storage, k, projectId)) {
        collect(storage.getItem(k), projectId);
      }
    }

    if (dedupByKey.size > 0) {
      return [...dedupByKey.values()].map((v) => v.item);
    }

    collect(storage.getItem(EMERGENCY_BACKUP_KEY), projectId);
    return [...dedupByKey.values()].map((v) => v.item);
  }

  // Si no se especifica proyecto ni instancia, agregar clave legado y todas las particiones existentes
  // resolviendo colisiones entre pestañas a favor del timestamp más reciente.
  collect(storage.getItem(EMERGENCY_BACKUP_KEY));

  const keys = getAllStorageKeys(storage);
  for (const k of keys) {
    if (k && k.startsWith(EMERGENCY_BACKUP_PREFIX)) {
      collect(storage.getItem(k));
    }
  }

  return [...dedupByKey.values()].map((v) => v.item);
}

/**
 * @param {Storage} [storage]
 * @param {string|null} [projectId]
 * @param {string|null} [instanceId]
 */
export function clearEmergencyBackup(storage = getDefaultStorage(), projectId = null, instanceId = null) {
  if (!storage || typeof storage.removeItem !== "function") return;
  try {
    if (projectId && instanceId) {
      storage.removeItem(getEmergencyBackupKey(projectId, instanceId));
      return;
    }
    if (projectId && !instanceId) {
      storage.removeItem(getEmergencyBackupKey(projectId));
      const keys = getAllStorageKeys(storage);
      for (const k of keys) {
        if (doesBackupKeyBelongToProject(storage, k, projectId)) {
          storage.removeItem(k);
        }
      }
      return;
    }
    storage.removeItem(EMERGENCY_BACKUP_KEY);
    const keys = getAllStorageKeys(storage);
    for (const k of keys) {
      if (k && k.startsWith(EMERGENCY_BACKUP_PREFIX)) {
        storage.removeItem(k);
      }
    }
  } catch {
    // Ignorar errores de almacenamiento restringido
  }
}

async function readInitialDbRecord(db, projectId, filePath, recordCache, projectEntriesCache) {
  const cacheKey = `${projectId}::${filePath}`;
  if (recordCache.has(cacheKey)) {
    return recordCache.get(cacheKey);
  }

  let record = null;
  if (typeof db.getEntryRecord === "function") {
    record = await db.getEntryRecord(projectId, filePath);
  } else if (typeof db.getFileRecord === "function") {
    record = await db.getFileRecord(projectId, filePath);
  } else if (typeof db.getEntry === "function") {
    record = await db.getEntry(projectId, filePath);
  } else if (typeof db.getRecord === "function") {
    record = await db.getRecord(projectId, filePath);
  } else if (typeof db.getProjectEntries === "function") {
    let byPath = projectEntriesCache.get(projectId);
    if (!byPath) {
      const list = await db.getProjectEntries(projectId);
      byPath = new Map();
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (entry && typeof entry.path === "string" && !entry.isFolder) {
            byPath.set(entry.path, entry);
          }
        }
      }
      projectEntriesCache.set(projectId, byPath);
    }
    const cleanPath = String(filePath || "").replace(/^\/+/, "");
    record = byPath.get(cleanPath) || byPath.get(filePath) || null;
  }

  recordCache.set(cacheKey, record || null);
  return record || null;
}

function hasRecordReader(db) {
  return Boolean(
    db &&
      (typeof db.getEntryRecord === "function" ||
        typeof db.getFileRecord === "function" ||
        typeof db.getEntry === "function" ||
        typeof db.getRecord === "function" ||
        typeof db.getProjectEntries === "function")
  );
}

async function applySnapshotAndCleanup(db, storage, snap, recordCache, projectEntriesCache, filterProjectId = null) {
  let restored = 0;
  const canReadRecord = hasRecordReader(db);
  if (!db || typeof db.updateFileContent !== "function" || (!canReadRecord && typeof db.entryExists !== "function")) {
    return 0;
  }
  const itemsToApply = filterProjectId
    ? snap.items.filter((it) => it.projectId === filterProjectId)
    : snap.items;

  if (itemsToApply.length > 0) {
    for (const item of itemsToApply) {
      if (canReadRecord) {
        // Una única lectura por snapshot/archivo: evita duplicar viajes a IndexedDB (entryExists + getEntryRecord).
        const record = await readInitialDbRecord(
          db,
          item.projectId,
          item.filePath,
          recordCache,
          projectEntriesCache
        );
        if (!record || record.deleted || record.isFolder || record.isBinary || record.encoding === "base64") {
          continue;
        }
        if (
          snap.savedAt > 0 &&
          typeof record.updatedAt === "number" &&
          Number.isFinite(record.updatedAt) &&
          snap.savedAt < record.updatedAt
        ) {
          continue;
        }
      } else {
        if (!(await db.entryExists(item.projectId, item.filePath))) {
          continue;
        }
      }

      const updated = await db.updateFileContent(item.projectId, item.filePath, item.content);
      if (updated === null || (updated && (updated.deleted || updated.isFolder || updated.isBinary || updated.encoding === "base64"))) {
        continue;
      }
      restored += 1;
    }
  }

  // Solo eliminar o actualizar la clave si no fue modificada concurrentemente mientras corrían los await.
  try {
    if (storage.getItem(snap.key) === snap.raw) {
      const remainingItems = filterProjectId
        ? snap.items.filter((it) => it.projectId !== filterProjectId)
        : [];
      if (remainingItems.length > 0) {
        storage.setItem(
          snap.key,
          JSON.stringify({
            savedAt: snap.savedAt || Date.now(),
            projectId: snap.projectId || null,
            instanceId: null,
            items: remainingItems
          })
        );
      } else {
        storage.removeItem(snap.key);
      }
    }
  } catch (_) {
    /* entorno restringido sin escritura */
  }

  return restored;
}

/**
 * Vuelca a IndexedDB el respaldo pendiente (si existe) y lo borra solo cuando todo quedó guardado.
 * Nunca recrea archivos que ya no existen (p. ej. borrados en otra pestaña) ni pisa registros más recientes.
 * @param {{ entryExists: (projectId: string, path: string) => Promise<boolean>, updateFileContent: (projectId: string, path: string, content: string) => Promise<unknown>, getEntryRecord?: (projectId: string, path: string) => Promise<any>, getProjectEntries?: (projectId: string) => Promise<Array<any>> }} db
 * @param {Storage} [storage]
 * @param {string|null} [projectId]
 * @param {string|null} [instanceId]
 * @returns {Promise<number>} cantidad de archivos recuperados
 */
export async function restoreEmergencyBackup(db, storage = getDefaultStorage(), projectId = null, instanceId = null) {
  if (!storage || typeof storage.getItem !== "function") return 0;
  const recordCache = new Map();
  const projectEntriesCache = new Map();

  // 1. Si se especifica projectId e instanceId puntual, restaurar y limpiar solo esa clave
  if (projectId && instanceId) {
    const key = getEmergencyBackupKey(projectId, instanceId);
    const raw = storage.getItem(key);
    if (!raw) return 0;
    const payload = parseBackupPayload(raw);
    if (payload.projectId && payload.projectId !== projectId) return 0;
    return applySnapshotAndCleanup(
      db,
      storage,
      { key, raw, savedAt: payload.savedAt, projectId: payload.projectId, items: payload.items },
      recordCache,
      projectEntriesCache,
      projectId
    );
  }

  // 2. Si es restauración global o por proyecto:
  // Tomar un snapshot exacto de las claves existentes al inicio para evitar que una escritura
  // concurrente de otra pestaña activa sea eliminada accidentalmente.
  const targetKeys = [];
  if (!projectId && storage.getItem(EMERGENCY_BACKUP_KEY)) {
    targetKeys.push(EMERGENCY_BACKUP_KEY);
  } else if (projectId) {
    const legacy = parseBackupItems(storage.getItem(EMERGENCY_BACKUP_KEY));
    if (legacy.some((it) => it.projectId === projectId)) {
      targetKeys.push(EMERGENCY_BACKUP_KEY);
    }
  }

  const allKeys = getAllStorageKeys(storage);
  for (const k of allKeys) {
    if (k && k.startsWith(EMERGENCY_BACKUP_PREFIX)) {
      if (!projectId || doesBackupKeyBelongToProject(storage, k, projectId)) {
        targetKeys.push(k);
      }
    }
  }

  if (targetKeys.length === 0) {
    return 0;
  }

  const snapshots = targetKeys.map((key, index) => {
    const raw = storage.getItem(key);
    const payload = parseBackupPayload(raw);
    return {
      key,
      raw,
      index,
      savedAt: payload.savedAt,
      projectId: payload.projectId,
      items: payload.items
    };
  });

  // Ordenar cronológicamente por savedAt ascendente para que el respaldo más reciente prevalezca
  snapshots.sort((a, b) => (a.savedAt - b.savedAt) || (a.index - b.index));

  let totalRestored = 0;
  for (const snap of snapshots) {
    totalRestored += await applySnapshotAndCleanup(
      db,
      storage,
      snap,
      recordCache,
      projectEntriesCache,
      projectId || null
    );
  }

  return totalRestored;
}
