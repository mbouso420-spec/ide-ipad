/**
 * Empaquetador ligero de módulos ES/TypeScript/JSX/CSS/JSON relativos 100% offline.
 * Resuelve dependencias locales (`./`, `../`, `/`) dentro del proyecto en IndexedDB y compila
 * el grafo en un registro virtual sincrónico compatible con `<iframe srcdoc>` y la CSP estricta
 * del IDE (sin necesidad de servidores locales ni URLs `blob:` bloqueadas en `script-src`).
 */

import { normalizePath } from "../storage/workspaceDb.js";
import { transpileTypeScriptAndJsx, tokenizeJsWithOffsets } from "./tsTranspiler.js";
import {
  TS_EXTENSIONS,
  IGNORED_PREVIEW_DIRS,
  getFileExtension,
  getParentFolder,
  resolveRelativePath
} from "./previewUtils.js";

const MODULE_EXTENSION_PROBES = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".css"];
const INDEX_EXTENSION_PROBES = [".ts", ".tsx", ".js", ".mjs", ".jsx", ".json"];
const CODE_SOURCE_EXTS = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx"]);

const CONTINUATION_NEXT_OPS = new Set([
  ".", "?.", "(", "[", ",", "?", ":", "=",
  "+", "-", "*", "/", "%", "**",
  "&&", "||", "??", "==", "===", "!=", "!==",
  "<", ">", "<=", ">=", "&", "|", "^", "<<", ">>", ">>>",
  "in", "of", "instanceof", "as", "satisfies"
]);

const CONTINUATION_PREV_TOKENS = new Set([
  "=", "+", "-", "*", "/", "%", "**",
  "&&", "||", "??", "?", ":", ",", ".", "?.", "=>",
  "(", "[", "{",
  "return", "throw", "await", "yield", "typeof", "void", "delete", "new",
  "in", "of", "instanceof"
]);

function isIgnoredPath(cleanPath) {
  for (const part of String(cleanPath || "").split("/")) {
    if (IGNORED_PREVIEW_DIRS.has(part.toLowerCase())) return true;
  }
  return false;
}

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
    if (!clean || isIgnoredPath(clean)) continue;
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
  return s.startsWith("./") || s.startsWith("../") || s.startsWith("/");
}

/**
 * Resuelve un import relativo `./foo`, `../bar` o `/baz` (con o sin extensión, incluyendo fallback `.js` -> `.ts`/`.tsx`).
 * @param {string} specifier
 * @param {string} fromPath
 * @param {Map<string, object>} exactMap
 * @param {{ allowParentTraversal?: boolean, allowUnloaded?: boolean }} [options]
 * @returns {object|null}
 */
