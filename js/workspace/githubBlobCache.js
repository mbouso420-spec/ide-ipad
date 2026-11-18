/**
 * Reconciliación en memoria y respaldo en IndexedDB de blobs descargados de GitHub (texto o binarios).
 */

import { cacheSingleGithubFileContent } from "../storage/workspaceDb.js";

/**
 * Sincroniza un objeto de archivo en memoria con el registro persistido en IndexedDB tras cachear un blob.
 */
export function applyCachedBlobRecordToFile(fileObj, saved, remotePayload) {
  if (!fileObj || typeof fileObj !== "object") {
    return { deleted: false };
  }
  const isRemoteObj = Boolean(remotePayload && typeof remotePayload === "object");
  const fallbackIsBinary = isRemoteObj && Boolean(remotePayload.isBinary);
  const fallbackContent = fallbackIsBinary
    ? ""
    : String(isRemoteObj ? (remotePayload.content ?? "") : (remotePayload ?? ""));
  const fallbackBase64 = fallbackIsBinary ? (remotePayload.base64 ?? null) : null;
  const fallbackBaseBase64 = fallbackIsBinary
    ? (remotePayload.baseBase64 ?? remotePayload.base64 ?? null)
    : null;

  if (saved && typeof saved === "object") {
    if (saved.deleted) {
      fileObj.deleted = true;
      fileObj.content = typeof saved.content === "string" ? saved.content : "";
      fileObj.baseContent = typeof saved.baseContent === "string" ? saved.baseContent : "";
      fileObj.isBinary = Boolean(saved.isBinary);
      fileObj.base64 = saved.base64 ?? null;
      fileObj.baseBase64 = saved.baseBase64 ?? null;
      fileObj.contentLoaded = saved.contentLoaded !== false;
      return { deleted: true };
    }

    const nextIsBinary = typeof saved.isBinary === "boolean" ? saved.isBinary : fallbackIsBinary;
    fileObj.deleted = false;
    fileObj.isBinary = nextIsBinary;
    fileObj.content = nextIsBinary
      ? ""
      : (typeof saved.content === "string" ? saved.content : fallbackContent);
    fileObj.baseContent = nextIsBinary
      ? ""
      : (typeof saved.baseContent === "string" ? saved.baseContent : fileObj.content);
    fileObj.base64 = nextIsBinary ? (saved.base64 ?? null) : null;
    fileObj.baseBase64 = nextIsBinary ? (saved.baseBase64 ?? fileObj.base64 ?? null) : null;
    fileObj.contentLoaded = saved.contentLoaded !== false;
    if (saved.blobSha) {
      fileObj.blobSha = saved.blobSha;
    }
    return { deleted: false };
  }

  fileObj.deleted = false;
  fileObj.isBinary = fallbackIsBinary;
  fileObj.content = fallbackContent;
  fileObj.baseContent = fallbackContent;
  fileObj.base64 = fallbackBase64;
  fileObj.baseBase64 = fallbackBaseBase64;
  fileObj.contentLoaded = true;
  return { deleted: false };
}

/**
 * Persiste el payload descargado de GitHub (texto o binario) y reconcilia `fileObj` con el registro guardado.
 */
export async function cacheAndSyncGithubFile({
  projectId,
  fileObj,
  remotePayload,
  blobSha = null,
  cacheFn = cacheSingleGithubFileContent
}) {
  const payload = remotePayload && typeof remotePayload === "object"
    ? remotePayload
    : String(remotePayload ?? "");
  const saved = await cacheFn(projectId, fileObj.path, payload, blobSha ?? fileObj.blobSha ?? null);
  const status = applyCachedBlobRecordToFile(fileObj, saved, payload);
  return { saved, ...status };
}
