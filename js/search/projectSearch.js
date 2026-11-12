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
const MAX_LINE_SNIPPET_LENGTH = 300;
const SNIPPET_MATCH_LEADING_CONTEXT = 60;
const WILDCARD_EQUIV_CLASSES = new Set(["[\\s\\S]", "[\\S\\s]", "[\\w\\W]", "[\\W\\w]", "[\\d\\D]", "[\\D\\d]"]);
const SAMPLE_OVERLAP_CHARS = (() => {
  const chars = ["\t", "\n"];
  for (let code = 32; code <= 126; code += 1) {
    chars.push(String.fromCharCode(code));
  }
  return chars;
})();

function classifyEscapeAtom(escaped) {
  if ("wWdDsS".includes(escaped)) {
    return { type: "atom", kind: "shorthand", value: escaped };
  }
  return { type: "atom", kind: "lit", value: escaped };
}

function skipGroupHeader(src, lparenIndex) {
  const afterParen = lparenIndex + 1;
  if (src[afterParen] !== "?") {
    return afterParen;
  }
  const mod = src[afterParen + 1];
  if (mod === ":" || mod === "=" || mod === "!") {
    return afterParen + 2;
  }
  if (mod === "<") {
    const afterLt = src[afterParen + 2];
    if (afterLt === "=" || afterLt === "!") {
      return afterParen + 3;
    }
    const closeGt = src.indexOf(">", afterParen + 2);
    if (closeGt !== -1 && !/[()]/.test(src.slice(afterParen + 2, closeGt))) {
      return closeGt + 1;
    }
  }
  if (mod === "P" && src[afterParen + 2] === "<") {
    const closeGt = src.indexOf(">", afterParen + 3);
    if (closeGt !== -1 && !/[()]/.test(src.slice(afterParen + 3, closeGt))) {
      return closeGt + 1;
    }
  }
  const flagMatch = /^[a-z-]+:/i.exec(src.slice(afterParen + 1));
  if (flagMatch) {
    return afterParen + 1 + flagMatch[0].length;
  }
  return afterParen + 1;
}

function tokenizeRegexPattern(src) {
  const tokens = [];
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") {
      const next = src[i + 1] ?? "";
      i += 1;
      if (next === "b" || next === "B") {
        tokens.push({ type: "anchor" });
      } else {
        tokens.push(classifyEscapeAtom(next));
      }
      continue;
    }
    if (ch === "[") {
      let end = i + 1;
      if (src[end] === "^") end += 1;
      if (src[end] === "]") end += 1;
      while (end < src.length) {
        if (src[end] === "\\") {
          end += 2;
          continue;
        }
        if (src[end] === "]") break;
        end += 1;
      }
      const rawClass = src.slice(i, end < src.length ? end + 1 : src.length);
      i = end < src.length ? end : src.length - 1;
      if (WILDCARD_EQUIV_CLASSES.has(rawClass)) {
        tokens.push({ type: "atom", kind: "wildcard", value: "." });
      } else {
        tokens.push({ type: "atom", kind: "class", value: rawClass });
      }
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i = skipGroupHeader(src, i) - 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen" });
      continue;
    }
    if (ch === "|") {
      tokens.push({ type: "alt" });
      continue;
    }
    if (ch === "^" || ch === "$") {
      tokens.push({ type: "anchor" });
      continue;
    }
    if (ch === "+" || ch === "*") {
      if (src[i + 1] === "?") i += 1;
      tokens.push({ type: "quant" });
      continue;
    }
    if (ch === "?") {
      tokens.push({ type: "optional" });
      continue;
    }
    if (ch === "{") {
      const braceMatch = /^\{(\d+)(?:,(\d*))?\}/.exec(src.slice(i));
      if (braceMatch) {
        i += braceMatch[0].length - 1;
        if (src[i + 1] === "?") i += 1;
        const min = Number(braceMatch[1]);
        const maxStr = braceMatch[2];
        const isVariableOrMulti = maxStr !== undefined || min > 1;
        if (maxStr === "1" && min === 0) {
          tokens.push({ type: "optional" });
        } else if (isVariableOrMulti && !(maxStr === undefined && min === 1)) {
          tokens.push({ type: "quant" });
        }
        continue;
      }
    }
    if (ch === ".") {
      tokens.push({ type: "atom", kind: "wildcard", value: "." });
    } else {
      tokens.push({ type: "atom", kind: "lit", value: ch });
    }
  }
  return tokens;
}

