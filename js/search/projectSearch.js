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
const WILDCARD_EQUIV_CLASSES = new Set(["[\\s\\S]", "[\\S\\s]", "[\\w\\W]", "[\\W\\w]", "[\\d\\D]", "[\\D\\d]", "[^]"]);
const SAMPLE_OVERLAP_CHARS = (() => {
  const chars = [
    "\0",
    "\x01",
    "\x08",
    "\t",
    "\n",
    "\v",
    "\f",
    "\r",
    "\x1f",
    "\x7f"
  ];
  for (let code = 32; code <= 126; code += 1) {
    chars.push(String.fromCharCode(code));
  }
  // Muestras Unicode no-ASCII y espacios Unicode para detectar solapamientos entre clases Unicode/negadas.
  chars.push(
    "\u00a0",
    "\u0100",
    "\u0150",
    "\u0200",
    "\u2000",
    "\u3000",
    "á",
    "é",
    "í",
    "ó",
    "ú",
    "ñ",
    "ü",
    "ç",
    "ß",
    "α",
    "Ω",
    "ж",
    "中",
    "😀"
  );
  return chars;
})();

const ESCAPE_CONTROL_CHARS = {
  t: "\t",
  n: "\n",
  r: "\r",
  f: "\f",
  v: "\v",
  0: "\0"
};

function classifyEscapeAtom(escaped, caseSensitive = true) {
  if ("wWdDsS".includes(escaped)) {
    return { type: "atom", kind: "shorthand", value: escaped, caseSensitive };
  }
  if (Object.hasOwn(ESCAPE_CONTROL_CHARS, escaped)) {
    return { type: "atom", kind: "lit", value: ESCAPE_CONTROL_CHARS[escaped], caseSensitive };
  }
  return { type: "atom", kind: "lit", value: escaped, caseSensitive };
}

function parseGroupHeader(src, lparenIndex, inheritedCaseSensitive = true) {
  const afterParen = lparenIndex + 1;
  if (src[afterParen] !== "?") {
    return { nextIndex: afterParen, isAssertion: false, caseSensitive: inheritedCaseSensitive };
  }
  const mod = src[afterParen + 1];
  if (mod === ":") {
    return { nextIndex: afterParen + 2, isAssertion: false, caseSensitive: inheritedCaseSensitive };
  }
  if (mod === "=" || mod === "!") {
    return { nextIndex: afterParen + 2, isAssertion: true, caseSensitive: inheritedCaseSensitive };
  }
  if (mod === "<") {
    const afterLt = src[afterParen + 2];
    if (afterLt === "=" || afterLt === "!") {
      return { nextIndex: afterParen + 3, isAssertion: true, caseSensitive: inheritedCaseSensitive };
    }
    const closeGt = src.indexOf(">", afterParen + 2);
    if (closeGt !== -1 && !/[()]/.test(src.slice(afterParen + 2, closeGt))) {
      return { nextIndex: closeGt + 1, isAssertion: false, caseSensitive: inheritedCaseSensitive };
    }
  }
  if (mod === "P" && src[afterParen + 2] === "<") {
    const closeGt = src.indexOf(">", afterParen + 3);
    if (closeGt !== -1 && !/[()]/.test(src.slice(afterParen + 3, closeGt))) {
      return { nextIndex: closeGt + 1, isAssertion: false, caseSensitive: inheritedCaseSensitive };
    }
  }
  const flagMatch = /^([a-z]*)(?:-([a-z]*))?:/i.exec(src.slice(afterParen + 1));
  if (flagMatch) {
    let nextCase = inheritedCaseSensitive;
    if ((flagMatch[1] || "").includes("i")) nextCase = false;
    if ((flagMatch[2] || "").includes("i")) nextCase = true;
    return { nextIndex: afterParen + 1 + flagMatch[0].length, isAssertion: false, caseSensitive: nextCase };
  }
  return { nextIndex: afterParen + 1, isAssertion: false, caseSensitive: inheritedCaseSensitive };
}

const MAX_CONTIGUOUS_OPTIONALS = 10;

