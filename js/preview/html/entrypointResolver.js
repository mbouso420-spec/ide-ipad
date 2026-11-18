/**
 * Resolución de puntos de entrada HTML y navegación multi-página en el visor de vista previa.
 */

import { normalizePath } from "../../storage/workspaceDb.js";
import {
  HTML_EXTENSIONS,
  getFileExtension,
  getParentFolder,
  isIgnoredPreviewPath,
  resolveRelativePath
} from "../previewUtils.js";

export function getSavedPreviewHtml(projectId) {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(`studio_preview_last_html:${projectId || "default"}`) || null;
  } catch (_) {
    return null;
  }
}

export function savePreviewHtml(projectId, htmlPath) {
  if (typeof localStorage === "undefined" || !htmlPath) return;
  try {
    localStorage.setItem(`studio_preview_last_html:${projectId || "default"}`, htmlPath);
  } catch (_) {
    /* localStorage no disponible o cuota agotada */
  }
}

/**
 * Resuelve el mejor archivo HTML de entrada cuando la pestaña activa es JS o CSS.
 */
export function findBestHtmlEntrypoint(allFiles, activeFile, preferredHtmlPath = null) {
  const htmlFiles = (allFiles || []).filter((f) => {
    if (!f || !f.path || f.contentLoaded === false) return false;
    if (isIgnoredPreviewPath(normalizePath(f.path))) return false;
    const ext = getFileExtension(f.path);
    return HTML_EXTENSIONS.has(ext) && typeof f.content === "string";
  });
  if (htmlFiles.length === 0) return null;

  const activePath = normalizePath(activeFile.path);
  const activeShort = activeFile.shortName || activePath.split("/").pop();
  const activeFolder = getParentFolder(activePath);
  const escapedName = activeShort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const scriptRegex = new RegExp(`<script[^>]+\\bsrc\\s*=\\s*["'][^"']*(?:^|[\\/"'])${escapedName}(?:[?#][^"']*)?["']`, "i");
  const linkRegex = new RegExp(`<link[^>]+\\bhref\\s*=\\s*["'][^"']*(?:^|[\\/"'])${escapedName}(?:[?#][^"']*)?["']`, "i");

  const directRefs = htmlFiles.filter((f) => {
    const content = f.content || "";
    return scriptRegex.test(content) || linkRegex.test(content);
  });

  if (directRefs.length > 0) {
    const sameFolder = directRefs.find((f) => getParentFolder(f.path) === activeFolder);
    if (sameFolder) return sameFolder;
    const index = directRefs.find((f) => (f.shortName || "").toLowerCase() === "index.html");
    if (index) return index;
    return directRefs[0];
  }

  if (preferredHtmlPath) {
    const cleanPref = normalizePath(preferredHtmlPath);
    const preferred = htmlFiles.find((f) => normalizePath(f.path) === cleanPref);
    if (preferred) return preferred;
  }

  const indexInSameFolder = htmlFiles.find(
    (f) => getParentFolder(f.path) === activeFolder && (f.shortName || "").toLowerCase() === "index.html"
  );
  if (indexInSameFolder) return indexInSameFolder;

  const indexInRoot = htmlFiles.find(
    (f) => !getParentFolder(f.path) && (f.shortName || "").toLowerCase() === "index.html"
  );
  if (indexInRoot) return indexInRoot;

  const anyIndex = htmlFiles.find((f) => (f.shortName || "").toLowerCase() === "index.html");
  if (anyIndex) return anyIndex;

  const anyInSameFolder = htmlFiles.find((f) => getParentFolder(f.path) === activeFolder);
  if (anyInSameFolder) return anyInSameFolder;

  return htmlFiles[0];
}

/**
 * Resuelve el archivo HTML de destino al navegar en enlaces dentro del iframe.
 */