function atomMatchesChar(atom, ch) {
  if (atom.kind === "wildcard") return ch !== "\n";
  if (atom.kind === "lit") return atom.value === ch;
  if (atom.kind === "shorthand") {
    switch (atom.value) {
      case "d": return /\d/.test(ch);
      case "D": return /\D/.test(ch);
      case "w": return /\w/.test(ch);
      case "W": return /\W/.test(ch);
      case "s": return /\s/.test(ch);
      case "S": return /\S/.test(ch);
      default: return true;
    }
  }
  if (atom.kind === "class") {
    try {
      return new RegExp(`^${atom.value}$`).test(ch);
    } catch {
      return true;
    }
  }
  return true;
}

function atomsCanOverlap(a, b) {
  if (!a || !b) return false;
  if (a.type === "alt-group") {
    return a.atoms.some((inner) => atomsCanOverlap(inner, b));
  }
  if (b.type === "alt-group") {
    return b.atoms.some((inner) => atomsCanOverlap(a, inner));
  }
  if (a.kind === "wildcard" || b.kind === "wildcard") return true;
  if (a.kind === "lit") return atomMatchesChar(b, a.value);
  if (b.kind === "lit") return atomMatchesChar(a, b.value);
  if (a.kind === b.kind && a.value === b.value) return true;
  return SAMPLE_OVERLAP_CHARS.some((ch) => atomMatchesChar(a, ch) && atomMatchesChar(b, ch));
}

function anyAtomOverlaps(listA, listB) {
  if (!listA?.length || !listB?.length) return false;
  return listA.some((a) => listB.some((b) => atomsCanOverlap(a, b)));
}

function branchesTokensOverlap(branchA, branchB) {
  if (branchA.length === 0 || branchB.length === 0) return false;
  const minLen = Math.min(branchA.length, branchB.length);
  for (let idx = 0; idx < minLen; idx += 1) {
    if (!atomsCanOverlap(branchA[idx], branchB[idx])) {
      return false;
    }
  }
  return true;
}

function groupHasOverlappingBranches(branches) {
  if (branches.length < 2) return false;
  for (let a = 0; a < branches.length; a += 1) {
    for (let b = a + 1; b < branches.length; b += 1) {
      if (branchesTokensOverlap(branches[a], branches[b])) {
        return true;
      }
    }
  }
  return false;
}

function createFrame(isRoot = false) {
  return {
    isRoot,
    hasQuantifier: false,
    hasAlternationOverlap: false,
    branches: [[]],
    prevQuantified: null,
    startsWithQuantified: false,
    leadingQuantified: null,
    sawFirstToken: false
  };
}

/**
 * Detecta patrones de expresiones regulares susceptibles a Catastrophic Backtracking (ReDoS):
 * 1. Cuantificadores anidados a cualquier nivel de paréntesis: (a+)+, ((a)+)+, (a{1,5})+, ([a-z]+)*
 * 2. Cuantificadores adyacentes solapados en raíz u otro nivel: .*.*!$, a+a+!$
 * 3. Alternancias solapadas o con comodines dentro de grupos cuantificados: (a|a)+, (a|ab)+, (b|.)+, (?<g>a|ab)+
 * @param {string} rawPattern
 * @returns {boolean}
 */