function tokenizeRegexPattern(src, { caseSensitive = true } = {}) {
  const tokens = [];
  const caseStack = [Boolean(caseSensitive)];
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const currentCase = caseStack[caseStack.length - 1];
    const classFlags = currentCase ? "" : "i";
    if (ch === "\\") {
      const next = src[i + 1] ?? "";
      if (next >= "1" && next <= "9") {
        i += 1;
        while (src[i + 1] >= "0" && src[i + 1] <= "9") {
          i += 1;
        }
        tokens.push({ type: "backref" });
        continue;
      }
      if (next === "k" && src[i + 2] === "<") {
        const closeGt = src.indexOf(">", i + 3);
        i = closeGt !== -1 ? closeGt : i + 1;
        tokens.push({ type: "backref" });
        continue;
      }
      if (next === "x") {
        const hexMatch = /^[0-9a-fA-F]{2}/.exec(src.slice(i + 2));
        if (hexMatch) {
          i += 1 + 2;
          tokens.push({
            type: "atom",
            kind: "lit",
            value: String.fromCodePoint(Number.parseInt(hexMatch[0], 16)),
            caseSensitive: currentCase
          });
          continue;
        }
      }
      if (next === "u") {
        if (src[i + 2] === "{") {
          const braceHex = /^\{([0-9a-fA-F]+)\}/.exec(src.slice(i + 2));
          if (braceHex) {
            const cp = Number.parseInt(braceHex[1], 16);
            i += 1 + braceHex[0].length;
            tokens.push({
              type: "atom",
              kind: "lit",
              value: cp <= 0x10ffff ? String.fromCodePoint(cp) : "",
              caseSensitive: currentCase
            });
            continue;
          }
        } else {
          const u4 = /^[0-9a-fA-F]{4}/.exec(src.slice(i + 2));
          if (u4) {
            i += 1 + 4;
            tokens.push({
              type: "atom",
              kind: "lit",
              value: String.fromCodePoint(Number.parseInt(u4[0], 16)),
              caseSensitive: currentCase
            });
            continue;
          }
        }
      }
      if ((next === "p" || next === "P") && src[i + 2] === "{") {
        const closeBrace = src.indexOf("}", i + 3);
        if (closeBrace !== -1) {
          const propExpr = src.slice(i, closeBrace + 1);
          i = closeBrace;
          let compiledRe = null;
          try {
            compiledRe = new RegExp(`^${propExpr}$`, currentCase ? "u" : "iu");
          } catch {
            compiledRe = null;
          }
          tokens.push({ type: "atom", kind: "class", value: propExpr, compiledRe, caseSensitive: currentCase });
          continue;
        }
      }
      if (next === "c" && /^[A-Za-z]$/.test(src[i + 2] ?? "")) {
        const ctrlCode = src.charCodeAt(i + 2) % 32;
        i += 2;
        tokens.push({ type: "atom", kind: "lit", value: String.fromCharCode(ctrlCode), caseSensitive: currentCase });
        continue;
      }
      i += 1;
      if (next === "b" || next === "B") {
        tokens.push({ type: "anchor" });
      } else {
        tokens.push(classifyEscapeAtom(next, currentCase));
      }
      continue;
    }
    if (ch === "[") {
      let end = i + 1;
      if (src[end] === "^") end += 1;
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
        tokens.push({ type: "atom", kind: "wildcard", value: ".", caseSensitive: currentCase });
      } else {
        // Precompilar una sola vez para evitar instanciar new RegExp por cada carácter muestreado.
        let compiledRe = null;
        try {
          compiledRe = new RegExp(`^${rawClass}$`, classFlags);
        } catch {
          compiledRe = null;
        }
        tokens.push({ type: "atom", kind: "class", value: rawClass, compiledRe, caseSensitive: currentCase });
      }
      continue;
    }
    if (ch === "(") {
      const header = parseGroupHeader(src, i, currentCase);
      caseStack.push(header.caseSensitive);
      tokens.push({ type: "lparen", isAssertion: header.isAssertion, caseSensitive: header.caseSensitive });
      i = header.nextIndex - 1;
      continue;
    }
    if (ch === ")") {
      if (caseStack.length > 1) caseStack.pop();
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
      tokens.push({ type: "quant", nullable: ch === "*" });
      continue;
    }
    if (ch === "?") {
      if (src[i + 1] === "?") i += 1;
      tokens.push({ type: "optional", nullable: true });
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
          tokens.push({ type: "optional", nullable: true });
        } else if (isVariableOrMulti) {
          tokens.push({ type: "quant", nullable: min === 0 });
        } else if (min === 0 && maxStr === undefined) {
          tokens.push({ type: "optional", nullable: true });
        }
        continue;
      }
    }
    if (ch === ".") {
      tokens.push({ type: "atom", kind: "wildcard", value: ".", caseSensitive: currentCase });
    } else {
      tokens.push({ type: "atom", kind: "lit", value: ch, caseSensitive: currentCase });
    }
  }
  return tokens;
}

