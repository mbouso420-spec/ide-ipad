/**
 * Eliminación de anotaciones de tipos TypeScript, genéricos, interfaces, declaraciones y compilación de enums.
 */

import { nextSigIndex, prevSigIndex } from "../jsTokenUtils.js";
import {
  EXPR_BEFORE_REGEX_KEYWORDS,
  EXPR_START_KEYWORDS,
  MODIFIER_KEYWORDS,
  prevSigToken,
  findTopBrace,
  angleCloseCount,
  hasNewlineBeforeToken,
  skipBalancedPair
} from "./tsTokenizer.js";

const DISALLOW_ARROW_GENERIC_OPS = new Set([
  "&&",
  "||",
  "??",
  "==",
  "===",
  "!=",
  "!==",
  "<=",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "+=",
  "-=",
  "*=",
  "/=",
  "&&=",
  "||=",
  "??="
]);

const TYPE_CONT_PREV_KEYWORDS = new Set([
  "keyof",
  "typeof",
  "readonly",
  "infer",
  "is",
  "extends",
  "implements",
  "asserts",
  "new"
]);

export function skipTypeAnnotation(tokens, startIdx, stopPuncts) {
  let k = startIdx;
  let angle = 0;
  let paren = 0;
  let brace = 0;
  let bracket = 0;

  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "ws" || t.type === "comment") {
      if (
        angle === 0 &&
        paren === 0 &&
        brace === 0 &&
        bracket === 0 &&
        t.value.includes("\n")
      ) {
        const prev = prevSigToken(tokens, k);
        const nxtIdx = nextSigIndex(tokens, k + 1);
        const nxt = nxtIdx < tokens.length ? tokens[nxtIdx] : null;
        const prevContinues =
          prev &&
          ((prev.type === "punct" &&
            (prev.value === "|" ||
              prev.value === "&" ||
              prev.value === "<" ||
              prev.value === "," ||
              prev.value === "=>" ||
              prev.value === "?" ||
              prev.value === ":" ||
              prev.value === ".")) ||
            (prev.type === "ident" && TYPE_CONT_PREV_KEYWORDS.has(prev.value)));
        const nextContinues =
          nxt &&
          ((nxt.type === "punct" &&
            (nxt.value === "|" ||
              nxt.value === "&" ||
              nxt.value === "." ||
              nxt.value === "=>")) ||
            (nxt.type === "ident" && (nxt.value === "extends" || nxt.value === "is")));
        if (!prevContinues && !nextContinues) {
          return k;
        }
      }
      k += 1;
      continue;
    }
    if (t.type === "punct") {
      const v = t.value;
      if (v === "{" && stopPuncts.has("{") && angle === 0 && paren === 0 && brace === 0 && bracket === 0) {
        const prevSig = prevSigToken(tokens, k);
        const isInlineObjTypeStart =
          k === startIdx ||
          (prevSig &&
            (prevSig.value === ":" || prevSig.value === "|" || prevSig.value === "&" || prevSig.value === "=>"));
        if (isInlineObjTypeStart) {
          k = skipBalancedPair(tokens, k, "{", "}");
          continue;
        }
      }
      if (angle === 0 && paren === 0 && brace === 0 && bracket === 0 && stopPuncts.has(v)) {
        return k;
      }
      if (v === "(") paren += 1;
      else if (v === ")" && paren > 0) paren -= 1;
      else if (v === "{") brace += 1;
      else if (v === "}" && brace > 0) brace -= 1;
      else if (v === "[") bracket += 1;
      else if (v === "]" && bracket > 0) bracket -= 1;
      else if (v === "<") angle += 1;
      else if (v === ">" && angle > 0) angle -= 1;
      else if (v === ">>" && angle >= 2) angle -= 2;
      else if (v === ">>>" && angle >= 3) angle -= 3;
      else if (v === "=>" && paren === 0 && brace === 0 && bracket === 0 && angle === 0) {
        // Tipo función `() => void`: consumir retorno hasta delimitador externo
        k += 1;
        continue;
      }
    } else if (
      t.type === "ident" &&
      angle === 0 &&
      paren === 0 &&
      brace === 0 &&
      bracket === 0 &&
      (t.value === "in" || t.value === "of" || t.value === "extends" || t.value === "implements") &&
      stopPuncts.has(t.value)
    ) {
      return k;
    }
    k += 1;
  }
  return k;
}

const GENERIC_LOOKAHEAD_STMT_BAIL = new Set([
  "return",
  "throw",
  "break",
  "continue",
  "if",
  "for",
  "while",
  "switch",
  "try",
  "catch",
  "finally",
  "let",
  "var",
  "function",
  "export",
  "import",
  "debugger"
]);

