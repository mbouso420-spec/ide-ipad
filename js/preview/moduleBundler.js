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

  const cleanRef = String(specifier).trim().split("?")[0].split("#")[0];
  if (!cleanRef) return null;
  if (cleanRef.startsWith("../") && !allowParentTraversal) {
    return null;
  }

  const fromDir = getParentFolder(fromPath);
  const base = cleanRef.startsWith("/")
    ? normalizePath(cleanRef.slice(1))
    : resolveRelativePath(fromDir, cleanRef);
  if (!base) return null;

  const isUsable = (entry) =>
    Boolean(entry) && (allowUnloaded || typeof entry.content === "string");

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

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === "ws" || t.type === "comment") continue;

    if (t.type === "punct") {
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
      (prevSig < 0 || tokens[prevSig].value !== ".")
    ) {
      const n1 = skipTrivia(tokens, i + 1);
      if (n1 >= tokens.length || tokens[n1].value !== ":") {
        hasTopLevelAwait = true;
      }
    }

    // Dynamic `import("...")` a cualquier profundidad
    if (t.type === "ident" && t.value === "import" && (prevSig < 0 || tokens[prevSig].value !== ".")) {
      const n1 = skipTrivia(tokens, i + 1);
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
          if (spec) dynamicLocalImports.push(spec);
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
export function rewriteEsModuleToRegistry(jsCode, resolveDep, options = {}) {
  const { useAsyncRequire = false } = options;
  const reqCall = (idLiteral) =>
    useAsyncRequire ? `(await __studioRequireAsync(${idLiteral}))` : `__studioRequire(${idLiteral})`;

  const source = String(jsCode ?? "");
  const tokens = tokenizeJsWithOffsets(source);
  const edits = [];
  const hoistedExports = [];
  const deferredExports = [];
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

    // Dynamic `import("./local")` -> `Promise.resolve(__studioRequire("..."))`
    if (t.type === "ident" && t.value === "import" && (prevSig < 0 || tokens[prevSig].value !== ".")) {
      const n1 = skipTrivia(tokens, i + 1);
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
                  lines.push(`const ${defaultIdent} = __studioInteropDefault(${tmp});`);
                }
                if (namedSpecs.length > 0) {
                  const pairs = namedSpecs.map((s) => `${s.imported}: ${s.local}`).join(", ");
                  lines.push(`const { ${pairs} } = ${tmp};`);
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
                edits.push({ start: t.start, end: tokens[n2].start, text: "" });
              } else {
                edits.push({ start: t.start, end: tokens[n2].start, text: "exports.default = (" });
                edits.push({ start: tokens[closeBody].end, end: tokens[closeBody].end, text: ");" });
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
                edits.push({ start: t.start, end: tokens[n2].start, text: "" });
                edits.push({
                  start: tokens[closeBody].end,
                  end: tokens[closeBody].end,
                  text: ` __studioExport(exports, "default", function() { return ${clsName}; });`
                });
              } else {
                edits.push({ start: t.start, end: tokens[n2].start, text: "exports.default = (" });
                edits.push({ start: tokens[closeBody].end, end: tokens[closeBody].end, text: ");" });
              }
              prevSig = i;
              continue;
            }
          }

          // `export default <expr>`
          const stmtEnd = findStatementEndOffset(tokens, n2, source.length);
          const exprEnd = stmtEnd.endsWithSemi ? stmtEnd.endOffset - 1 : stmtEnd.endOffset;
          edits.push({ start: t.start, end: tokens[n2].start, text: "exports.default = (" });
          edits.push({ start: exprEnd, end: stmtEnd.endOffset, text: ");" });
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
                text: `const ${tmp} = ${depExpr(spec)}; ${binds}`
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
            deferredExports.push({
              local: p.imported.startsWith('"') ? JSON.parse(p.imported) : p.imported,
              exported: p.local
            });
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
            let scan = n1 + 1;
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
            edits.push({ start: t.start, end: kw1.start, text: "" });
            edits.push({
              start: tokens[closeBody].end,
              end: tokens[closeBody].end,
              text: ` __studioExport(exports, ${JSON.stringify(clsName)}, function() { return ${clsName}; });`
            });
          } else {
            edits.push({ start: t.start, end: kw1.start, text: "" });
          }
          prevSig = i;
          continue;
        }

        // 6. export const / let / var ...
        if (kw1.type === "ident" && (kw1.value === "const" || kw1.value === "let" || kw1.value === "var")) {
          const decl = parseVarDeclBindingsAndEnd(tokens, n1, source.length);
          edits.push({ start: t.start, end: kw1.start, text: "" });
          if (decl.names.length > 0) {
            const bindCalls = decl.names
              .map((n) => `__studioExport(exports, ${JSON.stringify(n)}, function() { return ${n}; });`)
              .join(" ");
            edits.push({ start: decl.endOffset, end: decl.endOffset, text: ` ${bindCalls}` });
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

  const head = hoistedExports
    .map((e) => `__studioExport(exports, ${JSON.stringify(e.exported)}, function() { return ${e.local}; });`)
    .join(" ");
  const tail = deferredExports
    .map((e) => `__studioExport(exports, ${JSON.stringify(e.exported)}, function() { return ${e.local}; });`)
    .join(" ");

  const parts = [];
  if (head) parts.push(head);
  parts.push(body);
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
        if (!visited.has(targetNorm) && typeof target.content === "string") {
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
  window.__studioExt = window.__studioExt || Object.create(null);
  window.__studioExport = function (exports, name, getter) {
    Object.defineProperty(exports, name, { enumerable: true, configurable: true, get: getter });
  };
  window.__studioExportStar = function (exports, mod) {
    if (!mod || typeof mod !== "object") return;
    Object.keys(mod).forEach(function (k) {
      if (k === "default" || k === "__esModule") return;
      Object.defineProperty(exports, k, {
        enumerable: true,
        configurable: true,
        get: function () { return mod[k]; }
      });
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
    return module.exports;
  };
  window.__studioRequireAsync = async function (id) {
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
    await factory(window.__studioRequireAsync, module, module.exports);
    return module.exports;
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

    for (const spec of [...usage.staticImports, ...usage.dynamicLocalImports]) {
      if (isRelativeModuleSpecifier(spec)) {
        const target = resolveLocalModuleEntry(spec, node.id, exactMap, { allowParentTraversal });
        if (target) {
          const targetId = normalizePath(target.path);
          if (!visited.has(targetId)) {
            queue.push({ id: targetId, content: target.content, ext: getFileExtension(targetId) });
          }
        }
      } else if (/^https?:\/\//i.test(spec)) {
        externalSet.add(spec);
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
      useAsyncRequire: anyTopLevelAwait
    });
    const safeBody = safeTransformJs(rewritten.code, false).replace(/<\/script>/gi, "<\\/script>");
    const fnHeader = anyTopLevelAwait
      ? `async function (__studioRequire, module, exports)`
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

  const extImportPreamble = extParts.join("\n").replace(/<\/script>/gi, "<\\/script>");
  const bodyCode = parts.join("\n").replace(/<\/script>/gi, "<\\/script>");

  return {
    isModuleTag: needsModuleTag,
    extImportPreamble,
    scriptBodyCode: bodyCode,
    scriptCode: extImportPreamble ? `${extImportPreamble}\n${bodyCode}` : bodyCode
  };
}