function atomMatchesChar(atom, ch, caseSensitive = true) {
  const effectiveCase = atom.caseSensitive !== undefined ? atom.caseSensitive : caseSensitive;
  if (atom.kind === "wildcard") return ch !== "\n";
  if (atom.kind === "lit") {
    return effectiveCase ? atom.value === ch : atom.value.toLowerCase() === ch.toLowerCase();
  }
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
    return atom.compiledRe ? atom.compiledRe.test(ch) : true;
  }
  return true;
}

function parseCharClassProbeChars(rawClass) {
  const probes = [];
  if (!rawClass || rawClass.length < 3 || rawClass[0] !== "[") return probes;
  let body = rawClass.slice(1, rawClass.endsWith("]") ? -1 : rawClass.length);
  if (body.startsWith("^")) body = body.slice(1);
  const readCharCode = (str, idx) => {
    if (str[idx] !== "\\") return { cp: str.codePointAt(idx), next: idx + (str.codePointAt(idx) > 0xffff ? 2 : 1) };
    const esc = str[idx + 1] ?? "";
    if (esc === "u" && str[idx + 2] === "{") {
      const m = /^\{([0-9a-fA-F]+)\}/.exec(str.slice(idx + 2));
      if (m) return { cp: Number.parseInt(m[1], 16), next: idx + 2 + m[0].length };
    } else if (esc === "u") {
      const m = /^[0-9a-fA-F]{4}/.exec(str.slice(idx + 2));
      if (m) return { cp: Number.parseInt(m[0], 16), next: idx + 6 };
    } else if (esc === "x") {
      const m = /^[0-9a-fA-F]{2}/.exec(str.slice(idx + 2));
      if (m) return { cp: Number.parseInt(m[0], 16), next: idx + 4 };
    } else if (esc in ESCAPE_CONTROL_CHARS) {
      return { cp: ESCAPE_CONTROL_CHARS[esc].codePointAt(0), next: idx + 2 };
    }
    return { cp: esc ? esc.codePointAt(0) : -1, next: idx + 2 };
  };
  let pos = 0;
  while (pos < body.length && probes.length < 48) {
    const first = readCharCode(body, pos);
    pos = first.next;
    if (first.cp >= 0 && first.cp <= 0x10ffff) {
      probes.push(String.fromCodePoint(first.cp));
      if (body[pos] === "-" && pos + 1 < body.length) {
        const second = readCharCode(body, pos + 1);
        pos = second.next;
        if (second.cp >= first.cp && second.cp <= 0x10ffff) {
          const mid = Math.floor((first.cp + second.cp) / 2);
          probes.push(String.fromCodePoint(mid), String.fromCodePoint(second.cp));
        }
      }
    }
  }
  return probes;
}