function scanBalancedGenericCloseIndex(tokens, ltIdx) {
  let depth = 0;
  let innerParens = 0;
  let innerBraces = 0;
  let k = ltIdx;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "ws" || t.type === "comment") {
      if (innerParens === 0 && innerBraces === 0 && t.value.includes("\n")) {
        const prev = prevSigToken(tokens, k);
        const nxtIdx = nextSigIndex(tokens, k + 1);
        const nxt = nxtIdx < tokens.length ? tokens[nxtIdx] : null;
        const prevContinues =
          prev &&
          ((prev.type === "punct" &&
            (prev.value === "<" ||
              prev.value === "," ||
              prev.value === "&" ||
              prev.value === "|" ||
              prev.value === "=")) ||
            (prev.type === "ident" && (prev.value === "extends" || prev.value === "const")));
        const nextContinues =
          nxt &&
          ((nxt.type === "punct" &&
            (nxt.value === "," ||
              nxt.value === "&" ||
              nxt.value === "|" ||
              nxt.value === "=" ||
              angleCloseCount(nxt) > 0)) ||
            (nxt.type === "ident" && nxt.value === "extends"));
        if (!prevContinues && !nextContinues) {
          return -1;
        }
      }
      k += 1;
      continue;
    }
    if (t.type === "punct") {
      if (t.value === "<") {
        depth += 1;
      } else {
        const closeCount = angleCloseCount(t);
        if (closeCount > 0) {
          depth -= closeCount;
          if (depth === 0 && innerParens === 0 && innerBraces === 0) {
            return k;
          }
          if (depth <= 0) {
            return -1;
          }
        } else if (t.value === "(" || t.value === "[") {
          innerParens += 1;
        } else if (t.value === ")" || t.value === "]") {
          if (innerParens === 0) return -1;
          innerParens -= 1;
        } else if (t.value === "{") {
          innerBraces += 1;
        } else if (t.value === "}") {
          if (innerBraces === 0) return -1;
          innerBraces -= 1;
        } else if (t.value === ";" && innerParens === 0 && innerBraces === 0) {
          return -1;
        } else if (
          depth === 1 &&
          innerParens === 0 &&
          innerBraces === 0 &&
          (t.value === "?" || DISALLOW_ARROW_GENERIC_OPS.has(t.value))
        ) {
          return -1;
        }
      }
    } else if (
      depth === 1 &&
      innerParens === 0 &&
      innerBraces === 0 &&
      t.type === "ident" &&
      GENERIC_LOOKAHEAD_STMT_BAIL.has(t.value)
    ) {
      return -1;
    }
    k += 1;
  }
  return -1;
}

export function isArrowGenericAhead(tokens, ltIdx) {
  const closeIdx = scanBalancedGenericCloseIndex(tokens, ltIdx);
  if (closeIdx === -1) return false;
  const afterOpen = nextSigIndex(tokens, closeIdx + 1);
  if (afterOpen >= tokens.length || tokens[afterOpen].type !== "punct" || tokens[afterOpen].value !== "(") {
    return false;
  }
  const afterClose = skipBalancedPair(tokens, afterOpen, "(", ")");
  const retStart = nextSigIndex(tokens, afterClose);
  if (retStart >= tokens.length) return false;
  if (tokens[retStart].value === "=>") return true;
  if (tokens[retStart].value === ":") {
    const retEnd = skipTypeAnnotation(tokens, retStart + 1, new Set(["=>", ";", "{", ")", "}"]));
    return retEnd < tokens.length && tokens[retEnd].value === "=>";
  }
  return false;
}

export function skipStatement(tokens, startIdx) {
  let k = startIdx;
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "punct") {
      if (t.value === "{") brace += 1;
      else if (t.value === "}") {
        if (brace > 0) brace -= 1;
        if (brace === 0 && paren === 0 && bracket === 0 && angle === 0) {
          const nxt = nextSigIndex(tokens, k + 1);
          const nxtTok = nxt < tokens.length ? tokens[nxt] : null;
          if (
            nxtTok &&
            ((nxtTok.type === "ident" && (nxtTok.value === "from" || nxtTok.value === "extends" || nxtTok.value === "implements")) ||
              nxtTok.value === "|" ||
              nxtTok.value === "&" ||
              nxtTok.value === "[")
          ) {
            k += 1;
            continue;
          }
          if (nxtTok && nxtTok.value === ";") {
            return nxt + 1;
          }
          return k + 1;
        }
      } else if (t.value === "(") paren += 1;
      else if (t.value === ")" && paren > 0) paren -= 1;
      else if (t.value === "[") bracket += 1;
      else if (t.value === "]" && bracket > 0) bracket -= 1;
      else if (brace === 0 && paren === 0 && bracket === 0 && t.value === "<") angle += 1;
      else if (brace === 0 && paren === 0 && bracket === 0 && angleCloseCount(t) > 0 && angle > 0) {
        angle = Math.max(0, angle - angleCloseCount(t));
      } else if (t.value === ";" && brace === 0 && paren === 0 && bracket === 0 && angle === 0) {
        return k + 1;
      }
    } else if (
      t.type === "ws" &&
      t.value.includes("\n") &&
      brace === 0 &&
      paren === 0 &&
      bracket === 0 &&
      angle === 0
    ) {
      const prev = prevSigToken(tokens, k);
      const nxtIdx = nextSigIndex(tokens, k + 1);
      const nxt = nxtIdx < tokens.length ? tokens[nxtIdx] : null;
      const continues =
        (prev && prev.type === "punct" && (prev.value === "=" || prev.value === "|" || prev.value === "&" || prev.value === "<")) ||
        (nxt && nxt.type === "punct" && (nxt.value === "|" || nxt.value === "&" || nxt.value === "{" || nxt.value === ">"));
      if (!continues) return k;
    }
    k += 1;
  }
  return k;
}

