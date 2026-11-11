import { inferFileMeta } from "../storage/workspaceDb.js";
import { createMinimapController } from "./minimap.js";

const PREF_KEYS = {
  wordWrap: "ide.editor.wordWrap",
  fontSize: "ide.editor.fontSize",
  hardwareKeyboard: "ide.editor.hardwareKeyboard"
};

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 22;
const DEFAULT_FONT_SIZE = 14;

/**
 * Construye los atributos DOM de la superficie editable para desactivar corrección automática,
 * capitalización, sugerencias de iPadOS y suprimir el teclado virtual en pantalla cuando se usa teclado físico.
 * @param {boolean} hardwareKeyboard
 * @returns {Record<string, string>}
 */
export function buildContentAttributes(hardwareKeyboard = true) {
  return {
    autocorrect: "off",
    autocapitalize: "off",
    spellcheck: "false",
    autocomplete: "off",
    writingsuggestions: "false",
    enterkeyhint: "enter",
    inputmode: hardwareKeyboard ? "none" : "text"
  };
}

/**
 * Aplica los atributos de teclado físico / táctil a un elemento DOM editable y a los controles auxiliares del IDE.
 * @param {boolean} hardwareKeyboard
 * @param {HTMLElement|null} [targetEl]
 */
export function applyHardwareKeyboardAttributes(hardwareKeyboard, targetEl = null) {
  const attrs = buildContentAttributes(hardwareKeyboard);
  if (targetEl && typeof targetEl.setAttribute === "function") {
    for (const [k, v] of Object.entries(attrs)) {
      targetEl.setAttribute(k, v);
    }
  }
  if (typeof document !== "undefined" && document.body) {
    if (document.body.dataset) {
      document.body.dataset.hardwareKeyboard = String(Boolean(hardwareKeyboard));
    }
    const auxIds = ["chat-prompt-input", "quick-open-input", "global-search-input", "gh-commit-msg"];
    for (const id of auxIds) {
      const el = document.getElementById(id);
      if (el && typeof el.setAttribute === "function") {
        for (const [k, v] of Object.entries(attrs)) {
          el.setAttribute(k, v);
        }
      }
    }
  }
}

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
    const searchFrom = Math.max(bestStartIdx + 1, expectedEnd - 6);
    const searchTo = Math.min(docLines.length - 1, expectedEnd + 8);

    // Si el bloque abre llaves { ... }, podemos buscar la línea de cierre balanceada con misma sangría
    const startIndent = (docLines[bestStartIdx].match(/^[ \t]*/) || [""])[0];
    if (lastSnippetLine.trim() === "}" || lastSnippetLine.trim() === "};") {
      for (let k = bestStartIdx + 1; k <= searchTo; k++) {
        const lineIndent = (docLines[k].match(/^[ \t]*/) || [""])[0];
        if ((docLines[k].trim() === "}" || docLines[k].trim() === "};") && lineIndent === startIndent) {
          matchedEndIdx = k;
          break;
        }
      }
    }

    if (matchedEndIdx === -1) {
      let bestEndScore = 0;
      for (let k = searchFrom; k <= searchTo; k++) {
        const s = scoreLineSimilarity(docLines[k], lastSnippetLine);
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

  // Si el snippet es claramente un fragmento corto respecto al archivo total (ej. 2 a 6 líneas en un archivo grande)
  const isSmallFragment =
    docLines.length >= 6 &&
    nonEmptySnippetLines <= Math.max(4, Math.floor(nonEmptyDocLines * 0.45)) &&
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

/**
 * Devuelve la cantidad de espacios de indentación inteligente según el lenguaje:
 * 4 espacios para Python, C, C++ y SQL; 2 espacios para HTML, CSS y JavaScript.
 * @param {string} lang
 * @returns {number}
 */
export function getIndentSize(lang) {
  return lang === "python" || lang === "cpp" || lang === "c" || lang === "sql" || lang === "rust" || lang === "go" || lang === "java" || lang === "csharp" ? 4 : 2;
}

/**
 * Envuelve un texto seleccionado entre delimitadores de apertura y cierre
 * calculados a partir de la longitud del texto y la distancia de retroceso del cursor.
 * @param {string} text
 * @param {string} selectedText
 * @param {number} cursorBack
 * @returns {{ text: string, selectFrom: number, selectTo: number }}
 */
export function wrapTextWithDelimiters(text, selectedText, cursorBack) {
  const openDelim = text.slice(0, text.length - cursorBack);
  const closeDelim = text.slice(text.length - cursorBack);
  return {
    text: `${openDelim}${selectedText}${closeDelim}`,
    selectFrom: openDelim.length,
    selectTo: openDelim.length + selectedText.length
  };
}

/**
 * Diccionario de vocabulario y funciones estándar por lenguaje para autocompletado instantáneo.
 */
export const LANGUAGE_COMPLETIONS = {
  c: [
    { label: "printf", detail: "stdio.h · imprimir con formato", type: "function" },
    { label: "fprintf", detail: "stdio.h · imprimir en stream", type: "function" },
    { label: "sprintf", detail: "stdio.h · formatear en cadena", type: "function" },
    { label: "snprintf", detail: "stdio.h · formatear seguro con límite", type: "function" },
    { label: "scanf", detail: "stdio.h · leer entrada con formato", type: "function" },
    { label: "fscanf", detail: "stdio.h · leer desde archivo", type: "function" },
    { label: "sscanf", detail: "stdio.h · leer desde cadena", type: "function" },
    { label: "putchar", detail: "stdio.h · escribir carácter", type: "function" },
    { label: "getchar", detail: "stdio.h · leer carácter", type: "function" },
    { label: "puts", detail: "stdio.h · imprimir línea", type: "function" },
    { label: "fgets", detail: "stdio.h · leer línea segura", type: "function" },
    { label: "fopen", detail: "stdio.h · abrir archivo", type: "function" },
    { label: "fclose", detail: "stdio.h · cerrar archivo", type: "function" },
    { label: "fread", detail: "stdio.h · leer bloque binario", type: "function" },
    { label: "fwrite", detail: "stdio.h · escribir bloque binario", type: "function" },
    { label: "fseek", detail: "stdio.h · mover puntero de archivo", type: "function" },
    { label: "ftell", detail: "stdio.h · posición actual en archivo", type: "function" },
    { label: "fflush", detail: "stdio.h · vaciar buffer de salida", type: "function" },
    { label: "malloc", detail: "stdlib.h · reservar memoria dinámica", type: "function" },
    { label: "calloc", detail: "stdlib.h · reservar e inicializar en cero", type: "function" },
    { label: "realloc", detail: "stdlib.h · redimensionar memoria", type: "function" },
    { label: "free", detail: "stdlib.h · liberar memoria dinámica", type: "function" },
    { label: "memcpy", detail: "string.h · copiar bloque de memoria", type: "function" },
    { label: "memmove", detail: "string.h · mover bloque de memoria", type: "function" },
    { label: "memset", detail: "string.h · rellenar bloque de memoria", type: "function" },
    { label: "memcmp", detail: "string.h · comparar bloques de memoria", type: "function" },
    { label: "strlen", detail: "string.h · longitud de cadena", type: "function" },
    { label: "strcpy", detail: "string.h · copiar cadena", type: "function" },
    { label: "strncpy", detail: "string.h · copiar cadena con límite", type: "function" },
    { label: "strcat", detail: "string.h · concatenar cadena", type: "function" },
    { label: "strncat", detail: "string.h · concatenar con límite", type: "function" },
    { label: "strcmp", detail: "string.h · comparar cadenas", type: "function" },
    { label: "strncmp", detail: "string.h · comparar n caracteres", type: "function" },
    { label: "strchr", detail: "string.h · buscar carácter en cadena", type: "function" },
    { label: "strstr", detail: "string.h · buscar subcadena", type: "function" },
    { label: "atoi", detail: "stdlib.h · convertir cadena a int", type: "function" },
    { label: "atof", detail: "stdlib.h · convertir cadena a double", type: "function" },
    { label: "strtol", detail: "stdlib.h · convertir cadena a long", type: "function" },
    { label: "qsort", detail: "stdlib.h · ordenar arreglo (quicksort)", type: "function" },
    { label: "bsearch", detail: "stdlib.h · búsqueda binaria", type: "function" },
    { label: "exit", detail: "stdlib.h · terminar programa", type: "function" },
    { label: "abort", detail: "stdlib.h · abortar ejecución", type: "function" },
    { label: "assert", detail: "assert.h · verificar condición", type: "function" },
    { label: "sizeof", detail: "operador C · tamaño en bytes", type: "keyword" },
    { label: "typedef", detail: "palabra clave · alias de tipo", type: "keyword" },
    { label: "struct", detail: "palabra clave · estructura de datos", type: "keyword" },
    { label: "union", detail: "palabra clave · unión de datos", type: "keyword" },
    { label: "enum", detail: "palabra clave · enumeración", type: "keyword" },
    { label: "return", detail: "palabra clave · retornar valor", type: "keyword" },
    { label: "switch", detail: "palabra clave · selección múltiple", type: "keyword" },
    { label: "case", detail: "palabra clave · rama de switch", type: "keyword" },
    { label: "default", detail: "palabra clave · caso por defecto", type: "keyword" },
    { label: "break", detail: "palabra clave · salir de bloque/bucle", type: "keyword" },
    { label: "continue", detail: "palabra clave · siguiente iteración", type: "keyword" },
    { label: "while", detail: "palabra clave · bucle condicional", type: "keyword" },
    { label: "for", detail: "palabra clave · bucle iterativo", type: "keyword" },
    { label: "static", detail: "palabra clave · alcance estático", type: "keyword" },
    { label: "extern", detail: "palabra clave · símbolo externo", type: "keyword" },
    { label: "const", detail: "palabra clave · valor constante", type: "keyword" },
    { label: "volatile", detail: "palabra clave · variable volátil", type: "keyword" },
    { label: "unsigned", detail: "tipo C · entero sin signo", type: "type" },
    { label: "signed", detail: "tipo C · entero con signo", type: "type" },
    { label: "int", detail: "tipo C · entero", type: "type" },
    { label: "char", detail: "tipo C · carácter / byte", type: "type" },
    { label: "float", detail: "tipo C · punto flotante simple", type: "type" },
    { label: "double", detail: "tipo C · punto flotante doble", type: "type" },
    { label: "void", detail: "tipo C · sin valor / puntero genérico", type: "type" },
    { label: "bool", detail: "stdbool.h · booleano", type: "type" },
    { label: "size_t", detail: "stddef.h · tamaño sin signo", type: "type" },
    { label: "uint8_t", detail: "stdint.h · entero 8 bits sin signo", type: "type" },
    { label: "uint16_t", detail: "stdint.h · entero 16 bits sin signo", type: "type" },
    { label: "uint32_t", detail: "stdint.h · entero 32 bits sin signo", type: "type" },
    { label: "uint64_t", detail: "stdint.h · entero 64 bits sin signo", type: "type" },
    { label: "int32_t", detail: "stdint.h · entero 32 bits con signo", type: "type" },
    { label: "int64_t", detail: "stdint.h · entero 64 bits con signo", type: "type" },
    { label: "NULL", detail: "stddef.h · puntero nulo", type: "constant" },
    { label: "EOF", detail: "stdio.h · fin de archivo", type: "constant" },
    { label: "stdin", detail: "stdio.h · entrada estándar", type: "constant" },
    { label: "stdout", detail: "stdio.h · salida estándar", type: "constant" },
    { label: "stderr", detail: "stdio.h · salida de error", type: "constant" },
    { label: "#include <stdio.h>", detail: "directiva · entrada/salida estándar", type: "keyword" },
    { label: "#include <stdlib.h>", detail: "directiva · memoria y utilidades", type: "keyword" },
    { label: "#include <string.h>", detail: "directiva · funciones de cadenas", type: "keyword" },
    { label: "#include <stdbool.h>", detail: "directiva · tipo bool", type: "keyword" },
    { label: "#include <math.h>", detail: "directiva · funciones matemáticas", type: "keyword" },
    { label: "#define", detail: "directiva · definir macro", type: "keyword" }
  ],
  cpp: [
    { label: "std::cout", detail: "iostream · flujo de salida estándar", type: "variable" },
    { label: "std::cin", detail: "iostream · flujo de entrada estándar", type: "variable" },
    { label: "std::endl", detail: "iostream · salto de línea y flush", type: "function" },
    { label: "std::cerr", detail: "iostream · salida de errores", type: "variable" },
    { label: "std::string", detail: "string · cadena dinámica C++", type: "type" },
    { label: "std::vector", detail: "vector · arreglo dinámico STL", type: "type" },
    { label: "std::map", detail: "map · diccionario ordenado STL", type: "type" },
    { label: "std::unordered_map", detail: "unordered_map · tabla hash STL", type: "type" },
    { label: "std::set", detail: "set · conjunto ordenado STL", type: "type" },
    { label: "std::pair", detail: "utility · par de valores", type: "type" },
    { label: "std::unique_ptr", detail: "memory · puntero único inteligente", type: "type" },
    { label: "std::shared_ptr", detail: "memory · puntero compartido", type: "type" },
    { label: "std::make_unique", detail: "memory · construir unique_ptr", type: "function" },
    { label: "std::make_shared", detail: "memory · construir shared_ptr", type: "function" },
    { label: "std::sort", detail: "algorithm · ordenar rango", type: "function" },
    { label: "std::find", detail: "algorithm · buscar en rango", type: "function" },
    { label: "std::max", detail: "algorithm · valor máximo", type: "function" },
    { label: "std::min", detail: "algorithm · valor mínimo", type: "function" },
    { label: "std::move", detail: "utility · semántica de movimiento", type: "function" },
    { label: "push_back", detail: "STL · agregar elemento al final", type: "function" },
    { label: "emplace_back", detail: "STL · construir elemento al final", type: "function" },
    { label: "pop_back", detail: "STL · quitar último elemento", type: "function" },
    { label: "namespace", detail: "C++ · espacio de nombres", type: "keyword" },
    { label: "using namespace std;", detail: "C++ · importar espacio std", type: "keyword" },
    { label: "template", detail: "C++ · plantilla genérica", type: "keyword" },
    { label: "typename", detail: "C++ · parámetro de tipo", type: "keyword" },
    { label: "class", detail: "C++ · declaración de clase", type: "keyword" },
    { label: "public", detail: "C++ · acceso público", type: "keyword" },
    { label: "private", detail: "C++ · acceso privado", type: "keyword" },
    { label: "protected", detail: "C++ · acceso protegido", type: "keyword" },
    { label: "virtual", detail: "C++ · método polimórfico", type: "keyword" },
    { label: "override", detail: "C++ · sobrescribir método virtual", type: "keyword" },
    { label: "constexpr", detail: "C++ · evaluación en compilación", type: "keyword" },
    { label: "nullptr", detail: "C++ · puntero nulo tipado", type: "constant" },
    { label: "auto", detail: "C++ · deducción automática de tipo", type: "keyword" },
    { label: "#include <iostream>", detail: "directiva · entrada/salida C++", type: "keyword" },
    { label: "#include <vector>", detail: "directiva · contenedor std::vector", type: "keyword" },
    { label: "#include <string>", detail: "directiva · cadena std::string", type: "keyword" },
    { label: "#include <algorithm>", detail: "directiva · algoritmos STL", type: "keyword" }
  ],
  python: [
    { label: "print", detail: "built-in · mostrar en consola", type: "function" },
    { label: "input", detail: "built-in · leer línea del usuario", type: "function" },
    { label: "range", detail: "built-in · secuencia numérica", type: "function" },
    { label: "len", detail: "built-in · longitud de colección", type: "function" },
    { label: "enumerate", detail: "built-in · iterar con índice y valor", type: "function" },
    { label: "zip", detail: "built-in · combinar iterables", type: "function" },
    { label: "sorted", detail: "built-in · devolver lista ordenada", type: "function" },
    { label: "isinstance", detail: "built-in · comprobar tipo de objeto", type: "function" },
    { label: "sum", detail: "built-in · sumar elementos", type: "function" },
    { label: "min", detail: "built-in · valor mínimo", type: "function" },
    { label: "max", detail: "built-in · valor máximo", type: "function" },
    { label: "abs", detail: "built-in · valor absoluto", type: "function" },
    { label: "round", detail: "built-in · redondear número", type: "function" },
    { label: "open", detail: "built-in · abrir archivo", type: "function" },
    { label: "list", detail: "tipo · lista mutable", type: "type" },
    { label: "dict", detail: "tipo · diccionario clave-valor", type: "type" },
    { label: "set", detail: "tipo · conjunto único", type: "type" },
    { label: "tuple", detail: "tipo · tupla inmutable", type: "type" },
    { label: "int", detail: "tipo · entero", type: "type" },
    { label: "float", detail: "tipo · punto flotante", type: "type" },
    { label: "str", detail: "tipo · cadena de texto", type: "type" },
    { label: "bool", detail: "tipo · booleano", type: "type" },
    { label: "def", detail: "palabra clave · definir función", type: "keyword" },
    { label: "return", detail: "palabra clave · devolver resultado", type: "keyword" },
    { label: "class", detail: "palabra clave · definir clase", type: "keyword" },
    { label: "import", detail: "palabra clave · importar módulo", type: "keyword" },
    { label: "from", detail: "palabra clave · importar desde módulo", type: "keyword" },
    { label: "elif", detail: "palabra clave · condición alternativa", type: "keyword" },
    { label: "else", detail: "palabra clave · rama sino", type: "keyword" },
    { label: "while", detail: "palabra clave · bucle condicional", type: "keyword" },
    { label: "for", detail: "palabra clave · bucle sobre iterable", type: "keyword" },
    { label: "break", detail: "palabra clave · terminar bucle", type: "keyword" },
    { label: "continue", detail: "palabra clave · saltar iteración", type: "keyword" },
    { label: "pass", detail: "palabra clave · bloque vacío", type: "keyword" },
    { label: "try", detail: "palabra clave · capturar excepciones", type: "keyword" },
    { label: "except", detail: "palabra clave · manejar excepción", type: "keyword" },
    { label: "finally", detail: "palabra clave · bloque de cierre", type: "keyword" },
    { label: "raise", detail: "palabra clave · lanzar excepción", type: "keyword" },
    { label: "with", detail: "palabra clave · gestor de contexto", type: "keyword" },
    { label: "lambda", detail: "palabra clave · función anónima", type: "keyword" },
    { label: "yield", detail: "palabra clave · generador", type: "keyword" },
    { label: "async", detail: "palabra clave · corrutina asíncrona", type: "keyword" },
    { label: "await", detail: "palabra clave · esperar corrutina", type: "keyword" },
    { label: "True", detail: "constante · verdadero", type: "constant" },
    { label: "False", detail: "constante · falso", type: "constant" },
    { label: "None", detail: "constante · valor nulo", type: "constant" },
    { label: "__init__", detail: "método · constructor de clase", type: "function" },
    { label: "append", detail: "list · agregar al final", type: "function" },
    { label: "split", detail: "str · dividir en lista", type: "function" },
    { label: "join", detail: "str · unir iterable en cadena", type: "function" },
    { label: "strip", detail: "str · quitar espacios extremos", type: "function" },
    { label: "replace", detail: "str · reemplazar subcadena", type: "function" }
  ],
  js: [
    { label: "console.log", detail: "consola · imprimir mensaje", type: "function" },
    { label: "console.error", detail: "consola · imprimir error", type: "function" },
    { label: "console.warn", detail: "consola · imprimir advertencia", type: "function" },
    { label: "function", detail: "JS · declarar función", type: "keyword" },
    { label: "const", detail: "JS · constante de bloque", type: "keyword" },
    { label: "let", detail: "JS · variable de bloque", type: "keyword" },
    { label: "return", detail: "JS · retornar valor", type: "keyword" },
    { label: "async", detail: "JS · función asíncrona", type: "keyword" },
    { label: "await", detail: "JS · esperar promesa", type: "keyword" },
    { label: "Promise", detail: "JS · operación asíncrona", type: "type" },
    { label: "fetch", detail: "Web API · petición HTTP", type: "function" },
    { label: "setTimeout", detail: "Web API · temporizador diferido", type: "function" },
    { label: "clearTimeout", detail: "Web API · cancelar temporizador", type: "function" },
    { label: "setInterval", detail: "Web API · intervalo periódico", type: "function" },
    { label: "requestAnimationFrame", detail: "Web API · cuadro de animación", type: "function" },
    { label: "document.getElementById", detail: "DOM · buscar elemento por ID", type: "function" },
    { label: "document.querySelector", detail: "DOM · buscar primer selector CSS", type: "function" },
    { label: "document.querySelectorAll", detail: "DOM · buscar todos por selector", type: "function" },
    { label: "document.createElement", detail: "DOM · crear nodo HTML", type: "function" },
    { label: "addEventListener", detail: "DOM · escuchar evento", type: "function" },
    { label: "removeEventListener", detail: "DOM · quitar oyente de evento", type: "function" },
    { label: "JSON.stringify", detail: "JSON · serializar objeto a texto", type: "function" },
    { label: "JSON.parse", detail: "JSON · convertir texto a objeto", type: "function" },
    { label: "Object.keys", detail: "Object · arreglo de claves", type: "function" },
    { label: "Object.values", detail: "Object · arreglo de valores", type: "function" },
    { label: "Object.entries", detail: "Object · pares [clave, valor]", type: "function" },
    { label: "Array.isArray", detail: "Array · verificar si es arreglo", type: "function" },
    { label: "Array.from", detail: "Array · crear desde iterable", type: "function" },
    { label: "forEach", detail: "Array · recorrer elementos", type: "function" },
    { label: "map", detail: "Array · transformar elementos", type: "function" },
    { label: "filter", detail: "Array · filtrar elementos", type: "function" },
    { label: "reduce", detail: "Array · acumular en un valor", type: "function" },
    { label: "find", detail: "Array · buscar primer coincidente", type: "function" },
    { label: "includes", detail: "Array/String · comprobar existencia", type: "function" },
    { label: "export", detail: "ESM · exportar módulo", type: "keyword" },
    { label: "import", detail: "ESM · importar módulo", type: "keyword" },
    { label: "default", detail: "JS · exportación/rama por defecto", type: "keyword" },
    { label: "class", detail: "JS · declarar clase", type: "keyword" },
    { label: "constructor", detail: "JS · inicializador de instancia", type: "function" },
    { label: "extends", detail: "JS · heredar de clase", type: "keyword" },
    { label: "typeof", detail: "JS · consultar tipo primitivo", type: "keyword" },
    { label: "instanceof", detail: "JS · verificar prototipo", type: "keyword" },
    { label: "try", detail: "JS · bloque seguro", type: "keyword" },
    { label: "catch", detail: "JS · capturar error", type: "keyword" },
    { label: "finally", detail: "JS · ejecutar siempre al final", type: "keyword" },
    { label: "throw", detail: "JS · lanzar excepción", type: "keyword" },
    { label: "switch", detail: "JS · condicional múltiple", type: "keyword" }
  ],
  ts: [
    { label: "interface", detail: "TS · contrato de tipo", type: "keyword" },
    { label: "type", detail: "TS · alias de tipo", type: "keyword" },
    { label: "readonly", detail: "TS · propiedad inmutable", type: "keyword" },
    { label: "implements", detail: "TS · implementar interfaz", type: "keyword" },
    { label: "private", detail: "TS · miembro privado", type: "keyword" },
    { label: "public", detail: "TS · miembro público", type: "keyword" },
    { label: "protected", detail: "TS · miembro protegido", type: "keyword" },
    { label: "unknown", detail: "TS · tipo seguro desconocido", type: "type" },
    { label: "never", detail: "TS · tipo sin retorno", type: "type" },
    { label: "Record", detail: "TS · mapa tipado Record<K, V>", type: "type" },
    { label: "Partial", detail: "TS · propiedades opcionales", type: "type" }
  ],
  html: [
    { label: "<!DOCTYPE html>", detail: "HTML5 · declaración de documento", type: "keyword" },
    { label: "header", detail: "HTML · encabezado semántico", type: "tag" },
    { label: "nav", detail: "HTML · barra de navegación", type: "tag" },
    { label: "main", detail: "HTML · contenido principal", type: "tag" },
    { label: "section", detail: "HTML · sección temática", type: "tag" },
    { label: "article", detail: "HTML · artículo independiente", type: "tag" },
    { label: "aside", detail: "HTML · panel complementario", type: "tag" },
    { label: "footer", detail: "HTML · pie de página", type: "tag" },
    { label: "button", detail: "HTML · botón interactivo", type: "tag" },
    { label: "input", detail: "HTML · campo de entrada", type: "tag" },
    { label: "textarea", detail: "HTML · área de texto multilínea", type: "tag" },
    { label: "select", detail: "HTML · lista desplegable", type: "tag" },
    { label: "option", detail: "HTML · opción de lista", type: "tag" },
    { label: "dialog", detail: "HTML · ventana modal nativa", type: "tag" },
    { label: "canvas", detail: "HTML · lienzo gráfico 2D/WebGL", type: "tag" },
    { label: "script", detail: "HTML · bloque o módulo JS", type: "tag" },
    { label: "stylesheet", detail: "HTML · hoja de estilos", type: "constant" },
    { label: "placeholder", detail: "atributo · texto de ayuda", type: "property" },
    { label: "aria-label", detail: "accesibilidad · etiqueta lectora", type: "property" }
  ],
  css: [
    { label: "display", detail: "CSS · modelo de caja (flex, grid…)", type: "property" },
    { label: "position", detail: "CSS · posicionamiento", type: "property" },
    { label: "justify-content", detail: "Flex/Grid · alineación eje principal", type: "property" },
    { label: "align-items", detail: "Flex/Grid · alineación eje transversal", type: "property" },
    { label: "flex-direction", detail: "Flex · dirección de fila o columna", type: "property" },
    { label: "grid-template-columns", detail: "Grid · definición de columnas", type: "property" },
    { label: "background-color", detail: "CSS · color de fondo", type: "property" },
    { label: "border-radius", detail: "CSS · redondeo de esquinas", type: "property" },
    { label: "box-shadow", detail: "CSS · sombra de contenedor", type: "property" },
    { label: "transition", detail: "CSS · transición animada", type: "property" },
    { label: "transform", detail: "CSS · transformación geométrica", type: "property" },
    { label: "overflow", detail: "CSS · control de desborde", type: "property" },
    { label: "font-family", detail: "CSS · familia tipográfica", type: "property" },
    { label: "font-size", detail: "CSS · tamaño de fuente", type: "property" },
    { label: "font-weight", detail: "CSS · grosor de fuente", type: "property" },
    { label: "line-height", detail: "CSS · altura de línea", type: "property" },
    { label: "pointer-events", detail: "CSS · interacción de puntero", type: "property" },
    { label: "user-select", detail: "CSS · selección de texto", type: "property" },
    { label: "minmax", detail: "CSS Grid · rango mínimo y máximo", type: "function" },
    { label: "clamp", detail: "CSS · valor fluido acotado", type: "function" },
    { label: "@media", detail: "CSS · consulta de medios responsiva", type: "keyword" }
  ],
  sql: [
    { label: "SELECT", detail: "SQL · consultar columnas", type: "keyword" },
    { label: "FROM", detail: "SQL · tabla de origen", type: "keyword" },
    { label: "WHERE", detail: "SQL · filtrar filas", type: "keyword" },
    { label: "INSERT INTO", detail: "SQL · insertar registros", type: "keyword" },
    { label: "VALUES", detail: "SQL · valores a insertar", type: "keyword" },
    { label: "UPDATE", detail: "SQL · actualizar registros", type: "keyword" },
    { label: "DELETE FROM", detail: "SQL · eliminar registros", type: "keyword" },
    { label: "CREATE TABLE", detail: "SQL · crear tabla", type: "keyword" },
    { label: "ALTER TABLE", detail: "SQL · modificar estructura", type: "keyword" },
    { label: "DROP TABLE", detail: "SQL · eliminar tabla", type: "keyword" },
    { label: "PRIMARY KEY", detail: "SQL · clave primaria", type: "keyword" },
    { label: "FOREIGN KEY", detail: "SQL · clave foránea", type: "keyword" },
    { label: "REFERENCES", detail: "SQL · tabla referenciada", type: "keyword" },
    { label: "AUTOINCREMENT", detail: "SQLite · incremento automático", type: "keyword" },
    { label: "INNER JOIN", detail: "SQL · unión interna", type: "keyword" },
    { label: "LEFT JOIN", detail: "SQL · unión izquierda", type: "keyword" },
    { label: "GROUP BY", detail: "SQL · agrupar resultados", type: "keyword" },
    { label: "HAVING", detail: "SQL · filtrar grupos", type: "keyword" },
    { label: "ORDER BY", detail: "SQL · ordenar filas", type: "keyword" },
    { label: "LIMIT", detail: "SQL · cantidad máxima de filas", type: "keyword" },
    { label: "OFFSET", detail: "SQL · desplazamiento de paginación", type: "keyword" },
    { label: "DISTINCT", detail: "SQL · valores sin duplicados", type: "keyword" },
    { label: "COUNT", detail: "SQL · contar registros", type: "function" },
    { label: "COALESCE", detail: "SQL · primer valor no nulo", type: "function" },
    { label: "INTEGER", detail: "SQL · tipo entero", type: "type" },
    { label: "VARCHAR", detail: "SQL · texto longitud variable", type: "type" }
  ],
  rust: [
    { label: "println!", detail: "macro Rust · imprimir con salto", type: "function" },
    { label: "eprintln!", detail: "macro Rust · imprimir en stderr", type: "function" },
    { label: "format!", detail: "macro Rust · formatear String", type: "function" },
    { label: "vec!", detail: "macro Rust · inicializar vector", type: "function" },
    { label: "struct", detail: "Rust · definir estructura", type: "keyword" },
    { label: "enum", detail: "Rust · tipo algebraico", type: "keyword" },
    { label: "impl", detail: "Rust · bloque de implementación", type: "keyword" },
    { label: "trait", detail: "Rust · interfaz de comportamiento", type: "keyword" },
    { label: "match", detail: "Rust · coincidencia de patrones", type: "keyword" },
    { label: "Option", detail: "std · valor opcional Some/None", type: "type" },
    { label: "Result", detail: "std · resultado Ok/Err", type: "type" },
    { label: "String", detail: "std · cadena en heap", type: "type" },
    { label: "Vec", detail: "std · vector dinámico", type: "type" },
    { label: "unwrap", detail: "Result/Option · extraer valor", type: "function" },
    { label: "expect", detail: "Result/Option · extraer con mensaje", type: "function" },
    { label: "return", detail: "Rust · retornar valor", type: "keyword" }
  ],
  go: [
    { label: "fmt.Println", detail: "fmt · imprimir línea", type: "function" },
    { label: "fmt.Printf", detail: "fmt · imprimir con formato", type: "function" },
    { label: "fmt.Sprintf", detail: "fmt · formatear cadena", type: "function" },
    { label: "package", detail: "Go · declarar paquete", type: "keyword" },
    { label: "import", detail: "Go · importar paquetes", type: "keyword" },
    { label: "func", detail: "Go · declarar función", type: "keyword" },
    { label: "return", detail: "Go · retornar valores", type: "keyword" },
    { label: "struct", detail: "Go · definir estructura", type: "keyword" },
    { label: "interface", detail: "Go · definir interfaz", type: "keyword" },
    { label: "defer", detail: "Go · posponer hasta el cierre", type: "keyword" },
    { label: "range", detail: "Go · iterar colección", type: "keyword" },
    { label: "append", detail: "built-in · agregar a slice", type: "function" },
    { label: "make", detail: "built-in · inicializar slice/map/chan", type: "function" }
  ],
  java: [
    { label: "System.out.println", detail: "Java · imprimir línea en consola", type: "function" },
    { label: "System.out.printf", detail: "Java · imprimir con formato", type: "function" },
    { label: "public", detail: "Java · visibilidad pública", type: "keyword" },
    { label: "private", detail: "Java · visibilidad privada", type: "keyword" },
    { label: "protected", detail: "Java · visibilidad protegida", type: "keyword" },
    { label: "class", detail: "Java · declarar clase", type: "keyword" },
    { label: "interface", detail: "Java · declarar interfaz", type: "keyword" },
    { label: "extends", detail: "Java · heredar de clase", type: "keyword" },
    { label: "implements", detail: "Java · implementar interfaz", type: "keyword" },
    { label: "static", detail: "Java · miembro de clase", type: "keyword" },
    { label: "final", detail: "Java · constante / no sobrescribible", type: "keyword" },
    { label: "return", detail: "Java · retornar valor", type: "keyword" },
    { label: "String", detail: "java.lang · cadena de texto", type: "type" },
    { label: "ArrayList", detail: "java.util · lista dinámica", type: "type" },
    { label: "HashMap", detail: "java.util · mapa hash", type: "type" }
  ],
  csharp: [
    { label: "Console.WriteLine", detail: "System · imprimir línea", type: "function" },
    { label: "Console.Write", detail: "System · imprimir sin salto", type: "function" },
    { label: "namespace", detail: "C# · espacio de nombres", type: "keyword" },
    { label: "using", detail: "C# · directiva o bloque de recurso", type: "keyword" },
    { label: "public", detail: "C# · acceso público", type: "keyword" },
    { label: "private", detail: "C# · acceso privado", type: "keyword" },
    { label: "class", detail: "C# · declarar clase", type: "keyword" },
    { label: "interface", detail: "C# · declarar interfaz", type: "keyword" },
    { label: "async", detail: "C# · método asíncrono", type: "keyword" },
    { label: "await", detail: "C# · esperar Task", type: "keyword" },
    { label: "return", detail: "C# · retornar valor", type: "keyword" },
    { label: "List", detail: "Collections.Generic · lista tipada", type: "type" },
    { label: "Dictionary", detail: "Collections.Generic · diccionario", type: "type" }
  ]
};

/**
 * Extrae el fragmento de palabra o directiva inmediatamente anterior a la posición del cursor.
 * @param {string} docText
 * @param {number} cursorOffset
 * @returns {{ word: string, from: number, to: number }}
 */
export function extractWordBeforeCursor(docText, cursorOffset) {
  const safeDoc = String(docText ?? "");
  const pos = Math.min(Math.max(0, Number(cursorOffset) || 0), safeDoc.length);
  // Si el carácter inmediatamente posterior al cursor es alfanumérico, no estamos al final de la palabra
  if (pos < safeDoc.length && /[A-Za-z0-9_]/.test(safeDoc[pos])) {
    return { word: "", from: pos, to: pos };
  }
  const before = safeDoc.slice(0, pos);
  const match = before.match(/(#?[A-Za-z_][A-Za-z0-9_:.!-]*)$/);
  if (!match) {
    return { word: "", from: pos, to: pos };
  }
  const word = match[1];
  return {
    word,
    from: pos - word.length,
    to: pos
  };
}

/**
 * Distancia de edición Damerau-Levenshtein acotada para detectar similitud en prefijos de 3+ letras.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function computeEditDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

/**
 * Calcula un puntaje de coincidencia (0 a 100) entre lo que el usuario está escribiendo (query)
 * y una palabra candidata del lenguaje o del archivo.
 * Soporta prefijos exactos (`prin` -> `printf`), miembros (`cout` -> `std::cout`),
 * subcadenas (`prin` -> `fprintf`) y similitud difusa de 3+ letras (`prinf` -> `printf`).
 *
 * @param {string} query
 * @param {string} candidateLabel
 * @returns {number}
 */
export function scoreCompletionMatch(query, candidateLabel) {
  const q = String(query || "").trim().toLowerCase();
  const c = String(candidateLabel || "").trim().toLowerCase();
  if (!q || !c || q === c) return 0;

  // 1. Coincidencia exacta de prefijo (ej: "prin" -> "printf")
  if (c.startsWith(q)) {
    return 100 - Math.min(25, c.length - q.length);
  }

  // 2. Coincidencia sin el "#" inicial o tras "::", ".", " " o "<" (ej: "inc" -> "#include <stdio.h>", "cout" -> "std::cout")
  const stripped = c.replace(/^#/, "");
  if (stripped.startsWith(q)) {
    return 92 - Math.min(25, stripped.length - q.length);
  }

  const segments = c.split(/(?:::|\.|\s+|<|>)/).filter(Boolean);
  for (const seg of segments) {
    if (seg !== q && seg.startsWith(q)) {
      return 86 - Math.min(20, seg.length - q.length);
    }
  }

  // 3. Coincidencia de subcadena directa con 2+ letras (ej: "prin" dentro de "fprintf" o "sprintf")
  if (q.length >= 2) {
    const idx = c.indexOf(q);
    if (idx !== -1) {
      return 74 - Math.min(18, idx * 2) - Math.min(15, c.length - q.length);
    }
  }

  // 4. A partir de 3 letras: subsecuencia en orden o similitud por distancia de edición (typos)
  if (q.length >= 3) {
    const targetWord = segments[segments.length - 1] || stripped;
    if (targetWord[0] === q[0]) {
      // 4a. Subsecuencia ordenada con la misma inicial (ej: "prtf" -> "printf", "scnf" -> "scanf")
      let qi = 0;
      for (let ci = 0; ci < targetWord.length && qi < q.length; ci++) {
        if (targetWord[ci] === q[qi]) qi++;
      }
      if (qi === q.length) {
        return 62 - Math.min(20, targetWord.length - q.length);
      }

      // 4b. Similitud con el prefijo o palabra completa (ej: "prinf" -> "printf", "retrun" -> "return")
      const prefixSlice = targetWord.slice(0, Math.min(targetWord.length, q.length + 1));
      const distPrefix = computeEditDistance(q, prefixSlice);
      const distFull = computeEditDistance(q, targetWord);
      const bestDist = Math.min(distPrefix, distFull);
      const maxAllowed = q.length >= 5 ? 2 : 1;
      if (bestDist <= maxAllowed) {
        return 54 - bestDist * 10 - Math.min(12, Math.abs(targetWord.length - q.length));
      }
    }
  }

  return 0;
}

/**
 * Obtiene la lista ordenada de sugerencias de autocompletado para el lenguaje activo y el documento actual.
 * En C++ incluye tanto el vocabulario de C++ como las funciones estándar de C (`printf`, `scanf`, etc.).
 *
 * @param {string} lang
 * @param {string} query
 * @param {string} [docText=""]
 * @param {number} [limit=8]
 * @returns {Array<{ label: string, apply: string, detail: string, type: string, score: number }>}
 */
export function getLanguageCompletions(lang, query, docText = "", limit = 8) {
  const cleanQuery = String(query || "").trim();
  if (cleanQuery.length < 2) return [];

  const normalizedLang =
    lang === "tsx" || lang === "typescript" ? "ts"
    : lang || "js";

  const pool = [];
  if (LANGUAGE_COMPLETIONS[normalizedLang]) {
    pool.push(...LANGUAGE_COMPLETIONS[normalizedLang]);
  }
  if (normalizedLang === "cpp" && LANGUAGE_COMPLETIONS.c) {
    pool.push(...LANGUAGE_COMPLETIONS.c);
  }
  if (normalizedLang === "ts" && LANGUAGE_COMPLETIONS.js) {
    pool.push(...LANGUAGE_COMPLETIONS.js);
  }

  const seen = new Set();
  const scored = [];

  for (const item of pool) {
    if (seen.has(item.label)) continue;
    const score = scoreCompletionMatch(cleanQuery, item.label);
    if (score > 0) {
      seen.add(item.label);
      scored.push({
        label: item.label,
        apply: item.label,
        detail: item.detail || "",
        type: item.type || "keyword",
        score: score + 5 // Prioridad leve para palabras estándar del lenguaje
      });
    }
  }

  // Extraer también identificadores definidos por el usuario en el archivo actual
  if (docText && typeof docText === "string") {
    const matches = docText.match(/[A-Za-z_][A-Za-z0-9_]{2,50}/g) || [];
    for (const word of matches) {
      if (seen.has(word) || word === cleanQuery) continue;
      const score = scoreCompletionMatch(cleanQuery, word);
      if (score > 0) {
        seen.add(word);
        scored.push({
          label: word,
          apply: word,
          detail: "en este archivo",
          type: "variable",
          score
        });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length || a.label.localeCompare(b.label));
  return scored.slice(0, Math.max(1, limit));
}

/**
 * Controlador visual de la barra inferior de sugerencias en vivo (`#editor-autocomplete-bar`),
 * que muestra opciones para elegir con un toque o con Tab mientras el usuario escribe.
 */
function createAutocompleteBarController({ mountEl, onAccept }) {
  let barEl = typeof document !== "undefined" ? document.getElementById("editor-autocomplete-bar") : null;
  let trackEl = typeof document !== "undefined" ? document.getElementById("editor-autocomplete-track") : null;
  let createdLocally = false;

  if (!barEl && mountEl && typeof document !== "undefined") {
    barEl = document.createElement("div");
    barEl.className = "editor-autocomplete-bar";
    barEl.setAttribute("role", "region");
    barEl.setAttribute("aria-label", "Sugerencias de autocompletado");
    barEl.hidden = true;

    const hintEl = document.createElement("span");
    hintEl.className = "editor-autocomplete-hint";
    hintEl.textContent = "Sugerencias";

    trackEl = document.createElement("div");
    trackEl.className = "editor-autocomplete-track";

    barEl.append(hintEl, trackEl);
    const parent = mountEl.parentElement || mountEl;
    parent.appendChild(barEl);
    createdLocally = true;
  }

  let currentItems = [];
  let selectedIndex = 0;
  let currentWordRange = { word: "", from: 0, to: 0 };

  function update(items, wordRange) {
    currentItems = Array.isArray(items) ? items : [];
    currentWordRange = wordRange || { word: "", from: 0, to: 0 };
    selectedIndex = 0;

    if (!barEl || !trackEl) return;

    if (currentItems.length === 0) {
      barEl.hidden = true;
      trackEl.innerHTML = "";
      return;
    }

    barEl.hidden = false;
    renderPills();
  }

  function renderPills() {
    if (!trackEl) return;
    trackEl.innerHTML = "";
    currentItems.slice(0, 6).forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = idx === selectedIndex
        ? "editor-autocomplete-pill is-selected"
        : "editor-autocomplete-pill";
      btn.setAttribute("aria-label", `Autocompletar ${item.label}`);
      btn.title = item.detail ? `${item.label} (${item.detail})` : item.label;

      const labelSpan = document.createElement("span");
      labelSpan.className = "editor-autocomplete-label code-font";
      labelSpan.textContent = item.label;
      btn.appendChild(labelSpan);

      if (item.detail) {
        const detailSpan = document.createElement("span");
        detailSpan.className = "editor-autocomplete-detail";
        detailSpan.textContent = item.detail.split("·")[0].trim();
        btn.appendChild(detailSpan);
      }

      if (idx === selectedIndex) {
        const kbd = document.createElement("kbd");
        kbd.className = "editor-autocomplete-kbd";
        kbd.textContent = "Tab";
        btn.appendChild(kbd);
      }

      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        onAccept(item, currentWordRange);
      });

      trackEl.appendChild(btn);
    });
  }

  function hide() {
    currentItems = [];
    selectedIndex = 0;
    if (barEl) barEl.hidden = true;
    if (trackEl) trackEl.innerHTML = "";
  }

  function moveSelection(delta) {
    if (currentItems.length === 0) return false;
    const max = Math.min(6, currentItems.length);
    selectedIndex = (selectedIndex + delta + max) % max;
    renderPills();
    return true;
  }

  function acceptCurrent() {
    if (currentItems.length === 0) return false;
    const chosen = currentItems[selectedIndex] || currentItems[0];
    if (!chosen) return false;
    onAccept(chosen, currentWordRange);
    return true;
  }

  return {
    update,
    hide,
    moveSelection,
    acceptCurrent,
    isOpen: () => currentItems.length > 0,
    getItems: () => [...currentItems],
    destroy() {
      hide();
      if (createdLocally && barEl?.parentElement) {
        barEl.remove();
      }
    }
  };
}

/**
 * Gestor del motor de código principal basado en CodeMirror 6 vía ES Modules,
 * con caché de estado (historial Undo/Redo y cursor por archivo), indentación inteligente,
 * controles táctiles y respaldo resiliente si no hay red en la primera carga.
 *
 * @param {{
 *   mountEl: HTMLElement,
 *   onDocChange: (fileId: string, content: string) => void,
 *   onSelectionChange: (selection: { text: string, lineCount: number }) => void
 * }} config
 */
export async function createEditorManager({ mountEl, onDocChange, onSelectionChange, enableMinimap = true }) {
  let wordWrap = readStoredBool(PREF_KEYS.wordWrap, true);
  let fontSize = clampFontSize(Number(readStoredValue(PREF_KEYS.fontSize)) || DEFAULT_FONT_SIZE);
  let hardwareKeyboard = readStoredBool(PREF_KEYS.hardwareKeyboard, true);
  let activeFileId = null;

  applyFontSize(fontSize);
  applyHardwareKeyboardAttributes(hardwareKeyboard);

  let cm = null;
  try {
    cm = await loadCodeMirrorModules();
  } catch (error) {
    console.warn("CodeMirror 6 no pudo cargarse desde la red; activando superficie local de respaldo.", error);
  }

  if (!cm) {
    return createFallbackEditor({
      mountEl,
      initialWrap: wordWrap,
      initialFontSize: fontSize,
      initialHardwareKeyboard: hardwareKeyboard,
      onDocChange,
      onSelectionChange,
      enableMinimap
    });
  }

  const {
    EditorState,
    Compartment,
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    highlightActiveLineGutter,
    drawSelection,
    syntaxHighlighting,
    HighlightStyle,
    foldGutter,
    foldKeymap,
    bracketMatching,
    indentOnInput,
    indentUnit,
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
    undo,
    redo,
    search,
    searchKeymap,
    openSearchPanel,
    autocompletion,
    completionKeymap,
    completeAnyWord,
    acceptCompletion,
    closeBrackets,
    closeBracketsKeymap,
    tags,
    langs,
    StateEffect,
    StateField,
    Decoration
  } = cm;

  const wrapCompartment = new Compartment();
  const contentAttrsCompartment = new Compartment();
  const statesByFile = new Map();

  const buildCmContentAttrsExtension = (hwKb) =>
    EditorView.contentAttributes && typeof EditorView.contentAttributes.of === "function"
      ? EditorView.contentAttributes.of(buildContentAttributes(hwKb))
      : [];

  const minimap = enableMinimap
    ? createMinimapController({
        mountEl: mountEl.parentElement || mountEl,
        getDocLines: () => {
          if (view?.state?.doc) {
            const doc = view.state.doc;
            const lines = [];
            for (let i = 1; i <= doc.lines; i++) {
              lines.push(doc.line(i).text);
            }
            return lines;
          }
          return [];
        },
        getViewport: () => {
          const scroller = view?.scrollDOM;
          if (scroller) {
            return {
              top: scroller.scrollTop,
              height: scroller.clientHeight,
              totalHeight: scroller.scrollHeight
            };
          }
          return { top: 0, height: 100, totalHeight: 100 };
        },
        onScrollToRatio: (ratio) => {
          const scroller = view?.scrollDOM;
          if (scroller) {
            scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
          }
        }
      })
    : null;

  // Marcadores de error de sintaxis / compilación (GCC / Clang / Linters)
  const addErrorEffect = StateEffect?.define ? StateEffect.define() : null;
  const clearErrorEffect = StateEffect?.define ? StateEffect.define() : null;

  const errorLineDeco = (msg) =>
    Decoration?.line
      ? Decoration.line({
          attributes: {
            class: "cm-error-line",
            title: msg || "Error de compilación"
          }
        })
      : null;

  const errorMarkerField =
    StateField?.define && addErrorEffect && Decoration?.line
      ? StateField.define({
          create() {
            return Decoration.none;
          },
          update(underlying, tr) {
            let markers = underlying.map(tr.changes);
            for (const effect of tr.effects) {
              if (effect.is(addErrorEffect)) {
                const { lineNum, errorMessage } = effect.value;
                const totalLines = tr.state.doc.lines;
                const targetLine = Math.min(Math.max(1, lineNum), totalLines);
                const lineObj = tr.state.doc.line(targetLine);
                const deco = errorLineDeco(errorMessage);
                if (deco) {
                  markers = markers.update({
                    add: [deco.range(lineObj.from)]
                  });
                }
              } else if (effect.is(clearErrorEffect)) {
                markers = Decoration.none;
              }
            }
            return markers;
          },
          provide: (f) => EditorView.decorations.from(f)
        })
      : null;

  let activeErrorMarkers = [];

  // Tema sintáctico acoplado 100% a nuestros tokens CSS (:root)
  const highlightRules = [
    { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.moduleKeyword], color: "var(--syn-keyword)", fontWeight: "500" },
    { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syn-type)" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syn-fn)" },
    { tag: [tags.string, tags.special(tags.string)], color: "var(--syn-string)" },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--syn-number)" },
    { tag: [tags.operator, tags.punctuation], color: "var(--syn-operator)" },
    { tag: [tags.tagName], color: "var(--syn-tag)" },
    { tag: [tags.attributeName, tags.propertyName], color: "var(--syn-attr)" },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--syn-comment)", fontStyle: "italic" }
  ];
  if (tags.heading) {
    highlightRules.push({ tag: [tags.heading], color: "var(--syn-keyword)", fontWeight: "600" });
  }
  if (tags.strong) {
    highlightRules.push({ tag: [tags.strong], color: "var(--color-ink)", fontWeight: "600" });
  }
  if (tags.emphasis) {
    highlightRules.push({ tag: [tags.emphasis], fontStyle: "italic" });
  }
  if (tags.link) {
    highlightRules.push({ tag: [tags.link], color: "var(--syn-attr)" });
  }
  if (tags.monospace) {
    highlightRules.push({ tag: [tags.monospace], color: "var(--syn-string)" });
  }
  const studioHighlightStyle = HighlightStyle.define(highlightRules);

  const studioBaseTheme = EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--color-editor-bg)",
        color: "var(--color-ink)"
      },
      ".cm-content": {
        caretColor: "var(--color-accent-text)",
        paddingBlock: "var(--space-sm)"
      },
      ".cm-gutters": {
        backgroundColor: "var(--color-editor-gutter)",
        color: "var(--color-gutter-ink)",
        borderRight: "var(--rule-hair) solid var(--color-rule)"
      },
      ".cm-matchingBracket": {
        backgroundColor: "var(--color-accent-soft)",
        outline: "1px solid var(--color-rule-strong)"
      }
    },
    { dark: true }
  );

  let view = null;
  let isSyncingExternal = false;
  let activeLang = "js";

  const autocompleteBar = createAutocompleteBarController({
    mountEl,
    onAccept(item, wordRange) {
      if (!view) return;
      const docLen = view.state.doc.length;
      const from = Math.min(Math.max(0, wordRange.from), docLen);
      const to = Math.min(Math.max(from, wordRange.to), docLen);
      const insertText = item.apply || item.label;
      view.dispatch({
        changes: { from, to, insert: insertText },
        selection: { anchor: from + insertText.length },
        scrollIntoView: true
      });
      autocompleteBar.hide();
      view.focus();
    }
  });

  function refreshAutocompleteBar(state) {
    if (!state) {
      autocompleteBar.hide();
      return;
    }
    const main = state.selection.main;
    if (!main.empty) {
      autocompleteBar.hide();
      return;
    }
    const docText = state.doc.toString();
    const wordRange = extractWordBeforeCursor(docText, main.head);
    if (!wordRange.word || wordRange.word.length < 2) {
      autocompleteBar.hide();
      return;
    }
    const suggestions = getLanguageCompletions(activeLang, wordRange.word, docText, 6);
    autocompleteBar.update(suggestions, wordRange);
  }

  function createCmCompletionSource(lang) {
    return (context) => {
      const docText = context.state.doc.toString();
      const wordRange = extractWordBeforeCursor(docText, context.pos);
      if (!wordRange.word || (wordRange.word.length < 2 && !context.explicit)) {
        return null;
      }
      const items = getLanguageCompletions(lang, wordRange.word, docText, 12);
      if (items.length === 0) {
        return null;
      }
      return {
        from: wordRange.from,
        to: wordRange.to,
        filter: false,
        options: items.map((it, idx) => ({
          label: it.label,
          apply: it.apply,
          detail: it.detail ? ` ${it.detail}` : "",
          type: it.type,
          boost: 50 - idx
        }))
      };
    };
  }

  function resolveLanguageExtension(lang) {
    switch (lang) {
      case "python":
        return langs.python ? langs.python() : [];
      case "markdown":
        return langs.markdown ? langs.markdown() : [];
      case "text":
        return [];
      case "json":
        return langs.json ? langs.json() : langs.javascript();
      case "rust":
      case "go":
      case "java":
      case "csharp":
      case "cpp":
      case "c":
        return langs.cpp ? langs.cpp() : [];
      case "html":
        return langs.html ? langs.html() : [];
      case "css":
        return langs.css ? langs.css() : [];
      case "sql":
        return langs.sql ? langs.sql() : [];
      case "ts":
      case "tsx":
        return langs.javascript ? langs.javascript({ typescript: true, jsx: true }) : [];
      case "js":
      default:
        return langs.javascript ? langs.javascript() : [];
    }
  }

  function buildEditorState(file) {
    const spaces = getIndentSize(file.lang);
    const indentStr = " ".repeat(spaces);

    return EditorState.create({
      doc: file.content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        foldGutter(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({
          activateOnTyping: true,
          icons: false,
          override: [createCmCompletionSource(file.lang), completeAnyWord].filter(Boolean)
        }),
        history(),
        search({ top: true }),
        EditorState.tabSize.of(spaces),
        indentUnit.of(indentStr),
        wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
        contentAttrsCompartment.of(buildCmContentAttrsExtension(hardwareKeyboard)),
        resolveLanguageExtension(file.lang),
        syntaxHighlighting(studioHighlightStyle),
        studioBaseTheme,
        ...(errorMarkerField ? [errorMarkerField] : []),
        keymap.of([
          {
            key: "Tab",
            run(v) {
              if (typeof acceptCompletion === "function" && acceptCompletion(v)) {
                autocompleteBar.hide();
                return true;
              }
              if (autocompleteBar.isOpen() && autocompleteBar.acceptCurrent()) {
                return true;
              }
              return false;
            }
          },
          {
            key: "Escape",
            run() {
              if (autocompleteBar.isOpen()) {
                autocompleteBar.hide();
                return true;
              }
              return false;
            }
          },
          ...completionKeymap,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && activeFileId && !isSyncingExternal) {
            onDocChange(activeFileId, update.state.doc.toString());
            minimap?.render();
            refreshAutocompleteBar(update.state);
          } else if (update.docChanged && isSyncingExternal) {
            minimap?.render();
            autocompleteBar.hide();
          } else if (update.selectionSet && !update.docChanged) {
            autocompleteBar.hide();
          }
          if (update.selectionSet || update.docChanged) {
            emitSelection(update.state);
          }
        })
      ]
    });
  }

  function emitSelection(state) {
    const main = state.selection.main;
    const headLine = state.doc.lineAt(main.head);
    const cursorLine = headLine.number;
    const cursorCol = main.head - headLine.from + 1;

    if (main.empty) {
      onSelectionChange({ text: "", lineCount: 0, cursorLine, cursorCol });
      return;
    }
    const selectedText = state.sliceDoc(main.from, main.to);
    const fromLine = state.doc.lineAt(main.from).number;
    const toLine = state.doc.lineAt(main.to).number;
    onSelectionChange({
      text: selectedText,
      lineCount: Math.max(1, toLine - fromLine + 1),
      cursorLine,
      cursorCol
    });
  }

  function openFile(file) {
    if (!file || file.isBinary || file.encoding === "base64") {
      return;
    }
    if (view && activeFileId) {
      statesByFile.set(activeFileId, view.state);
    }

    activeFileId = file.id;
    activeLang = file.lang || inferFileMeta(file.id).lang || "js";
    autocompleteBar.hide();
    let nextState = statesByFile.get(file.id);

    if (!nextState) {
      nextState = buildEditorState(file);
      statesByFile.set(file.id, nextState);
    } else {
      // Sincronizar Word Wrap y atributos de teclado físico actual al recuperar estado en caché
      nextState = nextState.update({
        effects: [
          wrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : []),
          contentAttrsCompartment.reconfigure(buildCmContentAttrsExtension(hardwareKeyboard))
        ]
      }).state;
    }

    if (!view) {
      mountEl.innerHTML = "";
      view = new EditorView({
        state: nextState,
        parent: mountEl
      });
      if (view.scrollDOM) {
        view.scrollDOM.addEventListener("scroll", () => {
          minimap?.updateSlider();
        }, { passive: true });
      }
    } else {
      view.setState(nextState);
    }

    if (view?.contentDOM) {
      applyHardwareKeyboardAttributes(hardwareKeyboard, view.contentDOM);
    }

    minimap?.render();
    minimap?.updateSlider();
    emitSelection(view.state);
  }

  function purgeViewDocument() {
    if (!view) return;
    try {
      // Reemplaza el documento por un estado neutro de 0 bytes para liberar AST de Lezer y buffers en RAM
      const emptyState = EditorState.create({ doc: "", extensions: [] });
      view.setState(emptyState);
    } catch (_) {
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
      } catch (_) {}
    }
  }

  function clearActiveFile() {
    activeFileId = null;
    autocompleteBar.hide();
    clearErrorMarkers();
    purgeViewDocument();
    onSelectionChange({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
  }

  function dropFileState(fileId) {
    statesByFile.delete(fileId);
    if (activeFileId === fileId) {
      activeFileId = null;
      clearErrorMarkers();
      purgeViewDocument();
      onSelectionChange({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
    }
  }

  function renameFileStates(oldPath, newPath, isFolder) {
    if (view && activeFileId) {
      statesByFile.set(activeFileId, view.state);
    }

    const updates = [];
    for (const [key, stateVal] of statesByFile.entries()) {
      if (key === oldPath) {
        updates.push([key, newPath, stateVal]);
      } else if (isFolder && key.startsWith(`${oldPath}/`)) {
        updates.push([key, `${newPath}${key.slice(oldPath.length)}`, stateVal]);
      }
    }

    for (const [fromKey, toKey, stateVal] of updates) {
      statesByFile.delete(fromKey);
      const oldLang = inferFileMeta(fromKey).lang;
      const newLang = inferFileMeta(toKey).lang;
      if (oldLang === newLang) {
        statesByFile.set(toKey, stateVal);
        continue;
      }
      // Cambió la extensión: reconstruir con el nuevo lenguaje e indentación conservando texto y cursor
      const rebuilt = buildEditorState({
        id: toKey,
        lang: newLang,
        content: stateVal.doc.toString()
      });
      const head = Math.min(stateVal.selection.main.head, rebuilt.doc.length);
      const anchor = Math.min(stateVal.selection.main.anchor, rebuilt.doc.length);
      statesByFile.set(toKey, rebuilt.update({ selection: { anchor, head } }).state);
    }

    if (activeFileId === oldPath) {
      activeFileId = newPath;
    } else if (isFolder && activeFileId && activeFileId.startsWith(`${oldPath}/`)) {
      activeFileId = `${newPath}${activeFileId.slice(oldPath.length)}`;
    }

    if (view && activeFileId && statesByFile.get(activeFileId) !== view.state) {
      const refreshed = statesByFile.get(activeFileId);
      if (refreshed) {
        view.setState(refreshed);
        emitSelection(view.state);
      }
    }
  }

  function insertAtCursor(text, cursorBack = 0) {
    if (!view) {
      return;
    }
    const range = view.state.selection.main;
    const hasSelection = range.from < range.to;
    if (hasSelection && cursorBack > 0 && cursorBack < text.length) {
      const selectedText = view.state.sliceDoc(range.from, range.to);
      const wrapped = wrapTextWithDelimiters(text, selectedText, cursorBack);
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: wrapped.text },
        selection: { anchor: range.from + wrapped.selectFrom, head: range.from + wrapped.selectTo },
        scrollIntoView: true
      });
      view.focus();
      return;
    }

    const nextAnchor = Math.max(0, range.from + text.length - cursorBack);
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: nextAnchor },
      scrollIntoView: true
    });
    view.focus();
  }

  function goToLine(lineNo) {
    if (!view) return;
    const doc = view.state.doc;
    const targetLine = Math.min(Math.max(1, lineNo), doc.lines);
    const lineObj = doc.line(targetLine);
    const effects = [];
    if (EditorView && typeof EditorView.scrollIntoView === "function") {
      effects.push(EditorView.scrollIntoView(lineObj.from, { y: "center" }));
    }
    view.dispatch({
      selection: { anchor: lineObj.from },
      effects,
      scrollIntoView: true
    });
    view.focus();
    emitSelection(view.state);
  }

  function replaceSelection(text, contextHint = null) {
    if (!view) return;
    const range = view.state.selection.main;
    if (range.from < range.to) {
      insertAtCursor(text, 0);
      return;
    }
    const currentDoc = view.state.doc.toString();
    const cursorLine = view.state.doc.lineAt(range.head).number;
    const smart = computeSmartReplacement(currentDoc, text, {
      cursorLine,
      selectionFrom: range.from,
      selectionTo: range.to,
      contextHint
    });
    if (smart.mode === "full") {
      replaceEntireDocument(smart.insertedText);
      return;
    }
    view.dispatch({
      changes: { from: smart.from, to: smart.to, insert: smart.insertedText },
      selection: { anchor: smart.from, head: smart.from + smart.insertedText.length },
      scrollIntoView: true
    });
    view.focus();
    emitSelection(view.state);
  }

  function replaceEntireDocument(text, { preserveCursorLine = false } = {}) {
    if (!view) {
      return;
    }
    const prevLine = preserveCursorLine
      ? view.state.doc.lineAt(view.state.selection.main.head).number
      : 1;
    // Reemplaza todo el rango del documento (from: 0, to: length) en lugar de insertar en el cursor
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0, head: 0 },
      scrollIntoView: true
    });
    if (preserveCursorLine && prevLine > 1 && view.state?.doc?.lines) {
      const clampedLine = Math.max(1, Math.min(prevLine, view.state.doc.lines));
      const targetLine = view.state.doc.line(clampedLine);
      view.dispatch({
        selection: { anchor: targetLine.from, head: targetLine.from },
        scrollIntoView: true
      });
    }
    view.focus();
    emitSelection(view.state);
  }

  function replaceCode(text, forceWholeDoc = false, contextHint = null) {
    if (!view) return;
    if (forceWholeDoc) {
      replaceEntireDocument(text);
      return;
    }
    replaceSelection(text, contextHint);
  }

  function addErrorMarker(lineNum, errorMessage) {
    const num = Math.max(1, parseInt(lineNum, 10) || 1);
    const msg = String(errorMessage || "Error de compilación / sintaxis");
    activeErrorMarkers.push({ lineNum: num, errorMessage: msg });

    if (view && addErrorEffect) {
      view.dispatch({
        effects: addErrorEffect.of({ lineNum: num, errorMessage: msg })
      });
      if (activeErrorMarkers.length === 1) {
        goToLine(num);
      }
    }
    const totalLines = view?.state?.doc?.lines || 1;
    renderErrorRuler(activeErrorMarkers, totalLines, goToLine);
  }

  function clearErrorMarkers() {
    activeErrorMarkers = [];
    if (view && clearErrorEffect) {
      view.dispatch({
        effects: clearErrorEffect.of(null)
      });
    }
    renderErrorRuler([], 1, goToLine);
  }

  function getErrorMarkers() {
    return [...activeErrorMarkers];
  }

  function triggerUndo() {
    if (view) {
      undo(view);
      view.focus();
    }
  }

  function triggerRedo() {
    if (view) {
      redo(view);
      view.focus();
    }
  }

  function triggerSearch() {
    if (view) {
      openSearchPanel(view);
    }
  }

  function toggleWordWrap() {
    wordWrap = !wordWrap;
    saveStoredValue(PREF_KEYS.wordWrap, String(wordWrap));
    if (view) {
      view.dispatch({
        effects: wrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : [])
      });
    }
    return wordWrap;
  }

  function stepFontSize(delta) {
    fontSize = clampFontSize(fontSize + delta);
    saveStoredValue(PREF_KEYS.fontSize, String(fontSize));
    applyFontSize(fontSize);
    if (view) {
      view.requestMeasure();
    }
    return fontSize;
  }

  function setHardwareKeyboardMode(nextState) {
    hardwareKeyboard = Boolean(nextState);
    saveStoredValue(PREF_KEYS.hardwareKeyboard, String(hardwareKeyboard));
    applyHardwareKeyboardAttributes(hardwareKeyboard, view?.contentDOM || null);
    if (view) {
      try {
        view.dispatch({
          effects: contentAttrsCompartment.reconfigure(buildCmContentAttrsExtension(hardwareKeyboard))
        });
      } catch (_) {}
      if (view.contentDOM) {
        applyHardwareKeyboardAttributes(hardwareKeyboard, view.contentDOM);
      }
    }
    return hardwareKeyboard;
  }

  function toggleHardwareKeyboardMode() {
    return setHardwareKeyboardMode(!hardwareKeyboard);
  }

  function syncDoc(fileId, newContent) {
    if (activeFileId === fileId && view) {
      const cur = view.state.doc.toString();
      if (cur !== newContent) {
        const prevMain = view.state.selection.main;
        const nextAnchor = Math.min(prevMain.anchor, newContent.length);
        const nextHead = Math.min(prevMain.head, newContent.length);
        isSyncingExternal = true;
        try {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: newContent },
            selection: { anchor: nextAnchor, head: nextHead }
          });
        } finally {
          isSyncingExternal = false;
        }
      }
    } else {
      const cached = statesByFile.get(fileId);
      if (cached && cached.doc.toString() !== newContent) {
        statesByFile.delete(fileId);
      }
    }
  }

  return {
    openFile,
    clearActiveFile,
    dropFileState,
    purgeViewDocument,
    renameFileStates,
    insertAtCursor,
    replaceSelection,
    replaceEntireDocument,
    replaceCode,
    addErrorMarker,
    clearErrorMarkers,
    getErrorMarkers,
    goToLine,
    triggerUndo,
    triggerRedo,
    triggerSearch,
    toggleWordWrap,
    isWordWrapEnabled: () => wordWrap,
    stepFontSize,
    getFontSize: () => fontSize,
    toggleMinimap: (force) => minimap?.toggle(force),
    isMinimapVisible: () => (minimap ? minimap.isVisible() : false),
    setHardwareKeyboardMode,
    toggleHardwareKeyboardMode,
    isHardwareKeyboardMode: () => hardwareKeyboard,
    getActiveFileId: () => activeFileId,
    getValue: () => (view ? view.state.doc.toString() : ""),
    getCompletions: (prefix) =>
      getLanguageCompletions(activeLang, prefix, view ? view.state.doc.toString() : ""),
    acceptTopCompletion: () => autocompleteBar.acceptCurrent(),
    syncDoc,
    focus: () => view?.focus(),
    destroy() {
      clearErrorMarkers();
      autocompleteBar.destroy();
      minimap?.destroy?.();
      if (view) {
        try {
          view.destroy();
        } catch (_) {}
        view = null;
      }
      statesByFile.clear();
      activeFileId = null;
    }
  };
}

