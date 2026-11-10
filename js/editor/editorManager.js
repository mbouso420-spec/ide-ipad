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
        autocompletion({ activateOnTyping: true, icons: false }),
        EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
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
          } else if (update.docChanged && isSyncingExternal) {
            minimap?.render();
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

  function replaceEntireDocument(text) {
    if (!view) {
      return;
    }
    // Reemplaza todo el rango del documento (from: 0, to: length) en lugar de insertar en el cursor
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0, head: 0 },
      scrollIntoView: true
    });
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
    syncDoc,
    focus: () => view?.focus(),
    destroy() {
      clearErrorMarkers();
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

  textarea.addEventListener("scroll", () => {
    fallbackMinimap?.updateSlider();
  }, { passive: true });

  textarea.addEventListener("input", () => {
    if (activeFileId) {
      onDocChange(activeFileId, textarea.value);
    }
    fallbackMinimap?.render();
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
      const spaces = " ".repeat(getIndentSize(activeLang));
      insertInTextarea(spaces, 0);
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
      if (cursorBack > 0) {
        const pos = Math.max(0, start + text.length - cursorBack);
        textarea.setSelectionRange(pos, pos);
      }
    }
    if (activeFileId) {
      onDocChange(activeFileId, textarea.value);
    }
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
      onSelectionChange({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
    },
    clearActiveFile() {
      activeFileId = null;
      textarea.value = "";
      this.clearErrorMarkers();
      onSelectionChange({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
    },
    dropFileState(fileId) {
      if (activeFileId === fileId) {
        activeFileId = null;
        textarea.value = "";
        this.clearErrorMarkers();
        onSelectionChange({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
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
    replaceEntireDocument(text) {
      textarea.value = text;
      textarea.setSelectionRange(0, 0);
      if (activeFileId) {
        onDocChange(activeFileId, text);
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
      document.execCommand("undo");
    },
    triggerRedo() {
      textarea.focus();
      document.execCommand("redo");
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
    syncDoc: (fileId, newContent) => {
      if (activeFileId === fileId && textarea) {
        if (textarea.value !== newContent) {
          textarea.value = newContent;
        }
      }
    },
    focus: () => textarea?.focus(),
    destroy() {
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