export function compileEnumDeclaration(tokens, enumKwIdx) {
  const nameIdx = nextSigIndex(tokens, enumKwIdx + 1);
  if (nameIdx >= tokens.length || tokens[nameIdx].type !== "ident") return null;
  const enumName = tokens[nameIdx].value;
  const openBraceIdx = nextSigIndex(tokens, nameIdx + 1);
  if (openBraceIdx >= tokens.length || tokens[openBraceIdx].value !== "{") return null;
  const endIdx = skipBalancedPair(tokens, openBraceIdx, "{", "}");
  const props = [];
  const entries = [];
  const priorNames = new Set();
  let usesSelfRef = false;
  let autoNum = 0;

  let k = openBraceIdx + 1;
  while (k < endIdx - 1) {
    k = nextSigIndex(tokens, k);
    if (k >= endIdx - 1) break;
    const keyTok = tokens[k];
    if (keyTok.type !== "ident" && keyTok.type !== "string") {
      k += 1;
      continue;
    }
    const keyName = keyTok.value;
    let nextIdx = nextSigIndex(tokens, k + 1);
    let exprStr = String(autoNum);
    if (nextIdx < endIdx - 1 && tokens[nextIdx].value === "=") {
      const valStart = nextSigIndex(tokens, nextIdx + 1);
      let valEnd = valStart;
      let valStr = "";
      let pDepth = 0;
      let bDepth = 0;
      let cDepth = 0;
      while (valEnd < endIdx - 1) {
        const vt = tokens[valEnd];
        if (pDepth === 0 && bDepth === 0 && cDepth === 0 && vt.type === "punct" && vt.value === ",") {
          break;
        }
        if (vt.type === "punct") {
          if (vt.value === "(") pDepth += 1;
          else if (vt.value === ")") pDepth = Math.max(0, pDepth - 1);
          else if (vt.value === "[") bDepth += 1;
          else if (vt.value === "]") bDepth = Math.max(0, bDepth - 1);
          else if (vt.value === "{") cDepth += 1;
          else if (vt.value === "}") cDepth = Math.max(0, cDepth - 1);
        }
        if (vt.type === "ident" && priorNames.has(vt.value) && tokens[prevSigIndex(tokens, valEnd)]?.value !== ".") {
          usesSelfRef = true;
        }
        if (vt.type !== "comment") {
          valStr += vt.type === "ws" ? " " : vt.value;
        }
        valEnd += 1;
      }
      const trimmedVal = valStr.replace(/\s+/g, " ").trim();
      const numVal = Number(trimmedVal);
      if (trimmedVal !== "" && Number.isInteger(numVal)) {
        autoNum = numVal + 1;
      }
      exprStr = trimmedVal || "undefined";
      props.push(`${keyName}: ${exprStr}`);
      k = valEnd + 1;
    } else {
      props.push(`${keyName}: ${autoNum}`);
      autoNum += 1;
      k = nextIdx + (tokens[nextIdx]?.value === "," ? 1 : 0);
    }
    entries.push({ keyName, exprStr });
    if (keyTok.type === "ident") {
      priorNames.add(keyName);
    }
  }

  if (usesSelfRef) {
    const bodyStmts = entries
      .map((e) => (e.keyName.startsWith('"') || e.keyName.startsWith("'")
        ? `__e[${e.keyName}] = ${e.exprStr};`
        : `const ${e.keyName} = (__e[${JSON.stringify(e.keyName)}] = ${e.exprStr});`))
      .join(" ");
    return {
      js: `const ${enumName} = (() => { const __e = {}; ${bodyStmts} return __e; })();`,
      nextIdx: endIdx
    };
  }

  return {
    js: `const ${enumName} = { ${props.join(", ")} };`,
    nextIdx: endIdx
  };
}

function isBeforeMethodOrNamedFuncHeader(tokens, openParenIdx, stack) {
  const prevIdx = prevSigIndex(tokens, openParenIdx);
  if (prevIdx < 0) return false;
  const prev = tokens[prevIdx];
  if (prev.type === "ident" && (prev.value === "function" || prev.value === "constructor")) {
    return true;
  }
  let nameIdx = prevIdx;
  let nameTok = prev;
  if (angleCloseCount(prev) > 0) {
    let j = prevIdx;
    let angle = angleCloseCount(prev);
    j -= 1;
    while (j >= 0 && angle > 0) {
      const tj = tokens[j];
      if (tj.type === "punct" && tj.value === "<") {
        angle -= 1;
      } else {
        angle += angleCloseCount(tj);
      }
      if (angle === 0) break;
      j -= 1;
    }
    nameIdx = prevSigIndex(tokens, j);
    if (nameIdx < 0) return false;
    nameTok = tokens[nameIdx];
  }
  if (nameTok.type !== "ident" || EXPR_START_KEYWORDS.has(nameTok.value)) {
    return false;
  }
  const beforeName = prevSigToken(tokens, nameIdx);
  if (beforeName && (beforeName.value === "function" || beforeName.value === "*")) {
    return true;
  }
  const topBrace = findTopBrace(stack);
  if (topBrace?.inClass) {
    return !beforeName || beforeName.value !== "=";
  }
  if (topBrace?.isObject) {
    if (nameTok.value === "async" && beforeName?.value === ":") {
      return false;
    }
    return beforeName?.value === "{" || beforeName?.value === "," || beforeName?.value === "async";
  }
  return false;
}

