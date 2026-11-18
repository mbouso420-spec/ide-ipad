/**
 * Utilidades compartidas de navegación sobre streams de tokens JS/TS
 * para evitar duplicación y búsquedas O(T²) en tsTranspiler y moduleBundler.
 */

export function skipTrivia(tokens, idx) {
  let j = idx;
  while (j < tokens.length && (tokens[j].type === "ws" || tokens[j].type === "comment")) {
    j += 1;
  }
  return j;
}

export function nextSigIndex(tokens, idx) {
  return skipTrivia(tokens, idx);
}

export function prevSigIndex(tokens, idx) {
  let j = idx - 1;
  while (j >= 0 && (tokens[j].type === "ws" || tokens[j].type === "comment")) {
    j -= 1;
  }
  return j;
}

export function hasNewlineBetween(tokens, fromIdx, toIdx) {
  const start = Math.max(0, fromIdx);
  const end = Math.min(tokens.length, toIdx);
  for (let k = start; k < end; k += 1) {
    const val = tokens[k]?.value;
    if (val && (val.includes("\n") || val.includes("\r"))) {
      return true;
    }
  }
  return false;
}

const PAIR_MAP_CACHE = new WeakMap();
const STANDARD_CLOSE_BY_OPEN = { "{": "}", "(": ")", "[": "]" };

export function findMatchingDelimiter(tokens, openIdx, openChar = "{", closeChar = "}") {
  if (
    tokens &&
    tokens.length >= 64 &&
    openIdx >= 0 &&
    openIdx < tokens.length &&
    STANDARD_CLOSE_BY_OPEN[openChar] === closeChar &&
    tokens[openIdx]?.type === "punct" &&
    tokens[openIdx].value === openChar
  ) {
    let pairs = PAIR_MAP_CACHE.get(tokens);
    if (!pairs || pairs.length !== tokens.length) {
      pairs = buildBracketPairMap(tokens);
      PAIR_MAP_CACHE.set(tokens, pairs);
    }
    const paired = pairs[openIdx];
    return paired >= openIdx ? paired : Math.max(0, tokens.length - 1);
  }

  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === "punct" && t.value === openChar) {
      depth += 1;
    } else if (t.type === "punct" && t.value === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return Math.max(0, tokens.length - 1);
}

/**
 * Precalcula en O(T) los índices pareados de `( )`, `[ ]` y `{ }` para saltos O(1).
 * @param {Array<{ type: string, value: string }>} tokens
 * @returns {Int32Array}
 */
export function buildBracketPairMap(tokens) {
  const len = tokens ? tokens.length : 0;
  const pairs = new Int32Array(len);
  pairs.fill(-1);
  const parenStack = [];
  const bracketStack = [];
  const braceStack = [];

  for (let i = 0; i < len; i += 1) {
    const t = tokens[i];
    if (!t || t.type !== "punct") continue;
    const v = t.value;
    if (v === "(") {
      parenStack.push(i);
    } else if (v === ")" && parenStack.length > 0) {
      const openIdx = parenStack.pop();
      pairs[openIdx] = i;
      pairs[i] = openIdx;
    } else if (v === "[") {
      bracketStack.push(i);
    } else if (v === "]" && bracketStack.length > 0) {
      const openIdx = bracketStack.pop();
      pairs[openIdx] = i;
      pairs[i] = openIdx;
    } else if (v === "{") {
      braceStack.push(i);
    } else if (v === "}" && braceStack.length > 0) {
      const openIdx = braceStack.pop();
      pairs[openIdx] = i;
      pairs[i] = openIdx;
    }
  }
  return pairs;
}
