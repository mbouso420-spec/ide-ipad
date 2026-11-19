/**
 * Reescritura de módulos ES a llamadas `__studioRequire` / `__studioExport` con soporte de live bindings.
 */

import { tokenizeJsWithOffsets } from "../tsTranspiler.js";
import {
  skipTrivia,
  prevSigIndex as prevNonTriviaIndex,
  findMatchingDelimiter as findMatchingBrace
} from "../jsTokenUtils.js";
import {
  unquoteStringToken,
  canStartTopLevelKeyword,
  consumeImportAttributesAndSemi,
  isAsiBoundary,
  findStatementEndOffset,
  parseNamedSpecifiers,
  parseImportClause,
  traverseBindingPattern,
  parseVarDeclBindingsAndEnd
} from "./moduleAstScanner.js";

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

function collectPatternInfo(tokens, startIdx, namesOut, nonRefOut) {
  return traverseBindingPattern(tokens, startIdx, namesOut, nonRefOut);
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
      if (t.type === "template_tail" || t.type === "template_mid") {
        break;
      }
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

  const tryWrapDestructuringAssignment = (patStart, assignEndIdx, wrapStartOffset) => {
    const targetNames = [];
    const targetTokenIdxs = new Set();
    traverseBindingPattern(tokens, patStart, targetNames, targetTokenIdxs);
    if (targetTokenIdxs.size === 0) return false;
    // Descartar declaraciones (const/let/var), parámetros y defaults internos de otro destructuring ya procesado
    for (const idx of targetTokenIdxs) {
      if (nonRefTokens.has(idx)) return false;
    }
    if (!targetNames.some((name) => liveExportNames.has(name) && !isShadowed(name))) {
      return false;
    }
    const rhsEnd = findAssignRhsEndOffset(tokens, assignEndIdx + 1, code.length);
    splices.push({ pos: wrapStartOffset, text: "__studioSync(", isStart: true });
    splices.push({ pos: rhsEnd, text: ")", isStart: false });
    for (const idx of targetTokenIdxs) {
      nonRefTokens.add(idx);
    }
    return true;
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
        } else if (!nonRefTokens.has(i)) {
          // Métodos computados/privados/clave string/generadores en clases u objetos: `[k](x, [a] = [1]) { ... }`
          const afterPIsBlock = afterP < tokens.length && tokens[afterP].type === "punct" && tokens[afterP].value === "{";
          const allowedBeforeBlock =
            prev &&
            prev.type === "ident" &&
            (prev.value === "if" ||
              prev.value === "while" ||
              prev.value === "with" ||
              prev.value === "for" ||
              prev.value === "switch");
          const isMethodHeader =
            afterPIsBlock && !allowedBeforeBlock && (curFrame.kind === "class" || curFrame.kind === "obj");
          if (isMethodHeader) {
            const pNames = collectParamNamesAndNonRefs(tokens, i, closeP, nonRefTokens);
            scopes.push({ kind: "paren", parenDepth: paren, shadows: new Set(pNames) });
            const closeB = findMatchingBrace(tokens, afterP);
            const hoists = collectFunctionHoists(tokens, afterP, closeB);
            attachScopeAtBrace.set(afterP, { kind: "fn", shadows: new Set([...pNames, ...hoists]) });
          } else {
            // Destructuring de asignación entre paréntesis: `({ count } = obj)` o `([count] = arr)`
            const innerStart = skipTrivia(tokens, i + 1);
            if (
              innerStart < closeP &&
              tokens[innerStart].type === "punct" &&
              (tokens[innerStart].value === "{" || tokens[innerStart].value === "[")
            ) {
              const closePat = findMatchingBrace(
                tokens,
                innerStart,
                tokens[innerStart].value,
                tokens[innerStart].value === "{" ? "}" : "]"
              );
              const eqIdx = skipTrivia(tokens, closePat + 1);
              if (eqIdx < closeP && tokens[eqIdx].type === "punct" && tokens[eqIdx].value === "=") {
                tryWrapDestructuringAssignment(innerStart, eqIdx, tokens[innerStart].start);
              }
            }
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
        // Destructuring de asignación por arreglo: `[count, b] = [1, 2]`
        if (
          !nonRefTokens.has(i) &&
          (!prev ||
            prev.type !== "ident" ||
            LIVE_NON_DECL_PREV.has(prev.value) ||
            prev.value === "else" ||
            prev.value === "do") &&
          (!prev || (prev.value !== "." && prev.value !== "?." && prev.value !== ")" && prev.value !== "]"))
        ) {
          const closeBracket = findMatchingBrace(tokens, i, "[", "]");
          const eqIdx = skipTrivia(tokens, closeBracket + 1);
          if (eqIdx < tokens.length && tokens[eqIdx].type === "punct" && tokens[eqIdx].value === "=") {
            tryWrapDestructuringAssignment(i, eqIdx, t.start);
          }
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
          } else if (
            scan < closeP &&
            !(tokens[scan].type === "ident" && tokens[scan].value === "var")
          ) {
            // Bucle `for (exportedLet of iterable) { ... }` o `for (exportedLet in obj) { ... }`
            const lhsNames = [];
            const lhsEnd = traverseBindingPattern(tokens, scan, lhsNames, null);
            const opIdx = skipTrivia(tokens, lhsEnd);
            if (
              opIdx < closeP &&
              tokens[opIdx].type === "ident" &&
              (tokens[opIdx].value === "of" || tokens[opIdx].value === "in") &&
              lhsNames.some((name) => liveExportNames.has(name) && !isShadowed(name))
            ) {
              const afterP = skipTrivia(tokens, closeP + 1);
              if (afterP < tokens.length && tokens[afterP].type === "punct" && tokens[afterP].value === "{") {
                splices.push({ pos: tokens[afterP].end, text: " __studioNotify(exports);", isStart: false });
              }
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
          splices.push({ pos: prev.start, text: "__studioSync(", isStart: true });
          splices.push({ pos: t.end, text: ")", isStart: false });
        } else if (nextTok && (nextTok.value === "++" || nextTok.value === "--") && !isAsiBoundary(tokens, i, n1Idx)) {
          splices.push({ pos: t.start, text: "__studioSync(", isStart: true });
          splices.push({ pos: nextTok.end, text: ")", isStart: false });
        } else if (nextTok && LIVE_ASSIGN_OPS.has(nextTok.value)) {
          const rhsEnd = findAssignRhsEndOffset(tokens, n1Idx + 1, code.length);
          splices.push({ pos: t.start, text: "__studioSync(", isStart: true });
          splices.push({ pos: rhsEnd, text: ")", isStart: false });
        }
      }
    }

    prevSig = i;
  }

  if (splices.length === 0) {
    return code;
  }
  splices.sort((a, b) => a.pos - b.pos || (a.isStart === b.isStart ? 0 : a.isStart ? 1 : -1));
  const chunks = [];
  let cursor = 0;
  for (const sp of splices) {
    if (sp.pos > cursor) {
      chunks.push(code.slice(cursor, sp.pos));
    }
    chunks.push(sp.text);
    cursor = sp.pos;
  }
  if (cursor < code.length) {
    chunks.push(code.slice(cursor));
  }
  return `const __studioSync = function(__v) { __studioNotify(exports); return __v; };\n${chunks.join("")}`;
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
                tokens[beforeOpen].value === "*" ||
                tokens[beforeOpen].value === "]")
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
      conciseArrowStack.length === 0 &&
      (prevSig < 0 || tokens[prevSig].value !== ".")
    ) {
      const n1 = skipTrivia(tokens, i + 1);
      if (n1 >= tokens.length || tokens[n1].value !== ":") {
        hasTopLevelAwait = true;
      }
    }

    // Dynamic `import("./local" [, { with: ... }])` y `import.meta` a cualquier profundidad
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
        const afterArg = skipTrivia(tokens, argIdx + 1);
        const closeP = findMatchingBrace(tokens, n1, "(", ")");
        if (
          argIdx < tokens.length &&
          tokens[argIdx].type === "string" &&
          afterArg < tokens.length &&
          tokens[afterArg].type === "punct" &&
          (tokens[afterArg].value === ")" || tokens[afterArg].value === ",") &&
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

  // Aplicar reemplazos en orden ascendente en O(N + E log E)
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  const bodyChunks = [];
  let bodyCursor = 0;
  for (const edit of edits) {
    if (edit.start < bodyCursor) continue;
    if (edit.start > bodyCursor) {
      bodyChunks.push(source.slice(bodyCursor, edit.start));
    }
    bodyChunks.push(edit.text);
    bodyCursor = edit.end;
  }
  if (bodyCursor < source.length) {
    bodyChunks.push(source.slice(bodyCursor));
  }
  const body = bodyChunks.join("");
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