export function resolveLocalModuleEntry(specifier, fromPath, exactMap, options = {}) {
  const { allowParentTraversal = true, allowUnloaded = false } = options;
  if (!exactMap || !isRelativeModuleSpecifier(specifier)) return null;

  const cleanRef = String(specifier).trim().split("?")[0].split("#")[0].replace(/\\/g, "/");
  if (!cleanRef) return null;
  if (!allowParentTraversal) {
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
  if (!base) return null;

  const isUsable = (entry) =>
    Boolean(entry) && (allowUnloaded || (typeof entry.content === "string" && entry.contentLoaded !== false));

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

  for (const ext of INDEX_EXTENSION_PROBES) {
    const found = exactMap.get(`${base}/index${ext}`);
    if (isUsable(found)) return found;
  }

  return null;
}

function unquoteStringToken(tok) {
  if (!tok || tok.type !== "string" || tok.value.length < 2) return "";
  return tok.value.slice(1, -1).replace(/\\(.)/g, "$1");
}

function skipTrivia(tokens, idx) {
  let j = idx;
  while (j < tokens.length && (tokens[j].type === "ws" || tokens[j].type === "comment")) {
    j += 1;
  }
  return j;
}

function prevNonTriviaIndex(tokens, idx) {
  let j = idx - 1;
  while (j >= 0 && (tokens[j].type === "ws" || tokens[j].type === "comment")) {
    j -= 1;
  }
  return j;
}

function hasNewlineBetween(tokens, fromIdx, toIdx) {
  for (let k = fromIdx; k < toIdx; k += 1) {
    const val = tokens[k]?.value || "";
    if (val.includes("\n") || val.includes("\r")) return true;
  }
  return false;
}

function canStartTopLevelKeyword(tokens, idx, prevSigIdx) {
  if (prevSigIdx < 0) return true;
  const prev = tokens[prevSigIdx];
  if (!prev) return true;
  if (prev.value === ";" || prev.value === "}") return true;
  if (prev.value === ".") return false;
  return hasNewlineBetween(tokens, prevSigIdx + 1, idx);
}

function findMatchingBrace(tokens, openIdx, openChar = "{", closeChar = "}") {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === "punct" && t.value === openChar) depth += 1;
    else if (t.type === "punct" && t.value === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

function consumeImportAttributesAndSemi(tokens, startIdx, sourceLen) {
  let idx = skipTrivia(tokens, startIdx);
  if (
    idx < tokens.length &&
    tokens[idx].type === "ident" &&
    (tokens[idx].value === "with" || tokens[idx].value === "assert")
  ) {
    const next = skipTrivia(tokens, idx + 1);
    if (next < tokens.length && tokens[next].type === "punct" && tokens[next].value === "{") {
      idx = skipTrivia(tokens, findMatchingBrace(tokens, next) + 1);
    }
  }
  if (idx < tokens.length && tokens[idx].type === "punct" && tokens[idx].value === ";") {
    return { nextTokenIdx: idx + 1, endOffset: tokens[idx].end };
  }
  const prevEnd = idx > 0 && idx - 1 < tokens.length ? tokens[idx - 1].end : sourceLen;
  // Si el siguiente token es trivia antes de salto de línea, el statement termina justo tras el token previo significativo
  const prevSig = prevNonTriviaIndex(tokens, idx);
  return {
    nextTokenIdx: prevSig + 1,
    endOffset: prevSig >= 0 ? tokens[prevSig].end : prevEnd
  };
}

function isAsiBoundary(tokens, prevSigIdx, nextSigIdx) {
  if (prevSigIdx < 0) return false;
  if (nextSigIdx >= tokens.length) return true;
  if (!hasNewlineBetween(tokens, prevSigIdx + 1, nextSigIdx)) return false;
  const prev = tokens[prevSigIdx];
  const next = tokens[nextSigIdx];
  if (!prev || !next) return true;
  if (CONTINUATION_PREV_TOKENS.has(prev.value)) return false;
  if (CONTINUATION_NEXT_OPS.has(next.value)) return false;
  return true;
}

function findStatementEndOffset(tokens, startIdx, sourceLen) {
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let prevSig = -1;

  for (let i = startIdx; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === "ws" || t.type === "comment") continue;

    if (brace === 0 && paren === 0 && bracket === 0) {
      if (t.type === "punct" && t.value === ";") {
        return { endOffset: t.end, nextTokenIdx: i + 1, endsWithSemi: true };
      }
      if (isAsiBoundary(tokens, prevSig, i)) {
        const endOffset = prevSig >= 0 ? tokens[prevSig].end : t.start;
        return { endOffset, nextTokenIdx: prevSig + 1, endsWithSemi: false };
      }
    }

    if (t.type === "punct") {
      if (t.value === "{") brace += 1;
      else if (t.value === "}") brace = Math.max(0, brace - 1);
      else if (t.value === "(") paren += 1;
      else if (t.value === ")") paren = Math.max(0, paren - 1);
      else if (t.value === "[") bracket += 1;
      else if (t.value === "]") bracket = Math.max(0, bracket - 1);
    }
    prevSig = i;
  }

  return { endOffset: sourceLen, nextTokenIdx: tokens.length, endsWithSemi: false };
}

function parseNamedSpecifiers(tokens, openBraceIdx, closeBraceIdx) {
  const specs = [];
  let i = openBraceIdx + 1;
  while (i < closeBraceIdx) {
    i = skipTrivia(tokens, i);
    if (i >= closeBraceIdx) break;
    if (tokens[i].type === "punct" && tokens[i].value === ",") {
      i += 1;
      continue;
    }
    let first = tokens[i];
    // Soporte defensivo para `import { type Foo, bar }` si quedara sin transpilar
    if (first.type === "ident" && first.value === "type") {
      const look = skipTrivia(tokens, i + 1);
      if (look < closeBraceIdx && tokens[look].type === "ident" && tokens[look].value !== "as") {
        i = look + 1;
        while (i < closeBraceIdx && !(tokens[i].type === "punct" && tokens[i].value === ",")) {
          i += 1;
        }
        continue;
      }
    }
    if (first.type !== "ident" && first.type !== "string") {
      i += 1;
      continue;
    }
    const rawImported = first.type === "string" ? JSON.stringify(unquoteStringToken(first)) : first.value;
    let localName = first.type === "string" ? unquoteStringToken(first) : first.value;
    const afterFirst = skipTrivia(tokens, i + 1);
    if (
      afterFirst < closeBraceIdx &&
      tokens[afterFirst].type === "ident" &&
      tokens[afterFirst].value === "as"
    ) {
      const aliasIdx = skipTrivia(tokens, afterFirst + 1);
      if (aliasIdx < closeBraceIdx && (tokens[aliasIdx].type === "ident" || tokens[aliasIdx].type === "string")) {
        localName =
          tokens[aliasIdx].type === "string" ? unquoteStringToken(tokens[aliasIdx]) : tokens[aliasIdx].value;
        i = aliasIdx + 1;
      } else {
        i = afterFirst + 1;
      }
    } else {
      i = afterFirst;
    }
    specs.push({ imported: rawImported, local: localName });
  }
  return specs;
}

function parseImportClause(tokens, startIdx, fromIdx) {
  let defaultIdent = null;
  let namespaceIdent = null;
  let namedSpecs = [];

  let i = skipTrivia(tokens, startIdx);
  if (i < fromIdx && tokens[i].type === "ident") {
    defaultIdent = tokens[i].value;
    i = skipTrivia(tokens, i + 1);
    if (i < fromIdx && tokens[i].type === "punct" && tokens[i].value === ",") {
      i = skipTrivia(tokens, i + 1);
    }
  }
  if (i < fromIdx && tokens[i].type === "punct" && tokens[i].value === "*") {
    const asIdx = skipTrivia(tokens, i + 1);
    if (asIdx < fromIdx && tokens[asIdx].type === "ident" && tokens[asIdx].value === "as") {
      const nsIdx = skipTrivia(tokens, asIdx + 1);
      if (nsIdx < fromIdx && tokens[nsIdx].type === "ident") {
        namespaceIdent = tokens[nsIdx].value;
      }
    }
  } else if (i < fromIdx && tokens[i].type === "punct" && tokens[i].value === "{") {
    const closeIdx = Math.min(fromIdx - 1, findMatchingBrace(tokens, i));
    namedSpecs = parseNamedSpecifiers(tokens, i, closeIdx);
  }

  return { defaultIdent, namespaceIdent, namedSpecs };
}

function extractBindingNamesFromPattern(tokens, startIdx) {
  const names = [];
  let i = skipTrivia(tokens, startIdx);
  if (i >= tokens.length) return { names, nextTokenIdx: i };

  const tok = tokens[i];
  if (tok.type === "ident") {
    names.push(tok.value);
    return { names, nextTokenIdx: i + 1 };
  }

  if (tok.type === "punct" && tok.value === "{") {
    const closeIdx = findMatchingBrace(tokens, i);
    let cur = i + 1;
    while (cur < closeIdx) {
      cur = skipTrivia(tokens, cur);
      if (cur >= closeIdx) break;
      if (tokens[cur].type === "punct" && tokens[cur].value === ",") {
        cur += 1;
        continue;
      }
      if (tokens[cur].type === "punct" && tokens[cur].value === "...") {
        cur = skipTrivia(tokens, cur + 1);
        if (cur < closeIdx && tokens[cur].type === "ident") {
          names.push(tokens[cur].value);
          cur += 1;
        }
        continue;
      }
      // Propiedad computada `{ [expr]: target }`
      if (tokens[cur].type === "punct" && tokens[cur].value === "[") {
        cur = findMatchingBrace(tokens, cur, "[", "]") + 1;
        cur = skipTrivia(tokens, cur);
        if (cur < closeIdx && tokens[cur].type === "punct" && tokens[cur].value === ":") {
          const inner = extractBindingNamesFromPattern(tokens, cur + 1);
          names.push(...inner.names);
          cur = inner.nextTokenIdx;
        }
      } else if (tokens[cur].type === "ident" || tokens[cur].type === "string" || tokens[cur].type === "number") {
        const keyTok = tokens[cur];
        const afterKey = skipTrivia(tokens, cur + 1);
        if (afterKey < closeIdx && tokens[afterKey].type === "punct" && tokens[afterKey].value === ":") {
          const inner = extractBindingNamesFromPattern(tokens, afterKey + 1);
          names.push(...inner.names);
          cur = inner.nextTokenIdx;
        } else {
          if (keyTok.type === "ident") names.push(keyTok.value);
          cur = afterKey;
        }
      } else {
        cur += 1;
      }
      // Saltar valor por defecto `= expr` hasta coma o cierre `}` de este patrón
      cur = skipTrivia(tokens, cur);
      if (cur < closeIdx && tokens[cur].type === "punct" && tokens[cur].value === "=") {
        let p = 0;
        let b = 0;
        let br = 0;
        cur += 1;
        while (cur < closeIdx) {
          const t = tokens[cur];
          if (t.type === "punct") {
            if (p === 0 && b === 0 && br === 0 && t.value === ",") break;
            if (t.value === "(") p += 1;
            else if (t.value === ")") p = Math.max(0, p - 1);
            else if (t.value === "[") b += 1;
            else if (t.value === "]") b = Math.max(0, b - 1);
            else if (t.value === "{") br += 1;
            else if (t.value === "}") br = Math.max(0, br - 1);
          }
          cur += 1;
        }
      }
    }
    return { names, nextTokenIdx: closeIdx + 1 };
  }

  if (tok.type === "punct" && tok.value === "[") {
    const closeIdx = findMatchingBrace(tokens, i, "[", "]");
    let cur = i + 1;
    while (cur < closeIdx) {
      cur = skipTrivia(tokens, cur);
      if (cur >= closeIdx) break;
      if (tokens[cur].type === "punct" && tokens[cur].value === ",") {
        cur += 1;
        continue;
      }
      if (tokens[cur].type === "punct" && tokens[cur].value === "...") {
        cur += 1;
      }
      const inner = extractBindingNamesFromPattern(tokens, cur);
      names.push(...inner.names);
      cur = skipTrivia(tokens, inner.nextTokenIdx);
      if (cur < closeIdx && tokens[cur].type === "punct" && tokens[cur].value === "=") {
        let p = 0;
        let b = 0;
        let br = 0;
        cur += 1;
        while (cur < closeIdx) {
          const t = tokens[cur];
          if (t.type === "punct") {
            if (p === 0 && b === 0 && br === 0 && t.value === ",") break;
            if (t.value === "(") p += 1;
            else if (t.value === ")") p = Math.max(0, p - 1);
            else if (t.value === "[") b += 1;
            else if (t.value === "]") b = Math.max(0, b - 1);
            else if (t.value === "{") br += 1;
            else if (t.value === "}") br = Math.max(0, br - 1);
          }
          cur += 1;
        }
      }
    }
    return { names, nextTokenIdx: closeIdx + 1 };
  }

  return { names, nextTokenIdx: i + 1 };
}

function parseVarDeclBindingsAndEnd(tokens, kwIdx, sourceLen) {
  const allNames = [];
  let i = kwIdx + 1;
  let lastSig = kwIdx;

  while (i < tokens.length) {
    const pat = extractBindingNamesFromPattern(tokens, i);
    allNames.push(...pat.names);
    i = skipTrivia(tokens, pat.nextTokenIdx);
    if (i > 0) lastSig = i - 1;

    // Avanzar por inicializador `= ...` hasta `,`, `;` o fin ASI a profundidad 0
    if (i < tokens.length && tokens[i].type === "punct" && tokens[i].value === "=") {
      let brace = 0;
      let paren = 0;
      let bracket = 0;
      let prevSig = i;
      i += 1;
      while (i < tokens.length) {
        const t = tokens[i];
        if (t.type === "ws" || t.type === "comment") {
          i += 1;
          continue;
        }
        if (brace === 0 && paren === 0 && bracket === 0) {
          if (t.type === "punct" && (t.value === "," || t.value === ";")) {
            break;
          }
          if (isAsiBoundary(tokens, prevSig, i)) {
            return {
              names: allNames,
              endOffset: tokens[prevSig].end,
              nextTokenIdx: prevSig + 1
            };
          }
        }
        if (t.type === "punct") {
          if (t.value === "{") brace += 1;
          else if (t.value === "}") brace = Math.max(0, brace - 1);
          else if (t.value === "(") paren += 1;
          else if (t.value === ")") paren = Math.max(0, paren - 1);
          else if (t.value === "[") bracket += 1;
          else if (t.value === "]") bracket = Math.max(0, bracket - 1);
        }
        prevSig = i;
        i += 1;
      }
      lastSig = prevSig;
    }

    if (i < tokens.length && tokens[i].type === "punct" && tokens[i].value === ",") {
      i += 1;
      continue;
    }
    if (i < tokens.length && tokens[i].type === "punct" && tokens[i].value === ";") {
      return { names: allNames, endOffset: tokens[i].end, nextTokenIdx: i + 1 };
    }
    const endPos = prevNonTriviaIndex(tokens, i);
    return {
      names: allNames,
      endOffset: endPos >= 0 ? tokens[endPos].end : sourceLen,
      nextTokenIdx: Math.max(lastSig + 1, endPos + 1)
    };
  }

  return { names: allNames, endOffset: sourceLen, nextTokenIdx: tokens.length };
}

/**
 * Analiza un código fuente JavaScript ya transpilado (sin anotaciones TS ni JSX) para extraer sus
 * especificadores de importación/reexportación y detectar si requiere bundling de módulos locales.
 * @param {string} jsCode
 * @returns {{ staticImports: string[], dynamicLocalImports: string[], hasModuleSyntax: boolean, hasTopLevelAwait: boolean }}
 */
export function inspectModuleUsage(jsCode) {
  const source = String(jsCode ?? "");
  const tokens = tokenizeJsWithOffsets(source);
  const staticImports = [];
  const dynamicLocalImports = [];
  let hasModuleSyntax = false;
  let hasTopLevelAwait = false;

  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let prevSig = -1;

  // Rastreo liviano de si estamos en ámbito superior (fuera de function/arrow/class) para detectar top-level await
  const fnBraceDepthStack = [];
  const conciseArrowStack = [];
  const STMT_POP_KEYWORDS = new Set([
    "const",
    "let",
    "var",
    "function",
    "class",
    "if",
    "for",
    "while",
    "do",
    "switch",
    "try",
    "export",
    "import",
    "return",
    "throw"
  ]);

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === "ws" || t.type === "comment") continue;

    while (conciseArrowStack.length > 0) {
      const top = conciseArrowStack[conciseArrowStack.length - 1];
      const sameDepth = brace === top.brace && paren === top.paren && bracket === top.bracket;
      if (
        brace < top.brace ||
        paren < top.paren ||
        bracket < top.bracket ||
        (sameDepth && t.type === "punct" && (t.value === "," || t.value === ";")) ||
        (sameDepth && t.type === "ident" && STMT_POP_KEYWORDS.has(t.value))
      ) {
        conciseArrowStack.pop();
      } else {
        break;
      }
    }

    if (t.type === "punct") {
      if (t.value === "=>") {
        const afterArrow = skipTrivia(tokens, i + 1);
        if (afterArrow >= tokens.length || tokens[afterArrow].value !== "{") {
          conciseArrowStack.push({ brace, paren, bracket });
        }
        prevSig = i;
        continue;
      }
      if (t.value === "{") {
        brace += 1;
        if (prevSig >= 0) {
          const p = tokens[prevSig].value;
          if (p === ")" || p === "=>" || p === "else" || p === "try" || p === "finally") {
            if (p === "=>") {
              fnBraceDepthStack.push(brace);
            } else if (p === ")") {
              // Heurística segura: buscar si hubo `function` o método antes de los paréntesis
              let scan = prevSig;
              let pDepth = 0;
              while (scan >= 0) {
                if (tokens[scan].value === ")") pDepth += 1;
                else if (tokens[scan].value === "(") {
                  pDepth -= 1;
                  if (pDepth === 0) break;
                }
                scan -= 1;
              }
              const beforeOpen = prevNonTriviaIndex(tokens, scan);
              if (
                beforeOpen >= 0 &&
                (tokens[beforeOpen].value === "function" ||
                  tokens[beforeOpen].type === "ident" ||
                  tokens[beforeOpen].value === "*")
              ) {
                const bTok = tokens[beforeOpen].value;
                if (bTok !== "if" && bTok !== "while" && bTok !== "for" && bTok !== "switch" && bTok !== "catch" && bTok !== "with") {
                  fnBraceDepthStack.push(brace);
                }
              }
            }
          }
        }
      } else if (t.value === "}") {
        if (fnBraceDepthStack.length > 0 && fnBraceDepthStack[fnBraceDepthStack.length - 1] === brace) {
          fnBraceDepthStack.pop();
        }
        brace = Math.max(0, brace - 1);
      } else if (t.value === "(") paren += 1;
      else if (t.value === ")") paren = Math.max(0, paren - 1);
      else if (t.value === "[") bracket += 1;
      else if (t.value === "]") bracket = Math.max(0, bracket - 1);
      prevSig = i;
      continue;
    }

    if (
      t.type === "ident" &&
      t.value === "await" &&
      fnBraceDepthStack.length === 0 &&
      conciseArrowStack.length === 0 &&
      (prevSig < 0 || tokens[prevSig].value !== ".")
    ) {
      const n1 = skipTrivia(tokens, i + 1);
      if (n1 >= tokens.length || tokens[n1].value !== ":") {
        hasTopLevelAwait = true;
      }
    }

    // Dynamic `import("...")` a cualquier profundidad: solo precargar módulos locales relativos
    if (t.type === "ident" && t.value === "import" && (prevSig < 0 || tokens[prevSig].value !== ".")) {
      const n1 = skipTrivia(tokens, i + 1);
      if (n1 < tokens.length && tokens[n1].type === "punct" && tokens[n1].value === ".") {
        const n2 = skipTrivia(tokens, n1 + 1);
        if (n2 < tokens.length && tokens[n2].type === "ident" && tokens[n2].value === "meta") {
          hasModuleSyntax = true;
        }
      }
      if (n1 < tokens.length && tokens[n1].type === "punct" && tokens[n1].value === "(") {
        const argIdx = skipTrivia(tokens, n1 + 1);
        const closeP = skipTrivia(tokens, argIdx + 1);
        if (
          argIdx < tokens.length &&
          tokens[argIdx].type === "string" &&
          closeP < tokens.length &&
          tokens[closeP].type === "punct" &&
          tokens[closeP].value === ")"
        ) {
          const spec = unquoteStringToken(tokens[argIdx]);
          if (spec && isRelativeModuleSpecifier(spec)) dynamicLocalImports.push(spec);
        }
      }
    }

    if (brace === 0 && paren === 0 && bracket === 0 && t.type === "ident") {
      if (t.value === "import" && canStartTopLevelKeyword(tokens, i, prevSig)) {
        const n1 = skipTrivia(tokens, i + 1);
        if (n1 < tokens.length && tokens[n1].value !== "." && tokens[n1].value !== "(") {
          hasModuleSyntax = true;
          if (tokens[n1].type === "string") {
            const spec = unquoteStringToken(tokens[n1]);
            if (spec) staticImports.push(spec);
          } else {
            let d = 0;
            for (let k = n1; k < tokens.length; k += 1) {
              const kt = tokens[k];
              if (kt.type === "punct") {
                if (kt.value === "{") d += 1;
                else if (kt.value === "}") d = Math.max(0, d - 1);
                else if (kt.value === ";" && d === 0) break;
              } else if (d === 0 && kt.type === "ident" && kt.value === "from") {
                const sIdx = skipTrivia(tokens, k + 1);
                if (sIdx < tokens.length && tokens[sIdx].type === "string") {
                  const spec = unquoteStringToken(tokens[sIdx]);
                  if (spec) staticImports.push(spec);
                }
                break;
              }
            }
          }
        }
      } else if (t.value === "export" && canStartTopLevelKeyword(tokens, i, prevSig)) {
        hasModuleSyntax = true;
        const n1 = skipTrivia(tokens, i + 1);
        if (n1 < tokens.length && (tokens[n1].value === "*" || tokens[n1].value === "{")) {
          let afterClause = n1;
          if (tokens[n1].value === "{") {
            afterClause = findMatchingBrace(tokens, n1) + 1;
          } else {
            afterClause = n1 + 1;
            const maybeAs = skipTrivia(tokens, afterClause);
            if (maybeAs < tokens.length && tokens[maybeAs].value === "as") {
              afterClause = skipTrivia(tokens, maybeAs + 1) + 1;
            }
          }
          const maybeFrom = skipTrivia(tokens, afterClause);
          if (maybeFrom < tokens.length && tokens[maybeFrom].type === "ident" && tokens[maybeFrom].value === "from") {
            const sIdx = skipTrivia(tokens, maybeFrom + 1);
            if (sIdx < tokens.length && tokens[sIdx].type === "string") {
              const spec = unquoteStringToken(tokens[sIdx]);
              if (spec) staticImports.push(spec);
            }
          }
        }
      }
    }

    prevSig = i;
  }

  return { staticImports, dynamicLocalImports, hasModuleSyntax, hasTopLevelAwait };
}