function classifyParamParen(tokens, openParenIdx, stack) {
  const prevIdx = prevSigIndex(tokens, openParenIdx);
  const prev = prevIdx >= 0 ? tokens[prevIdx] : null;
  if (prev) {
    if (prev.type === "ident" && prev.value === "catch") {
      return { isParams: false, isMethodOrFunc: false };
    }
    if (prev.type === "ident" && (prev.value === "function" || prev.value === "constructor")) {
      return { isParams: true, isMethodOrFunc: true };
    }
    if (angleCloseCount(prev) > 0) {
      // `function foo<T>(` o `<T>(`
      return { isParams: true, isMethodOrFunc: isBeforeMethodOrNamedFuncHeader(tokens, openParenIdx, stack) };
    }
  }
  const closeIdx = skipBalancedPair(tokens, openParenIdx, "(", ")");
  const afterClose = nextSigIndex(tokens, closeIdx);
  const isMethodOrFunc = isBeforeMethodOrNamedFuncHeader(tokens, openParenIdx, stack);
  if (afterClose < tokens.length) {
    const t = tokens[afterClose];
    if (t.type === "punct" && t.value === "=>") {
      return { isParams: true, isMethodOrFunc: false };
    }
    if (t.type === "punct" && t.value === ":") {
      const stopSet = isMethodOrFunc
        ? new Set(["{", ";", ",", ")"])
        : new Set(["{", "=>", ";", ",", ")"]);
      const retEnd = skipTypeAnnotation(tokens, afterClose + 1, stopSet);
      if (retEnd < tokens.length && (tokens[retEnd].value === "=>" || tokens[retEnd].value === "{")) {
        return { isParams: true, isMethodOrFunc };
      }
    }
  }
  // Verificar método de clase o función nombrada: `ident (` seguido de `) {`
  if (prev && prev.type === "ident" && !EXPR_START_KEYWORDS.has(prev.value)) {
    const beforeName = prevSigToken(tokens, prevIdx);
    if (beforeName && beforeName.value === "function") {
      return { isParams: true, isMethodOrFunc: true };
    }
    const topBrace = findTopBrace(stack);
    if ((topBrace?.inClass || topBrace?.isObject) && afterClose < tokens.length && tokens[afterClose].value === "{") {
      return { isParams: true, isMethodOrFunc: true };
    }
  }
  return { isParams: false, isMethodOrFunc: false };
}

function looksLikeCallGeneric(tokens, ltIdx) {
  const prev = prevSigToken(tokens, ltIdx);
  if (!prev || prev.type !== "ident" || EXPR_BEFORE_REGEX_KEYWORDS.has(prev.value)) {
    return false;
  }
  const closeIdx = scanBalancedGenericCloseIndex(tokens, ltIdx);
  if (closeIdx === -1) return false;
  const after = nextSigIndex(tokens, closeIdx + 1);
  return (
    after < tokens.length &&
    tokens[after].type === "punct" &&
    (tokens[after].value === "(" || tokens[after].value === "=>")
  );
}

