/**
 * Tokenizador léxico para TypeScript / JSX / JavaScript con utilidades de navegación de tokens.
 */

import {
  prevSigIndex,
  hasNewlineBetween,
  findMatchingDelimiter
} from "../jsTokenUtils.js";

export const EXPR_BEFORE_REGEX_KEYWORDS = new Set([
  "return",
  "throw",
  "yield",
  "await",
  "case",
  "else",
  "typeof",
  "void",
  "delete",
  "in",
  "of",
  "instanceof",
  "new",
  "export",
  "default"
]);

export const EXPR_START_KEYWORDS = new Set([
  "return",
  "throw",
  "yield",
  "await",
  "case",
  "else",
  "default",
  "export"
]);

export const MODIFIER_KEYWORDS = new Set([
  "public",
  "private",
  "protected",
  "readonly",
  "override",
  "abstract",
  "declare"
]);

export const FOUR_CHAR_OPS = new Set([">>>="]);

export const THREE_CHAR_OPS = new Set([
  "===",
  "!==",
  ">>>",
  "<<=",
  ">>=",
  "**=",
  "...",
  "&&=",
  "||=",
  "??="
]);

export const TWO_CHAR_OPS = new Set([
  "=>",
  "?.",
  "??",
  "&&",
  "||",
  "<=",
  ">=",
  "==",
  "!=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**",
  "<<",
  ">>",
  "++",
  "--",
  "::"
]);

const UNICODE_ID_START_RE = /[\p{ID_Start}$_]/u;
const UNICODE_ID_CONT_RE = /[\p{ID_Continue}$\u200c\u200d]/u;

function isIdentStartChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code <= 127) {
    return (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95 ||
      code === 36
    );
  }
  return UNICODE_ID_START_RE.test(ch);
}

function isIdentContinueChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code <= 127) {
    return (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 95 ||
      code === 36
    );
  }
  return UNICODE_ID_CONT_RE.test(ch);
}

export function canStartRegex(prevToken, prevWasProp = false) {
  if (!prevToken) return true;
  if (prevToken.type === "template_head" || prevToken.type === "template_mid") return true;
  if (prevToken.type === "ident") {
    return !prevWasProp && EXPR_BEFORE_REGEX_KEYWORDS.has(prevToken.value);
  }
  if (prevToken.type === "punct") {
    return (
      prevToken.value !== ")" &&
      prevToken.value !== "]" &&
      prevToken.value !== "}" &&
      prevToken.value !== "++" &&
      prevToken.value !== "--"
    );
  }
  return false;
}