/**
 * Reescribe declaraciones ES Module (`import`, `export`, `import("./x")`) a llamadas compatibles
 * con `__studioRequire` / `__studioExport`, preservando literales de string, regex y comentarios.
 *
 * @param {string} jsCode
 * @param {(specifier: string) => { kind: "local"|"external", id?: string, extVar?: string }} resolveDep
 * @param {{ useAsyncRequire?: boolean }} [options]
 * @returns {{ code: string, hasTopLevelAwait: boolean }}
 */
const LIVE_NON_DECL_PREV = new Set([
  "=",
  "(",
  "[",
  ",",
  ":",
  "?",
  "&&",
  "||",
  "??",
  "!",
  "+",
  "-",
  "*",
  "/",
  "%",
  "=>",
  "return",
  "throw",
  "yield",
  "await",
  "typeof",
  "void",
  "delete",
  "new"
]);

const LIVE_OBJ_BEFORE_PUNCT = new Set([
  "=",
  "(",
  "[",
  ",",
  ":",
  ";",
  "?",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "&&",
  "||",
  "??",
  "...",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&&=",
  "||=",
  "??="
]);

const LIVE_OBJ_BEFORE_KEYWORD = new Set([
  "return",
  "throw",
  "yield",
  "await",
  "typeof",
  "void",
  "delete"
]);

/**
 * Recolecta identificadores ligados y tokens de clave/patrón que no son referencias de lectura en LHS.
 */
function collectPatternInfo(tokens, startIdx, namesOut, nonRefOut) {
  let i = skipTrivia(tokens, startIdx);
  if (i >= tokens.length) return i;
  const t = tokens[i];
  if (t.type === "ident") {
    namesOut.push(t.value);
    nonRefOut.add(i);
    return i + 1;
  }
  if (t.type === "punct" && t.value === "{") {
    const closeIdx = findMatchingBrace(tokens, i);
    let cur = i + 1;
    while (cur < closeIdx) {
      cur = skipTrivia(tokens, cur);
      if (cur >= closeIdx) break;
      const ct = tokens[cur];
      if (ct.type === "punct" && ct.value === ",") {
        cur += 1;
        continue;
      }
      if (ct.type === "punct" && ct.value === "...") {
        cur = skipTrivia(tokens, cur + 1);
        if (cur < closeIdx && tokens[cur].type === "ident") {
          namesOut.push(tokens[cur].value);
          nonRefOut.add(cur);
          cur += 1;
        }
        continue;
      }
      if (ct.type === "punct" && ct.value === "[") {
        cur = findMatchingBrace(tokens, cur, "[", "]") + 1;
        cur = skipTrivia(tokens, cur);
        if (cur < closeIdx && tokens[cur].type === "punct" && tokens[cur].value === ":") {
          cur = collectPatternInfo(tokens, cur + 1, namesOut, nonRefOut);
        }
      } else if (ct.type === "ident" || ct.type === "string" || ct.type === "number") {
        const keyIdx = cur;
        const n1 = skipTrivia(tokens, cur + 1);
        if (n1 < closeIdx && tokens[n1].type === "punct" && tokens[n1].value === ":") {
          nonRefOut.add(keyIdx);
          cur = collectPatternInfo(tokens, n1 + 1, namesOut, nonRefOut);
        } else {
          if (ct.type === "ident") {
            namesOut.push(ct.value);
            nonRefOut.add(keyIdx);
          }
          cur = n1;
        }
      } else {
        cur += 1;
        continue;
      }
      cur = skipTrivia(tokens, cur);
      if (cur < closeIdx && tokens[cur].type === "punct" && tokens[cur].value === "=") {
        cur += 1;
        let b = 0;
        let p = 0;
        let br = 0;
        while (cur < closeIdx) {
          const dt = tokens[cur];
          if (dt.type === "punct") {
            if (dt.value === "{") b += 1;
            else if (dt.value === "}") b = Math.max(0, b - 1);
            else if (dt.value === "(") p += 1;
            else if (dt.value === ")") p = Math.max(0, p - 1);
            else if (dt.value === "[") br += 1;
            else if (dt.value === "]") br = Math.max(0, br - 1);
            else if (dt.value === "," && b === 0 && p === 0 && br === 0) break;
          }
          cur += 1;
        }
      }
    }
    return closeIdx + 1;
  }
  if (t.type === "punct" && t.value === "[") {
    const closeIdx = findMatchingBrace(tokens, i, "[", "]");
    let cur = i + 1;
    while (cur < closeIdx) {
      cur = skipTrivia(tokens, cur);
      if (cur >= closeIdx) break;
      const ct = tokens[cur];
      if (ct.type === "punct" && ct.value === ",") {
        cur += 1;
        continue;
      }
      if (ct.type === "punct" && ct.value === "...") {
        cur = collectPatternInfo(tokens, cur + 1, namesOut, nonRefOut);
        continue;
      }
      cur = collectPatternInfo(tokens, cur, namesOut, nonRefOut);
      cur = skipTrivia(tokens, cur);
      if (cur < closeIdx && tokens[cur].type === "punct" && tokens[cur].value === "=") {
        cur += 1;
        let b = 0;
        let p = 0;
        let br = 0;
        while (cur < closeIdx) {
          const dt = tokens[cur];
          if (dt.type === "punct") {
            if (dt.value === "{") b += 1;
            else if (dt.value === "}") b = Math.max(0, b - 1);
            else if (dt.value === "(") p += 1;
            else if (dt.value === ")") p = Math.max(0, p - 1);
            else if (dt.value === "[") br += 1;
            else if (dt.value === "]") br = Math.max(0, br - 1);
            else if (dt.value === "," && b === 0 && p === 0 && br === 0) break;
          }
          cur += 1;
        }
      }
    }
    return closeIdx + 1;
  }
  return i + 1;
}

function collectParamNamesAndNonRefs(tokens, openParenIdx, closeParenIdx, nonRefOut) {
  const names = [];
  let cur = openParenIdx + 1;
  while (cur < closeParenIdx) {
    cur = skipTrivia(tokens, cur);
    if (cur >= closeParenIdx) break;
    if (tokens[cur].type === "punct" && tokens[cur].value === ",") {
      cur += 1;
      continue;
    }
    if (tokens[cur].type === "punct" && tokens[cur].value === "...") {
      cur = skipTrivia(tokens, cur + 1);
    }
    cur = collectPatternInfo(tokens, cur, names, nonRefOut);
    cur = skipTrivia(tokens, cur);
    if (cur < closeParenIdx && tokens[cur].type === "punct" && tokens[cur].value === "=") {
      cur += 1;
      let b = 0;
      let p = 0;
      let br = 0;
      while (cur < closeParenIdx) {
        const dt = tokens[cur];
        if (dt.type === "punct") {
          if (dt.value === "{") b += 1;
          else if (dt.value === "}") b = Math.max(0, b - 1);
          else if (dt.value === "(") p += 1;
          else if (dt.value === ")") p = Math.max(0, p - 1);
          else if (dt.value === "[") br += 1;
          else if (dt.value === "]") br = Math.max(0, br - 1);
          else if (dt.value === "," && b === 0 && p === 0 && br === 0) break;
        }
        cur += 1;
      }
    }
  }
  return names;
}

function collectVarDeclaratorsInfo(tokens, startIdx, namesOut, nonRefOut) {
  let cur = startIdx;
  let prevSig = startIdx > 0 ? prevNonTriviaIndex(tokens, startIdx) : -1;
  while (cur < tokens.length) {
    cur = skipTrivia(tokens, cur);
    if (cur >= tokens.length) break;
    cur = collectPatternInfo(tokens, cur, namesOut, nonRefOut);
    cur = skipTrivia(tokens, cur);
    if (cur >= tokens.length) break;
    const ct = tokens[cur];
    if (ct.type === "punct" && ct.value === "=") {
      cur += 1;
      let b = 0;
      let p = 0;
      let br = 0;
      prevSig = cur - 1;
      while (cur < tokens.length) {
        const it = tokens[cur];
        if (it.type === "ws" || it.type === "comment") {
          cur += 1;
          continue;
        }
        if (b === 0 && p === 0 && br === 0) {
          if (it.type === "punct" && (it.value === "," || it.value === ";" || it.value === ")")) {
            break;
          }
          if (it.type === "ident" && (it.value === "in" || it.value === "of")) {
            break;
          }
          if (isAsiBoundary(tokens, prevSig, cur)) {
            return;
          }
        }
        if (it.type === "punct") {
          if (it.value === "{") b += 1;
          else if (it.value === "}") {
            if (b === 0) return;
            b -= 1;
          } else if (it.value === "(") p += 1;
          else if (it.value === ")") {
            if (p === 0) return;
            p -= 1;
          } else if (it.value === "[") br += 1;
          else if (it.value === "]") br = Math.max(0, br - 1);
        }
        prevSig = cur;
        cur += 1;
      }
    }
    cur = skipTrivia(tokens, cur);
    if (cur >= tokens.length) break;
    const sep = tokens[cur];
    if (sep.type === "punct" && sep.value === ",") {
      cur += 1;
      continue;
    }
    break;
  }
}

