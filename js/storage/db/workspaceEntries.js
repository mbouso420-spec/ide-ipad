/**
 * Operaciones CRUD de archivos y carpetas del espacio de trabajo en IndexedDB.
 */

import {
  STORE_FILES,
  openDbTransaction,
  resolveTxError,
  normalizePath,
  makeFileKey,
  getRecord,
  resolveEntryBaselineBase64,
  broadcastWorkspaceChange
} from "./dbCore.js";

export async function getAllRawProjectEntries(projectId) {
  return openDbTransaction(
    STORE_FILES,
    "readonly",
    (tx) =>
      new Promise((resolve, reject) => {
        const idx = tx.objectStore(STORE_FILES).index("byProject");
        const req = idx.getAll(projectId);
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = (ev) => reject(resolveTxError(ev, tx, "Error leyendo archivos del proyecto."));
        tx.onerror = (ev) => reject(resolveTxError(ev, tx, "La transacción getAllRawProjectEntries falló."));
        tx.onabort = (ev) => reject(resolveTxError(ev, tx, "La transacción getAllRawProjectEntries se canceló."));
      })
  );
}

export async function getProjectEntries(projectId) {
  const all = await getAllRawProjectEntries(projectId);
  return all.filter((e) => !e.deleted);
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
    base64 = undefined,
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
  let writtenRecord = null;
  let skippedDeleted = false;
  let txErr = null;

  await openDbTransaction(
    STORE_FILES,
    "readwrite",
    (tx) =>
      new Promise((resolve, reject) => {
        const store = tx.objectStore(STORE_FILES);
        const abortWith = (message) => {
          txErr = new Error(message);
          tx.abort();
        };

        const writeTarget = (latestExisting) => {
          const resolvedIsBinary = !isFolder && Boolean(isBinary);
          const resolvedBase = resolvedIsBinary
            ? (typeof baseContent === "string" ? baseContent : "")
            : (baseContent !== null
                ? baseContent
                : fromGithub
                  ? content
                  : latestExisting && !latestExisting.isBinary && typeof latestExisting.baseContent === "string"
                    ? latestExisting.baseContent
                    : "");

          const binaryKindChanged = Boolean(
            !isFolder &&
              !fromGithub &&
              latestExisting &&
              latestExisting.trackedInGithub &&
              Boolean(latestExisting.isBinary) !== resolvedIsBinary
          );
          const recreatedOverUnloaded = Boolean(
            !isFolder &&
              !fromGithub &&
              latestExisting &&
              latestExisting.trackedInGithub &&
              (latestExisting.contentLoaded === false || binaryKindChanged)
          );
          const hasExplicitBaseline = baseContent !== null || baseBase64 !== undefined;
          const baselineUnloaded = Boolean(
            !isFolder &&
              !fromGithub &&
              !hasExplicitBaseline &&
              ((latestExisting &&
                latestExisting.trackedInGithub &&
                (latestExisting.contentLoaded === false || binaryKindChanged)) ||
                latestExisting?.baselineUnloaded)
          );

          const resolvedBase64 = resolvedIsBinary
            ? (base64 !== undefined
                ? base64
                : (latestExisting && !latestExisting.deleted ? latestExisting.base64 : null) ?? null)
            : null;
          const resolvedBaseBase64 = isFolder || !resolvedIsBinary
            ? null
            : baseBase64 !== undefined
              ? baseBase64
              : fromGithub
                ? resolvedBase64
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
            baselineUnloaded,
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
          fReq.onerror = (ev) => reject(resolveTxError(ev, tx, "Error asegurando carpeta padre."));
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
            cursorReq.onerror = (ev) => reject(resolveTxError(ev, tx, "Error verificando conflictos de carpeta."));
            return;
          }

          ensureParentAt(0, "", latestExisting);
        };
        req.onerror = (ev) => reject(resolveTxError(ev, tx, "Error leyendo entrada en upsertEntry."));
        tx.oncomplete = () => resolve();
        tx.onerror = (ev) => reject(txErr || resolveTxError(ev, tx, "Error guardando entrada."));
        tx.onabort = (ev) => reject(txErr || resolveTxError(ev, tx, "La transacción de guardado se canceló."));
      })
  );

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
  let updatedRecord = null;
  let needsUpsert = false;

  await openDbTransaction(
    STORE_FILES,
    "readwrite",
    (tx) =>
      new Promise((resolve, reject) => {
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
        req.onerror = (ev) => reject(resolveTxError(ev, tx, "Error leyendo archivo en updateFileContent."));
        tx.oncomplete = () => resolve();
        tx.onerror = (ev) => reject(resolveTxError(ev, tx, "La transacción de guardado falló."));
        tx.onabort = (ev) => reject(resolveTxError(ev, tx, "La transacción de guardado se canceló."));
      })
  );

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

  let didRename = false;
  let resolvedIsFolder = Boolean(isFolder);
  let txErr = null;

  await openDbTransaction(
    STORE_FILES,
    "readwrite",
    (tx) =>
      new Promise((resolve, reject) => {
        const store = tx.objectStore(STORE_FILES);
        const abortWith = (message) => {
          txErr = new Error(message);
          tx.abort();
        };

        const req = store.index("byProject").getAll(projectId);
        req.onsuccess = () => {
          const all = Array.isArray(req.result) ? req.result : [];
          const targetEntry = all.find((e) => !e.deleted && e.path === fromPath);
          if (!targetEntry) {
            return;
          }
          resolvedIsFolder = Boolean(targetEntry.isFolder);
          if (resolvedIsFolder && toPath.startsWith(`${fromPath}/`)) {
            abortWith("No se puede mover una carpeta dentro de sí misma.");
            return;
          }
          const targetConflict = all.find(
            (e) =>
              !e.deleted &&
              e.path !== fromPath &&
              !(resolvedIsFolder && e.path.startsWith(`${fromPath}/`)) &&
              (e.path === toPath || e.path.startsWith(`${toPath}/`) || (!e.isFolder && toPath.startsWith(`${e.path}/`)))
          );
          if (targetConflict) {
            abortWith(`Ya existe "${targetConflict.path}" en esa ubicación.`);
            return;
          }

          const rawByPath = new Map(all.map((e) => [e.path, e]));
          const affected = all.filter(
            (e) => !e.deleted && (e.path === fromPath || (resolvedIsFolder && e.path.startsWith(`${fromPath}/`)))
          );

          if (affected.length === 0) {
            return;
          }

          const unloadedFile = affected.find((item) => !item.isFolder && item.contentLoaded === false);
          if (unloadedFile) {
            abortWith(
              `No se puede renombrar "${unloadedFile.path}" antes de cargar su contenido desde GitHub.`
            );
            return;
          }

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
            const targetBinaryKindChanged = Boolean(
              !item.isFolder &&
                prevTarget &&
                prevTarget.trackedInGithub &&
                Boolean(prevTarget.isBinary) !== Boolean(item.isBinary)
            );
            const preserveTargetBase =
              targetBinaryKindChanged
                ? ""
                : prevTarget && prevTarget.trackedInGithub
                  ? prevTarget.baseContent
                  : item.trackedInGithub
                    ? ""
                    : item.baseContent;
            const preserveTargetBaseBase64 =
              targetBinaryKindChanged
                ? null
                : !item.isFolder && prevTarget && prevTarget.trackedInGithub
                  ? resolveEntryBaselineBase64(prevTarget)
                  : null;
            const recreatedOverUnloaded = Boolean(
              !item.isFolder &&
                prevTarget &&
                prevTarget.trackedInGithub &&
                (prevTarget.contentLoaded === false || targetBinaryKindChanged)
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
              baselineUnloaded: recreatedOverUnloaded || Boolean(prevTarget?.baselineUnloaded),
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

        req.onerror = (ev) => reject(resolveTxError(ev, tx, "Error leyendo entradas para renombrar."));
        tx.oncomplete = () => resolve();
        tx.onerror = (ev) => reject(txErr || resolveTxError(ev, tx, "Error en transacción de renombrado."));
        tx.onabort = (ev) => reject(txErr || resolveTxError(ev, tx, "La transacción de renombrado se canceló."));
      })
  );

  if (didRename) {
    broadcastWorkspaceChange({ type: "ENTRY_RENAMED", projectId, oldPath: fromPath, newPath: toPath, isFolder: resolvedIsFolder });
  }
}

export async function deleteProjectEntry(projectId, targetPath, isFolder) {
  const cleanPath = normalizePath(targetPath);
  if (!cleanPath) return;

  let deletedAny = false;
  let resolvedIsFolder = Boolean(isFolder);

  await openDbTransaction(
    STORE_FILES,
    "readwrite",
    (tx) =>
      new Promise((resolve, reject) => {
        const store = tx.objectStore(STORE_FILES);
        const now = Date.now();
        const targetKey = makeFileKey(projectId, cleanPath);

        const removeOrTombstone = (item) => {
          deletedAny = true;
          if (!item.isFolder) {
            item.deleted = true;
            item.content = "";
            item.base64 = null;
            item.updatedAt = now;
            store.put(item);
          } else {
            store.delete(item.key);
          }
        };

        const targetReq = store.get(targetKey);
        targetReq.onsuccess = () => {
          const targetEntry = targetReq.result;
          if (targetEntry && !targetEntry.deleted) {
            resolvedIsFolder = Boolean(targetEntry.isFolder);
            removeOrTombstone(targetEntry);
          } else {
            resolvedIsFolder = Boolean(isFolder);
          }

          if (!resolvedIsFolder) return;

          // Rango acotado solo a descendientes de la carpeta: evita cargar todo el repositorio en RAM.
          const prefixKey = makeFileKey(projectId, `${cleanPath}/`);
          const cursorReq = store.openCursor(IDBKeyRange.bound(prefixKey, `${prefixKey}\uffff`, false, true));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const item = cursor.value;
            if (item && !item.deleted && item.projectId === projectId) {
              removeOrTombstone(item);
            }
            cursor.continue();
          };
          cursorReq.onerror = (ev) => reject(resolveTxError(ev, tx, "Error escaneando descendientes para borrar."));
        };
        targetReq.onerror = (ev) => reject(resolveTxError(ev, tx, "Error leyendo entrada para borrar."));
        tx.oncomplete = () => resolve();
        tx.onerror = (ev) => reject(resolveTxError(ev, tx, "Error borrando entrada."));
        tx.onabort = (ev) => reject(resolveTxError(ev, tx, "La transacción de borrado se canceló."));
      })
  );

  if (deletedAny) {
    broadcastWorkspaceChange({ type: "ENTRY_DELETED", projectId, path: cleanPath, isFolder: resolvedIsFolder });
  }
}