async function loadCodeMirrorModules() {
  const [
    stateMod,
    viewMod,
    langMod,
    cmdMod,
    searchMod,
    autoMod,
    hiMod,
    cppMod,
    htmlMod,
    cssMod,
    jsMod,
    pyMod,
    mdMod,
    jsonMod,
    sqlMod
  ] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/language"),
    import("@codemirror/commands"),
    import("@codemirror/search"),
    import("@codemirror/autocomplete"),
    import("@lezer/highlight"),
    import("@codemirror/lang-cpp"),
    import("@codemirror/lang-html"),
    import("@codemirror/lang-css"),
    import("@codemirror/lang-javascript"),
    import("@codemirror/lang-python").catch(() => null),
    import("@codemirror/lang-markdown").catch(() => null),
    import("@codemirror/lang-json").catch(() => null),
    import("@codemirror/lang-sql")
  ]);

  return {
    EditorState: stateMod.EditorState,
    Compartment: stateMod.Compartment,
    StateEffect: stateMod.StateEffect,
    StateField: stateMod.StateField,
    EditorView: viewMod.EditorView,
    Decoration: viewMod.Decoration,
    keymap: viewMod.keymap,
    lineNumbers: viewMod.lineNumbers,
    highlightActiveLine: viewMod.highlightActiveLine,
    highlightActiveLineGutter: viewMod.highlightActiveLineGutter,
    drawSelection: viewMod.drawSelection,
    syntaxHighlighting: langMod.syntaxHighlighting,
    HighlightStyle: langMod.HighlightStyle,
    foldGutter: langMod.foldGutter,
    foldKeymap: langMod.foldKeymap,
    bracketMatching: langMod.bracketMatching,
    indentOnInput: langMod.indentOnInput,
    indentUnit: langMod.indentUnit,
    defaultKeymap: cmdMod.defaultKeymap,
    history: cmdMod.history,
    historyKeymap: cmdMod.historyKeymap,
    indentWithTab: cmdMod.indentWithTab,
    undo: cmdMod.undo,
    redo: cmdMod.redo,
    search: searchMod.search,
    searchKeymap: searchMod.searchKeymap,
    openSearchPanel: searchMod.openSearchPanel,
    autocompletion: autoMod.autocompletion,
    completionKeymap: autoMod.completionKeymap,
    completeAnyWord: autoMod.completeAnyWord,
    acceptCompletion: autoMod.acceptCompletion,
    closeBrackets: autoMod.closeBrackets,
    closeBracketsKeymap: autoMod.closeBracketsKeymap,
    tags: hiMod.tags,
    langs: {
      cpp: cppMod.cpp,
      html: htmlMod.html,
      css: cssMod.css,
      javascript: jsMod.javascript,
      python: pyMod?.python ?? null,
      markdown: mdMod?.markdown ?? null,
      json: jsonMod?.json ?? null,
      sql: sqlMod.sql
    }
  };
}

