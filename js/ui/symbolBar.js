import { readStoredBool, saveStoredValue } from "../utils/storage.js";

const SYMBOL_STORAGE_KEY = "ide.symbols.visible";

/**
 * Mapas de símbolos táctiles adaptados al lenguaje activo.
 * Indentación inteligente: 4 espacios en C/C++ y SQL; 2 espacios en HTML, CSS y JS.
 */
export const LANGUAGE_SYMBOLS = {
  cpp: {
    label: "C / C++",
    keys: [
      { label: "Tab", insert: "    ", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "\\n", insert: "\\n", cursorBack: 0 },
      { label: "{ }", insert: "{}", cursorBack: 1 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "[ ]", insert: "[]", cursorBack: 1 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 },
      { label: "->", insert: "->", cursorBack: 0 },
      { label: "::", insert: "::", cursorBack: 0 },
      { label: "#include", insert: "#include <>", cursorBack: 1 },
      { label: "std::", insert: "std::", cursorBack: 0 },
      { label: "*", insert: "*", cursorBack: 0 },
      { label: "&", insert: "&", cursorBack: 0 },
      { label: "=", insert: " = ", cursorBack: 0 }
    ]
  },
  rust: {
    label: "Rust",
    keys: [
      { label: "Tab", insert: "    ", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "\\n", insert: "\\n", cursorBack: 0 },
      { label: "{ }", insert: "{}", cursorBack: 1 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "fn", insert: "fn () {\n    \n}", cursorBack: 7 },
      { label: "let mut", insert: "let mut ", cursorBack: 0 },
      { label: "->", insert: " -> ", cursorBack: 0 },
      { label: "::", insert: "::", cursorBack: 0 },
      { label: "pub", insert: "pub ", cursorBack: 0 },
      { label: "struct", insert: "struct {\n    \n}", cursorBack: 7 },
      { label: "&", insert: "&", cursorBack: 0 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "!=", insert: " != ", cursorBack: 0 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 }
    ]
  },
  go: {
    label: "Go",
    keys: [
      { label: "Tab", insert: "    ", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "\\n", insert: "\\n", cursorBack: 0 },
      { label: "{ }", insert: "{}", cursorBack: 1 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "func", insert: "func () {\n    \n}", cursorBack: 7 },
      { label: ":=", insert: " := ", cursorBack: 0 },
      { label: "package", insert: "package main\n\n", cursorBack: 0 },
      { label: "import", insert: "import (\n\t\"\"\n)", cursorBack: 4 },
      { label: "err != nil", insert: "if err != nil {\n    return \n}", cursorBack: 2 },
      { label: "return", insert: "return ", cursorBack: 0 },
      { label: "fmt.Println", insert: "fmt.Println()", cursorBack: 1 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 }
    ]
  },
  java: {
    label: "Java",
    keys: [
      { label: "Tab", insert: "    ", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "\\n", insert: "\\n", cursorBack: 0 },
      { label: "public", insert: "public ", cursorBack: 0 },
      { label: "class", insert: "class  {\n    \n}", cursorBack: 7 },
      { label: "void", insert: "void ", cursorBack: 0 },
      { label: "static", insert: "static ", cursorBack: 0 },
      { label: "sout", insert: "System.out.println();", cursorBack: 2 },
      { label: "{ }", insert: "{\n    \n}", cursorBack: 2 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "new", insert: "new ", cursorBack: 0 },
      { label: "return", insert: "return ", cursorBack: 0 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 }
    ]
  },
  csharp: {
    label: "C#",
    keys: [
      { label: "Tab", insert: "    ", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "\\n", insert: "\\n", cursorBack: 0 },
      { label: "using", insert: "using System;\n", cursorBack: 0 },
      { label: "namespace", insert: "namespace \n{\n    \n}", cursorBack: 6 },
      { label: "class", insert: "class  {\n    \n}", cursorBack: 7 },
      { label: "public", insert: "public ", cursorBack: 0 },
      { label: "cw", insert: "Console.WriteLine();", cursorBack: 2 },
      { label: "{ }", insert: "{\n    \n}", cursorBack: 2 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "var", insert: "var ", cursorBack: 0 },
      { label: "=>", insert: " => ", cursorBack: 0 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 }
    ]
  },
  ts: {
    label: "TypeScript",
    keys: [
      { label: "Tab", insert: "  ", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "\\n", insert: "\\n", cursorBack: 0 },
      { label: "interface", insert: "interface  {\n  \n}", cursorBack: 5 },
      { label: "type", insert: "type  = ;\n", cursorBack: 4 },
      { label: ": string", insert: ": string", cursorBack: 0 },
      { label: ": number", insert: ": number", cursorBack: 0 },
      { label: "=>", insert: " => ", cursorBack: 0 },
      { label: "as", insert: " as ", cursorBack: 0 },
      { label: "{ }", insert: "{}", cursorBack: 1 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 }
    ]
  },
  html: {
    label: "HTML",
    keys: [
      { label: "Tab", insert: "  ", cursorBack: 0 },
      { label: "< >", insert: "<>", cursorBack: 1 },
      { label: "</>", insert: "</>", cursorBack: 1 },
      { label: "/>", insert: " />", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "=\"\"", insert: "=\"\"", cursorBack: 1 },
      { label: "class", insert: "class=\"\"", cursorBack: 1 },
      { label: "id", insert: "id=\"\"", cursorBack: 1 },
      { label: "div", insert: "<div></div>", cursorBack: 6 },
      { label: "!", insert: "!", cursorBack: 0 }
    ]
  },
  css: {
    label: "CSS",
    keys: [
      { label: "Tab", insert: "  ", cursorBack: 0 },
      { label: "{ }", insert: " {\n  \n}", cursorBack: 2 },
      { label: ":", insert: ": ", cursorBack: 0 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "var()", insert: "var(--)", cursorBack: 1 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "--", insert: "--", cursorBack: 0 },
      { label: "px", insert: "px", cursorBack: 0 },
      { label: "rem", insert: "rem", cursorBack: 0 },
      { label: ".", insert: ".", cursorBack: 0 }
    ]
  },
  js: {
    label: "JavaScript",
    keys: [
      { label: "Tab", insert: "  ", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "\\n", insert: "\\n", cursorBack: 0 },
      { label: "{ }", insert: "{}", cursorBack: 1 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "[ ]", insert: "[]", cursorBack: 1 },
      { label: "=>", insert: " => ", cursorBack: 0 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "const", insert: "const ", cursorBack: 0 },
      { label: "===", insert: " === ", cursorBack: 0 },
      { label: "` `", insert: "``", cursorBack: 1 },
      { label: "${}", insert: "${}", cursorBack: 1 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 }
    ]
  },
  python: {
    label: "Python",
    keys: [
      { label: "Tab", insert: "    ", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "\\n", insert: "\\n", cursorBack: 0 },
      { label: ":", insert: ":", cursorBack: 0 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "[ ]", insert: "[]", cursorBack: 1 },
      { label: "{ }", insert: "{}", cursorBack: 1 },
      { label: "def", insert: "def ", cursorBack: 0 },
      { label: "return", insert: "return ", cursorBack: 0 },
      { label: "print()", insert: "print()", cursorBack: 1 },
      { label: "f\"\"", insert: "f\"\"", cursorBack: 1 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 },
      { label: "=", insert: " = ", cursorBack: 0 },
      { label: "==", insert: " == ", cursorBack: 0 },
      { label: "#", insert: "# ", cursorBack: 0 },
      { label: "_", insert: "_", cursorBack: 0 }
    ]
  },
  sql: {
    label: "SQL",
    keys: [
      { label: "Tab", insert: "    ", cursorBack: 0 },
      { label: "SELECT", insert: "SELECT ", cursorBack: 0 },
      { label: "FROM", insert: "FROM ", cursorBack: 0 },
      { label: "WHERE", insert: "WHERE ", cursorBack: 0 },
      { label: "JOIN", insert: "JOIN ", cursorBack: 0 },
      { label: ";", insert: ";", cursorBack: 0 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "' '", insert: "''", cursorBack: 1 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "=", insert: " = ", cursorBack: 0 },
      { label: "*", insert: "*", cursorBack: 0 },
      { label: "_", insert: "_", cursorBack: 0 }
    ]
  },
  markdown: {
    label: "Markdown",
    keys: [
      { label: "#", insert: "# ", cursorBack: 0 },
      { label: "##", insert: "## ", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "** **", insert: "****", cursorBack: 2 },
      { label: "` `", insert: "``", cursorBack: 1 },
      { label: "```", insert: "```\n\n```", cursorBack: 4 },
      { label: "-", insert: "- ", cursorBack: 0 },
      { label: "[ ]()", insert: "[]()", cursorBack: 3 },
      { label: ">", insert: "> ", cursorBack: 0 },
      { label: "---", insert: "\n---\n", cursorBack: 0 }
    ]
  },
  json: {
    label: "JSON",
    keys: [
      { label: "Tab", insert: "  ", cursorBack: 0 },
      { label: "{ }", insert: "{}", cursorBack: 1 },
      { label: "[ ]", insert: "[]", cursorBack: 1 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: ":", insert: ": ", cursorBack: 0 },
      { label: ",", insert: ",", cursorBack: 0 },
      { label: "true", insert: "true", cursorBack: 0 },
      { label: "false", insert: "false", cursorBack: 0 },
      { label: "null", insert: "null", cursorBack: 0 }
    ]
  },
  text: {
    label: "Texto",
    keys: [
      { label: "Tab", insert: "  ", cursorBack: 0 },
      { label: "\\", insert: "\\", cursorBack: 0 },
      { label: "\\n", insert: "\\n", cursorBack: 0 },
      { label: "( )", insert: "()", cursorBack: 1 },
      { label: "[ ]", insert: "[]", cursorBack: 1 },
      { label: "{ }", insert: "{}", cursorBack: 1 },
      { label: "\" \"", insert: "\"\"", cursorBack: 1 },
      { label: "-", insert: "- ", cursorBack: 0 },
      { label: "#", insert: "#", cursorBack: 0 },
      { label: "/", insert: "/", cursorBack: 0 },
      { label: "_", insert: "_", cursorBack: 0 }
    ]
  }
};

