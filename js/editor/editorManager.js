import { inferFileMeta } from "../storage/workspaceDb.js";
import { readStoredBool, readStoredValue, saveStoredValue } from "../utils/storage.js";
import { createMinimapController } from "./minimap.js";
import { computeSmartReplacement } from "./smartReplace.js";
import {
  extractWordBeforeCursor,
  extractDocumentIdentifiers,
  getLanguageCompletions,
  createAutocompleteBarController
} from "./autocompleteCatalog.js";
import { getIndentSize } from "./languageConfig.js";
import { createErrorMarkersController } from "./errorMarkersController.js";
import { createFallbackEditor } from "./fallbackEditor.js";

export { getIndentSize } from "./languageConfig.js";
export { scoreLineSimilarity, computeSmartReplacement } from "./smartReplace.js";
export {
  LANGUAGE_COMPLETIONS,
  extractWordBeforeCursor,
  scoreCompletionMatch,
  getLanguageCompletions
} from "./autocompleteCatalog.js";

const MAX_IDENT_SLICE_CHARS = 120000;

/**
 * Helper compartido para procesar ediciones de documento desde el editor principal y el Split View,
 * actualizando contenido, estado sucio y autoguardado sin duplicar lógica.
 */
export function applyDocumentEdit({
  filePath,
  newContent,
  getFilesOnly,
  isFileDirtyForProject,
  renderTabs,
  onDirtyChange,
  getActiveProject,
  scheduleAutosave,
  onAfterEdit
}) {
  const target = getFilesOnly?.().find((f) => f.id === filePath);
  if (!target) return false;
  const wasDirty = Boolean(isFileDirtyForProject?.(target));
  target.content = newContent;
  const nowDirty = Boolean(isFileDirtyForProject?.(target));
  if (wasDirty !== nowDirty) {
    if (typeof onDirtyChange === "function") {
      onDirtyChange(target, nowDirty);
    } else {
      renderTabs?.();
    }
  }
  const activeProject = getActiveProject?.();
  if (activeProject) {
    scheduleAutosave?.(activeProject.id, filePath, newContent);
  }
  onAfterEdit?.(filePath, newContent, target);
  return true;
}
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
export async function createEditorManager({
  mountEl,
  onDocChange,
  onSelectionChange,
  enableMinimap = true,
  isSplitInstance = false,
  enableGlobalRuler = !isSplitInstance,
  enableAutocomplete = !isSplitInstance,
  minimapParent = mountEl
}) {
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
      prefKeys: PREF_KEYS,
      clampFontSize,
      applyFontSize,
      applyHardwareKeyboardAttributes,
      wrapTextWithDelimiters,
      onDocChange,
      onSelectionChange,
      enableMinimap,
      isSplitInstance,
      enableGlobalRuler,
      enableAutocomplete,
      minimapParent
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
  const MAX_CACHED_STATES = isSplitInstance ? 4 : 15;
  const stateCompartmentPrefs = new WeakMap();

  function setCachedState(fileId, state) {
    if (!fileId || !state) return;
    if (statesByFile.has(fileId)) {
      statesByFile.delete(fileId);
    } else if (statesByFile.size >= MAX_CACHED_STATES) {
      for (const candidateKey of statesByFile.keys()) {
        if (candidateKey !== activeFileId && candidateKey !== fileId) {
          statesByFile.delete(candidateKey);
          break;
        }
      }
    }
    statesByFile.set(fileId, state);
    stateCompartmentPrefs.set(state, { wordWrap, hardwareKeyboard });
  }

  function getCachedState(fileId) {
    const state = statesByFile.get(fileId);
    if (!state) return undefined;
    statesByFile.delete(fileId);
    statesByFile.set(fileId, state);
    return state;
  }

  const buildCmContentAttrsExtension = (hwKb) =>
    EditorView.contentAttributes && typeof EditorView.contentAttributes.of === "function"
      ? EditorView.contentAttributes.of(buildContentAttributes(hwKb))
      : [];

  const resolvedMinimapParent = minimapParent || mountEl;
  if (mountEl) {
    mountEl.innerHTML = "";
  }

  const minimap = enableMinimap
    ? createMinimapController({
        mountEl: resolvedMinimapParent,
        getLineCount: () => view?.state?.doc?.lines || 0,
        getLine: (index) => {
          const doc = view?.state?.doc;
          if (!doc || index < 0 || index >= doc.lines) return "";
          return doc.line(index + 1).text;
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

  const errorMarkers = createErrorMarkersController({
    enableGlobalRuler,
    onJump: goToLine
  });

  function syncErrorRuler(totalLines = view?.state?.doc?.lines || 1) {
    errorMarkers.syncRuler(activeFileId, totalLines);
  }

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
    enabled: enableAutocomplete,
    sharedGlobalBar: enableAutocomplete,
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

  // Caché con debounce del vocabulario de identificadores del archivo activo
  let docVocabFileId = null;
  let docVocabWords = [];
  let docVocabDocRef = null;
  let docVocabTimer = null;

  function computeDocWordsNow(doc) {
    if (!doc) return [];
    const sliceLen = Math.min(doc.length, MAX_IDENT_SLICE_CHARS);
    const sample = doc.sliceString(0, sliceLen);
    return extractDocumentIdentifiers(sample);
  }

  function getCachedDocWords(doc, { immediate = false } = {}) {
    if (!doc) return [];
    if (docVocabFileId === activeFileId && docVocabDocRef === doc) {
      return docVocabWords;
    }
    if (immediate || docVocabFileId !== activeFileId || docVocabWords.length === 0) {
      if (docVocabTimer) {
        clearTimeout(docVocabTimer);
        docVocabTimer = null;
      }
      docVocabFileId = activeFileId;
      docVocabDocRef = doc;
      docVocabWords = computeDocWordsNow(doc);
      return docVocabWords;
    }
    // Reutilizar vocabulario reciente mientras el usuario teclea y refrescar tras breve pausa
    if (!docVocabTimer) {
      docVocabTimer = setTimeout(() => {
        docVocabTimer = null;
        const currentDoc = view?.state?.doc;
        if (currentDoc) {
          docVocabFileId = activeFileId;
          docVocabDocRef = currentDoc;
          docVocabWords = computeDocWordsNow(currentDoc);
        }
      }, 180);
    }
    return docVocabWords;
  }

  function extractPrefixWordFromDoc(doc, pos) {
    const winStart = Math.max(0, pos - 128);
    const prefixSlice = doc.sliceString(winStart, pos);
    const rel = extractWordBeforeCursor(prefixSlice, prefixSlice.length);
    return {
      word: rel.word,
      from: winStart + rel.from,
      to: winStart + rel.to
    };
  }

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
    const wordRange = extractPrefixWordFromDoc(state.doc, main.head);
    if (!wordRange.word || wordRange.word.length < 2) {
      autocompleteBar.hide();
      return;
    }
    const docWords = getCachedDocWords(state.doc);
    const suggestions = getLanguageCompletions(activeLang, wordRange.word, docWords, 6);
    autocompleteBar.update(suggestions, wordRange);
  }

  function createCmCompletionSource(lang) {
    return (context) => {
      const wordRange = extractPrefixWordFromDoc(context.state.doc, context.pos);
      if (!wordRange.word || (wordRange.word.length < 2 && !context.explicit)) {
        return null;
      }
      const docWords = getCachedDocWords(context.state.doc, { immediate: Boolean(context.explicit) });
      const items = getLanguageCompletions(lang, wordRange.word, docWords, 12);
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
      setCachedState(activeFileId, view.state);
    }

    activeFileId = file.id;
    activeLang = file.lang || inferFileMeta(file.id).lang || "js";
    autocompleteBar.hide();
    let nextState = getCachedState(file.id);

    if (!nextState) {
      nextState = buildEditorState(file);
      setCachedState(file.id, nextState);
    } else {
      // Sincronizar Word Wrap y atributos de teclado físico solo si cambiaron desde el último uso
      const prevPrefs = stateCompartmentPrefs.get(nextState);
      const effects = [];
      if (!prevPrefs || prevPrefs.wordWrap !== wordWrap) {
        effects.push(wrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : []));
      }
      if (!prevPrefs || prevPrefs.hardwareKeyboard !== hardwareKeyboard) {
        effects.push(contentAttrsCompartment.reconfigure(buildCmContentAttrsExtension(hardwareKeyboard)));
      }
      if (effects.length > 0) {
        nextState = nextState.update({ effects }).state;
        setCachedState(file.id, nextState);
      }
    }

    if (!view) {
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

    syncErrorRuler(view?.state?.doc?.lines || 1);
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
    errorMarkers.dropFile(fileId);
    if (docVocabFileId === fileId) {
      docVocabFileId = null;
      docVocabWords = [];
      docVocabDocRef = null;
    }
    if (activeFileId === fileId) {
      activeFileId = null;
      clearErrorMarkers();
      purgeViewDocument();
      onSelectionChange({ text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });
    }
  }

  function renameFileStates(oldPath, newPath, isFolder) {
    if (view && activeFileId) {
      setCachedState(activeFileId, view.state);
    }

    errorMarkers.renamePaths(oldPath, newPath, isFolder);

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
        setCachedState(toKey, stateVal);
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
      setCachedState(toKey, rebuilt.update({ selection: { anchor, head } }).state);
    }

    if (activeFileId === oldPath) {
      activeFileId = newPath;
      activeLang = inferFileMeta(newPath).lang;
    } else if (isFolder && activeFileId && activeFileId.startsWith(`${oldPath}/`)) {
      activeFileId = `${newPath}${activeFileId.slice(oldPath.length)}`;
      activeLang = inferFileMeta(activeFileId).lang;
    }

    if (view && activeFileId && statesByFile.get(activeFileId) !== view.state) {
      const refreshed = getCachedState(activeFileId);
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
    const { marker, isFirstForFile } = errorMarkers.addMarker(activeFileId, lineNum, errorMessage);

    if (view && addErrorEffect) {
      view.dispatch({
        effects: addErrorEffect.of({ lineNum: marker.lineNum, errorMessage: marker.errorMessage })
      });
      if (isFirstForFile) {
        goToLine(marker.lineNum);
      }
    }
    syncErrorRuler(view?.state?.doc?.lines || 1);
  }

  function clearErrorMarkers() {
    errorMarkers.clearFile(activeFileId);
    if (view && clearErrorEffect) {
      view.dispatch({
        effects: clearErrorEffect.of(null)
      });
    }
    syncErrorRuler(1);
  }

  function getErrorMarkers() {
    return errorMarkers.getMarkers(activeFileId);
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
      stateCompartmentPrefs.set(view.state, { wordWrap, hardwareKeyboard });
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
        stateCompartmentPrefs.set(view.state, { wordWrap, hardwareKeyboard });
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
    getCompletions: (prefix) => {
      const query = prefix !== undefined
        ? prefix
        : (view ? extractPrefixWordFromDoc(view.state.doc, view.state.selection.main.head).word : "");
      const words = view ? getCachedDocWords(view.state.doc, { immediate: true }) : "";
      return getLanguageCompletions(activeLang, query, words);
    },
    acceptTopCompletion: () => autocompleteBar.acceptCurrent(),
    syncDoc,
    focus: () => view?.focus(),
    destroy() {
      if (docVocabTimer) {
        clearTimeout(docVocabTimer);
        docVocabTimer = null;
      }
      docVocabWords = [];
      docVocabDocRef = null;
      docVocabFileId = null;
      errorMarkers.destroy();
      if (view && clearErrorEffect) {
        try {
          view.dispatch({ effects: clearErrorEffect.of(null) });
        } catch (_) {}
      }
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

function applyFontSize(px) {
  document.documentElement.style.setProperty("--editor-font-size", `${px}px`);
}

function clampFontSize(px) {
  return Math.min(Math.max(Math.round(px), MIN_FONT_SIZE), MAX_FONT_SIZE);
}