function collectFunctionHoists(tokens, openBraceIdx, closeBraceIdx) {
  const hoists = [];
  const dummyNonRef = new Set();
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let prevSig = -1;
  let k = openBraceIdx + 1;
  while (k < closeBraceIdx) {
    const t = tokens[k];
    if (t.type === "ws" || t.type === "comment") {
      k += 1;
      continue;
    }
    if (t.type === "punct") {
      if (t.value === "{") brace += 1;
      else if (t.value === "}") brace = Math.max(0, brace - 1);
      else if (t.value === "(") paren += 1;
      else if (t.value === ")") paren = Math.max(0, paren - 1);
      else if (t.value === "[") bracket += 1;
      else if (t.value === "]") bracket = Math.max(0, bracket - 1);
      prevSig = k;
      k += 1;
      continue;
    }
    const prev = prevSig >= 0 ? tokens[prevSig] : null;
    const isProp = prev && (prev.value === "." || prev.value === "?.");
    if (!isProp && t.type === "ident" && t.value === "function") {
      let nameIdx = skipTrivia(tokens, k + 1);
      if (nameIdx < closeBraceIdx && tokens[nameIdx].value === "*") {
        nameIdx = skipTrivia(tokens, nameIdx + 1);
      }
      if (brace === 0 && nameIdx < closeBraceIdx && tokens[nameIdx].type === "ident") {
        hoists.push(tokens[nameIdx].value);
      }
      // Saltar cuerpo completo de funciones anidadas para no filtrar sus `var` internos
      let pScan = nameIdx;
      while (pScan < closeBraceIdx && tokens[pScan].value !== "{") pScan += 1;
      if (pScan < closeBraceIdx && tokens[pScan].value === "{") {
        k = findMatchingBrace(tokens, pScan) + 1;
        continue;
      }
    } else if (!isProp && t.type === "ident" && t.value === "var" && paren === 0 && bracket === 0) {
      const next = tokens[skipTrivia(tokens, k + 1)];
      if (!next || next.value !== ":") {
        collectVarDeclaratorsInfo(tokens, k + 1, hoists, dummyNonRef);
      }
    } else if (t.type === "punct" && t.value === "=>") {
      const after = skipTrivia(tokens, k + 1);
      if (after < closeBraceIdx && tokens[after].value === "{") {
        k = findMatchingBrace(tokens, after) + 1;
        continue;
      }
    }
    prevSig = k;
    k += 1;
  }
  return hoists;
}

const LIVE_ASSIGN_OPS = new Set([
  "=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "^=", "|=", "&&=", "||=", "??="
]);

const ASSIGN_INCOMPLETE_PREV_OPS = new Set([
  "=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "^=", "|=", "&&=", "||=", "??=",
  "+", "-", "*", "/", "%", "**", "&&", "||", "??", "?", ":", ".", "?.", "=>", ",", "(", "[", "{"
]);

const ASSIGN_INCOMPLETE_PREV_KW = new Set([
  "return", "throw", "yield", "await", "typeof", "void", "delete", "new", "in", "instanceof"
]);

const ASSIGN_CONTINUATION_OPS = new Set([
  ".", "?.", "[", "(", "+", "-", "*", "/", "%", "**", "&&", "||", "??", "?", ":",
  "===", "!==", "==", "!=", "<", ">", "<=", ">=", "<<", ">>", ">>>", "&", "|", "^", "in", "instanceof"
]);

function findAssignRhsEndOffset(tokens, startIdx, sourceLen) {
  let b = 0;
  let p = 0;
  let br = 0;
  let ternary = 0;
  let prevRhsSig = -1;
  for (let k = startIdx; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type === "ws" || t.type === "comment") continue;
    if (b === 0 && p === 0 && br === 0) {
      if (t.type === "punct") {
        if (t.value === "?") {
          ternary += 1;
          prevRhsSig = k;
          continue;
        }
        if (t.value === ":") {
          if (ternary > 0) {
            ternary -= 1;
            prevRhsSig = k;
            continue;
          }
          break;
        }
        if (t.value === "," || t.value === ";" || t.value === ")" || t.value === "]" || t.value === "}") {
          break;
        }
      }
      if (prevRhsSig >= 0 && isAsiBoundary(tokens, prevRhsSig, k)) {
        const pt = tokens[prevRhsSig];
        const prevIncomplete =
          (pt.type === "punct" && ASSIGN_INCOMPLETE_PREV_OPS.has(pt.value)) ||
          (pt.type === "ident" && ASSIGN_INCOMPLETE_PREV_KW.has(pt.value));
        const curContinues =
          (t.type === "punct" || t.type === "ident") && ASSIGN_CONTINUATION_OPS.has(t.value);
        if (!prevIncomplete && !curContinues) {
          break;
        }
      }
    }
    if (t.type === "punct") {
      if (t.value === "{") b += 1;
      else if (t.value === "}") b = Math.max(0, b - 1);
      else if (t.value === "(") p += 1;
      else if (t.value === ")") p = Math.max(0, p - 1);
      else if (t.value === "[") br += 1;
      else if (t.value === "]") br = Math.max(0, br - 1);
    }
    prevRhsSig = k;
  }
  if (prevRhsSig >= startIdx) return tokens[prevRhsSig].end;
  return startIdx < tokens.length ? tokens[startIdx].end : sourceLen;
}

/**
 * Envuelve escrituras/mutaciones sobre variables locales exportadas (`export let count = 0`)
 * para propagar sus cambios en vivo hacia los bindings importados (`__studioBind`).
 */