/**
 * Inicializa la barra inferior de símbolos rápidos para iPad y el conmutador de teclado táctil/físico.
 * @param {{ onInsert: (text: string, cursorBack: number) => void, onToggle?: (touchKeyboardVisible: boolean) => void }} options
 */
export function initSymbolBar({ onInsert, onToggle }) {
  const track = document.getElementById("symbol-keys-track");
  const langPill = document.getElementById("symbol-lang-pill");
  const toggleBtn = document.getElementById("btn-toggle-symbols");

  const listenerController = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = listenerController ? { signal: listenerController.signal } : undefined;

  const defaultVisible = readDefaultVisibility();
  let visible = readStoredBool(SYMBOL_STORAGE_KEY, defaultVisible);

  applyVisibility();

  toggleBtn?.addEventListener("click", () => {
    setVisible(!visible);
  }, listenOpts);

  function setVisible(nextState) {
    visible = Boolean(nextState);
    saveStoredValue(SYMBOL_STORAGE_KEY, String(visible));
    applyVisibility();
    onToggle?.(visible);
    return visible;
  }

  function applyVisibility() {
    document.body.dataset.symbolsVisible = String(visible);
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-pressed", String(visible));
      toggleBtn.title = visible
        ? "Teclado táctil y barra de símbolos activos (tocá para volver a Modo Teclado Físico sin barra flotante)"
        : "Modo Teclado Físico activo: sin barra flotante de teclado virtual en iPad (tocá para abrir teclado en pantalla)";
    }
  }

  /**
   * Actualiza las teclas rápidas según la extensión o lenguaje del archivo activo.
   * @param {string} langKey
   */
  function setLanguage(langKey) {
    const normalized =
      langKey === "c" ? "cpp"
      : langKey === "tsx" || langKey === "typescript" ? "ts"
      : langKey;
    const config = LANGUAGE_SYMBOLS[normalized] ?? LANGUAGE_SYMBOLS.js;
    if (langPill) {
      langPill.textContent = config.label;
    }
    if (!track) {
      return;
    }

    track.innerHTML = "";
    for (const item of config.keys) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "symbol-key";
      btn.textContent = item.label;
      btn.setAttribute("aria-label", `Insertar ${item.label}`);

      btn.addEventListener("pointerdown", (event) => {
        event.preventDefault();
      });

      btn.addEventListener("click", () => {
        onInsert(item.insert, item.cursorBack);
      });

      track.appendChild(btn);
    }
  }

  return {
    setLanguage,
    isVisible: () => visible,
    setVisible,
    destroy() {
      listenerController?.abort();
    }
  };
}

function readDefaultVisibility() {
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(pointer: coarse)").matches;
  }
  return true;
}