export function findTargetHtmlFile(allFiles, currentPreviewPath, requestedHref) {
  if (!requestedHref || typeof requestedHref !== "string") return null;

  let clean = requestedHref.trim().split("?")[0].split("#")[0];
  try {
    clean = decodeURIComponent(clean);
  } catch (_) {
    /* Mantener cadena original ante % inválido */
  }
  if (!clean) return null;

  const htmlFiles = (allFiles || []).filter((f) => {
    if (!f || !f.path) return false;
    if (isIgnoredPreviewPath(normalizePath(f.path))) return false;
    const ext = getFileExtension(f.path);
    return HTML_EXTENSIONS.has(ext);
  });
  if (htmlFiles.length === 0) return null;

  const findByNormPath = (targetPath) => {
    const normTarget = normalizePath(targetPath);
    const exact = htmlFiles.find((f) => normalizePath(f.path) === normTarget);
    if (exact) return exact;
    const lowerTarget = normTarget.toLowerCase();
    return htmlFiles.find((f) => normalizePath(f.path).toLowerCase() === lowerTarget) || null;
  };

  const currentFolder = currentPreviewPath ? getParentFolder(currentPreviewPath) : "";

  // Enlaces a raíz ("/", "./", "../") o carpeta terminada en "/" resuelven a index.html
  if (clean === "/" || clean === "./" || clean === "." || clean === ".." || clean.endsWith("/")) {
    const dirTarget = clean === "/"
      ? ""
      : normalizePath(resolveRelativePath(currentFolder, clean));
    const idxPath = dirTarget ? `${dirTarget}/index.html` : "index.html";
    const matchDirIdx = findByNormPath(idxPath);
    if (matchDirIdx) return matchDirIdx;
    const rootIdx = findByNormPath("index.html");
    if (rootIdx) return rootIdx;
  }

  const relResolved = resolveRelativePath(currentFolder, clean);
  const match1 = findByNormPath(relResolved);
  if (match1) return match1;

  const relLastSeg = relResolved.split("/").pop() || "";
  if (relLastSeg && !relLastSeg.includes(".")) {
    const relHtml = resolveRelativePath(currentFolder, `${clean}.html`);
    const match2 = findByNormPath(relHtml);
    if (match2) return match2;
  }

  const rootClean = clean.replace(/^\/+/, "");
  const match3 = findByNormPath(rootClean);
  if (match3) return match3;

  const rootLastSeg = rootClean.split("/").pop() || "";
  if (rootLastSeg && !rootLastSeg.includes(".")) {
    const match4 = findByNormPath(`${rootClean}.html`);
    if (match4) return match4;
  }

  const targetBase = rootClean.split("/").pop();
  const match5 = htmlFiles.find(
    (f) => (f.shortName || f.path.split("/").pop()).toLowerCase() === targetBase.toLowerCase()
  );
  if (match5) return match5;

  if (targetBase && !targetBase.includes(".")) {
    const match6 = htmlFiles.find(
      (f) => (f.shortName || f.path.split("/").pop()).toLowerCase() === `${targetBase.toLowerCase()}.html`
    );
    if (match6) return match6;
  }

  return null;
}

export function findSiblingHtmlInSameFolder(scopeFiles, folder, targetFile) {
  if (!Array.isArray(scopeFiles) || !targetFile) return null;
  const htmlInSameDir = scopeFiles.filter((f) => {
    if (!f || !f.path) return false;
    const ext = getFileExtension(f.path);
    return HTML_EXTENSIONS.has(ext) && getParentFolder(f.path) === folder;
  });

  if (htmlInSameDir.length === 0) return null;

  const preferred =
    htmlInSameDir.find((f) => (f.shortName || "").toLowerCase() === "index.html") || htmlInSameDir[0];

  const targetName = targetFile.shortName || String(targetFile.path || "").split("/").pop() || "";
  const escapedName = targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const linksThisJs = Boolean(
    escapedName &&
    typeof preferred.content === "string" &&
    new RegExp(`src=["'][^"']*${escapedName}["']`, "i").test(preferred.content)
  );

  return {
    file: preferred,
    linksThisJs
  };
}