function rewriteLiveExportWritesInCode(code, liveExportNames) {
  if (!liveExportNames || liveExportNames.size === 0) {
    return code;
  }

  const tokens = tokenizeJsWithOffsets(code);
  const splices = [];
  const nonRefTokens = new Set();
  const attachScopeAtBrace = new Map();
  const attachScopeAtParen = new Map();
  const attachConciseArrowAt = new Map();

  const scopes = [{ kind: "module", shadows: new Set() }];
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let prevSig = -1;
  let ternaryDepth = 0;
  let inCaseExpr = false;

  const isShadowed = (name) => {
    for (let s = scopes.length - 1; s >= 1; s -= 1) {
      if (scopes[s].shadows && scopes[s].shadows.has(name)) {
        return true;
      }
    }
    return false;
  };

  const addShadowToCurrent = (name, isVar) => {
    if (scopes.length <= 1) return;
    if (isVar) {
      for (let s = scopes.length - 1; s >= 1; s -= 1) {
        if (scopes[s].kind === "fn") {
          scopes[s].shadows.add(name);
          return;
        }
      }
      return;
    }
    for (let s = scopes.length - 1; s >= 1; s -= 1) {
      if (scopes[s].shadows) {
        scopes[s].shadows.add(name);
        return;
      }
    }
  };

  const activeBraceFrame = () => {
    for (let s = scopes.length - 1; s >= 0; s -= 1) {
      const k = scopes[s].kind;
      if (k === "obj" || k === "class" || k === "block" || k === "fn" || k === "module") {
        return scopes[s];
      }
    }
    return scopes[0];
  };

  const popConciseArrowsIfNeeded = (tok, nextBrace, nextParen, nextBracket) => {
    while (scopes.length > 1) {
      const top = scopes[scopes.length - 1];
      if (top.kind !== "concise") break;
      const exitedDelim =
        nextBrace < top.braceDepth || nextParen < top.parenDepth || nextBracket < top.bracketDepth;
      const sameDepthSep =
        nextBrace === top.braceDepth &&
        nextParen === top.parenDepth &&
        nextBracket === top.bracketDepth &&
        tok &&
        tok.type === "punct" &&
        (tok.value === "," || tok.value === ";");
      if (exitedDelim || sameDepthSep) {
        scopes.pop();
      } else {
        break;
      }
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === "ws" || t.type === "comment") {
      continue;
    }

    const prev = prevSig >= 0 ? tokens[prevSig] : null;
    const isAfterDot = Boolean(prev && (prev.value === "." || prev.value === "?."));
    const curFrame = activeBraceFrame();

    // Fin de concise arrow por ASI en salto de línea
    if (prevSig >= 0 && scopes[scopes.length - 1]?.kind === "concise") {
      const topC = scopes[scopes.length - 1];
      if (
        brace === topC.braceDepth &&
        paren === topC.parenDepth &&
        bracket === topC.bracketDepth &&
        isAsiBoundary(tokens, prevSig, i)
      ) {
        scopes.pop();
      }
    }

    // Fin de expresión `case expr:`
    if (inCaseExpr && t.type === "punct" && t.value === ":") {
      inCaseExpr = false;
      prevSig = i;
      continue;
    }

    if (t.type === "punct") {
      if (t.value === "?") {
        ternaryDepth += 1;
        prevSig = i;
        continue;
      }
      if (t.value === ":") {
        if (ternaryDepth > 0) ternaryDepth -= 1;
        if (curFrame.kind === "obj" && curFrame.braceDepth === brace) {
          curFrame.objKeyExpected = false;
        }
        prevSig = i;
        continue;
      }

      if (t.value === "(") {
        paren += 1;
        const closeP = findMatchingBrace(tokens, i, "(", ")");
        const afterP = skipTrivia(tokens, closeP + 1);
        const paramAttach = attachScopeAtParen.get(i);
        if (paramAttach) {
          attachScopeAtParen.delete(i);
          scopes.push({ kind: "paren", parenDepth: paren, shadows: paramAttach });
        } else if (afterP < tokens.length && tokens[afterP].type === "punct" && tokens[afterP].value === "=>") {
          const pNames = collectParamNamesAndNonRefs(tokens, i, closeP, nonRefTokens);
          const afterArrow = skipTrivia(tokens, afterP + 1);
          scopes.push({ kind: "paren", parenDepth: paren, shadows: new Set(pNames) });
          if (afterArrow < tokens.length && tokens[afterArrow].value === "{") {
            const closeB = findMatchingBrace(tokens, afterArrow);
            const hoists = collectFunctionHoists(tokens, afterArrow, closeB);
            attachScopeAtBrace.set(afterArrow, {
              kind: "fn",
              shadows: new Set([...pNames, ...hoists])
            });
          } else {
            attachConciseArrowAt.set(afterP, new Set(pNames));
          }
        }
        prevSig = i;
        continue;
      }

      if (t.value === ")") {
        const nextP = Math.max(0, paren - 1);
        popConciseArrowsIfNeeded(t, brace, nextP, bracket);
        paren = nextP;
        if (scopes[scopes.length - 1]?.kind === "paren" && scopes[scopes.length - 1].parenDepth === paren + 1) {
          scopes.pop();
        }
        prevSig = i;
        continue;
      }

      if (t.value === "[") {
        if (curFrame.kind === "obj" && curFrame.braceDepth === brace) {
          curFrame.objKeyExpected = false;
        }
        bracket += 1;
        prevSig = i;
        continue;
      }

      if (t.value === "]") {
        const nextBr = Math.max(0, bracket - 1);
        popConciseArrowsIfNeeded(t, brace, paren, nextBr);
        bracket = nextBr;
        prevSig = i;
        continue;
      }

      if (t.value === "=>") {
        const conciseShadows = attachConciseArrowAt.get(i);
        if (conciseShadows) {
          attachConciseArrowAt.delete(i);
          scopes.push({
            kind: "concise",
            braceDepth: brace,
            parenDepth: paren,
            bracketDepth: bracket,
            shadows: conciseShadows
          });
        }
        prevSig = i;
        continue;
      }

      if (t.value === "{") {
        brace += 1;
        const attached = attachScopeAtBrace.get(i);
        if (attached) {
          attachScopeAtBrace.delete(i);
          scopes.push({
            kind: attached.kind,
            braceDepth: brace,
            shadows: attached.shadows,
            memberExpected: attached.kind === "class"
          });
        } else {
          const isObj =
            !inCaseExpr &&
            prev &&
            ((prev.type === "punct" && LIVE_OBJ_BEFORE_PUNCT.has(prev.value)) ||
              (prev.type === "ident" && LIVE_OBJ_BEFORE_KEYWORD.has(prev.value)));
          if (isObj) {
            scopes.push({
              kind: "obj",
              braceDepth: brace,
              shadows: null,
              objKeyExpected: true
            });
          } else {
            scopes.push({
              kind: "block",
              braceDepth: brace,
              shadows: new Set()
            });
          }
        }
        prevSig = i;
        continue;
      }

      if (t.value === "}") {
        const nextB = Math.max(0, brace - 1);
        popConciseArrowsIfNeeded(t, nextB, paren, bracket);
        brace = nextB;
        while (scopes.length > 1) {
          const top = scopes[scopes.length - 1];
          if (top.braceDepth === brace + 1) {
            scopes.pop();
            if (top.kind === "forSingle") continue;
            break;
          }
          break;
        }
        const outerFrame = activeBraceFrame();
        if (outerFrame.kind === "class" && outerFrame.braceDepth === brace) {
          outerFrame.memberExpected = true;
        }
        prevSig = i;
        continue;
      }

      if (t.value === "," || t.value === ";") {
        popConciseArrowsIfNeeded(t, brace, paren, bracket);
        if (t.value === "," && curFrame.kind === "obj" && curFrame.braceDepth === brace) {
          curFrame.objKeyExpected = true;
        }
        if (t.value === ";" && curFrame.kind === "class" && curFrame.braceDepth === brace) {
          curFrame.memberExpected = true;
        }
        if (t.value === ";" && scopes[scopes.length - 1]?.kind === "for" && scopes[scopes.length - 1].inBody) {
          scopes.pop();
        }
        prevSig = i;
        continue;
      }

      if (t.value === "..." && curFrame.kind === "obj" && curFrame.braceDepth === brace) {
        curFrame.objKeyExpected = false;
      }

      prevSig = i;
      continue;
    }

    // Clase / Objeto llaves & miembros
    if (!isAfterDot && t.type === "ident") {
      if (curFrame.kind === "obj" && curFrame.braceDepth === brace && curFrame.objKeyExpected) {
        const n1 = skipTrivia(tokens, i + 1);
        const nt = n1 < tokens.length ? tokens[n1] : null;
        if (
          (t.value === "get" || t.value === "set" || t.value === "async") &&
          nt &&
          nt.type === "ident"
        ) {
          nonRefTokens.add(i);
          prevSig = i;
          continue;
        }
        if (nt && nt.type === "punct" && (nt.value === ":" || nt.value === "(")) {
          nonRefTokens.add(i);
          curFrame.objKeyExpected = false;
          if (nt.value === "(") {
            const closeP = findMatchingBrace(tokens, n1, "(", ")");
            const openB = skipTrivia(tokens, closeP + 1);
            const pNames = collectParamNamesAndNonRefs(tokens, n1, closeP, nonRefTokens);
            attachScopeAtParen.set(n1, new Set(pNames));
            if (openB < tokens.length && tokens[openB].value === "{") {
              const closeB = findMatchingBrace(tokens, openB);
              const hoists = collectFunctionHoists(tokens, openB, closeB);
              attachScopeAtBrace.set(openB, { kind: "fn", shadows: new Set([...pNames, ...hoists]) });
            }
          }
          prevSig = i;
          continue;
        }
        if (nt && nt.type === "punct" && (nt.value === "," || nt.value === "}" || nt.value === "=")) {
          curFrame.objKeyExpected = false;
        }
      }

      if (curFrame.kind === "class" && curFrame.braceDepth === brace) {
        if (!curFrame.memberExpected && prevSig >= 0 && isAsiBoundary(tokens, prevSig, i)) {
          curFrame.memberExpected = true;
        }
        if (curFrame.memberExpected) {
          const n1 = skipTrivia(tokens, i + 1);
          const nt = n1 < tokens.length ? tokens[n1] : null;
          if (
            (t.value === "static" || t.value === "get" || t.value === "set" || t.value === "async") &&
            nt &&
            (nt.type === "ident" || nt.value === "#" || nt.value === "[" || nt.value === "*")
          ) {
            nonRefTokens.add(i);
            prevSig = i;
            continue;
          }
          if (t.value === "static" && nt && nt.value === "{") {
            curFrame.memberExpected = false;
            prevSig = i;
            continue;
          }
          if (
            !nt ||
            nt.value === "=" ||
            nt.value === ";" ||
            nt.value === "(" ||
            isAsiBoundary(tokens, i, n1)
          ) {
            nonRefTokens.add(i);
            curFrame.memberExpected = false;
            if (nt && nt.value === "(") {
              const closeP = findMatchingBrace(tokens, n1, "(", ")");
              const openB = skipTrivia(tokens, closeP + 1);
              const pNames = collectParamNamesAndNonRefs(tokens, n1, closeP, nonRefTokens);
              attachScopeAtParen.set(n1, new Set(pNames));
              if (openB < tokens.length && tokens[openB].value === "{") {
                const closeB = findMatchingBrace(tokens, openB);
                const hoists = collectFunctionHoists(tokens, openB, closeB);
                attachScopeAtBrace.set(openB, { kind: "fn", shadows: new Set([...pNames, ...hoists]) });
              }
            }
            prevSig = i;
            continue;
          }
        }
      }

      if (t.value === "case" || (t.value === "default" && tokens[skipTrivia(tokens, i + 1)]?.value === ":")) {
        inCaseExpr = true;
      }

      if (t.value === "function") {
        let nameIdx = skipTrivia(tokens, i + 1);
        if (nameIdx < tokens.length && tokens[nameIdx].value === "*") {
          nameIdx = skipTrivia(tokens, nameIdx + 1);
        }
        let fnName = null;
        if (nameIdx < tokens.length && tokens[nameIdx].type === "ident") {
          fnName = tokens[nameIdx].value;
          nonRefTokens.add(nameIdx);
          const isExpr = prev && LIVE_NON_DECL_PREV.has(prev.value);
          if (!isExpr) {
            addShadowToCurrent(fnName, true);
          }
        }
        let pScan = nameIdx;
        while (pScan < tokens.length && tokens[pScan].value !== "(") pScan += 1;
        if (pScan < tokens.length) {
          const closeP = findMatchingBrace(tokens, pScan, "(", ")");
          const pNames = collectParamNamesAndNonRefs(tokens, pScan, closeP, nonRefTokens);
          const openB = skipTrivia(tokens, closeP + 1);
          const paramSet = new Set(pNames);
          if (fnName) paramSet.add(fnName);
          attachScopeAtParen.set(pScan, paramSet);
          if (openB < tokens.length && tokens[openB].value === "{") {
            const closeB = findMatchingBrace(tokens, openB);
            const hoists = collectFunctionHoists(tokens, openB, closeB);
            const bodySet = new Set([...paramSet, ...hoists]);
            attachScopeAtBrace.set(openB, { kind: "fn", shadows: bodySet });
          }
        }
        prevSig = i;
        continue;
      }

      if (t.value === "class") {
        const nameIdx = skipTrivia(tokens, i + 1);
        let clsName = null;
        if (nameIdx < tokens.length && tokens[nameIdx].type === "ident" && tokens[nameIdx].value !== "extends") {
          clsName = tokens[nameIdx].value;
          nonRefTokens.add(nameIdx);
          const isExpr = prev && LIVE_NON_DECL_PREV.has(prev.value);
          if (!isExpr) {
            addShadowToCurrent(clsName, false);
          }
        }
        let scan = i + 1;
        let pD = 0;
        let bD = 0;
        while (scan < tokens.length) {
          if (tokens[scan].value === "(") pD += 1;
          else if (tokens[scan].value === ")") pD = Math.max(0, pD - 1);
          else if (tokens[scan].value === "[") bD += 1;
          else if (tokens[scan].value === "]") bD = Math.max(0, bD - 1);
          else if (pD === 0 && bD === 0 && tokens[scan].value === "{") {
            const clsSet = new Set();
            if (clsName) clsSet.add(clsName);
            attachScopeAtBrace.set(scan, { kind: "class", shadows: clsSet });
            break;
          }
          scan += 1;
        }
        prevSig = i;
        continue;
      }

      if (t.value === "catch") {
        const n1 = skipTrivia(tokens, i + 1);
        if (n1 < tokens.length && tokens[n1].value === "(") {
          const closeP = findMatchingBrace(tokens, n1, "(", ")");
          const cNames = collectParamNamesAndNonRefs(tokens, n1, closeP, nonRefTokens);
          const openB = skipTrivia(tokens, closeP + 1);
          attachScopeAtParen.set(n1, new Set(cNames));
          if (openB < tokens.length && tokens[openB].value === "{") {
            attachScopeAtBrace.set(openB, { kind: "block", shadows: new Set(cNames) });
          }
        }
        prevSig = i;
        continue;
      }

      if (t.value === "for") {
        let n1 = skipTrivia(tokens, i + 1);
        if (n1 < tokens.length && tokens[n1].type === "ident" && tokens[n1].value === "await") {
          n1 = skipTrivia(tokens, n1 + 1);
        }
        if (n1 < tokens.length && tokens[n1].value === "(") {
          const closeP = findMatchingBrace(tokens, n1, "(", ")");
          const fNames = [];
          let scan = skipTrivia(tokens, n1 + 1);
          if (
            scan < closeP &&
            tokens[scan].type === "ident" &&
            (tokens[scan].value === "let" || tokens[scan].value === "const")
          ) {
            collectVarDeclaratorsInfo(tokens, scan + 1, fNames, nonRefTokens);
          }
          if (fNames.length > 0) {
            attachScopeAtParen.set(n1, new Set(fNames));
            const afterP = skipTrivia(tokens, closeP + 1);
            if (afterP < tokens.length && tokens[afterP].value === "{") {
              attachScopeAtBrace.set(afterP, { kind: "block", shadows: new Set(fNames) });
            }
          }
        }
        prevSig = i;
        continue;
      }

      if (t.value === "const" || t.value === "let" || t.value === "var") {
        const dNames = [];
        collectVarDeclaratorsInfo(tokens, i + 1, dNames, nonRefTokens);
        for (const name of dNames) {
          addShadowToCurrent(name, t.value === "var");
        }
        prevSig = i;
        continue;
      }

      // Arrow de parámetro único `x => ...`
      const n1Idx = skipTrivia(tokens, i + 1);
      if (n1Idx < tokens.length && tokens[n1Idx].type === "punct" && tokens[n1Idx].value === "=>") {
        nonRefTokens.add(i);
        const afterArrow = skipTrivia(tokens, n1Idx + 1);
        if (afterArrow < tokens.length && tokens[afterArrow].value === "{") {
          const closeB = findMatchingBrace(tokens, afterArrow);
          const hoists = collectFunctionHoists(tokens, afterArrow, closeB);
          attachScopeAtBrace.set(afterArrow, { kind: "fn", shadows: new Set([t.value, ...hoists]) });
        } else {
          attachConciseArrowAt.set(n1Idx, new Set([t.value]));
        }
        prevSig = i;
        continue;
      }
    }

    // Envolver escrituras sobre variables exportadas para notificar bindings vivos
    if (
      t.type === "ident" &&
      !isAfterDot &&
      !nonRefTokens.has(i) &&
      liveExportNames.has(t.value) &&
      !isShadowed(t.value)
    ) {
      const prevIsBreakCont = prev && (prev.value === "break" || prev.value === "continue");
      const n1Idx = skipTrivia(tokens, i + 1);
      const nextTok = n1Idx < tokens.length ? tokens[n1Idx] : null;
      const isLabel =
        nextTok &&
        nextTok.type === "punct" &&
        nextTok.value === ":" &&
        ternaryDepth === 0 &&
        !inCaseExpr &&
        curFrame.kind !== "obj";

      if (!prevIsBreakCont && !isLabel) {
        if (prev && (prev.value === "++" || prev.value === "--") && !isAsiBoundary(tokens, prevSig, i)) {
          splices.push({ pos: prev.start, text: "(__studioSync(", isStart: true });
          splices.push({ pos: t.end, text: "))", isStart: false });
        } else if (nextTok && (nextTok.value === "++" || nextTok.value === "--") && !isAsiBoundary(tokens, i, n1Idx)) {
          splices.push({ pos: t.start, text: "(__studioSync(", isStart: true });
          splices.push({ pos: nextTok.end, text: "))", isStart: false });
        } else if (nextTok && LIVE_ASSIGN_OPS.has(nextTok.value)) {
          const rhsEnd = findAssignRhsEndOffset(tokens, n1Idx + 1, code.length);
          splices.push({ pos: t.start, text: "(__studioSync(", isStart: true });
          splices.push({ pos: rhsEnd, text: "))", isStart: false });
        }
      }
    }

    prevSig = i;
  }

  if (splices.length === 0) {
    return code;
  }
  splices.sort((a, b) => b.pos - a.pos || (a.isStart === b.isStart ? 0 : a.isStart ? 1 : -1));
  let out = code;
  for (const sp of splices) {
    out = out.slice(0, sp.pos) + sp.text + out.slice(sp.pos);
  }
  return `const __studioSync = function(__v) { __studioNotify(exports); return __v; };\n${out}`;
}