function renderErrorRuler(markers, totalLines, onJump) {
  const rulerEl = typeof document !== "undefined" ? document.getElementById("editor-error-ruler") : null;
  if (!rulerEl) return;
  if (!markers || markers.length === 0) {
    rulerEl.hidden = true;
    rulerEl.innerHTML = "";
    return;
  }
  rulerEl.hidden = false;
  rulerEl.innerHTML = "";
  const linesCount = Math.max(1, totalLines || 1);

  for (const m of markers) {
    const pill = document.createElement("button");
    pill.type = "button";
    const isWarn = /warning/i.test(m.errorMessage || "");
    pill.className = isWarn ? "editor-error-marker-pill is-warning" : "editor-error-marker-pill";
    pill.title = `Línea ${m.lineNum}: ${m.errorMessage} (tocá para ir a la línea)`;
    pill.setAttribute("aria-label", `Línea ${m.lineNum}: ${m.errorMessage}`);
    const pct = Math.min(97, Math.max(3, (m.lineNum / linesCount) * 100));
    pill.style.top = `${pct}%`;
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      onJump?.(m.lineNum);
    });
    rulerEl.appendChild(pill);
  }
}

/**
 * Respaldo local ligero por si el usuario abre el IDE sin conexión antes del cacheo PWA.
 */
