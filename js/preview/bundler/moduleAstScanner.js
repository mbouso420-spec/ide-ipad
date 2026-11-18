/**
 * Análisis léxico de import/export, ASI, destructuring y descubrimiento recursivo de dependencias locales.
 */

import { normalizePath } from "../../storage/workspaceDb.js";
import { transpileTypeScriptAndJsx, tokenizeJsWithOffsets } from "../tsTranspiler.js";
import {
  skipTrivia,
  prevSigIndex as prevNonTriviaIndex,
  hasNewlineBetween,
  findMatchingDelimiter as findMatchingBrace
} from "../jsTokenUtils.js";
import { TS_EXTENSIONS, getFileExtension } from "../previewUtils.js";
import {
  buildExactModuleMap,
  isRelativeModuleSpecifier,
  resolveLocalModuleEntry
} from "./modulePathResolver.js";

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

export function unquoteStringToken(tok) {
  if (!tok || tok.type !== "string" || tok.value.length < 2) return "";
  return tok.value.slice(1, -1).replace(/\\(.)/g, "$1");
}

export function canStartTopLevelKeyword(tokens, idx, prevSigIdx) {
  if (prevSigIdx < 0) return true;
  const prev = tokens[prevSigIdx];
  if (!prev) return true;
  if (prev.value === ";" || prev.value === "}") return true;
  if (prev.value === ".") return false;
  return hasNewlineBetween(tokens, prevSigIdx + 1, idx);
}

export function consumeImportAttributesAndSemi(tokens, startIdx, sourceLen) {
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

export function isAsiBoundary(tokens, prevSigIdx, nextSigIdx) {
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

export function findStatementEndOffset(tokens, startIdx, sourceLen) {
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

export function parseNamedSpecifiers(tokens, openBraceIdx, closeBraceIdx) {
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

export function parseImportClause(tokens, startIdx, fromIdx) {
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

function skipPatternDefaultValue(tokens, startIdx, closeIdx) {
  let cur = skipTrivia(tokens, startIdx);
  if (cur >= closeIdx || tokens[cur].type !== "punct" || tokens[cur].value !== "=") {
    return cur;
  }
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
  return cur;
}

/**
 * Recorre un patrón de binding JS/destructuring (identificador, `{...}`, `[...]`)
 * extrayendo los nombres ligados y, opcionalmente, marcando índices no-referencia en `nonRefOut`.
 */
export function traverseBindingPattern(tokens, startIdx, namesOut, nonRefOut = null) {
  const i = skipTrivia(tokens, startIdx);
  if (i >= tokens.length) return i;

  const t = tokens[i];
  if (t.type === "ident") {
    namesOut.push(t.value);
    if (nonRefOut) nonRefOut.add(i);
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
          if (nonRefOut) nonRefOut.add(cur);
          cur += 1;
        }
        continue;
      }
      if (ct.type === "punct" && ct.value === "[") {
        cur = findMatchingBrace(tokens, cur, "[", "]") + 1;
        cur = skipTrivia(tokens, cur);
        if (cur < closeIdx && tokens[cur].type === "punct" && tokens[cur].value === ":") {
          cur = traverseBindingPattern(tokens, cur + 1, namesOut, nonRefOut);
        }
      } else if (ct.type === "ident" || ct.type === "string" || ct.type === "number") {
        const keyIdx = cur;
        const n1 = skipTrivia(tokens, cur + 1);
        if (n1 < closeIdx && tokens[n1].type === "punct" && tokens[n1].value === ":") {
          if (nonRefOut) nonRefOut.add(keyIdx);
          cur = traverseBindingPattern(tokens, n1 + 1, namesOut, nonRefOut);
        } else {
          if (ct.type === "ident") {
            namesOut.push(ct.value);
            if (nonRefOut) nonRefOut.add(keyIdx);
          }
          cur = n1;
        }
      } else {
        cur += 1;
        continue;
      }
      cur = skipPatternDefaultValue(tokens, cur, closeIdx);
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
        cur = traverseBindingPattern(tokens, cur + 1, namesOut, nonRefOut);
        continue;
      }
      cur = traverseBindingPattern(tokens, cur, namesOut, nonRefOut);
      cur = skipPatternDefaultValue(tokens, cur, closeIdx);
    }
    return closeIdx + 1;
  }

  return i + 1;
}

function extractBindingNamesFromPattern(tokens, startIdx) {
  const names = [];
  const nextTokenIdx = traverseBindingPattern(tokens, startIdx, names, null);
  return { names, nextTokenIdx };
}

export function parseVarDeclBindingsAndEnd(tokens, kwIdx, sourceLen) {
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
 * Comprueba si el script necesita resolverse con el empaquetador virtual local (contiene imports relativos
 * `./`, `../`, `/` o exportaciones desde rutas locales).
 * @param {string} rawCode
 * @param {string} sourcePath
 * @returns {boolean}
 */
export function hasRelativeDepsInUsage(usage) {
  if (!usage) return false;
  for (const spec of usage.staticImports || []) {
    if (isRelativeModuleSpecifier(spec)) return true;
  }
  for (const spec of usage.dynamicLocalImports || []) {
    if (isRelativeModuleSpecifier(spec)) return true;
  }
  return false;
}

export function hasLocalModuleDependencies(rawCode, sourcePath) {
  const ext = getFileExtension(sourcePath);
  let jsLike = String(rawCode || "");
  if (TS_EXTENSIONS.has(ext) || ext === "jsx") {
    jsLike = transpileTypeScriptAndJsx(jsLike, {
      jsx: ext === "tsx" || ext === "jsx",
      fileName: sourcePath || "entry.tsx"
    }).code;
  }
  return hasRelativeDepsInUsage(inspectModuleUsage(jsLike));
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
  let head = 0;

  while (head < queue.length) {
    const current = queue[head];
    head += 1;
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