/**
 * Reescribe declaraciones ES Module (`import`, `export`, `import("./x")`, `import.meta`) a llamadas compatibles
 * con `__studioRequire` / `__studioExport`, preservando literales de string, regex, comentarios y live bindings.
 *
 * @param {string} jsCode
 * @param {(specifier: string) => { kind: "local"|"external", id?: string, extVar?: string }} resolveDep
 * @param {{ useAsyncRequire?: boolean, moduleId?: string, moduleUrl?: string }} [options]
 * @returns {{ code: string, hasTopLevelAwait: boolean }}
 */
export function rewriteEsModuleToRegistry(jsCode, resolveDep, options = {}) {
  const { useAsyncRequire = false, moduleId = "module.js", moduleUrl = "" } = options;
  const reqCall = (idLiteral) =>
    useAsyncRequire ? `(await __studioRequireAsync(${idLiteral}))` : `__studioRequire(${idLiteral})`;

  const source = String(jsCode ?? "");
  const tokens = tokenizeJsWithOffsets(source);
  const edits = [];
  const hoistedExports = [];
  const deferredExports = [];
  const liveExportNames = new Set();
  let tempCounter = 0;

  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let prevSig = -1;
  let hasTopLevelAwait = false;
  const fnBraceDepthStack = [];

  const depExpr = (spec) => {
    const dep = resolveDep(spec);
    if (dep.kind === "local") {
      return reqCall(JSON.stringify(dep.id));
    }
    return `__studioExt[${JSON.stringify(dep.specifier)}]`;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === "ws" || t.type === "comment") continue;

    if (t.type === "punct") {
      if (t.value === "{") {
        brace += 1;
        if (prevSig >= 0) {
          const p = tokens[prevSig].value;
          if (p === "=>") {
            fnBraceDepthStack.push(brace);
          } else if (p === ")") {
            let scan = prevSig;
            let pDepth = 0;
            while (scan >= 0) {
              if (tokens[scan].value === ")") pDepth += 1;
              else if (tokens[scan].value === "(") {
                pDepth -= 1;
                if (pDepth === 0) break;
              }
              scan -= 1;
            }
            const beforeOpen = prevNonTriviaIndex(tokens, scan);
            if (
              beforeOpen >= 0 &&
              (tokens[beforeOpen].value === "function" ||
                tokens[beforeOpen].type === "ident" ||
                tokens[beforeOpen].value === "*")
            ) {
              const bTok = tokens[beforeOpen].value;
              if (bTok !== "if" && bTok !== "while" && bTok !== "for" && bTok !== "switch" && bTok !== "catch" && bTok !== "with") {
                fnBraceDepthStack.push(brace);
              }
            }
          }
        }
      } else if (t.value === "}") {
        if (fnBraceDepthStack.length > 0 && fnBraceDepthStack[fnBraceDepthStack.length - 1] === brace) {
          fnBraceDepthStack.pop();
        }
        brace = Math.max(0, brace - 1);
      } else if (t.value === "(") paren += 1;
      else if (t.value === ")") paren = Math.max(0, paren - 1);
      else if (t.value === "[") bracket += 1;
      else if (t.value === "]") bracket = Math.max(0, bracket - 1);
      prevSig = i;
      continue;
    }

    if (
      t.type === "ident" &&
      t.value === "await" &&
      fnBraceDepthStack.length === 0 &&
      (prevSig < 0 || tokens[prevSig].value !== ".")
    ) {
      const n1 = skipTrivia(tokens, i + 1);
      if (n1 >= tokens.length || tokens[n1].value !== ":") {
        hasTopLevelAwait = true;
      }
    }

    // Dynamic `import("./local")` y `import.meta` a cualquier profundidad
    if (t.type === "ident" && t.value === "import" && (prevSig < 0 || tokens[prevSig].value !== ".")) {
      const n1 = skipTrivia(tokens, i + 1);
      if (n1 < tokens.length && tokens[n1].type === "punct" && tokens[n1].value === ".") {
        const n2 = skipTrivia(tokens, n1 + 1);
        if (n2 < tokens.length && tokens[n2].type === "ident" && tokens[n2].value === "meta") {
          const cleanId = String(moduleId || "module.js").replace(/^\/+/, "");
          const safeUrl = moduleUrl || `https://studio.local/${encodeURI(cleanId)}`;
          edits.push({ start: t.start, end: tokens[n2].end, text: `({ url: ${JSON.stringify(safeUrl)} })` });
          i = n2;
          prevSig = n2;
          continue;
        }
      }
      if (n1 < tokens.length && tokens[n1].type === "punct" && tokens[n1].value === "(") {
        const argIdx = skipTrivia(tokens, n1 + 1);
        const closeP = skipTrivia(tokens, argIdx + 1);
        if (
          argIdx < tokens.length &&
          tokens[argIdx].type === "string" &&
          closeP < tokens.length &&
          tokens[closeP].type === "punct" &&
          tokens[closeP].value === ")"
        ) {
          const spec = unquoteStringToken(tokens[argIdx]);
          const dep = resolveDep(spec);
          if (dep.kind === "local") {
            const dynExpr = useAsyncRequire
              ? `__studioRequireAsync(${JSON.stringify(dep.id)})`
              : `Promise.resolve(__studioRequire(${JSON.stringify(dep.id)}))`;
            edits.push({ start: t.start, end: tokens[closeP].end, text: dynExpr });
          }
          prevSig = i;
          continue;
        }
      }
    }

    if (brace === 0 && paren === 0 && bracket === 0 && t.type === "ident") {
      // Static `import ...`
      if (t.value === "import" && canStartTopLevelKeyword(tokens, i, prevSig)) {
        const n1 = skipTrivia(tokens, i + 1);
        if (n1 < tokens.length && tokens[n1].value !== "." && tokens[n1].value !== "(") {
          if (tokens[n1].type === "string") {
            const spec = unquoteStringToken(tokens[n1]);
            const endInfo = consumeImportAttributesAndSemi(tokens, n1 + 1, source.length);
            edits.push({
              start: t.start,
              end: endInfo.endOffset,
              text: `${depExpr(spec)};`
            });
            i = Math.max(i, endInfo.nextTokenIdx - 1);
            prevSig = i;
            continue;
          }

          let d = 0;
          let fromIdx = -1;
          for (let k = n1; k < tokens.length; k += 1) {
            const kt = tokens[k];
            if (kt.type === "punct") {
              if (kt.value === "{") d += 1;
              else if (kt.value === "}") d = Math.max(0, d - 1);
            } else if (d === 0 && kt.type === "ident" && kt.value === "from") {
              fromIdx = k;
              break;
            }
          }

          if (fromIdx !== -1) {
            const strIdx = skipTrivia(tokens, fromIdx + 1);
            if (strIdx < tokens.length && tokens[strIdx].type === "string") {
              const spec = unquoteStringToken(tokens[strIdx]);
              const { defaultIdent, namespaceIdent, namedSpecs } = parseImportClause(tokens, n1, fromIdx);
              const endInfo = consumeImportAttributesAndSemi(tokens, strIdx + 1, source.length);
              const lines = [];
              if (!defaultIdent && !namespaceIdent && namedSpecs.length === 0) {
                lines.push(`${depExpr(spec)};`);
              } else {
                const tmp = `__imp_${tempCounter}`;
                tempCounter += 1;
                lines.push(`const ${tmp} = ${depExpr(spec)};`);
                if (namespaceIdent) {
                  lines.push(`const ${namespaceIdent} = ${tmp};`);
                }
                if (defaultIdent) {
                  lines.push(
                    `let ${defaultIdent}; __studioBind(${tmp}, "__default_interop__", function(__v) { ${defaultIdent} = __v; });`
                  );
                }
                for (const s of namedSpecs) {
                  const propKey = s.imported.startsWith('"') ? JSON.parse(s.imported) : s.imported;
                  lines.push(
                    `let ${s.local}; __studioBind(${tmp}, ${JSON.stringify(propKey)}, function(__v) { ${s.local} = __v; });`
                  );
                }
              }
              edits.push({ start: t.start, end: endInfo.endOffset, text: lines.join(" ") });
              i = Math.max(i, endInfo.nextTokenIdx - 1);
              prevSig = i;
              continue;
            }
          }
        }
      }

      // Static `export ...`
      if (t.value === "export" && canStartTopLevelKeyword(tokens, i, prevSig)) {
        const n1 = skipTrivia(tokens, i + 1);
        if (n1 >= tokens.length) {
          prevSig = i;
          continue;
        }
        const kw1 = tokens[n1];

        // 1. export default ...
        if (kw1.type === "ident" && kw1.value === "default") {
          const n2 = skipTrivia(tokens, n1 + 1);
          if (n2 < tokens.length && tokens[n2].type === "ident") {
            let fnOrClassKind = null;
            let cursor = n2;
            if (tokens[cursor].value === "async") {
              const afterAsync = skipTrivia(tokens, cursor + 1);
              if (afterAsync < tokens.length && tokens[afterAsync].value === "function") {
                cursor = afterAsync;
              }
            }
            if (tokens[cursor].value === "function") {
              fnOrClassKind = "function";
            } else if (tokens[n2].value === "class") {
              fnOrClassKind = "class";
              cursor = n2;
            }

            if (fnOrClassKind === "function") {
              let nameTokIdx = skipTrivia(tokens, cursor + 1);
              if (nameTokIdx < tokens.length && tokens[nameTokIdx].value === "*") {
                nameTokIdx = skipTrivia(tokens, nameTokIdx + 1);
              }
              const hasName = nameTokIdx < tokens.length && tokens[nameTokIdx].type === "ident";
              // Buscar `{` del cuerpo tras los parámetros `(...)`
              let pScan = nameTokIdx;
              while (pScan < tokens.length && tokens[pScan].value !== "(") pScan += 1;
              const closeParams = pScan < tokens.length ? findMatchingBrace(tokens, pScan, "(", ")") : pScan;
              const openBody = skipTrivia(tokens, closeParams + 1);
              const closeBody = openBody < tokens.length && tokens[openBody].value === "{"
                ? findMatchingBrace(tokens, openBody)
                : tokens.length - 1;
              if (hasName) {
                const fnName = tokens[nameTokIdx].value;
                hoistedExports.push({ local: fnName, exported: "default" });
                liveExportNames.add(fnName);
                edits.push({ start: t.start, end: tokens[n2].start, text: "" });
              } else {
                edits.push({ start: t.start, end: tokens[n2].start, text: "exports.default = (" });
                edits.push({ start: tokens[closeBody].end, end: tokens[closeBody].end, text: "); __studioNotify(exports);" });
              }
              prevSig = i;
              continue;
            }

            if (fnOrClassKind === "class") {
              const nameTokIdx = skipTrivia(tokens, cursor + 1);
              const hasName =
                nameTokIdx < tokens.length &&
                tokens[nameTokIdx].type === "ident" &&
                tokens[nameTokIdx].value !== "extends";
              let scan = cursor + 1;
              let pD = 0;
              let bD = 0;
              let openBody = tokens.length - 1;
              while (scan < tokens.length) {
                if (tokens[scan].value === "(") pD += 1;
                else if (tokens[scan].value === ")") pD = Math.max(0, pD - 1);
                else if (tokens[scan].value === "[") bD += 1;
                else if (tokens[scan].value === "]") bD = Math.max(0, bD - 1);
                else if (pD === 0 && bD === 0 && tokens[scan].value === "{") {
                  openBody = scan;
                  break;
                }
                scan += 1;
              }
              const closeBody = findMatchingBrace(tokens, openBody);
              if (hasName) {
                const clsName = tokens[nameTokIdx].value;
                hoistedExports.push({ local: clsName, exported: "default" });
                liveExportNames.add(clsName);
                edits.push({ start: t.start, end: tokens[n2].start, text: "" });
              } else {
                edits.push({ start: t.start, end: tokens[n2].start, text: "exports.default = (" });
                edits.push({ start: tokens[closeBody].end, end: tokens[closeBody].end, text: "); __studioNotify(exports);" });
              }
              prevSig = i;
              continue;
            }
          }

          // `export default <expr>`
          const stmtEnd = findStatementEndOffset(tokens, n2, source.length);
          const exprEnd = stmtEnd.endsWithSemi ? stmtEnd.endOffset - 1 : stmtEnd.endOffset;
          edits.push({ start: t.start, end: tokens[n2].start, text: "exports.default = (" });
          edits.push({ start: exprEnd, end: stmtEnd.endOffset, text: "); __studioNotify(exports);" });
          i = Math.max(i, stmtEnd.nextTokenIdx - 1);
          prevSig = i;
          continue;
        }

        // 2. export * [as ns] from "spec"
        if (kw1.type === "punct" && kw1.value === "*") {
          let nsName = null;
          let scan = skipTrivia(tokens, n1 + 1);
          if (scan < tokens.length && tokens[scan].type === "ident" && tokens[scan].value === "as") {
            const nsIdx = skipTrivia(tokens, scan + 1);
            if (nsIdx < tokens.length && tokens[nsIdx].type === "ident") {
              nsName = tokens[nsIdx].value;
              scan = skipTrivia(tokens, nsIdx + 1);
            }
          }
          if (scan < tokens.length && tokens[scan].type === "ident" && tokens[scan].value === "from") {
            const strIdx = skipTrivia(tokens, scan + 1);
            if (strIdx < tokens.length && tokens[strIdx].type === "string") {
              const spec = unquoteStringToken(tokens[strIdx]);
              const endInfo = consumeImportAttributesAndSemi(tokens, strIdx + 1, source.length);
              const tmp = `__re_${tempCounter}`;
              tempCounter += 1;
              const codeOut = nsName
                ? `const ${tmp} = ${depExpr(spec)}; __studioExport(exports, ${JSON.stringify(nsName)}, function() { return ${tmp}; });`
                : `const ${tmp} = ${depExpr(spec)}; __studioExportStar(exports, ${tmp});`;
              edits.push({ start: t.start, end: endInfo.endOffset, text: codeOut });
              i = Math.max(i, endInfo.nextTokenIdx - 1);
              prevSig = i;
              continue;
            }
          }
        }

        // 3. export { ... } [from "spec"]
        if (kw1.type === "punct" && kw1.value === "{") {
          const closeBrace = findMatchingBrace(tokens, n1);
          const specPairs = parseNamedSpecifiers(tokens, n1, closeBrace);
          const afterBrace = skipTrivia(tokens, closeBrace + 1);
          if (
            afterBrace < tokens.length &&
            tokens[afterBrace].type === "ident" &&
            tokens[afterBrace].value === "from"
          ) {
            const strIdx = skipTrivia(tokens, afterBrace + 1);
            if (strIdx < tokens.length && tokens[strIdx].type === "string") {
              const spec = unquoteStringToken(tokens[strIdx]);
              const endInfo = consumeImportAttributesAndSemi(tokens, strIdx + 1, source.length);
              const tmp = `__re_${tempCounter}`;
              tempCounter += 1;
              const binds = specPairs
                .map(
                  (p) =>
                    `__studioExport(exports, ${JSON.stringify(p.local)}, function() { return ${tmp}[${
                      p.imported.startsWith('"') ? p.imported : JSON.stringify(p.imported)
                    }]; });`
                )
                .join(" ");
              edits.push({
                start: t.start,
                end: endInfo.endOffset,
                text: `const ${tmp} = ${depExpr(spec)}; ${binds} __studioBindReexport(exports, ${tmp});`
              });
              i = Math.max(i, endInfo.nextTokenIdx - 1);
              prevSig = i;
              continue;
            }
          }

          let endPos = tokens[closeBrace].end;
          let nextIdx = closeBrace + 1;
          if (afterBrace < tokens.length && tokens[afterBrace].type === "punct" && tokens[afterBrace].value === ";") {
            endPos = tokens[afterBrace].end;
            nextIdx = afterBrace + 1;
          }
          for (const p of specPairs) {
            const localName = p.imported.startsWith('"') ? JSON.parse(p.imported) : p.imported;
            hoistedExports.push({
              local: localName,
              exported: p.local
            });
            liveExportNames.add(localName);
          }
          edits.push({ start: t.start, end: endPos, text: "" });
          i = Math.max(i, nextIdx - 1);
          prevSig = i;
          continue;
        }

        // 4. export [async] function [*]? Name (...) { ... }
        if (
          kw1.type === "ident" &&
          (kw1.value === "function" ||
            (kw1.value === "async" && tokens[skipTrivia(tokens, n1 + 1)]?.value === "function"))
        ) {
          const fnTokIdx = kw1.value === "function" ? n1 : skipTrivia(tokens, n1 + 1);
          let nameIdx = skipTrivia(tokens, fnTokIdx + 1);
          if (nameIdx < tokens.length && tokens[nameIdx].value === "*") {
            nameIdx = skipTrivia(tokens, nameIdx + 1);
          }
          if (nameIdx < tokens.length && tokens[nameIdx].type === "ident") {
            const fnName = tokens[nameIdx].value;
            hoistedExports.push({ local: fnName, exported: fnName });
            liveExportNames.add(fnName);
          }
          edits.push({ start: t.start, end: kw1.start, text: "" });
          prevSig = i;
          continue;
        }

        // 5. export class Name ... { ... }
        if (kw1.type === "ident" && kw1.value === "class") {
          const nameIdx = skipTrivia(tokens, n1 + 1);
          if (nameIdx < tokens.length && tokens[nameIdx].type === "ident") {
            const clsName = tokens[nameIdx].value;
            hoistedExports.push({ local: clsName, exported: clsName });
            liveExportNames.add(clsName);
          }
          edits.push({ start: t.start, end: kw1.start, text: "" });
          prevSig = i;
          continue;
        }

        // 6. export const / let / var ...
        if (kw1.type === "ident" && (kw1.value === "const" || kw1.value === "let" || kw1.value === "var")) {
          const decl = parseVarDeclBindingsAndEnd(tokens, n1, source.length);
          edits.push({ start: t.start, end: kw1.start, text: "" });
          edits.push({ start: decl.endOffset, end: decl.endOffset, text: "; __studioNotify(exports);" });
          for (const name of decl.names) {
            hoistedExports.push({ local: name, exported: name });
            liveExportNames.add(name);
          }
          i = Math.max(i, decl.nextTokenIdx - 1);
          prevSig = i;
          continue;
        }
      }
    }

    prevSig = i;
  }

  // Aplicar reemplazos de atrás hacia adelante sin alterar offsets anteriores
  edits.sort((a, b) => b.end - a.end || b.start - a.start);
  let body = source;
  for (const edit of edits) {
    body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  }
  const rewrittenBody = rewriteLiveExportWritesInCode(body, liveExportNames);

  const head = hoistedExports
    .map((e) => `__studioExport(exports, ${JSON.stringify(e.exported)}, function() { return ${e.local}; });`)
    .join(" ");
  const tail = deferredExports
    .map((e) => `__studioExport(exports, ${JSON.stringify(e.exported)}, function() { return ${e.local}; });`)
    .join(" ");

  const parts = [];
  if (head) parts.push(head);
  parts.push(rewrittenBody);
  if (tail) parts.push(tail);
  return {
    code: parts.join("\n"),
    hasTopLevelAwait
  };
}