/**
 * Descarta cambios locales pendientes de un archivo frente a su estado base de GitHub:
 * elimina archivos nuevos no trackeados, revierte modificaciones a `baseContent`/`baseBase64`
 * o restaura archivos borrados localmente.
 */
export async function discardEntryChange(projectId, targetPath) {
  const cleanPath = normalizePath(targetPath);
  if (!cleanPath) return { discarded: false, action: null };

  const key = makeFileKey(projectId, cleanPath);
  let action = null;
  let txErr = null;

  await openDbTransaction(
    STORE_FILES,
    "readwrite",
    (tx) =>
      new Promise((resolve, reject) => {
        const store = tx.objectStore(STORE_FILES);
        const abortWith = (message) => {
          txErr = new Error(message);
          tx.abort();
        };

        const req = store.get(key);
        req.onsuccess = () => {
          const item = req.result;
          if (!item || item.isFolder) return;
          const now = Date.now();

          if (!item.trackedInGithub) {
            store.delete(key);
            action = "removed";
            return;
          }

          const restoredBase64 = resolveEntryBaselineBase64(item);
          const wasDeleted = Boolean(item.deleted);
          const unloadedOverwritten = Boolean(
            item.baselineUnloaded && !item.baseContent && !restoredBase64 && item.blobSha
          );
          const hadLoadedBase =
            !unloadedOverwritten &&
            (item.contentLoaded !== false || Boolean(item.baseContent) || Boolean(restoredBase64) || !item.blobSha);

          const applyRestore = () => {
            item.deleted = false;
            item.content = item.isBinary ? "" : (item.baseContent || "");
            item.base64 = item.isBinary ? restoredBase64 : null;
            item.forceModified = false;
            item.baselineUnloaded = false;
            item.contentLoaded = hadLoadedBase;
            item.updatedAt = now;
            store.put(item);
            action = wasDeleted ? "restored" : "reverted";
          };

          if (!wasDeleted) {
            applyRestore();
            return;
          }

          const parts = cleanPath.split("/");
          const checkAndCreateParents = (idx, prefixAcc, foldersToCreate) => {
            if (idx >= parts.length - 1) {
              for (const folderRec of foldersToCreate) {
                store.put(folderRec);
              }
              applyRestore();
              return;
            }
            const nextPrefix = prefixAcc ? `${prefixAcc}/${parts[idx]}` : parts[idx];
            const folderKey = makeFileKey(projectId, nextPrefix);
            const fReq = store.get(folderKey);
            fReq.onsuccess = () => {
              const folder = fReq.result;
              if (folder && !folder.deleted && !folder.isFolder) {
                abortWith(`No se puede restaurar "${cleanPath}" porque "${nextPrefix}" existe como archivo.`);
                return;
              }
              if (!folder || folder.deleted) {
                foldersToCreate.push({
                  key: folderKey,
                  projectId,
                  path: nextPrefix,
                  isFolder: true,
                  content: "",
                  baseContent: "",
                  contentLoaded: true,
                  deleted: false,
                  updatedAt: now
                });
              }
              checkAndCreateParents(idx + 1, nextPrefix, foldersToCreate);
            };
            fReq.onerror = (ev) => {
              txErr = resolveTxError(ev, tx, "Error verificando carpetas padre al restaurar.");
              tx.abort();
            };
          };

          // Verificar antes de restaurar que no exista una carpeta activa con el mismo nombre
          const prefixKey = makeFileKey(projectId, `${cleanPath}/`);
          const cursorReq = store.openCursor(IDBKeyRange.bound(prefixKey, `${prefixKey}\uffff`, false, true));
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) {
              checkAndCreateParents(0, "", []);
              return;
            }
            if (!cursor.value?.deleted) {
              abortWith(`No se puede restaurar "${cleanPath}" porque existe una carpeta con ese nombre.`);
              return;
            }
            cursor.continue();
          };
          cursorReq.onerror = (ev) => {
            txErr = resolveTxError(ev, tx, "Error verificando conflictos al restaurar.");
            tx.abort();
          };
        };
        req.onerror = (ev) => {
          txErr = resolveTxError(ev, tx, "Error leyendo archivo para descartar cambios.");
          tx.abort();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = (ev) => reject(txErr || resolveTxError(ev, tx, "No se pudo descartar el cambio local."));
        tx.onabort = (ev) => reject(txErr || resolveTxError(ev, tx, "La transacción de descarte se canceló."));
      })
  );

  if (action) {
    broadcastWorkspaceChange({
      type: action === "removed" ? "ENTRY_DELETED" : "ENTRY_UPSERTED",
      projectId,
      path: cleanPath,
      isFolder: false
    });
  }
  return { discarded: Boolean(action), action };
}