function atomsCanOverlap(a, b, caseSensitive = true) {
  if (!a || !b) return false;
  if (a.type === "alt-group") {
    return a.atoms.some((inner) => atomsCanOverlap(inner, b, caseSensitive));
  }
  if (b.type === "alt-group") {
    return b.atoms.some((inner) => atomsCanOverlap(a, inner, caseSensitive));
  }
  if (a.kind === "wildcard" || b.kind === "wildcard") return true;
  const effectiveCaseA = a.caseSensitive !== undefined ? a.caseSensitive : caseSensitive;
  const effectiveCaseB = b.caseSensitive !== undefined ? b.caseSensitive : caseSensitive;
  if (a.kind === "lit") return atomMatchesChar(b, a.value, effectiveCaseB);
  if (b.kind === "lit") return atomMatchesChar(a, b.value, effectiveCaseA);
  if (a.kind === b.kind && a.value === b.value && effectiveCaseA === effectiveCaseB) return true;
  if (SAMPLE_OVERLAP_CHARS.some((ch) => atomMatchesChar(a, ch, effectiveCaseA) && atomMatchesChar(b, ch, effectiveCaseB))) {
    return true;
  }
  const extraProbes = [];
  if (a.kind === "class" && a.value) extraProbes.push(...parseCharClassProbeChars(a.value));
  if (b.kind === "class" && b.value) extraProbes.push(...parseCharClassProbeChars(b.value));
  return extraProbes.some((ch) => atomMatchesChar(a, ch, effectiveCaseA) && atomMatchesChar(b, ch, effectiveCaseB));
}

function anyAtomOverlaps(listA, listB, caseSensitive = true) {
  if (!listA?.length || !listB?.length) return false;
  return listA.some((a) => listB.some((b) => atomsCanOverlap(a, b, caseSensitive)));
}

function branchesTokensOverlap(branchA, branchB, caseSensitive = true) {
  if (branchA.length === 0 || branchB.length === 0) return false;
  const lenA = branchA.length;
  const lenB = branchB.length;
  if (lenA * lenB > 4096) return true;
  const memo = new Map();

  // Modela átomos `isOptional` como anulables para detectar solapamientos tipo `(a?b|b)+` y `(a|b?a)+`.
  function canAlign(i, j, matchedAny) {
    if (i === lenA || j === lenB) {
      return matchedAny;
    }
    const key = ((i * (lenB + 1)) + j) * 2 + (matchedAny ? 1 : 0);
    if (memo.has(key)) return memo.get(key);

    let result = false;
    if (atomsCanOverlap(branchA[i], branchB[j], caseSensitive) && canAlign(i + 1, j + 1, true)) {
      result = true;
    } else if (branchA[i]?.isOptional && canAlign(i + 1, j, matchedAny)) {
      result = true;
    } else if (branchB[j]?.isOptional && canAlign(i, j + 1, matchedAny)) {
      result = true;
    }

    memo.set(key, result);
    return result;
  }

  return canAlign(0, 0, false);
}

function groupHasOverlappingBranches(branches, caseSensitive = true) {
  if (branches.length < 2) return false;
  for (let a = 0; a < branches.length; a += 1) {
    for (let b = a + 1; b < branches.length; b += 1) {
      if (branchesTokensOverlap(branches[a], branches[b], caseSensitive)) {
        return true;
      }
    }
  }
  return false;
}

function createBranchState() {
  return {
    prevQuantified: null,
    startsWithQuantified: false,
    leadingQuantified: null,
    leadingNullable: true,
    sawFirstToken: false,
    allNullable: true,
    consecutiveOptionals: 0,
    optionalCount: 0
  };
}

function createFrame({ isAssertion = false } = {}) {
  return {
    isAssertion: Boolean(isAssertion),
    hasQuantifier: false,
    hasBackref: false,
    hasOptional: false,
    hasAlternationOverlap: false,
    branches: [[]],
    activeBranch: createBranchState(),
    completedBranches: []
  };
}

function mergeAtomLists(listA, listB) {
  const out = [];
  if (Array.isArray(listA)) out.push(...listA);
  if (Array.isArray(listB)) out.push(...listB);
  return out.length > 0 ? out : null;
}

/**
 * Detecta patrones de expresiones regulares susceptibles a Catastrophic Backtracking (ReDoS):
 * 1. Cuantificadores anidados a cualquier nivel de paréntesis: (a+)+, ((a)+)+, (a{1,5})+, ([a-z]+)*, (?:a?)+
 * 2. Cuantificadores adyacentes o separados por anulables/aserciones: .*.*!$, a+a+!$, a+b*a+!$, a+(?=a)a+!$
 * 3. Alternancias solapadas (incluidos átomos opcionales anulables o entre ramas en secuencia): (a|a)+, a+(?:a+|c+)!$, (?:a+|c+)a+!$
 * 4. Backreferences cuantificadas ((a+)\1+) y cascadas de > 10 opcionales contiguos (incluidos grupos opcionales).
 * @param {string} rawPattern
 * @param {{ caseSensitive?: boolean }} [options]
 * @returns {boolean}
 */