/**
 * Comprueba si el script necesita resolverse con el empaquetador virtual local (contiene imports relativos
 * `./`, `../`, `/` o exportaciones desde rutas locales que resuelven contra el proyecto o son explícitamente relativas).
 * @param {string} rawCode
 * @param {string} sourcePath
 * @param {Map<string, object>} exactMap
 * @param {{ allowParentTraversal?: boolean }} [options]
 * @returns {boolean}
 */
export function hasLocalModuleDependencies(rawCode, sourcePath, exactMap, options = {}) {
  const ext = getFileExtension(sourcePath);
  let jsLike = String(rawCode || "");
  if (TS_EXTENSIONS.has(ext) || ext === "jsx") {
    jsLike = transpileTypeScriptAndJsx(jsLike, {
      jsx: ext === "tsx" || ext === "jsx",
      fileName: sourcePath || "entry.tsx"
    }).code;
  }
  void exactMap;
  void options;
  const usage = inspectModuleUsage(jsLike);
  for (const spec of [...usage.staticImports, ...usage.dynamicLocalImports]) {
    if (isRelativeModuleSpecifier(spec)) {
      return true;
    }
  }
  return false;
}

/**
 * Recolecta de forma recursiva las rutas de módulos locales referenciados por un archivo raíz
 * (para precarga lazy desde GitHub antes de generar el bundle).
 * @param {string} entryPath
 * @param {string} rawCode
 * @param {Array<object>} allFiles
 * @param {{ allowParentTraversal?: boolean }} [options]
 * @returns {string[]}
 */
export function extractModuleDependencyPaths(entryPath, rawCode, allFiles, options = {}) {
  const metadataMap = buildExactModuleMap(allFiles);
  const discovered = new Set();
  const visited = new Set();
  const queue = [{ path: normalizePath(entryPath), content: rawCode }];

  while (queue.length > 0) {
    const current = queue.shift();
    const clean = normalizePath(current.path);
    if (!clean || visited.has(clean)) continue;
    visited.add(clean);

    const ext = getFileExtension(clean);
    if (typeof current.content !== "string") continue;
    let jsCode = current.content;
    if (TS_EXTENSIONS.has(ext) || ext === "jsx") {
      jsCode = transpileTypeScriptAndJsx(jsCode, {
        jsx: ext === "tsx" || ext === "jsx",
        fileName: clean
      }).code;
    }

    const usage = inspectModuleUsage(jsCode);
    for (const spec of [...usage.staticImports, ...usage.dynamicLocalImports]) {
      if (!isRelativeModuleSpecifier(spec)) continue;
      const target = resolveLocalModuleEntry(spec, clean, metadataMap, {
        allowParentTraversal: options.allowParentTraversal !== false,
        allowUnloaded: true
      });
      if (target && target.path) {
        const targetNorm = normalizePath(target.path);
        discovered.add(targetNorm);
        if (!visited.has(targetNorm) && target.contentLoaded !== false && typeof target.content === "string") {
          queue.push({ path: targetNorm, content: target.content });
        }
      }
    }
  }

  return Array.from(discovered);
}

/**
 * Runtime compartida idempotente para ejecutar módulos CommonJS/ESM locales dentro de `<iframe srcdoc>`.
 * @returns {string}
 */
