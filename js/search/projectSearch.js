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
/**
 * Detecta patrones de expresiones regulares susceptibles a Catastrophic Backtracking (ReDoS):
 * 1. Cuantificadores anidados a cualquier nivel de paréntesis: (a+)+, ((a)+)+, (a{1,5})+, ([a-z]+)*
 * 2. Alternancias solapadas o duplicadas dentro de grupos cuantificados: (a|a)+, (a|ab)+, (ab|a)*
 * @param {string} rawPattern
 * @returns {boolean}
 */
export function hasUnsafeReDoSPattern(rawPattern) {
  const src = String(rawPattern || "");
  // Reemplazar escapes y clases de caracteres [...] por un token neutro 'a'
  let normalized = "";
  let inCharClass = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") {
      normalized += "a";
      i += 1;
      continue;
    }
    if (inCharClass) {
      if (ch === "]") {
        inCharClass = false;
        normalized += "a";
      }
      continue;
    }
    if (ch === "[") {
      inCharClass = true;
      continue;
    }
    normalized += ch;
  }

  const isRepetitionAt = (str, idx) => {
    const c = str[idx];
    return c === "+" || c === "*" || c === "{";
  };

  // Analizar grupos con pila para detectar cuantificadores anidados y alternancias solapadas
  const stack = [];
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "(") {
      // Ignorar prefijos de grupo como ?:, ?=, ?!
      let startIdx = i + 1;
      if (normalized[startIdx] === "?") {
        startIdx += 2;
      }
      stack.push({ hasQuantifier: false, startIdx });
    } else if (ch === ")") {
      const group = stack.pop();
      if (!group) continue;
      const groupBody = normalized.slice(group.startIdx, i);
      const groupQuantified = isRepetitionAt(normalized, i + 1);

      if (groupQuantified) {
        if (group.hasQuantifier) {
          return true;
        }
        // Verificar alternancias solapadas en grupo cuantificado: ej. (a|a)+ o (a|ab)+
        if (groupBody.includes("|")) {
          const branches = groupBody
            .split("|")
            .map((b) => b.replace(/[()?:^$]/g, "").trim())
            .filter(Boolean);
          for (let a = 0; a < branches.length; a += 1) {
            for (let b = a + 1; b < branches.length; b += 1) {
              if (
                branches[a] === branches[b] ||
                branches[a].startsWith(branches[b]) ||
                branches[b].startsWith(branches[a])
              ) {
                return true;
              }
            }
          }
        }
      }

      if (stack.length > 0 && (group.hasQuantifier || groupQuantified)) {
        stack[stack.length - 1].hasQuantifier = true;
      }
    } else if (isRepetitionAt(normalized, i)) {
      if (stack.length > 0) {
        stack[stack.length - 1].hasQuantifier = true;
      }
    }
  }

  return false;
}

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
      if (hasUnsafeReDoSPattern(query)) {
        return {
          results: [],
          totalMatches: 0,
          filesMatched: 0,
          error: "Expresión regular inválida: contiene cuantificadores anidados inseguros."
        };
      }
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
