/**
 * Resolución de rutas y mapa exacto de módulos ES/TypeScript/JSX/CSS/JSON locales.
 */

import { normalizePath } from "../../storage/workspaceDb.js";
import {
  getParentFolder,
  isIgnoredPreviewPath,
  resolveRelativePath
} from "../previewUtils.js";

const MODULE_EXTENSION_PROBES = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".css"];
const INDEX_EXTENSION_PROBES = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json"];
export const CODE_SOURCE_EXTS = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx"]);

/**
 * Construye un mapa indexado exclusivamente por ruta normalizada completa (`src/foo.ts`),
 * evitando colisiones por nombre base al resolver rutas relativas.
 * @param {Map<string, object>|Array<object>} fileMapOrList
 * @returns {Map<string, object>}
 */
export function buildExactModuleMap(fileMapOrList) {
  const exact = new Map();
  if (!fileMapOrList) return exact;
  const entries = fileMapOrList instanceof Map ? fileMapOrList.values() : fileMapOrList;
  for (const entry of entries || []) {
    if (!entry || !entry.path) continue;
    const clean = normalizePath(entry.path);
    if (!clean || isIgnoredPreviewPath(clean)) continue;
    if (!exact.has(clean)) {
      exact.set(clean, entry);
    }
  }
  return exact;
}

/**
 * Determina si un especificador corresponde a una importación relativa o raíz del proyecto.
 * @param {string} specifier
 * @returns {boolean}
 */
export function isRelativeModuleSpecifier(specifier) {
  const s = String(specifier || "").trim();
  if (!s || /^(https?:|data:|blob:|node:|\/\/)/i.test(s)) return false;
  return s === "." || s === ".." || s.startsWith("./") || s.startsWith("../") || s.startsWith("/");
}

/**
 * Resuelve un import relativo `./foo`, `../bar`, `.`, `..` o `/baz` (con o sin extensión, incluyendo fallback `.js` -> `.ts`/`.tsx`).
 * @param {string} specifier
 * @param {string} fromPath
 * @param {Map<string, object>} exactMap
 * @param {{ allowParentTraversal?: boolean, allowUnloaded?: boolean }} [options]
 * @returns {object|null}
 */
export function resolveLocalModuleEntry(specifier, fromPath, exactMap, options = {}) {
  const { allowParentTraversal = true, allowUnloaded = false } = options;
  if (!exactMap || !isRelativeModuleSpecifier(specifier)) return null;

  let cleanRef = String(specifier).trim().split("?")[0].split("#")[0].replace(/\\/g, "/");
  try {
    cleanRef = decodeURIComponent(cleanRef);
  } catch (_) {
    /* conservar cadena cruda si tiene % malformado */
  }
  cleanRef = cleanRef.replace(/\\/g, "/");
  if (!cleanRef) return null;
  if (!allowParentTraversal) {
    if (cleanRef.startsWith("/")) {
      return null;
    }
    let depth = 0;
    for (const seg of cleanRef.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        depth -= 1;
        if (depth < 0) {
          return null;
        }
      } else {
        depth += 1;
      }
    }
  }

  const fromDir = getParentFolder(fromPath);
  const base = cleanRef.startsWith("/")
    ? normalizePath(cleanRef.slice(1))
    : resolveRelativePath(fromDir, cleanRef);
  const isDotSelf = cleanRef === "." || cleanRef === "./" || cleanRef === ".." || cleanRef === "../";
  if (!base && !isDotSelf) return null;

  const isUsable = (entry) =>
    Boolean(entry) && (allowUnloaded || (typeof entry.content === "string" && entry.contentLoaded !== false));

  if (base) {
    const direct = exactMap.get(base);
    if (isUsable(direct)) return direct;

    // Convención TypeScript ESM: `import "./math.js"` puede apuntar a `math.ts` o `math.tsx`
    const tsMappedCandidates = [];
    if (/\.(js|mjs|jsx)$/i.test(base)) {
      const stem = base.replace(/\.(js|mjs|jsx)$/i, "");
      tsMappedCandidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.jsx`);
    }
    for (const cand of tsMappedCandidates) {
      const found = exactMap.get(cand);
      if (isUsable(found)) return found;
    }

    for (const ext of MODULE_EXTENSION_PROBES) {
      const found = exactMap.get(`${base}${ext}`);
      if (isUsable(found)) return found;
    }
  }

  for (const ext of INDEX_EXTENSION_PROBES) {
    const found = exactMap.get(base ? `${base}/index${ext}` : `index${ext}`);
    if (isUsable(found)) return found;
  }

  return null;
}