export function buildVirtualModuleRuntimeScript() {
  return `(function () {
  if (window.__studioRuntimeInit) return;
  window.__studioRuntimeInit = true;
  window.__studioModules = window.__studioModules || Object.create(null);
  window.__studioCache = window.__studioCache || Object.create(null);
  window.__studioPending = window.__studioPending || Object.create(null);
  window.__studioExt = window.__studioExt || Object.create(null);
  var liveWatchers = typeof WeakMap === "function" ? new WeakMap() : null;
  function notifyModule(exports) {
    if (!exports || !liveWatchers) return;
    var list = liveWatchers.get(exports);
    if (!list) return;
    for (var i = 0; i < list.length; i += 1) {
      try { list[i](); } catch (_) {}
    }
  }
  function subscribeModule(mod, fn) {
    if (!mod || typeof mod !== "object" || !liveWatchers) return;
    var list = liveWatchers.get(mod);
    if (!list) {
      list = [];
      liveWatchers.set(mod, list);
    }
    list.push(fn);
  }
  window.__studioNotify = notifyModule;
  window.__studioBind = function (mod, key, setter) {
    var push = function () {
      if (!mod || (typeof mod !== "object" && typeof mod !== "function")) return;
      var val;
      try {
        val = key === "__default_interop__" ? window.__studioInteropDefault(mod) : mod[key];
      } catch (_) {
        return;
      }
      try { setter(val); } catch (_) {}
    };
    push();
    subscribeModule(mod, push);
  };
  window.__studioBindReexport = function (exports, srcMod) {
    subscribeModule(srcMod, function () { notifyModule(exports); });
  };
  window.__studioExport = function (exports, name, getter) {
    Object.defineProperty(exports, name, { enumerable: true, configurable: true, get: getter });
  };
  window.__studioExportStar = function (exports, mod) {
    if (!mod || typeof mod !== "object") return;
    function syncKeys() {
      Object.keys(mod).forEach(function (k) {
        if (k === "default" || k === "__esModule") return;
        if (!Object.prototype.hasOwnProperty.call(exports, k)) {
          Object.defineProperty(exports, k, {
            enumerable: true,
            configurable: true,
            get: function () { return mod[k]; }
          });
        }
      });
    }
    syncKeys();
    subscribeModule(mod, function () {
      syncKeys();
      notifyModule(exports);
    });
  };
  window.__studioInteropDefault = function (mod) {
    if (!mod || (typeof mod !== "object" && typeof mod !== "function")) return mod;
    if (mod.__esModule) return Object.prototype.hasOwnProperty.call(mod, "default") ? mod.default : mod;
    if (typeof Symbol !== "undefined" && mod[Symbol.toStringTag] === "Module" && "default" in mod) {
      return mod.default;
    }
    return mod;
  };
  window.__studioDefine = function (id, factory) {
    window.__studioModules[id] = factory;
  };
  window.__studioRequire = function (id) {
    if (Object.prototype.hasOwnProperty.call(window.__studioCache, id)) {
      return window.__studioCache[id].exports;
    }
    var factory = window.__studioModules[id];
    if (!factory) {
      throw new Error("Módulo no encontrado en vista previa: " + id);
    }
    var module = { exports: Object.create(null) };
    module.exports.__esModule = true;
    window.__studioCache[id] = module;
    factory(window.__studioRequire, module, module.exports);
    notifyModule(module.exports);
    return module.exports;
  };
  window.__studioRequireAsync = async function (id, ancestors) {
    var chain = ancestors || Object.create(null);
    if (Object.prototype.hasOwnProperty.call(window.__studioPending, id)) {
      if (chain[id] && Object.prototype.hasOwnProperty.call(window.__studioCache, id)) {
        return window.__studioCache[id].exports;
      }
      return await window.__studioPending[id];
    }
    if (Object.prototype.hasOwnProperty.call(window.__studioCache, id)) {
      return window.__studioCache[id].exports;
    }
    var factory = window.__studioModules[id];
    if (!factory) {
      throw new Error("Módulo no encontrado en vista previa: " + id);
    }
    var module = { exports: Object.create(null) };
    module.exports.__esModule = true;
    window.__studioCache[id] = module;
    var nextChain = Object.create(null);
    Object.keys(chain).forEach(function (k) { nextChain[k] = true; });
    nextChain[id] = true;
    var scopedRequire = function (depId) {
      return window.__studioRequireAsync(depId, nextChain);
    };
    var initPromise = (async function () {
      try {
        await factory(scopedRequire, module, module.exports, scopedRequire);
        notifyModule(module.exports);
        return module.exports;
      } catch (err) {
        delete window.__studioCache[id];
        throw err;
      } finally {
        delete window.__studioPending[id];
      }
    })();
    window.__studioPending[id] = initPromise;
    return await initPromise;
  };
})();`;
}

/**
 * Compila recursivamente un módulo de entrada y todas sus dependencias locales (`.js`, `.mjs`, `.ts`, `.tsx`, `.jsx`,
 * `.json`, `.css`) en código JS ejecutable dentro del registro virtual, aplicando `transformJs` por módulo.
 *
 * @param {{
 *   entryPath: string,
 *   entryCode: string,
 *   exactMap: Map<string, object>,
 *   transformJs?: (code: string, isModule?: boolean) => string,
 *   transformCss?: (cssContent: string, cssPath: string) => string,
 *   allowParentTraversal?: boolean
 * }} params
 * @returns {{
 *   entryId: string,
 *   modulesCode: string,
 *   externalSpecifiers: string[],
 *   isAsync: boolean
 * }}
 */
export function buildVirtualModuleBundle({
  entryPath,
  entryCode,
  exactMap,
  transformJs = (c) => c,
  transformCss = (css) => css,
  allowParentTraversal = true
}) {
  const safeTransformJs = typeof transformJs === "function" ? transformJs : (c) => c;
  const safeTransformCss = typeof transformCss === "function" ? transformCss : (css) => css;
  const entryId = normalizePath(entryPath);
  const compiledModules = [];
  const externalSet = new Set();
  const visited = new Set();
  const queue = [{ id: entryId, content: String(entryCode ?? ""), ext: getFileExtension(entryId) }];

  // Paso 1: descubrir el grafo completo y detectar si algún módulo tiene top-level await o imports externos
  const graphNodes = [];
  let anyTopLevelAwait = false;

  while (queue.length > 0) {
    const node = queue.shift();
    if (visited.has(node.id)) continue;
    visited.add(node.id);

    if (node.ext === "css") {
      graphNodes.push({ ...node, kind: "css" });
      continue;
    }
    if (node.ext === "json") {
      graphNodes.push({ ...node, kind: "json" });
      continue;
    }

    let jsCode = node.content;
    if (TS_EXTENSIONS.has(node.ext) || node.ext === "jsx") {
      jsCode = transpileTypeScriptAndJsx(jsCode, {
        jsx: node.ext === "tsx" || node.ext === "jsx",
        fileName: node.id
      }).code;
    } else if (!CODE_SOURCE_EXTS.has(node.ext) && node.ext) {
      jsCode = transpileTypeScriptAndJsx(jsCode, { jsx: false, fileName: node.id }).code;
    }

    const usage = inspectModuleUsage(jsCode);
    if (usage.hasTopLevelAwait) {
      anyTopLevelAwait = true;
    }

    for (const spec of usage.staticImports) {
      if (isRelativeModuleSpecifier(spec)) {
        const target = resolveLocalModuleEntry(spec, node.id, exactMap, { allowParentTraversal });
        if (target) {
          const targetId = normalizePath(target.path);
          if (!visited.has(targetId)) {
            queue.push({ id: targetId, content: target.content, ext: getFileExtension(targetId) });
          }
        }
      } else if (/^(?:https?:|data:|blob:)/i.test(spec)) {
        externalSet.add(spec);
      }
    }
    for (const spec of usage.dynamicLocalImports) {
      if (isRelativeModuleSpecifier(spec)) {
        const target = resolveLocalModuleEntry(spec, node.id, exactMap, { allowParentTraversal });
        if (target) {
          const targetId = normalizePath(target.path);
          if (!visited.has(targetId)) {
            queue.push({ id: targetId, content: target.content, ext: getFileExtension(targetId) });
          }
        }
      }
    }

    graphNodes.push({ ...node, kind: "js", jsCode });
  }

  // Paso 2: emitir cada módulo con su propio ámbito aislado y loopGuard aplicado
  for (const node of graphNodes) {
    const idLit = JSON.stringify(node.id);

    if (node.kind === "css") {
      const processedCss = safeTransformCss(node.content, node.id);
      const cssLit = JSON.stringify(processedCss).replace(/</g, "\\u003c");
      compiledModules.push(
        `__studioDefine(${idLit}, function (__studioRequire, module, exports) {\n` +
          `  var __st = document.createElement("style");\n` +
          `  __st.setAttribute("data-source", ${idLit});\n` +
          `  __st.textContent = ${cssLit};\n` +
          `  (document.head || document.documentElement).appendChild(__st);\n` +
          `  exports.default = "";\n` +
          `});`
      );
      continue;
    }

    if (node.kind === "json") {
      let jsonLiteral = "null";
      try {
        jsonLiteral = JSON.stringify(JSON.parse(node.content)).replace(/</g, "\\u003c");
      } catch {
        jsonLiteral = JSON.stringify(node.content).replace(/</g, "\\u003c");
      }
      compiledModules.push(
        `__studioDefine(${idLit}, function (__studioRequire, module, exports) {\n` +
          `  var __data = ${jsonLiteral};\n` +
          `  module.exports = __data;\n` +
          `});`
      );
      continue;
    }

    const resolveDep = (spec) => {
      if (isRelativeModuleSpecifier(spec)) {
        const target = resolveLocalModuleEntry(spec, node.id, exactMap, { allowParentTraversal });
        if (target) {
          return { kind: "local", id: normalizePath(target.path), specifier: spec };
        }
        return {
          kind: "local",
          id: resolveRelativePath(getParentFolder(node.id), spec.split("?")[0].split("#")[0]),
          specifier: spec
        };
      }
      return { kind: "external", specifier: spec };
    };

    const rewritten = rewriteEsModuleToRegistry(node.jsCode, resolveDep, {
      useAsyncRequire: anyTopLevelAwait,
      moduleId: node.id
    });
    const safeBody = safeTransformJs(rewritten.code, false).replace(/<\/script(?=[\s>/]|$)/gi, "<\\/script");
    const fnHeader = anyTopLevelAwait
      ? `async function (__studioRequire, module, exports, __studioRequireAsync)`
      : `function (__studioRequire, module, exports)`;
    compiledModules.push(`__studioDefine(${idLit}, ${fnHeader} {\n${safeBody}\n});`);
  }

  return {
    entryId,
    modulesCode: compiledModules.join("\n"),
    externalSpecifiers: Array.from(externalSet),
    isAsync: anyTopLevelAwait
  };
}

/**
 * Formatea un bundle generado por `buildVirtualModuleBundle` como bloque JavaScript listo para
 * inyectar en `<script>` o `<script type="module">`.
 * @param {ReturnType<typeof buildVirtualModuleBundle>} bundle
 * @returns {{ isModuleTag: boolean, scriptCode: string }}
 */
export function formatVirtualModuleExecution(bundle) {
  const needsModuleTag = (bundle.externalSpecifiers && bundle.externalSpecifiers.length > 0) || Boolean(bundle.isAsync);
  const extParts = [];
  const parts = [];

  if (bundle.externalSpecifiers && bundle.externalSpecifiers.length > 0) {
    const extLines = bundle.externalSpecifiers.map((url, idx) => {
      const lit = JSON.stringify(url).replace(/</g, "\\u003c");
      return `import * as __studio_ext_${idx} from ${lit};\n(window.__studioExt = window.__studioExt || Object.create(null))[${lit}] = __studio_ext_${idx};`;
    });
    extParts.push(extLines.join("\n"));
  }

  parts.push(buildVirtualModuleRuntimeScript());
  if (bundle.modulesCode) {
    parts.push(bundle.modulesCode);
  }
  const execCall = bundle.isAsync
    ? `await __studioRequireAsync(${JSON.stringify(bundle.entryId)});`
    : `__studioRequire(${JSON.stringify(bundle.entryId)});`;
  parts.push(execCall);

  const extImportPreamble = extParts.join("\n").replace(/<\/script(?=[\s>/]|$)/gi, "<\\/script");
  const bodyCode = parts.join("\n").replace(/<\/script(?=[\s>/]|$)/gi, "<\\/script");

  return {
    isModuleTag: needsModuleTag,
    extImportPreamble,
    scriptBodyCode: bodyCode,
    scriptCode: extImportPreamble ? `${extImportPreamble}\n${bodyCode}` : bodyCode
  };
}
