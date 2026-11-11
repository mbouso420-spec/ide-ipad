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

function parseBackupPayload(raw) {
  if (!raw) return { savedAt: 0, items: [] };
  try {
    const parsed = JSON.parse(raw);
    const savedAt = typeof parsed?.savedAt === "number" ? parsed.savedAt : 0;
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return {
      savedAt,
      items: items.filter(
        (it) => it && typeof it.projectId === "string" && typeof it.filePath === "string" && typeof it.content === "string"
      )
    };
  } catch {
    return { savedAt: 0, items: [] };
  }
}

function parseBackupItems(raw) {
  return parseBackupPayload(raw).items;
}

/**
 * @param {Array<{ projectId: string, filePath: string, content: string }>} items
 * @param {Storage} [storage]
 * @param {string|null} [projectId]
 * @param {string|null} [instanceId]
 * @returns {boolean} true si quedó escrito
 */
export function writeEmergencyBackup(items, storage = window.localStorage, projectId = null, instanceId = null) {
  const clean = (Array.isArray(items) ? items : []).filter(
    (it) => it && typeof it.projectId === "string" && typeof it.filePath === "string" && typeof it.content === "string"
  );
  const targetKey = getEmergencyBackupKey(projectId, instanceId);

  try {
    if (clean.length === 0) {
      storage.removeItem(targetKey);
      return true;
    }
    const payloadStr = JSON.stringify({
      savedAt: Date.now(),
      projectId: projectId || null,
      instanceId: instanceId || null,
      items: clean.map(({ projectId: p, filePath, content }) => ({ projectId: p, filePath, content }))
    });
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
export function readEmergencyBackup(storage = window.localStorage, projectId = null, instanceId = null) {
  if (projectId && instanceId) {
    const targetKey = getEmergencyBackupKey(projectId, instanceId);
    const direct = parseBackupItems(storage.getItem(targetKey));
    if (direct.length > 0) return direct;
    // Si no está particionado por instancia, buscar en la partición por proyecto
    const projectOnly = parseBackupItems(storage.getItem(getEmergencyBackupKey(projectId)));
    if (projectOnly.length > 0) return projectOnly;
    // Fallback: clave legado
    const legacy = parseBackupItems(storage.getItem(EMERGENCY_BACKUP_KEY));
    return legacy.filter((it) => it.projectId === projectId);
  }

  if (projectId && !instanceId) {
    const result = [];
    // Leer clave exacta de proyecto
    const direct = parseBackupItems(storage.getItem(getEmergencyBackupKey(projectId)));
    result.push(...direct);

    // Leer todas las particiones de instancias de este proyecto
    const prefix = `${EMERGENCY_BACKUP_PREFIX}${projectId}_`;
    const keys = getAllStorageKeys(storage);
    for (const k of keys) {
      if (k && k.startsWith(prefix)) {
        const instItems = parseBackupItems(storage.getItem(k));
        result.push(...instItems);
      }
    }

    if (result.length > 0) return result;

    // Fallback: clave legado
    const legacy = parseBackupItems(storage.getItem(EMERGENCY_BACKUP_KEY));
    return legacy.filter((it) => it.projectId === projectId);
  }

  // Si no se especifica proyecto ni instancia, agregar clave legado y todas las particiones existentes
  const result = [];
  const legacyItems = parseBackupItems(storage.getItem(EMERGENCY_BACKUP_KEY));
  result.push(...legacyItems);

  const keys = getAllStorageKeys(storage);
  for (const k of keys) {
    if (k && k.startsWith(EMERGENCY_BACKUP_PREFIX)) {
      const partItems = parseBackupItems(storage.getItem(k));
      result.push(...partItems);
    }
  }

  return result;
}

/**
 * @param {Storage} [storage]
 * @param {string|null} [projectId]
 * @param {string|null} [instanceId]
 */
export function clearEmergencyBackup(storage = window.localStorage, projectId = null, instanceId = null) {
  try {
    if (projectId && instanceId) {
      storage.removeItem(getEmergencyBackupKey(projectId, instanceId));
      return;
    }
    if (projectId && !instanceId) {
      storage.removeItem(getEmergencyBackupKey(projectId));
      const prefix = `${EMERGENCY_BACKUP_PREFIX}${projectId}_`;
      const keys = getAllStorageKeys(storage);
      for (const k of keys) {
        if (k && k.startsWith(prefix)) {
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

/**
 * Vuelca a IndexedDB el respaldo pendiente (si existe) y lo borra solo cuando todo quedó guardado.
 * Nunca recrea archivos que ya no existen (p. ej. borrados en otra pestaña).
 * @param {{ entryExists: (projectId: string, path: string) => Promise<boolean>, updateFileContent: (projectId: string, path: string, content: string) => Promise<unknown> }} db
 * @param {Storage} [storage]
 * @param {string|null} [projectId]
 * @param {string|null} [instanceId]
 * @returns {Promise<number>} cantidad de archivos recuperados
 */
export async function restoreEmergencyBackup(db, storage = window.localStorage, projectId = null, instanceId = null) {
  // 1. Si se especifica projectId e instanceId puntual, restaurar y limpiar solo esa clave
  if (projectId && instanceId) {
    const key = getEmergencyBackupKey(projectId, instanceId);
    const items = parseBackupItems(storage.getItem(key));
    if (items.length === 0) {
      try { storage.removeItem(key); } catch (_) {}
      return 0;
    }
    let restored = 0;
    for (const item of items) {
      if (await db.entryExists(item.projectId, item.filePath)) {
        await db.updateFileContent(item.projectId, item.filePath, item.content);
        restored += 1;
      }
    }
    try { storage.removeItem(key); } catch (_) {}
    return restored;
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
      if (!projectId || k === getEmergencyBackupKey(projectId) || k.startsWith(`${EMERGENCY_BACKUP_PREFIX}${projectId}_`)) {
        targetKeys.push(k);
      }
    }
  }

  if (targetKeys.length === 0) {
    return 0;
  }

  const snapshots = targetKeys.map((key, index) => {
    const payload = parseBackupPayload(storage.getItem(key));
    return {
      key,
      index,
      savedAt: payload.savedAt,
      items: payload.items
    };
  });

  // Ordenar cronológicamente por savedAt ascendente para que el respaldo más reciente prevalezca
  snapshots.sort((a, b) => (a.savedAt - b.savedAt) || (a.index - b.index));

  let totalRestored = 0;
  for (const snap of snapshots) {
    if (snap.items.length > 0) {
      for (const item of snap.items) {
        if (await db.entryExists(item.projectId, item.filePath)) {
          await db.updateFileContent(item.projectId, item.filePath, item.content);
          totalRestored += 1;
        }
      }
    }
    // Borrado individual y atómico de la clave procesada en el snapshot
    try {
      storage.removeItem(snap.key);
    } catch (_) {}
  }

  return totalRestored;
}
