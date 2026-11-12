/**
 * Constantes, utilidades de rutas y escapado HTML compartidas entre los empaquetadores de vista previa.
 */

import { normalizePath } from "../storage/workspaceDb.js";
import { escapeHtml } from "../utils/dom.js";

export { normalizePath, escapeHtml };

export const HTML_EXTENSIONS = new Set(["html", "htm"]);
export const JS_EXTENSIONS = new Set(["js", "mjs", "cjs"]);
export const CSS_EXTENSIONS = new Set(["css"]);
export const PYTHON_EXTENSIONS = new Set(["py", "pyw"]);
export const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
export const SQL_EXTENSIONS = new Set(["sql"]);
export const C_EXTENSIONS = new Set(["c", "h"]);
export const CPP_EXTENSIONS = new Set(["cpp", "cxx", "cc", "hpp"]);
export const RUST_EXTENSIONS = new Set(["rs"]);
export const GO_EXTENSIONS = new Set(["go"]);
export const JAVA_EXTENSIONS = new Set(["java"]);
export const CSHARP_EXTENSIONS = new Set(["cs"]);
export const TS_EXTENSIONS = new Set(["ts", "tsx"]);

export const MAX_PREVIEW_ASSET_BYTES = 512 * 1024; // 512 KB por recurso individual
export const MAX_TOTAL_INLINED_CSS = 2 * 1024 * 1024; // 2 MB presupuesto total acumulado de CSS

export const IGNORED_PREVIEW_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "venv",
  ".venv",
  "target",
  "bin",
  "obj",
  ".turbo",
  "out"
]);

export function getFileExtension(path) {
  const base = String(path || "").split("/").pop() || "";
  if (!base.includes(".")) return "";
  return base.split(".").pop().toLowerCase();
}

export function getParentFolder(path) {
  const clean = normalizePath(path);
  return clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
}

export function resolveRelativePath(baseDir, relPath) {
  if (relPath.startsWith("/")) {
    return normalizePath(relPath);
  }
  const stack = baseDir ? baseDir.split("/").filter(Boolean) : [];
  const parts = relPath.split("/");
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

export function escapeAttr(str) {
  return escapeHtml(str ?? "");
}

export function escapeHtmlText(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Normaliza una referencia URL antes de evaluar esquemas peligrosos en previews.
 * Elimina caracteres de control ASCII que podrían evadir regex simples en navegadores.
 */
export function normalizePreviewUrlRef(ref) {
  return String(ref ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .trim()
    .toLowerCase();
}

export function isBlockedPreviewUrlScheme(ref) {
  const normalized = normalizePreviewUrlRef(ref);
  return (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("data:")
  );
}
