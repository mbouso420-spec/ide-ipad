/**
 * Calcula la similitud estructural y léxica entre dos líneas de código (0 a 1).
 * Prioriza coincidencias de asignación/declaración (LHS), llamadas a funciones, etiquetas HTML y selectores.
 * @param {string} docLine
 * @param {string} snippetLine
 * @returns {number}
 */
export function scoreLineSimilarity(docLine, snippetLine) {
  const a = String(docLine || "").trim();
  const b = String(snippetLine || "").trim();
  if (!a || !b) return 0;
  if (a === b) return 1;

  let bonus = 0;

  // 1. Coincidencia de declaración / asignación (LHS antes de = o :)
  const assignRegex = /^(?:(?:const|let|var|int|float|double|long|short|char|bool|auto|std::\w+|string|final|public|private|protected|static)\s+)?([A-Za-z_$][\w$.]*)\s*(?:[+\-*/%&|^]?=(?!=)|:(?!:))/;
  const lhsA = a.match(assignRegex);
  const lhsB = b.match(assignRegex);
  if (lhsA && lhsB && lhsA[1] === lhsB[1]) {
    bonus = Math.max(bonus, 0.68);
  }

  // 2. Coincidencia de firma de función / método / bloque de control
  const sigRegex = /^(?:(?:export|default|async|public|private|protected|static|virtual|inline|fn|func|def|function|class|struct|interface|type)\s+)*([A-Za-z_$][\w$]*)\s*\(/;
  const sigA = a.match(sigRegex);
  const sigB = b.match(sigRegex);
  if (sigA && sigB && sigA[1] === sigB[1]) {
    bonus = Math.max(bonus, 0.62);
  }

  // 3. Coincidencia de sentencia de salida / comando común (print, console.log, std::cout, printf, return)
  const stmtRegex = /^(print|console\.\w+|std::cout|std::cerr|printf|fmt\.Print\w*|println!|System\.out\.print\w*|Console\.Write\w*|return|throw|yield|#include|import|from)\b/;
  const stmtA = a.match(stmtRegex);
  const stmtB = b.match(stmtRegex);
  if (stmtA && stmtB && stmtA[1] === stmtB[1]) {
    bonus = Math.max(bonus, 0.52);
  }

  // 4. Coincidencia de etiqueta HTML de apertura/cierre
  const tagRegex = /^<([A-Za-z][A-Za-z0-9-]*)\b/;
  const tagA = a.match(tagRegex);
  const tagB = b.match(tagRegex);
  if (tagA && tagB && tagA[1].toLowerCase() === tagB[1].toLowerCase()) {
    bonus = Math.max(bonus, 0.50);
  }

  // 5. Similitud por tokens (coeficiente de Dice sobre identificadores, números y operadores)
  const tokenRegex = /[A-Za-z_$\u00C0-\u024F][A-Za-z0-9_$\u00C0-\u024F]*|\d+|[^\s\w]/g;
  const tokensA = a.match(tokenRegex) || [];
  const tokensB = b.match(tokenRegex) || [];
  if (tokensA.length === 0 || tokensB.length === 0) return bonus;

  const countsA = new Map();
  for (const t of tokensA) {
    countsA.set(t, (countsA.get(t) || 0) + 1);
  }
  let intersection = 0;
  for (const t of tokensB) {
    const c = countsA.get(t) || 0;
    if (c > 0) {
      intersection += 1;
      countsA.set(t, c - 1);
    }
  }
  const dice = (2 * intersection) / (tokensA.length + tokensB.length);
  return Math.min(1, bonus + dice * (1 - bonus * 0.65));
}

/**
 * Determina el rango exacto del documento a reemplazar cuando el usuario aplica un bloque de código
 * desde el chat de la IA sin tener texto seleccionado manualmente.
 * Si el bloque devuelto por la IA es una única línea o un fragmento parcial, localiza y reemplaza
 * únicamente la línea o bloque correspondiente preservando la indentación y el resto del archivo.
 *
 * @param {string} docText
 * @param {string} newSnippet
 * @param {{
 *   cursorLine?: number,
 *   selectionFrom?: number,
 *   selectionTo?: number,
 *   contextHint?: { precedingProse?: string, previousCodeBlock?: string } | null
 * }} [options]
 * @returns {{
 *   text: string,
 *   from: number,
 *   to: number,
 *   insertedText: string,
 *   mode: "selection" | "single-line" | "block" | "full"
 * }}
 */
function findBalancedBraceBlockEnd(lines, startIdx) {
  let depth = 0;
  let sawOpen = false;
  let quote = "";
  let inBlockComment = false;

  for (let k = startIdx; k < lines.length; k++) {
    const line = lines[k];
    if (!sawOpen && k - startIdx > 4) {
      return -1;
    }
    let inLineComment = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1] || "";
      if (inLineComment) break;
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === "/" && next === "/") {
        inLineComment = true;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        sawOpen = true;
      } else if (ch === "}" && sawOpen) {
        depth -= 1;
        if (depth === 0) {
          return k;
        }
      }
    }
    if (quote === "'" || quote === '"') quote = "";
  }
  return -1;
}