export function tokenize(source) {
  const tokens = [];
  const len = source.length;
  let i = 0;
  let lastSig = null;
  let lastSigWasProp = false;
  const tmplBraceStack = [];

  const setLastSig = (tok, wasProp = false) => {
    lastSig = tok;
    lastSigWasProp = wasProp;
  };

  function scanTemplatePiece(isHead) {
    let val = isHead ? "`" : "}";
    i += 1;
    while (i < len) {
      const ch = source[i];
      if (ch === "\\") {
        val += ch + (source[i + 1] || "");
        i += 2;
        continue;
      }
      if (ch === "`") {
        val += "`";
        i += 1;
        const tok = { type: isHead ? "template_full" : "template_tail", value: val };
        tokens.push(tok);
        setLastSig(tok, false);
        return;
      }
      if (ch === "$" && source[i + 1] === "{") {
        val += "${";
        i += 2;
        const tok = { type: isHead ? "template_head" : "template_mid", value: val };
        tokens.push(tok);
        setLastSig(tok, false);
        tmplBraceStack.push(0);
        return;
      }
      val += ch;
      i += 1;
    }
    const tok = { type: isHead ? "template_full" : "template_tail", value: val };
    tokens.push(tok);
    setLastSig(tok, false);
  }

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1] || "";

    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < len && /\s/.test(source[j])) j += 1;
      tokens.push({ type: "ws", value: source.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < len && source[j] !== "\n") j += 1;
      tokens.push({ type: "comment", value: source.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "/" && next === "*") {
      const closeIdx = source.indexOf("*/", i + 2);
      const j = closeIdx === -1 ? len : closeIdx + 2;
      tokens.push({ type: "comment", value: source.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      const tok = { type: "string", value: source.slice(i, j) };
      tokens.push(tok);
      setLastSig(tok, false);
      i = j;
      continue;
    }

    if (ch === "`") {
      scanTemplatePiece(true);
      continue;
    }

    if (ch === "/" && canStartRegex(lastSig, lastSigWasProp)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < len && source[j] !== "\n") {
        const rc = source[j];
        if (rc === "\\") {
          j += 2;
          continue;
        }
        if (rc === "[") inClass = true;
        else if (rc === "]" && inClass) inClass = false;
        else if (rc === "/" && !inClass) {
          closed = true;
          j += 1;
          while (j < len && /[a-z]/i.test(source[j])) j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        const tok = { type: "regex", value: source.slice(i, j) };
        tokens.push(tok);
        setLastSig(tok, false);
        i = j;
        continue;
      }
    }

    if (ch === "}" && tmplBraceStack.length > 0 && tmplBraceStack[tmplBraceStack.length - 1] === 0) {
      tmplBraceStack.pop();
      scanTemplatePiece(false);
      continue;
    }

    if (tmplBraceStack.length > 0) {
      if (ch === "{") tmplBraceStack[tmplBraceStack.length - 1] += 1;
      else if (ch === "}") tmplBraceStack[tmplBraceStack.length - 1] -= 1;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next))) {
      let j = i;
      if (ch === "0" && (next === "x" || next === "X")) {
        j += 2;
        while (j < len && /[0-9a-fA-F_]/.test(source[j])) j += 1;
        if (source[j] === "n") j += 1;
      } else if (ch === "0" && (next === "b" || next === "B")) {
        j += 2;
        while (j < len && /[01_]/.test(source[j])) j += 1;
        if (source[j] === "n") j += 1;
      } else if (ch === "0" && (next === "o" || next === "O")) {
        j += 2;
        while (j < len && /[0-7_]/.test(source[j])) j += 1;
        if (source[j] === "n") j += 1;
      } else {
        let sawDot = ch === ".";
        let sawExp = false;
        j += 1;
        while (j < len && /[0-9_]/.test(source[j])) j += 1;
        if (!sawDot && source[j] === "." && !isIdentStartChar(source[j + 1] || "")) {
          sawDot = true;
          j += 1;
          while (j < len && /[0-9_]/.test(source[j])) j += 1;
        }
        if ((source[j] === "e" || source[j] === "E") && /[0-9+-]/.test(source[j + 1] || "")) {
          sawExp = true;
          j += 1;
          if (source[j] === "+" || source[j] === "-") j += 1;
          while (j < len && /[0-9_]/.test(source[j])) j += 1;
        }
        if (!sawDot && !sawExp && source[j] === "n") {
          j += 1;
        }
      }
      const tok = { type: "number", value: source.slice(i, j) };
      tokens.push(tok);
      setLastSig(tok, false);
      i = j;
      continue;
    }

    if (isIdentStartChar(ch)) {
      let j = i + 1;
      while (j < len && isIdentContinueChar(source[j])) j += 1;
      const tok = { type: "ident", value: source.slice(i, j) };
      const wasProp = Boolean(lastSig && lastSig.type === "punct" && (lastSig.value === "." || lastSig.value === "?."));
      tokens.push(tok);
      setLastSig(tok, wasProp);
      i = j;
      continue;
    }

    const quad = source.slice(i, i + 4);
    const tri = source.slice(i, i + 3);
    const duo = source.slice(i, i + 2);
    const op = FOUR_CHAR_OPS.has(quad)
      ? quad
      : THREE_CHAR_OPS.has(tri)
        ? tri
        : TWO_CHAR_OPS.has(duo)
          ? duo
          : ch;
    const tok = { type: "punct", value: op };
    tokens.push(tok);
    setLastSig(tok, false);
    i += op.length;
  }

  return tokens;
}

export function prevSigToken(tokens, idx) {
  const prevIdx = prevSigIndex(tokens, idx);
  return prevIdx >= 0 ? tokens[prevIdx] : null;
}

export function findTopBrace(stack) {
  for (let s = stack.length - 1; s >= 0; s -= 1) {
    if (stack[s].kind === "brace") return stack[s];
  }
  return null;
}

export function angleCloseCount(tok) {
  if (!tok || tok.type !== "punct") return 0;
  if (tok.value === ">") return 1;
  if (tok.value === ">>") return 2;
  if (tok.value === ">>>") return 3;
  return 0;
}

export function hasNewlineBeforeToken(tokens, idx) {
  const prevIdx = prevSigIndex(tokens, idx);
  return hasNewlineBetween(tokens, prevIdx + 1, idx);
}

export function skipBalancedPair(tokens, startIdx, openChar, closeChar) {
  if (openChar !== "<" || closeChar !== ">") {
    return Math.min(tokens.length, findMatchingDelimiter(tokens, startIdx, openChar, closeChar) + 1);
  }
  let depth = 0;
  let k = startIdx;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "punct" && t.value === openChar) {
      depth += 1;
    } else {
      const closeCount = angleCloseCount(t);
      if (closeCount > 0) {
        depth -= closeCount;
        if (depth <= 0) return k + 1;
      }
    }
    k += 1;
  }
  return k;
}

/**
 * Expone el tokenizador léxico con desplazamientos exactos `[start, end)` en el fuente original
 * para análisis de módulos ES (import/export) sin interferir con strings, regex o comentarios.
 *
 * @param {string} source
 * @returns {Array<{ type: string, value: string, start: number, end: number }>}
 */
export function tokenizeJsWithOffsets(source) {
  const src = String(source ?? "");
  const tokens = tokenize(src);
  let pos = 0;
  for (const tok of tokens) {
    tok.start = pos;
    pos += tok.value.length;
    tok.end = pos;
  }
  return tokens;
}
