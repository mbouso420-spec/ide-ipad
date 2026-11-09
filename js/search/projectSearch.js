/**
 * Motor de Búsqueda Global Asíncrono en Archivos del Proyecto
 * Permite buscar cadenas de texto, palabras completas o expresiones regulares en todo el workspace.
 */

import { BINARY_EXTENSIONS } from "../storage/fileImport.js";

/**
 * Escapa caracteres especiales para usar en una expresión regular.
 * @param {string} str
 * @returns {string}
 */
export function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Busca ocurrencias en una colección de archivos del proyecto.
 *
 * @param {Array<{ path: string, content?: string, isFolder?: boolean, isBinary?: boolean }>} files
 * @param {string} query
 * @param {{
 *   caseSensitive?: boolean,
 *   matchWholeWord?: boolean,
 *   isRegex?: boolean,
 *   maxMatchesPerFile?: number,
 *   maxTotalMatches?: number
 * }} options
 * @returns {{
 *   results: Array<{
 *     path: string,
 *     shortName: string,
 *     totalMatches: number,
 *     matches: Array<{
 *       line: number,
 *       column: number,
 *       lineText: string,
 *       matchText: string,
 *       start: number,
 *       end: number
 *     }>
 *   }>,
 *   totalMatches: number,
 *   filesMatched: number,
 *   error: string | null
 * }}
 */
export function searchInFiles(files, query, options = {}) {
  const {
    caseSensitive = false,
    matchWholeWord = false,
    isRegex = false,
    maxMatchesPerFile = 200,
    maxTotalMatches = 2000
  } = options;

  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    return { results: [], totalMatches: 0, filesMatched: 0, error: null };
  }

  let regex;
  try {
    let pattern;
    if (isRegex) {
      pattern = query;
    } else {
      pattern = escapeRegExp(query);
    }

    if (matchWholeWord) {
      pattern = `\\b${pattern}\\b`;
    }

    const flags = caseSensitive ? "g" : "gi";
    regex = new RegExp(pattern, flags);
  } catch (err) {
    return {
      results: [],
      totalMatches: 0,
      filesMatched: 0,
      error: `Expresión regular inválida: ${err.message}`
    };
  }

  const results = [];
  let totalMatchesCount = 0;

  for (const file of files || []) {
    if (!file || file.isFolder || file.isBinary) continue;
    if (typeof file.content !== "string" || !file.content) continue;

    const ext = file.path.includes(".") ? file.path.split(".").pop().toLowerCase() : "";
    if (BINARY_EXTENSIONS.has(ext)) continue;

    // Optimización: si el archivo no contiene el patrón, evitar la asignación de memoria
    // que implica dividir todo el archivo en un arreglo de miles de líneas.
    if (!isRegex || (!cleanQuery.includes("^") && !cleanQuery.includes("$"))) {
      regex.lastIndex = 0;
      if (!regex.test(file.content)) continue;
      regex.lastIndex = 0;
    }

    const lines = file.content.split(/\r?\n/);
    const fileMatches = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineText = lines[lineIdx];
      regex.lastIndex = 0;

      let match;
      while ((match = regex.exec(lineText)) !== null) {
        const matchText = match[0];
        if (matchText.length === 0) {
          regex.lastIndex++;
          continue;
        }

        fileMatches.push({
          line: lineIdx + 1,
          column: match.index + 1,
          lineText: lineText.length > 300 ? `${lineText.slice(0, 300)}…` : lineText,
          matchText,
          start: match.index,
          end: match.index + matchText.length
        });

        totalMatchesCount++;

        if (fileMatches.length >= maxMatchesPerFile || totalMatchesCount >= maxTotalMatches) {
          break;
        }
      }

      if (fileMatches.length >= maxMatchesPerFile || totalMatchesCount >= maxTotalMatches) {
        break;
      }
    }

    if (fileMatches.length > 0) {
      const shortName = file.path.split("/").pop() || file.path;
      results.push({
        path: file.path,
        shortName,
        totalMatches: fileMatches.length,
        matches: fileMatches
      });
    }

    if (totalMatchesCount >= maxTotalMatches) {
      break;
    }
  }

  return {
    results,
    totalMatches: totalMatchesCount,
    filesMatched: results.length,
    error: null
  };
}