export function hasUnsafeReDoSPattern(rawPattern, options = {}) {
  const caseSensitive = options?.caseSensitive !== false;
  const src = String(rawPattern || "");
  const tokens = tokenizeRegexPattern(src, { caseSensitive });
  const frames = [createFrame()];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const current = frames[frames.length - 1];
    const br = current.activeBranch;

    if (tok.type === "anchor" || tok.type === "quant" || tok.type === "optional") {
      continue;
    }

    if (tok.type === "alt") {
      current.completedBranches.push(current.activeBranch);
      current.branches.push([]);
      current.activeBranch = createBranchState();
      continue;
    }

    if (tok.type === "backref") {
      const nextTok = tokens[i + 1];
      const isQuantified = nextTok?.type === "quant";
      const isOptional = nextTok?.type === "optional";
      if (isQuantified || isOptional) {
        i += 1;
      }
      if (isQuantified) {
        return true;
      }
      current.hasBackref = true;
      if (isOptional) {
        current.hasOptional = true;
        br.consecutiveOptionals += 1;
        br.optionalCount += 1;
        if (br.consecutiveOptionals > MAX_CONTIGUOUS_OPTIONALS) return true;
      } else {
        br.allNullable = false;
        br.consecutiveOptionals = 0;
        br.prevQuantified = null;
      }
      br.sawFirstToken = true;
      continue;
    }

    if (tok.type === "lparen") {
      frames.push(createFrame({ isAssertion: Boolean(tok.isAssertion) }));
      continue;
    }

    if (tok.type === "rparen") {
      if (frames.length <= 1) continue;
      const group = frames.pop();
      group.completedBranches.push(group.activeBranch);
      const parent = frames[frames.length - 1];
      const pBr = parent.activeBranch;
      const nextTok = tokens[i + 1];
      const groupQuantified = nextTok?.type === "quant";
      const groupOptional = nextTok?.type === "optional";
      const isNullableQuant = Boolean(nextTok?.nullable);
      if (groupQuantified || groupOptional) {
        i += 1;
      }

      if (group.isAssertion) {
        if (group.hasBackref) parent.hasBackref = true;
        if (group.hasAlternationOverlap) parent.hasAlternationOverlap = true;
        if (group.hasQuantifier) parent.hasQuantifier = true;
        continue;
      }

      const branchOverlap = groupHasOverlappingBranches(group.branches, caseSensitive);
      const hasNestedOverlap = group.hasAlternationOverlap || branchOverlap;
      const groupAtoms = group.branches.flat();
      const groupAllNullable = group.completedBranches.every((b) => b.allNullable);

      if (groupQuantified) {
        if (group.hasQuantifier || group.hasBackref || group.hasOptional || groupAllNullable || hasNestedOverlap) {
          return true;
        }
        parent.hasQuantifier = true;
        if (!isNullableQuant) {
          pBr.allNullable = false;
          pBr.consecutiveOptionals = 0;
        } else {
          parent.hasOptional = true;
        }
        if (groupAtoms.length > 0) {
          if (anyAtomOverlaps(pBr.prevQuantified, groupAtoms, caseSensitive)) {
            return true;
          }
          pBr.prevQuantified = isNullableQuant
            ? mergeAtomLists(pBr.prevQuantified, groupAtoms)
            : groupAtoms;
          if (!pBr.sawFirstToken || pBr.leadingNullable) {
            pBr.startsWithQuantified = true;
            pBr.leadingQuantified = mergeAtomLists(pBr.leadingQuantified, groupAtoms);
          }
          if (!isNullableQuant) {
            pBr.leadingNullable = false;
          }
        }
        pBr.sawFirstToken = true;
        const branch = parent.branches[parent.branches.length - 1];
        if (group.branches.length === 1) {
          branch.push(...group.branches[0]);
        } else if (groupAtoms.length > 0) {
          branch.push({ type: "alt-group", atoms: groupAtoms, isOptional: isNullableQuant });
        }
        continue;
      }

      // Grupo vacío (): no restablecer estado cuantificado ni racha de opcionales del padre
      if (groupAtoms.length === 0 && !group.hasBackref) {
        continue;
      }

      if (group.hasQuantifier) parent.hasQuantifier = true;
      if (group.hasBackref) parent.hasBackref = true;
      if (group.hasOptional) parent.hasOptional = true;
      if (hasNestedOverlap) parent.hasAlternationOverlap = true;

      let unionLeading = null;
      let anyStartsQuantified = false;
      let unionEnding = null;
      let maxBranchOpts = 0;
      for (const bState of group.completedBranches) {
        if (bState.startsWithQuantified && bState.leadingQuantified) {
          anyStartsQuantified = true;
          unionLeading = mergeAtomLists(unionLeading, bState.leadingQuantified);
        }
        if (bState.prevQuantified) {
          unionEnding = mergeAtomLists(unionEnding, bState.prevQuantified);
        }
        if (bState.optionalCount > maxBranchOpts) {
          maxBranchOpts = bState.optionalCount;
        }
      }

      if (anyStartsQuantified && anyAtomOverlaps(pBr.prevQuantified, unionLeading, caseSensitive)) {
        return true;
      }

      if (groupOptional) {
        parent.hasOptional = true;
        const addedOpts = groupAllNullable ? Math.max(1, maxBranchOpts) : 1;
        pBr.consecutiveOptionals += addedOpts;
        pBr.optionalCount += addedOpts;
        if (pBr.consecutiveOptionals > MAX_CONTIGUOUS_OPTIONALS) return true;
        if (unionEnding) {
          pBr.prevQuantified = mergeAtomLists(pBr.prevQuantified, unionEnding);
        }
        if (anyStartsQuantified && (!pBr.sawFirstToken || pBr.leadingNullable)) {
          pBr.startsWithQuantified = true;
          pBr.leadingQuantified = mergeAtomLists(pBr.leadingQuantified, unionLeading);
        }
      } else {
        if (!groupAllNullable) {
          pBr.allNullable = false;
          pBr.consecutiveOptionals = 0;
        } else {
          pBr.consecutiveOptionals += maxBranchOpts;
          pBr.optionalCount += maxBranchOpts;
          if (pBr.consecutiveOptionals > MAX_CONTIGUOUS_OPTIONALS) return true;
        }
        if (anyStartsQuantified && (!pBr.sawFirstToken || pBr.leadingNullable)) {
          pBr.startsWithQuantified = true;
          pBr.leadingQuantified = mergeAtomLists(pBr.leadingQuantified, unionLeading);
        }
        if (!groupAllNullable) {
          pBr.leadingNullable = false;
          pBr.prevQuantified = unionEnding;
        } else {
          pBr.prevQuantified = mergeAtomLists(pBr.prevQuantified, unionEnding);
        }
      }
      pBr.sawFirstToken = true;

      const branch = parent.branches[parent.branches.length - 1];
      if (group.branches.length === 1) {
        if (groupOptional && group.branches[0].length === 1) {
          branch.push({ ...group.branches[0][0], isOptional: true });
        } else {
          branch.push(...group.branches[0]);
        }
      } else {
        if (groupAtoms.length > 0) {
          branch.push({ type: "alt-group", atoms: groupAtoms, isOptional: groupOptional || groupAllNullable });
        }
      }
      continue;
    }

    if (tok.type === "atom") {
      const nextTok = tokens[i + 1];
      const isQuantified = nextTok?.type === "quant";
      const isOptional = nextTok?.type === "optional";
      const isNullableQuant = Boolean(nextTok?.nullable);
      if (isQuantified || isOptional) {
        i += 1;
      }

      const branch = current.branches[current.branches.length - 1];
      branch.push(isOptional ? { ...tok, isOptional: true } : tok);

      if (isQuantified) {
        current.hasQuantifier = true;
        if (!isNullableQuant) {
          br.allNullable = false;
          br.consecutiveOptionals = 0;
        } else {
          current.hasOptional = true;
        }
        if (anyAtomOverlaps(br.prevQuantified, [tok], caseSensitive)) {
          return true;
        }
        br.prevQuantified = isNullableQuant ? mergeAtomLists(br.prevQuantified, [tok]) : [tok];
        if (!br.sawFirstToken || br.leadingNullable) {
          br.startsWithQuantified = true;
          br.leadingQuantified = mergeAtomLists(br.leadingQuantified, [tok]);
        }
        if (!isNullableQuant) {
          br.leadingNullable = false;
        }
      } else if (isOptional) {
        current.hasOptional = true;
        br.consecutiveOptionals += 1;
        br.optionalCount += 1;
        if (br.consecutiveOptionals > MAX_CONTIGUOUS_OPTIONALS) {
          return true;
        }
      } else {
        br.allNullable = false;
        br.leadingNullable = false;
        br.consecutiveOptionals = 0;
        br.prevQuantified = null;
      }
      br.sawFirstToken = true;
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
      if (hasUnsafeReDoSPattern(query, { caseSensitive })) {
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

    const needsUnicode = /\\(?:p|P)\{|\\u\{/.test(pattern);
    const flags = `${caseSensitive ? "g" : "gi"}${needsUnicode ? "u" : ""}`;
    try {
      regex = new RegExp(pattern, flags);
    } catch (unicodeErr) {
      if (needsUnicode) {
        regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
      } else {
        throw unicodeErr;
      }
    }
  } catch (err) {
    return {
      results: [],
      totalMatches: 0,
      filesMatched: 0,
      error: `Expresión regular inválida: ${err.message}`
    };
  }

  const hasAnchorOutsideClass = (pat) => {
    let inClass = false;
    for (let k = 0; k < pat.length; k += 1) {
      const ch = pat[k];
      if (ch === "\\") {
        k += 1;
        continue;
      }
      if (ch === "[" && !inClass) {
        inClass = true;
        continue;
      }
      if (ch === "]" && inClass) {
        inClass = false;
        continue;
      }
      if (!inClass && (ch === "^" || ch === "$")) return true;
    }
    return false;
  };
  const canPretestWholeFile = !isRegex || !hasAnchorOutsideClass(cleanQuery);

  const results = [];
  let totalMatchesCount = 0;

  for (const file of files || []) {
    if (!file || file.isFolder || file.isBinary) continue;
    if (typeof file.path !== "string" || typeof file.content !== "string" || !file.content) continue;

    const baseName = file.path.split(/[/\\]/).pop() || file.path;
    const ext = baseName.includes(".") ? baseName.split(".").pop().toLowerCase() : "";
    if (BINARY_EXTENSIONS.has(ext)) continue;

    // Optimización: si el archivo no contiene el patrón, evitar escanear línea a línea.
    if (canPretestWholeFile) {
      regex.lastIndex = 0;
      if (!regex.test(file.content)) continue;
      regex.lastIndex = 0;
    }

    // Escaneo línea por línea con indexOf("\n") en lugar de split(/\r?\n/), evitando reservar
    // arreglos masivos de miles de líneas cuando solo existen pocas coincidencias o se alcanza el límite.
    const content = file.content;
    const contentLen = content.length;
    const fileMatches = [];
    let lineIdx = 0;
    let lineStart = 0;

    while (lineStart <= contentLen) {
      const nlIdx = content.indexOf("\n", lineStart);
      const hasNl = nlIdx !== -1;
      const rawEnd = hasNl ? nlIdx : contentLen;
      const lineEnd = rawEnd > lineStart && content.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;

      if (lineEnd > lineStart) {
        const lineText = content.slice(lineStart, lineEnd);
        regex.lastIndex = 0;

        let match;
        while ((match = regex.exec(lineText)) !== null) {
          const matchText = match[0];
          if (matchText.length === 0) {
            // Avanzar un code point completo para no partir pares sustitutos UTF-16.
            const cp = lineText.codePointAt(regex.lastIndex);
            regex.lastIndex += cp !== undefined && cp > 0xffff ? 2 : 1;
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
      }

      if (fileMatches.length >= maxMatchesPerFile || totalMatchesCount >= maxTotalMatches || !hasNl) {
        break;
      }
      lineStart = nlIdx + 1;
      lineIdx += 1;
    }

    if (fileMatches.length > 0) {
      results.push({
        path: file.path,
        shortName: baseName,
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
