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

export function findMatchingDelimiter(tokens, openIdx, openChar = "{", closeChar = "}") {
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