function createFallbackEditor({
  mountEl,
  initialWrap,
  initialFontSize,
  initialHardwareKeyboard = true,
  onDocChange,
  onSelectionChange,
  enableMinimap = true
}) {
  let wordWrap = initialWrap;
  let fontSize = initialFontSize;
  let hardwareKeyboard = initialHardwareKeyboard;
  let activeFileId = null;
  let activeLang = "js";

  const textarea = document.createElement("textarea");
  textarea.className = "editor-fallback-surface";
  textarea.spellcheck = false;
  textarea.autocapitalize = "off";
  textarea.autocomplete = "off";
  textarea.setAttribute("aria-label", "Editor de código");
  applyHardwareKeyboardAttributes(hardwareKeyboard, textarea);
  textarea.wrap = wordWrap ? "soft" : "off";
  mountEl.innerHTML = "";
  mountEl.appendChild(textarea);

  const fallbackMinimap = enableMinimap
    ? createMinimapController({
        mountEl: mountEl.parentElement || mountEl,
        getDocLines: () => (textarea ? textarea.value.split("\n") : []),
        getViewport: () => {
          if (textarea) {
            return {
              top: textarea.scrollTop,
              height: textarea.clientHeight,
              totalHeight: textarea.scrollHeight
            };
          }
          return { top: 0, height: 100, totalHeight: 100 };
        },
        onScrollToRatio: (ratio) => {
          if (textarea) {
            textarea.scrollTop = ratio * (textarea.scrollHeight - textarea.clientHeight);
          }
        }
      })
    : null;

  const fallbackAutocompleteBar = createAutocompleteBarController({
    mountEl,
    onAccept(item, wordRange) {
      const docLen = textarea.value.length;
      const from = Math.min(Math.max(0, wordRange.from), docLen);
      const to = Math.min(Math.max(from, wordRange.to), docLen);
      const insertText = item.apply || item.label;
      textarea.focus();
      textarea.setRangeText(insertText, from, to, "end");
      const newPos = from + insertText.length;
      textarea.setSelectionRange(newPos, newPos);
      fallbackAutocompleteBar.hide();
      if (activeFileId) {
        onDocChange(activeFileId, textarea.value);
      }
      fallbackMinimap?.render();
      emitSel();
    }
  });

  function refreshFallbackAutocomplete() {
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (start !== end) {
      fallbackAutocompleteBar.hide();
      return;
    }
    const wordRange = extractWordBeforeCursor(textarea.value, end);
    if (!wordRange.word || wordRange.word.length < 2) {
      fallbackAutocompleteBar.hide();
      return;
    }
    const suggestions = getLanguageCompletions(activeLang, wordRange.word, textarea.value, 6);
    fallbackAutocompleteBar.update(suggestions, wordRange);
  }

  textarea.addEventListener("scroll", () => {
    fallbackMinimap?.updateSlider();
  }, { passive: true });

  textarea.addEventListener("input", () => {
    if (activeFileId) {
      onDocChange(activeFileId, textarea.value);
    }
    fallbackMinimap?.render();
    refreshFallbackAutocomplete();
    emitSel();
  });

  const emitSel = () => {
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const before = textarea.value.slice(0, end);
    const lastNl = before.lastIndexOf("\n");
    const cursorLine = lastNl === -1 ? 1 : before.split("\n").length;
    const cursorCol = lastNl === -1 ? end + 1 : end - lastNl;

    if (start === end) {
      onSelectionChange({ text: "", lineCount: 0, cursorLine, cursorCol });
      return;
    }
    const text = textarea.value.slice(start, end);
    onSelectionChange({ text, lineCount: text.split("\n").length, cursorLine, cursorCol });
  };

  textarea.addEventListener("select", emitSel);
  textarea.addEventListener("keyup", emitSel);
  textarea.addEventListener("mouseup", emitSel);
  textarea.addEventListener("click", emitSel);

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      // Si hay sugerencias activas o una palabra parcial antes del cursor, autocompletar primero
      if (!fallbackAutocompleteBar.isOpen()) {
        refreshFallbackAutocomplete();
      }
      if (fallbackAutocompleteBar.isOpen() && fallbackAutocompleteBar.acceptCurrent()) {
        return;
      }
      const spaces = " ".repeat(getIndentSize(activeLang));
      insertInTextarea(spaces, 0);
      return;
    }
    if (event.key === "Escape" && fallbackAutocompleteBar.isOpen()) {
      event.preventDefault();
      fallbackAutocompleteBar.hide();
    }
  });

  function insertInTextarea(text, cursorBack = 0) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.focus();
    if (start !== end && cursorBack > 0 && cursorBack < text.length) {
      const selected = textarea.value.slice(start, end);
      const wrapped = wrapTextWithDelimiters(text, selected, cursorBack);
      textarea.setRangeText(wrapped.text, start, end, "select");
      textarea.setSelectionRange(start + wrapped.selectFrom, start + wrapped.selectTo);
    } else {
      textarea.setRangeText(text, start, end, "end");
      const pos = Math.max(0, start + text.length - cursorBack);
      textarea.setSelectionRange(pos, pos);
    }
    if (activeFileId) {
      onDocChange(activeFileId, textarea.value);
    }
    refreshFallbackAutocomplete();
    emitSel();
  }

  const fallbackErrorMarkers = [];

  return {
    openFile(file) {
      if (!file || file.isBinary || file.encoding === "base64") {
        return;
      }
      activeFileId = file.id;
      activeLang = file.lang;
      if (!mountEl.contains(textarea)) {
        mountEl.innerHTML = "";
        mountEl.appendChild(textarea);
      }
      textarea.value = file.content;
      fallbackMinimap?.render();
      fallbackMinimap?.updateSlider();
      onSelectionChange?.({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
    },
    clearActiveFile() {
      activeFileId = null;
      textarea.value = "";
      this.clearErrorMarkers();
      onSelectionChange?.({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
    },
    dropFileState(fileId) {
      if (activeFileId === fileId) {
        activeFileId = null;
        textarea.value = "";
        this.clearErrorMarkers();
        onSelectionChange?.({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
      }
    },
    purgeViewDocument() {
      textarea.value = "";
    },
    renameFileStates(oldPath, newPath, isFolder) {
      if (!activeFileId) return;
      if (activeFileId === oldPath) {
        activeFileId = newPath;
      } else if (isFolder && activeFileId.startsWith(`${oldPath}/`)) {
        activeFileId = `${newPath}${activeFileId.slice(oldPath.length)}`;
      } else {
        return;
      }
      activeLang = inferFileMeta(activeFileId).lang;
    },
    insertAtCursor: insertInTextarea,
    replaceSelection(text, contextHint = null) {
      const start = textarea.selectionStart ?? 0;
      const end = textarea.selectionEnd ?? 0;
      if (start < end) {
        insertInTextarea(text, 0);
        return;
      }
      const before = textarea.value.slice(0, end);
      const lastNl = before.lastIndexOf("\n");
      const cursorLine = lastNl === -1 ? 1 : before.split("\n").length;
      const smart = computeSmartReplacement(textarea.value, text, {
        cursorLine,
        selectionFrom: start,
        selectionTo: end,
        contextHint
      });
      if (smart.mode === "full") {
        textarea.value = smart.insertedText;
        textarea.setSelectionRange(0, 0);
      } else {
        textarea.value = smart.text;
        textarea.setSelectionRange(smart.from, smart.from + smart.insertedText.length);
      }
      if (activeFileId) onDocChange(activeFileId, textarea.value);
      emitSel();
    },
    replaceEntireDocument(text, { preserveCursorLine = false } = {}) {
      let prevLine = 1;
      if (preserveCursorLine) {
        const head = textarea.selectionStart || 0;
        prevLine = textarea.value.slice(0, head).split("\n").length;
      }
      textarea.value = text;
      let nextOffset = 0;
      if (preserveCursorLine && prevLine > 1) {
        const lines = text.split("\n");
        const clamped = Math.max(1, Math.min(prevLine, lines.length));
        for (let i = 0; i < clamped - 1; i += 1) {
          nextOffset += lines[i].length + 1;
        }
      }
      textarea.setSelectionRange(nextOffset, nextOffset);
      if (activeFileId) {
        onDocChange?.(activeFileId, text);
      }
      emitSel();
    },
    replaceCode(text, forceWholeDoc = false, contextHint = null) {
      if (forceWholeDoc) {
        this.replaceEntireDocument(text);
      } else {
        this.replaceSelection(text, contextHint);
      }
    },
    addErrorMarker(lineNum, errorMessage) {
      const num = Math.max(1, parseInt(lineNum, 10) || 1);
      const msg = String(errorMessage || "Error de compilación / sintaxis");
      fallbackErrorMarkers.push({ lineNum: num, errorMessage: msg });
      textarea.classList.add("has-error");
      textarea.title = `Línea ${num}: ${msg}`;
      const lines = textarea.value.split("\n");
      const boundedLine = Math.min(num, lines.length);
      let offset = 0;
      for (let i = 0; i < boundedLine - 1; i++) {
        offset += lines[i].length + 1;
      }
      textarea.setSelectionRange(offset, offset);
      renderErrorRuler(fallbackErrorMarkers, lines.length, (l) => this.goToLine(l));
    },
    clearErrorMarkers() {
      fallbackErrorMarkers.length = 0;
      textarea.classList.remove("has-error");
      textarea.title = "";
      renderErrorRuler([], 1, () => {});
    },
    getErrorMarkers() {
      return [...fallbackErrorMarkers];
    },
    goToLine(lineNo) {
      const target = Math.max(1, parseInt(lineNo, 10) || 1);
      const lines = textarea.value.split("\n");
      const boundedLine = Math.min(target, lines.length);
      let offset = 0;
      for (let i = 0; i < boundedLine - 1; i++) {
        offset += lines[i].length + 1;
      }
      textarea.focus();
      textarea.setSelectionRange(offset, offset);
      const approxLineHeight = 20;
      const targetScroll = Math.max(0, (boundedLine - 3) * approxLineHeight);
      if (typeof textarea.scrollTo === "function") {
        textarea.scrollTo({ top: targetScroll, behavior: "smooth" });
      } else {
        textarea.scrollTop = targetScroll;
      }
      emitSel();
    },
    triggerUndo() {
      textarea.focus();
      document.execCommand?.("undo");
    },
    triggerRedo() {
      textarea.focus();
      document.execCommand?.("redo");
    },
    triggerSearch() {
      textarea.focus();
    },
    toggleWordWrap() {
      wordWrap = !wordWrap;
      textarea.wrap = wordWrap ? "soft" : "off";
      saveStoredValue(PREF_KEYS.wordWrap, String(wordWrap));
      return wordWrap;
    },
    isWordWrapEnabled: () => wordWrap,
    stepFontSize(delta) {
      fontSize = clampFontSize(fontSize + delta);
      saveStoredValue(PREF_KEYS.fontSize, String(fontSize));
      applyFontSize(fontSize);
      return fontSize;
    },
    getFontSize: () => fontSize,
    toggleMinimap: (force) => fallbackMinimap?.toggle(force),
    isMinimapVisible: () => (fallbackMinimap ? fallbackMinimap.isVisible() : false),
    setHardwareKeyboardMode(nextState) {
      hardwareKeyboard = Boolean(nextState);
      saveStoredValue(PREF_KEYS.hardwareKeyboard, String(hardwareKeyboard));
      applyHardwareKeyboardAttributes(hardwareKeyboard, textarea);
      return hardwareKeyboard;
    },
    toggleHardwareKeyboardMode() {
      return this.setHardwareKeyboardMode(!hardwareKeyboard);
    },
    isHardwareKeyboardMode: () => hardwareKeyboard,
    getActiveFileId: () => activeFileId,
    getValue: () => (textarea ? textarea.value : ""),
    getCompletions: (prefix) => {
      const query = prefix !== undefined
        ? prefix
        : extractWordBeforeCursor(textarea.value, textarea.selectionEnd ?? textarea.value.length).word;
      return getLanguageCompletions(activeLang, query, textarea.value);
    },
    acceptTopCompletion: () => {
      if (!fallbackAutocompleteBar.isOpen()) {
        refreshFallbackAutocomplete();
      }
      return fallbackAutocompleteBar.acceptCurrent();
    },
    syncDoc: (fileId, newContent) => {
      if (activeFileId === fileId && textarea) {
        if (textarea.value !== newContent) {
          textarea.value = newContent;
        }
      }
    },
    focus: () => textarea?.focus(),
    destroy() {
      fallbackAutocompleteBar.destroy();
      fallbackMinimap?.destroy?.();
      textarea.value = "";
      mountEl.innerHTML = "";
      activeFileId = null;
    }
  };
}

function applyFontSize(px) {
  document.documentElement.style.setProperty("--editor-font-size", `${px}px`);
}

function clampFontSize(px) {
  return Math.min(Math.max(Math.round(px), MIN_FONT_SIZE), MAX_FONT_SIZE);
}

function readStoredBool(key, fallback) {
  const raw = readStoredValue(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function readStoredValue(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveStoredValue(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignorar errores de almacenamiento restringido
  }
}