export function computeSmartReplacement(docText, newSnippet, options = {}) {
  const rawDoc = String(docText ?? "");
  const rawSnippet = String(newSnippet ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "");
  const {
    cursorLine = 1,
    selectionFrom = 0,
    selectionTo = 0,
    contextHint = null
  } = options;

  // 1. Si hay selección activa en el editor, reemplazar exclusivamente ese rango
  if (selectionFrom < selectionTo && selectionFrom >= 0 && selectionTo <= rawDoc.length) {
    const updated = rawDoc.slice(0, selectionFrom) + rawSnippet + rawDoc.slice(selectionTo);
    return {
      text: updated,
      from: selectionFrom,
      to: selectionTo,
      insertedText: rawSnippet,
      mode: "selection"
    };
  }

  const docLines = rawDoc.split("\n");
  const snippetLines = rawSnippet.split("\n");

  // 2. Documento vacío o de 1 sola línea: reemplazo directo
  if (!rawDoc.trim() || docLines.length <= 1) {
    return {
      text: rawSnippet,
      from: 0,
      to: rawDoc.length,
      insertedText: rawSnippet,
      mode: "full"
    };
  }

  // Helper para calcular desplazamientos de caracteres [from, to] de un rango de líneas [startLineIdx, endLineIdx]
  const lineRangeToOffsets = (startIdx, endIdx) => {
    let fromOffset = 0;
    for (let i = 0; i < startIdx; i++) {
      fromOffset += docLines[i].length + 1;
    }
    let toOffset = fromOffset;
    for (let i = startIdx; i <= endIdx; i++) {
      toOffset += docLines[i].length + (i < endIdx ? 1 : 0);
    }
    return { from: fromOffset, to: toOffset };
  };

  // Helper para preservar la indentación base cuando la IA envía un fragmento sin sangría
  const applyBaseIndentation = (targetLineStr, linesToInsert) => {
    const baseIndent = (targetLineStr.match(/^[ \t]*/) || [""])[0];
    if (!baseIndent || /^[ \t]/.test(linesToInsert[0])) {
      return linesToInsert.join("\n");
    }
    return linesToInsert
      .map((line) => (line.trim() ? baseIndent + line : line))
      .join("\n");
  };

  // 3. Pistas explícitas del mensaje de la IA (bloque "antes" o código inline `...` o número de línea)
  if (contextHint && typeof contextHint === "object") {
    const prevBlock = String(contextHint.previousCodeBlock || "").replace(/\r\n/g, "\n").trim();
    if (prevBlock && prevBlock.length < rawDoc.length) {
      const prevLines = prevBlock.split("\n").map((l) => l.trim()).filter(Boolean);
      if (prevLines.length > 0 && prevLines.length < docLines.length) {
        for (let i = 0; i <= docLines.length - prevLines.length; i++) {
          let allMatch = true;
          for (let j = 0; j < prevLines.length; j++) {
            if (docLines[i + j].trim() !== prevLines[j]) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            const endIdx = i + prevLines.length - 1;
            const { from, to } = lineRangeToOffsets(i, endIdx);
            const inserted = applyBaseIndentation(docLines[i], snippetLines);
            const updated = rawDoc.slice(0, from) + inserted + rawDoc.slice(to);
            return {
              text: updated,
              from,
              to,
              insertedText: inserted,
              targetLineNumber: i + 1,
              mode: snippetLines.length === 1 ? "single-line" : "block"
            };
          }
        }
      }
    }

    const prose = String(contextHint.precedingProse || "");
    if (prose && snippetLines.length <= 3) {
      // Buscar fragmentos entre backticks `...` en la explicación previa que coincidan exactamente con una línea del archivo
      const inlineMatches = [...prose.matchAll(/`([^`\n]{3,140})`/g)].map((m) => m[1].trim());
      for (const candidate of inlineMatches) {
        if (candidate === rawSnippet.trim()) continue;
        const foundIdx = docLines.findIndex((l) => l.trim() === candidate);
        if (foundIdx !== -1) {
          const { from, to } = lineRangeToOffsets(foundIdx, foundIdx);
          const inserted = applyBaseIndentation(docLines[foundIdx], snippetLines);
          const updated = rawDoc.slice(0, from) + inserted + rawDoc.slice(to);
          return {
            text: updated,
            from,
            to,
            insertedText: inserted,
            targetLineNumber: foundIdx + 1,
            mode: "single-line"
          };
        }
      }
    }
  }

  // Extraer posible número de línea mencionado en la prosa de la IA ("línea 14", "line 14")
  let hintedLineIdx = -1;
  if (contextHint?.precedingProse) {
    const lineMatch = String(contextHint.precedingProse).match(/\b(?:l[íi]nea|line)\s+(\d+)\b/i);
    if (lineMatch) {
      const parsed = parseInt(lineMatch[1], 10);
      if (parsed >= 1 && parsed <= docLines.length) {
        hintedLineIdx = parsed - 1;
      }
    }
  }

  const safeCursorIdx = Math.min(Math.max(0, (Number(cursorLine) || 1) - 1), docLines.length - 1);

  // 4. Caso Crítico: El código devuelto por la IA es UNA SOLA LÍNEA en un archivo de múltiples líneas
  if (snippetLines.length === 1) {
    const singleSnippet = snippetLines[0];
    let bestIdx = -1;
    let bestScore = -1;

    for (let i = 0; i < docLines.length; i++) {
      const candidateLine = docLines[i];
      if (!candidateLine.trim()) continue;
      let score = scoreLineSimilarity(candidateLine, singleSnippet);
      if (i === hintedLineIdx) {
        score += 0.35;
      }
      // Desempate por cercanía a la línea actual del cursor
      const distance = Math.abs(i - safeCursorIdx);
      const proximityBonus = 0.04 / (1 + distance * 0.25);
      const totalScore = score + (score >= 0.25 ? proximityBonus : 0);

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestIdx = i;
      }
    }

    const targetIdx =
      bestIdx !== -1 && bestScore >= 0.32
        ? bestIdx
        : hintedLineIdx !== -1
          ? hintedLineIdx
          : safeCursorIdx;

    const { from, to } = lineRangeToOffsets(targetIdx, targetIdx);
    const inserted = applyBaseIndentation(docLines[targetIdx], [singleSnippet]);
    const updated = rawDoc.slice(0, from) + inserted + rawDoc.slice(to);
    return {
      text: updated,
      from,
      to,
      insertedText: inserted,
      targetLineNumber: targetIdx + 1,
      mode: "single-line"
    };
  }

  // 5. Caso Bloque Parcial Multi-Línea vs Archivo Completo
  const nonEmptyDocLines = docLines.filter((l) => l.trim().length > 0).length;
  const nonEmptySnippetLines = snippetLines.filter((l) => l.trim().length > 0).length;

  // Buscar si el primer renglón del snippet ancla el inicio de una función o bloque interior del archivo
  const firstSnippetLine = snippetLines.find((l) => l.trim().length > 0) || snippetLines[0];
  const lastSnippetLine = [...snippetLines].reverse().find((l) => l.trim().length > 0) || snippetLines[snippetLines.length - 1];

  let bestStartIdx = -1;
  let bestStartScore = 0;
  for (let i = 0; i < docLines.length; i++) {
    const s = scoreLineSimilarity(docLines[i], firstSnippetLine);
    if (s > bestStartScore) {
      bestStartScore = s;
      bestStartIdx = i;
    }
  }

  if (bestStartIdx !== -1 && bestStartScore >= 0.58) {
    // Determinar fin del bloque en docLines a partir de bestStartIdx
    let matchedEndIdx = -1;
    const expectedEnd = Math.min(docLines.length - 1, bestStartIdx + snippetLines.length - 1);
    const trimmedLastSnippet = lastSnippetLine.trim();
    const closesBraceBlock = trimmedLastSnippet === "}" || trimmedLastSnippet === "};" || trimmedLastSnippet === "},";

    if (closesBraceBlock) {
      matchedEndIdx = findBalancedBraceBlockEnd(docLines, bestStartIdx);
      if (matchedEndIdx === -1) {
        const startIndent = (docLines[bestStartIdx].match(/^[ \t]*/) || [""])[0];
        for (let k = bestStartIdx + 1; k < docLines.length; k++) {
          const lineIndent = (docLines[k].match(/^[ \t]*/) || [""])[0];
          const kTrim = docLines[k].trim();
          if ((kTrim === "}" || kTrim === "};") && lineIndent === startIndent) {
            matchedEndIdx = k;
            break;
          }
        }
      }
    }

    if (matchedEndIdx === -1) {
      const searchFrom = bestStartIdx + 1;
      const searchTo = Math.min(
        docLines.length - 1,
        Math.max(expectedEnd + 24, bestStartIdx + snippetLines.length * 4 + 8)
      );
      let bestEndScore = 0;
      for (let k = searchFrom; k <= searchTo; k++) {
        const sim = scoreLineSimilarity(docLines[k], lastSnippetLine);
        if (sim <= 0) continue;
        const proximityBonus = 0.02 / (1 + Math.abs(k - expectedEnd));
        const s = sim + proximityBonus;
        if (s > bestEndScore) {
          bestEndScore = s;
          matchedEndIdx = k;
        }
      }
      if (bestEndScore < 0.45) {
        matchedEndIdx = expectedEnd;
      }
    }

    // Si el bloque encontrado es un subconjunto del archivo (no abarca de la primera a la última línea)
    if (bestStartIdx > 0 || matchedEndIdx < docLines.length - 1) {
      const { from, to } = lineRangeToOffsets(bestStartIdx, matchedEndIdx);
      const inserted = applyBaseIndentation(docLines[bestStartIdx], snippetLines);
      const updated = rawDoc.slice(0, from) + inserted + rawDoc.slice(to);
      return {
        text: updated,
        from,
        to,
        insertedText: inserted,
        mode: "block"
      };
    }
  }

  // Si el snippet es claramente un fragmento corto respecto al archivo total (incluyendo archivos cortos de < 6 líneas)
  const maxFragmentLines =
    docLines.length >= 6
      ? Math.max(4, Math.floor(nonEmptyDocLines * 0.45))
      : Math.max(1, Math.floor(nonEmptyDocLines * 0.5));
  const isSmallFragment =
    nonEmptyDocLines >= 3 &&
    nonEmptySnippetLines < nonEmptyDocLines &&
    nonEmptySnippetLines <= maxFragmentLines &&
    scoreLineSimilarity(docLines[0], firstSnippetLine) < 0.7;

  if (isSmallFragment) {
    const winLen = Math.min(snippetLines.length, docLines.length);
    let bestWinIdx = safeCursorIdx;
    let bestWinScore = -1;

    for (let i = 0; i <= docLines.length - winLen; i++) {
      let sum = 0;
      for (let j = 0; j < winLen; j++) {
        sum += scoreLineSimilarity(docLines[i + j], snippetLines[j]);
      }
      const avg = sum / winLen;
      if (avg > bestWinScore) {
        bestWinScore = avg;
        bestWinIdx = i;
      }
    }

    const startIdx = bestWinScore >= 0.32 ? bestWinIdx : safeCursorIdx;
    const endIdx = bestWinScore >= 0.32
      ? Math.min(docLines.length - 1, startIdx + winLen - 1)
      : startIdx;
    const { from, to } = lineRangeToOffsets(startIdx, endIdx);
    const inserted = applyBaseIndentation(docLines[startIdx], snippetLines);
    const updated = rawDoc.slice(0, from) + inserted + rawDoc.slice(to);
    return {
      text: updated,
      from,
      to,
      insertedText: inserted,
      mode: "block"
    };
  }

  // 6. El bloque devuelto por la IA representa el archivo completo
  return {
    text: rawSnippet,
    from: 0,
    to: rawDoc.length,
    insertedText: rawSnippet,
    mode: "full"
  };
}
