import { inferFileMeta } from "../storage/workspaceDb.js";
import { createMinimapController } from "./minimap.js";

const PREF_KEYS = {
  wordWrap: "ide.editor.wordWrap",
  fontSize: "ide.editor.fontSize"
};

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 22;
const DEFAULT_FONT_SIZE = 14;

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
  let activeFileId = null;

  applyFontSize(fontSize);

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
  const statesByFile = new Map();

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
      // Sincronizar Word Wrap actual al recuperar estado en caché
      nextState = nextState.update({
        effects: wrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : [])
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

  function replaceSelection(text) {
    if (!view) return;
    const range = view.state.selection.main;
    // Si no hay texto seleccionado (cursor colapsado), la acción de reemplazo reemplaza todo el documento
    if (range.from === range.to) {
      replaceEntireDocument(text);
      return;
    }
    insertAtCursor(text, 0);
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

  function replaceCode(text, forceWholeDoc = false) {
    if (!view) return;
    const range = view.state.selection.main;
    if (range.from < range.to && !forceWholeDoc) {
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: { anchor: range.from + text.length, head: range.from + text.length },
        scrollIntoView: true
      });
      view.focus();
      emitSelection(view.state);
    } else {
      replaceEntireDocument(text);
    }
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
function createFallbackEditor({ mountEl, initialWrap, initialFontSize, onDocChange, onSelectionChange, enableMinimap = true }) {
  let wordWrap = initialWrap;
  let fontSize = initialFontSize;
  let activeFileId = null;
  let activeLang = "js";

  const textarea = document.createElement("textarea");
  textarea.className = "editor-fallback-surface";
  textarea.spellcheck = false;
  textarea.autocapitalize = "off";
  textarea.autocomplete = "off";
  textarea.setAttribute("aria-label", "Editor de código");
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
    replaceSelection(text) {
      if (textarea.selectionStart === textarea.selectionEnd) {
        // Sin selección: reemplazar todo el documento
        textarea.value = text;
        textarea.setSelectionRange(0, 0);
        if (activeFileId) onDocChange(activeFileId, text);
        emitSel();
        return;
      }
      insertInTextarea(text, 0);
    },
    replaceEntireDocument(text) {
      textarea.value = text;
      textarea.setSelectionRange(0, 0);
      if (activeFileId) {
        onDocChange(activeFileId, text);
      }
      emitSel();
    },
    replaceCode(text, forceWholeDoc = false) {
      if (textarea.selectionStart < textarea.selectionEnd && !forceWholeDoc) {
        insertInTextarea(text, 0);
      } else {
        textarea.value = text;
        textarea.setSelectionRange(0, 0);
        if (activeFileId) onDocChange(activeFileId, text);
        emitSel();
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