export function hasUnsafeReDoSPattern(rawPattern) {
  const src = String(rawPattern || "");
  const tokens = tokenizeRegexPattern(src);
  const frames = [createFrame(true)];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const current = frames[frames.length - 1];

    if (tok.type === "anchor" || tok.type === "quant" || tok.type === "optional") {
      continue;
    }

    if (tok.type === "alt") {
      current.branches.push([]);
      current.prevQuantified = null;
      current.sawFirstToken = false;
      continue;
    }

    if (tok.type === "lparen") {
      frames.push(createFrame(false));
      continue;
    }

    if (tok.type === "rparen") {
      if (frames.length <= 1) continue;
      const group = frames.pop();
      const parent = frames[frames.length - 1];
      const nextTok = tokens[i + 1];
      const groupQuantified = nextTok?.type === "quant";
      const groupOptional = nextTok?.type === "optional";
      if (groupQuantified || groupOptional) {
        i += 1;
      }

      const branchOverlap = groupHasOverlappingBranches(group.branches);
      const hasNestedOverlap = group.hasAlternationOverlap || branchOverlap;

      if (groupQuantified) {
        if (group.hasQuantifier || hasNestedOverlap) {
          return true;
        }
        parent.hasQuantifier = true;
        const groupAtoms = group.branches.flat();
        if (groupAtoms.length > 0) {
          if (anyAtomOverlaps(parent.prevQuantified, groupAtoms)) {
            return true;
          }
          parent.prevQuantified = groupAtoms;
          if (!parent.sawFirstToken) {
            parent.startsWithQuantified = true;
            parent.leadingQuantified = groupAtoms;
          }
        }
        parent.sawFirstToken = true;
        const branch = parent.branches[parent.branches.length - 1];
        if (group.branches.length === 1) {
          branch.push(...group.branches[0]);
        } else if (groupAtoms.length > 0) {
          branch.push({ type: "alt-group", atoms: groupAtoms });
        }
        continue;
      }

      if (group.hasQuantifier) parent.hasQuantifier = true;
      if (hasNestedOverlap) parent.hasAlternationOverlap = true;

      if (group.startsWithQuantified && anyAtomOverlaps(parent.prevQuantified, group.leadingQuantified)) {
        return true;
      }
      if (!groupOptional) {
        if (!parent.sawFirstToken && group.startsWithQuantified) {
          parent.startsWithQuantified = true;
          parent.leadingQuantified = group.leadingQuantified;
        }
        parent.prevQuantified = group.prevQuantified;
      }
      parent.sawFirstToken = true;

      const branch = parent.branches[parent.branches.length - 1];
      if (group.branches.length === 1) {
        branch.push(...group.branches[0]);
      } else {
        const flatAtoms = group.branches.flat();
        if (flatAtoms.length > 0) {
          branch.push({ type: "alt-group", atoms: flatAtoms });
        }
      }
      continue;
    }

    if (tok.type === "atom") {
      const nextTok = tokens[i + 1];
      const isQuantified = nextTok?.type === "quant";
      const isOptional = nextTok?.type === "optional";
      if (isQuantified || isOptional) {
        i += 1;
      }

      const branch = current.branches[current.branches.length - 1];
      branch.push(tok);

      if (isQuantified) {
        current.hasQuantifier = true;
        if (anyAtomOverlaps(current.prevQuantified, [tok])) {
          return true;
        }
        current.prevQuantified = [tok];
        if (!current.sawFirstToken) {
          current.startsWithQuantified = true;
          current.leadingQuantified = [tok];
        }
      } else if (!isOptional) {
        current.prevQuantified = null;
      }
      current.sawFirstToken = true;
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
      pattern = `\\b(?:${pattern})\\b`;
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

        const matchStart = match.index;
        const matchEnd = matchStart + matchText.length;
        let snippet = lineText;
        let start = matchStart;
        let end = matchEnd;

        if (lineText.length > MAX_LINE_SNIPPET_LENGTH) {
          const fitsFromStart = matchEnd <= MAX_LINE_SNIPPET_LENGTH;
          const windowStart = fitsFromStart
            ? 0
            : Math.max(0, Math.min(matchStart - SNIPPET_MATCH_LEADING_CONTEXT, lineText.length - MAX_LINE_SNIPPET_LENGTH));
          const prefix = windowStart > 0 ? "…" : "";
          const maxBodyLength = MAX_LINE_SNIPPET_LENGTH - prefix.length;
          const windowEnd = Math.min(lineText.length, windowStart + maxBodyLength);
          const suffix = windowEnd < lineText.length ? "…" : "";
          snippet = `${prefix}${lineText.slice(windowStart, windowEnd)}${suffix}`;

          const minSnippetIdx = prefix.length;
          const maxSnippetIdx = prefix.length + (windowEnd - windowStart);
          start = Math.max(minSnippetIdx, Math.min(maxSnippetIdx, prefix.length + (matchStart - windowStart)));
          end = Math.max(start, Math.min(maxSnippetIdx, prefix.length + (matchEnd - windowStart)));
        }

        fileMatches.push({
          line: lineIdx + 1,
          column: match.index + 1,
          lineText: snippet,
          matchText,
          start,
          end
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