export function stripTypeScriptFromTokens(tokens) {
  let out = "";
  let i = 0;
  let ternaryDepth = 0;
  let inVarDecl = false;
  let inVarInit = false;
  let inImportExportClause = false;
  let inCaseExpr = false;
  let pendingClassBody = false;
  let pendingConstructorParams = null;
  let constructorParenDepth = -1;
  let injectConstructorThis = null;
  let waitingForSuperEnd = false;
  let superBodyDepth = -1;
  let superCallClosed = false;
  let lastClosedParen = null;
  const stack = [];

  const OBJ_BEFORE_PUNCT = new Set([
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
  const TOP_TYPE_STOP = new Set(["=", ";", ",", "in", "of", ")", "}"]);
  const PARAM_TYPE_STOP = new Set([",", ")", "="]);
  const RET_TYPE_STOP = new Set(["{", "=>", ";", ",", ")"]);
  const METHOD_RET_TYPE_STOP = new Set(["{", ";", ",", ")"]);
  const DECLARE_FOLLOWERS = new Set([
    "const",
    "let",
    "var",
    "function",
    "class",
    "abstract",
    "enum",
    "interface",
    "type",
    "namespace",
    "module",
    "async",
    "global"
  ]);
  const VAR_INIT_CONT_PREV = new Set([
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&&=",
    "||=",
    "??=",
    "?",
    ":",
    ",",
    "+",
    "-",
    "*",
    "/",
    "%",
    "&&",
    "||",
    "??",
    "==",
    "===",
    "!=",
    "!==",
    "<",
    ">",
    "<=",
    ">=",
    "<<",
    ">>",
    ">>>",
    "&",
    "|",
    "^",
    ".",
    "?.",
    "=>",
    "typeof",
    "await",
    "yield",
    "new",
    "return",
    "delete",
    "void",
    "in",
    "of",
    "instanceof"
  ]);
  const VAR_INIT_CONT_NEXT = new Set([
    ".",
    "?.",
    "?",
    ":",
    ",",
    "&&",
    "||",
    "??",
    "+",
    "-",
    "*",
    "/",
    "%",
    "==",
    "===",
    "!=",
    "!==",
    "<",
    ">",
    "<=",
    ">=",
    "as",
    "satisfies"
  ]);

  function currentBrace() {
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      if (stack[s].kind === "brace") return stack[s];
    }
    return null;
  }

  function currentParen() {
    for (let s = stack.length - 1; s >= 0; s -= 1) {
      if (stack[s].kind === "paren") return stack[s];
    }
    return null;
  }

  while (i < tokens.length) {
    const tok = tokens[i];
    const prev = prevSigToken(tokens, i);

    if (tok.type === "ws" || tok.type === "comment") {
      if (tok.value.includes("\n")) {
        if (inImportExportClause && prev?.type === "string") {
          inImportExportClause = false;
        }
        if (
          waitingForSuperEnd &&
          injectConstructorThis &&
          superCallClosed &&
          stack.length === superBodyDepth
        ) {
          const nxtIdx = nextSigIndex(tokens, i + 1);
          const nxt = nxtIdx < tokens.length ? tokens[nxtIdx] : null;
          if (
            !nxt ||
            (nxt.value !== "." &&
              nxt.value !== "?." &&
              nxt.value !== "(" &&
              nxt.value !== "[" &&
              nxt.value !== ";")
          ) {
            waitingForSuperEnd = false;
            superCallClosed = false;
            superBodyDepth = -1;
            const assignments = injectConstructorThis.map((p) => `this.${p} = ${p};`).join(" ");
            injectConstructorThis = null;
            out += `; ${assignments}`;
          }
        }
        if (inVarDecl) {
          const top = stack[stack.length - 1];
          const inStmtScope = !top || (top.kind === "brace" && !top.isObject && !top.isPattern);
          if (inStmtScope) {
            const nxtIdx = nextSigIndex(tokens, i + 1);
            const nxt = nxtIdx < tokens.length ? tokens[nxtIdx] : null;
            let continues = false;
            if (!inVarInit) {
              continues =
                Boolean(
                  prev &&
                    (prev.value === ":" ||
                      prev.value === "," ||
                      prev.value === "|" ||
                      prev.value === "&" ||
                      prev.value === "<" ||
                      prev.value === "const" ||
                      prev.value === "let" ||
                      prev.value === "var")
                ) ||
                Boolean(
                  nxt &&
                    (nxt.value === "=" ||
                      nxt.value === ":" ||
                      nxt.value === "|" ||
                      nxt.value === "&" ||
                      nxt.value === "in" ||
                      nxt.value === "of")
                );
            } else {
              continues =
                Boolean(prev && VAR_INIT_CONT_PREV.has(prev.value)) ||
                Boolean(nxt && VAR_INIT_CONT_NEXT.has(nxt.value));
            }
            if (!continues) {
              inVarDecl = false;
              inVarInit = false;
            }
          }
        }
      }
      out += tok.value;
      i += 1;
      continue;
    }

    // import / export type
    if (tok.type === "ident" && (tok.value === "import" || tok.value === "export")) {
      const n1 = nextSigIndex(tokens, i + 1);
      if (n1 < tokens.length && tokens[n1].type === "ident") {
        if (tokens[n1].value === "type") {
          const n2 = nextSigIndex(tokens, n1 + 1);
          if (tokens[n2]?.value === "{" || tokens[n2]?.type === "ident" || tokens[n2]?.value === "*") {
            i = skipStatement(tokens, i);
            continue;
          }
        }
        if (tok.value === "export" && (tokens[n1].value === "interface" || tokens[n1].value === "declare")) {
          i = skipStatement(tokens, i);
          continue;
        }
        if (tok.value === "export" && tokens[n1].value === "default") {
          const n2 = nextSigIndex(tokens, n1 + 1);
          if (n2 < tokens.length && tokens[n2].type === "ident" && tokens[n2].value === "interface") {
            i = skipStatement(tokens, i);
            continue;
          }
        }
        if (tok.value === "export" && tokens[n1].value === "enum") {
          const compiled = compileEnumDeclaration(tokens, n1);
          if (compiled) {
            out += `export ${compiled.js}`;
            i = compiled.nextIdx;
            continue;
          }
        }
        if (tok.value === "export" && tokens[n1].value === "const") {
          const n2 = nextSigIndex(tokens, n1 + 1);
          if (n2 < tokens.length && tokens[n2].value === "enum") {
            const compiled = compileEnumDeclaration(tokens, n2);
            if (compiled) {
              out += `export ${compiled.js}`;
              i = compiled.nextIdx;
              continue;
            }
          }
        }
      }
      const isStaticImport =
        tok.value === "import" &&
        n1 < tokens.length &&
        tokens[n1].value !== "(" &&
        tokens[n1].value !== ".";
      const isExportClause =
        tok.value === "export" &&
        n1 < tokens.length &&
        (tokens[n1].value === "{" || tokens[n1].value === "*");
      if (isStaticImport || isExportClause) {
        inImportExportClause = true;
      }
    }

    // Inline `type` en import { a, type B, type C as D }
    if (inImportExportClause && tok.type === "ident" && tok.value === "type") {
      const n1 = nextSigIndex(tokens, i + 1);
      if (n1 < tokens.length && tokens[n1].type === "ident" && tokens[n1].value !== "as") {
        let endSpec = n1;
        const afterName = nextSigIndex(tokens, n1 + 1);
        if (afterName < tokens.length && tokens[afterName].type === "ident" && tokens[afterName].value === "as") {
          const aliasIdx = nextSigIndex(tokens, afterName + 1);
          if (aliasIdx < tokens.length && tokens[aliasIdx].type === "ident") {
            endSpec = aliasIdx;
          }
        }
        const afterSpec = nextSigIndex(tokens, endSpec + 1);
        i = afterSpec < tokens.length && tokens[afterSpec].value === "," ? afterSpec + 1 : endSpec + 1;
        continue;
      }
    }

    // Declaraciones puras de TS a nivel de bloque o módulo (incluyendo ASI tras salto de línea)
    const startsTsStmt =
      !prev ||
      (prev.value !== "." &&
        prev.value !== "?." &&
        (prev.value === ";" ||
          prev.value === "{" ||
          prev.value === "}" ||
          prev.value === "export" ||
          hasNewlineBeforeToken(tokens, i)));

    if (tok.type === "ident" && startsTsStmt) {
      if (tok.value === "interface") {
        const n1 = nextSigIndex(tokens, i + 1);
        if (n1 < tokens.length && tokens[n1].type === "ident") {
          i = skipStatement(tokens, i);
          continue;
        }
      }
      if (tok.value === "declare") {
        const n1 = nextSigIndex(tokens, i + 1);
        if (n1 < tokens.length && tokens[n1].type === "ident" && DECLARE_FOLLOWERS.has(tokens[n1].value)) {
          i = skipStatement(tokens, i);
          continue;
        }
      }
      if (tok.value === "type") {
        const n1 = nextSigIndex(tokens, i + 1);
        const n2 = n1 < tokens.length ? nextSigIndex(tokens, n1 + 1) : tokens.length;
        if (
          n1 < tokens.length &&
          tokens[n1].type === "ident" &&
          (tokens[n2]?.value === "=" || tokens[n2]?.value === "<")
        ) {
          i = skipStatement(tokens, i);
          continue;
        }
      }
    }

    if (tok.type === "ident" && tok.value === "enum") {
      const compiled = compileEnumDeclaration(tokens, i);
      if (compiled) {
        out += compiled.js;
        i = compiled.nextIdx;
        continue;
      }
    }

    if (tok.type === "ident" && (tok.value === "const" || tok.value === "let" || tok.value === "var")) {
      const n1 = nextSigIndex(tokens, i + 1);
      if (tok.value === "const" && n1 < tokens.length && tokens[n1].value === "enum") {
        const compiled = compileEnumDeclaration(tokens, n1);
        if (compiled) {
          out += compiled.js;
          i = compiled.nextIdx;
          continue;
        }
      }
      inVarDecl = true;
      inVarInit = false;
    }

    if (
      tok.type === "ident" &&
      (tok.value === "case" ||
        (tok.value === "default" && tokens[nextSigIndex(tokens, i + 1)]?.value === ":"))
    ) {
      inCaseExpr = true;
    }

    if (tok.type === "ident" && tok.value === "class") {
      pendingClassBody = true;
    }

    if (tok.type === "ident" && tok.value === "implements") {
      const braceIdx = skipTypeAnnotation(tokens, i + 1, new Set(["{"]));
      i = braceIdx;
      continue;
    }

    if (tok.type === "ident" && MODIFIER_KEYWORDS.has(tok.value)) {
      const brace = currentBrace();
      const paren = currentParen();
      const inClassScope = Boolean(brace?.inClass) || (paren?.isParams && pendingConstructorParams !== null);
      const nextTokIdx = nextSigIndex(tokens, i + 1);
      const nextTok = nextTokIdx < tokens.length ? tokens[nextTokIdx] : null;
      if (
        (tok.value === "abstract" && nextTok?.value === "class") ||
        (inClassScope &&
          nextTok &&
          (nextTok.type === "ident" || nextTok.value === "[" || nextTok.value === "#"))
      ) {
        if (
          paren?.isParams &&
          stack.length - 1 === constructorParenDepth &&
          pendingConstructorParams !== null &&
          nextTok.type === "ident" &&
          !MODIFIER_KEYWORDS.has(nextTok.value)
        ) {
          pendingConstructorParams.push(nextTok.value);
        }
        i += 1;
        continue;
      }
    }

    if (tok.type === "ident" && tok.value === "constructor" && currentBrace()?.inClass) {
      pendingConstructorParams = [];
      constructorParenDepth = stack.length;
    }

    // as Type / satisfies Type (fuera de import/export, llamadas `as(...)` y accesos `obj.as`)
    const prevCanEndExpr =
      prev &&
      ((prev.type === "ident" && !EXPR_START_KEYWORDS.has(prev.value)) ||
        prev.type === "number" ||
        prev.type === "string" ||
        prev.type === "regex" ||
        prev.type === "template_full" ||
        prev.type === "template_tail" ||
        prev.value === ")" ||
        prev.value === "]");
    if (
      tok.type === "ident" &&
      (tok.value === "as" || tok.value === "satisfies") &&
      !inImportExportClause &&
      prevCanEndExpr &&
      prev.value !== "." &&
      prev.value !== "?."
    ) {
      const n1 = nextSigIndex(tokens, i + 1);
      const nTok = n1 < tokens.length ? tokens[n1] : null;
      const startsType =
        nTok &&
        (nTok.type === "ident" ||
          nTok.type === "string" ||
          nTok.type === "number" ||
          nTok.value === "{" ||
          nTok.value === "[" ||
          nTok.value === "(");
      if (startsType) {
        const afterType = skipTypeAnnotation(
          tokens,
          i + 1,
          new Set([
            ";", ",", ")", "]", "}", ":", "?",
            "&&", "||", "??",
            "=", "==", "===", "!=", "!==", "<=", ">=",
            "+", "-", "*", "/", "%", "**",
            "instanceof", "in"
          ])
        );
        i = afterType;
        continue;
      }
    }

    // Genéricos de llamada, flecha o cabecera de clase <T>
    if (tok.type === "punct" && tok.value === "<") {
      const isArrowGen =
        isArrowGenericAhead(tokens, i) &&
        (!prev || prev.type === "punct" || EXPR_START_KEYWORDS.has(prev.value || "") || prev.value === "function" || prev.value === "async");
      if (pendingClassBody || isArrowGen || looksLikeCallGeneric(tokens, i)) {
        i = skipBalancedPair(tokens, i, "<", ">");
        continue;
      }
    }

    // Postfix `!` no-nulo: `ident!` o `)!` o `]!` sin salto de línea previo (ASI) ni operador prefijo tras keyword
    if (tok.type === "punct" && tok.value === "!") {
      const n1 = nextSigIndex(tokens, i + 1);
      const hasNewlineBefore = hasNewlineBeforeToken(tokens, i);
      if (
        !hasNewlineBefore &&
        prev &&
        (prev.type === "ident" || prev.value === ")" || prev.value === "]") &&
        !(prev.type === "ident" && EXPR_BEFORE_REGEX_KEYWORDS.has(prev.value)) &&
        (!tokens[n1] || tokens[n1].value !== "=")
      ) {
        i += 1;
        continue;
      }
    }

    // `?` ternario vs `?:` parámetro/propiedad opcional
    if (tok.type === "punct" && tok.value === "?") {
      const n1 = nextSigIndex(tokens, i + 1);
      if (n1 < tokens.length && tokens[n1].type === "punct" && tokens[n1].value === ":") {
        // `?: Type` -> saltar `?` y dejar que la rama de `:` borre `: Type`
        i += 1;
        continue;
      }
      ternaryDepth += 1;
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === ":") {
      if (inCaseExpr) {
        inCaseExpr = false;
        out += tok.value;
        i += 1;
        continue;
      }
      if (ternaryDepth > 0) {
        ternaryDepth -= 1;
        out += tok.value;
        i += 1;
        continue;
      }

      const top = stack[stack.length - 1];
      const brace = currentBrace();
      const paren = currentParen();

      if (top?.kind === "paren" && top.isParams) {
        const stopIdx = skipTypeAnnotation(tokens, i + 1, PARAM_TYPE_STOP);
        const stopTok = tokens[stopIdx];
        if (stopTok && stopTok.value === "=" && out.length > 0 && !/\s$/.test(out)) {
          out += " ";
        }
        i = stopIdx;
        continue;
      }

      if (prev && (prev.value === ")" || prev.value === "]")) {
        const useMethodStop =
          prev.value === ")" &&
          lastClosedParen?.token === prev &&
          lastClosedParen.isMethodOrFunc;
        const stopIdx = skipTypeAnnotation(tokens, i + 1, useMethodStop ? METHOD_RET_TYPE_STOP : RET_TYPE_STOP);
        const stopTok = tokens[stopIdx];
        const canStripInObj = prev.value === ")" && (stopTok?.value === "{" || stopTok?.value === "=>");
        if (!brace?.isObject || canStripInObj) {
          if (stopTok && (stopTok.value === "{" || stopTok.value === "=>") && out.length > 0 && !/\s$/.test(out)) {
            out += " ";
          }
          i = stopIdx;
          continue;
        }
      }

      if (brace && brace.isObject) {
        out += tok.value;
        i += 1;
        continue;
      }

      if (
        ((!brace || (!brace.isObject && !brace.isPattern)) && !paren?.isParams && inVarDecl && !inVarInit) ||
        (brace?.inClass && !paren)
      ) {
        const stopIdx = skipTypeAnnotation(tokens, i + 1, TOP_TYPE_STOP);
        const stopTok = tokens[stopIdx];
        if (stopTok && (stopTok.value === "=" || stopTok.value === "in" || stopTok.value === "of") && out.length > 0 && !/\s$/.test(out)) {
          out += " ";
        }
        i = stopIdx;
        continue;
      }

      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && (tok.value === "." || tok.value === "?.")) {
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        superCallClosed = false;
      }
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === "[") {
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        superCallClosed = false;
      }
      stack.push({ kind: "bracket" });
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === "]") {
      if (stack.length > 0 && stack[stack.length - 1].kind === "bracket") {
        stack.pop();
      }
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        superCallClosed = true;
      }
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === "(") {
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        superCallClosed = false;
      }
      const parenMeta = classifyParamParen(tokens, i, stack);
      stack.push({ kind: "paren", isParams: parenMeta.isParams, isMethodOrFunc: parenMeta.isMethodOrFunc });
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === ")") {
      if (stack.length > 0 && stack[stack.length - 1].kind === "paren") {
        const closed = stack.pop();
        lastClosedParen = { token: tok, isMethodOrFunc: closed.isMethodOrFunc };
        if (
          closed.isParams &&
          stack.length === constructorParenDepth &&
          pendingConstructorParams &&
          pendingConstructorParams.length > 0
        ) {
          injectConstructorThis = pendingConstructorParams;
          pendingConstructorParams = null;
          constructorParenDepth = -1;
        } else if (stack.length === constructorParenDepth) {
          pendingConstructorParams = null;
          constructorParenDepth = -1;
        }
      }
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        superCallClosed = true;
      }
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === "{") {
      if (pendingClassBody) {
        stack.push({ kind: "brace", isObject: false, isPattern: false, inClass: true });
        pendingClassBody = false;
        out += tok.value;
        i += 1;
        continue;
      }
      const parentBrace = currentBrace();
      const parentParen = currentParen();
      const isPattern = Boolean(
        !inImportExportClause &&
          !parentBrace?.isObject &&
          ((inVarDecl && !inVarInit && !parentParen) || parentParen?.isParams)
      );
      const isObj =
        !isPattern &&
        !inImportExportClause &&
        (!inVarDecl || inVarInit) &&
        prev &&
        prev.type === "punct" &&
        OBJ_BEFORE_PUNCT.has(prev.value);
      const isObjFromKeyword =
        !isPattern && prev && prev.type === "ident" && EXPR_START_KEYWORDS.has(prev.value);
      const braceIsObject = Boolean(isObj || isObjFromKeyword);
      stack.push({ kind: "brace", isObject: braceIsObject, isPattern, inClass: false });
      out += tok.value;
      if (injectConstructorThis && !braceIsObject) {
        const nextTokIdx = nextSigIndex(tokens, i + 1);
        if (tokens[nextTokIdx]?.value === "super") {
          waitingForSuperEnd = true;
          superBodyDepth = stack.length;
          superCallClosed = false;
        } else {
          const assignments = injectConstructorThis.map((p) => `this.${p} = ${p};`).join(" ");
          injectConstructorThis = null;
          out += ` ${assignments}`;
        }
      }
      i += 1;
      continue;
    }

    if (tok.type === "punct" && tok.value === "}") {
      if (waitingForSuperEnd && stack.length === superBodyDepth) {
        waitingForSuperEnd = false;
        superCallClosed = false;
        superBodyDepth = -1;
        if (injectConstructorThis) {
          const assignments = injectConstructorThis.map((p) => `this.${p} = ${p};`).join(" ");
          injectConstructorThis = null;
          out += `${out.trimEnd().endsWith(";") ? " " : "; "}${assignments} `;
        }
      }
      if (stack.length > 0 && stack[stack.length - 1].kind === "brace") {
        stack.pop();
      }
      inImportExportClause = false;
      out += tok.value;
      i += 1;
      continue;
    }

    if (tok.type === "ident" && (tok.value === "in" || tok.value === "of") && inVarDecl) {
      inVarDecl = false;
      inVarInit = false;
    }

    if (tok.type === "punct" && tok.value === "=") {
      if (inVarDecl && !currentParen()) {
        inVarInit = true;
      }
    }

    if (tok.type === "punct" && tok.value === ",") {
      if (inVarDecl) {
        const top = stack[stack.length - 1];
        const inDeclaratorList = !top || (top.kind === "brace" && !top.isObject && !top.isPattern && !top.inClass);
        if (inDeclaratorList) {
          inVarInit = false;
        }
      }
    }

    if (tok.type === "punct" && tok.value === ";") {
      inVarDecl = false;
      inVarInit = false;
      inImportExportClause = false;
      out += tok.value;
      if (waitingForSuperEnd && injectConstructorThis && stack.length === superBodyDepth) {
        waitingForSuperEnd = false;
        superCallClosed = false;
        superBodyDepth = -1;
        const assignments = injectConstructorThis.map((p) => `this.${p} = ${p};`).join(" ");
        injectConstructorThis = null;
        out += ` ${assignments}`;
      }
      i += 1;
      continue;
    }

    out += tok.value;
    i += 1;
  }

  return out;
}
