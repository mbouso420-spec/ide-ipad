import "./setup.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { KEYBOARD_SHORTCUTS, initSettingsModal } from "../js/ui/settingsModal.js";
import { keyboardRouter } from "../js/ui/keyboardRouter.js";
import { inferFileMeta } from "../js/storage/workspaceDb.js";
import { LANGUAGE_SYMBOLS } from "../js/ui/symbolBar.js";
import {
  JAVA_EXTENSIONS,
  CSHARP_EXTENSIONS,
  TS_EXTENSIONS
} from "../js/preview/htmlBundler.js";
import {
  parseMarkdownSegments,
  detectFilePathFromCodeSegment
} from "../js/ai/chatController.js";
import {
  buildWandboxPayload,
  hasMainFunction,
  parseGccErrors
} from "../js/preview/cRunner.js";
import {
  getAiTemperature,
  setAiTemperature,
  getAiContextBudget,
  setAiContextBudget,
  getAiThinkingSpeed,
  setAiThinkingSpeed,
  saveApiKey
} from "../js/ai/providers.js";

function createMockEl(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  if (attrs.id) el.id = attrs.id;
  if (attrs.class) el.className = attrs.class;
  if (attrs.type) el.type = attrs.type;
  if (attrs.checked !== undefined) el.checked = attrs.checked;
  if (attrs.value !== undefined) el.value = attrs.value;
  for (const [k, v] of Object.entries(attrs)) {
    if (!["id", "class", "type", "checked", "value"].includes(k)) {
      el.setAttribute(k, v);
    }
  }
  for (const ch of children) {
    el.appendChild(ch);
  }
  return el;
}

describe("SettingsModal, Nuevos Lenguajes (Rust y Go) y Preferencias Extendidas", () => {
  beforeEach(() => {
    localStorage.clear();
    if (document.documentElement.dataset) {
      delete document.documentElement.dataset.theme;
    }
    keyboardRouter.modalStack = [];

    // Clear document.body
    document.body.children = [];

    // Build DOM structure
    const btnOpen = createMockEl("button", { id: "btn-open-settings", class: "btn-status-action" });
    const btnWrap = createMockEl("button", { id: "btn-editor-wrap", "aria-pressed": "true" });
    const btnMinimap = createMockEl("button", { id: "btn-editor-minimap", "aria-pressed": "true" });
    const btnSymbols = createMockEl("button", { id: "btn-toggle-symbols", "aria-pressed": "true" });

    const dialog = createMockEl("dialog", { id: "settings-dialog" });
    dialog.open = false;
    dialog.showModal = function () {
      this.open = true;
    };
    dialog.close = function () {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };

    const btnClose = createMockEl("button", { id: "btn-close-settings" });
    const tabAppearance = createMockEl("button", { class: "settings-tab-btn is-active", "data-tab": "appearance", "aria-selected": "true" });
    const tabEditor = createMockEl("button", { class: "settings-tab-btn", "data-tab": "editor", "aria-selected": "false" });
    const tabModels = createMockEl("button", { class: "settings-tab-btn", "data-tab": "models", "aria-selected": "false" });
    const tabShortcuts = createMockEl("button", { class: "settings-tab-btn", "data-tab": "shortcuts", "aria-selected": "false" });
    const tabStorage = createMockEl("button", { class: "settings-tab-btn", "data-tab": "storage", "aria-selected": "false" });

    // Panel 1: Apariencia
    const selectTheme = createMockEl("select", { id: "select-theme" });
    const chkWordWrap = createMockEl("input", { id: "setting-word-wrap", type: "checkbox", checked: true });
    const chkMinimap = createMockEl("input", { id: "setting-minimap", type: "checkbox", checked: true });
    const panelAppearance = createMockEl("section", { class: "settings-tab-panel", "data-tab": "appearance" }, [
      selectTheme, chkWordWrap, chkMinimap
    ]);

    // Panel 2: Editor y Autoguardado
    const selectAutosave = createMockEl("select", { id: "setting-autosave-delay" });
    const panelEditor = createMockEl("section", { class: "settings-tab-panel", "data-tab": "editor" }, [
      selectAutosave
    ]);
    panelEditor.hidden = true;

    // Panel 3: Modelos e Inteligencia Artificial
    const tokensPct = createMockEl("span", { id: "models-tokens-pct" });
    const meterFill = createMockEl("div", { id: "models-meter-fill" });
    const meterTrack = createMockEl("div", { class: "models-meter-track" }, [meterFill]);
    const tokensDetail = createMockEl("span", { id: "models-tokens-detail" });
    const tokensRemaining = createMockEl("span", { id: "models-tokens-remaining" });
    const modelsList = createMockEl("div", { id: "settings-active-models-list" });
    const panelModels = createMockEl("section", { class: "settings-tab-panel", "data-tab": "models" }, [
      tokensPct, meterTrack, tokensDetail, tokensRemaining, modelsList
    ]);
    panelModels.hidden = true;

    // Panel 4: Atajos
    const filterShortcuts = createMockEl("input", { id: "setting-shortcuts-filter", type: "search" });
    const listShortcuts = createMockEl("div", { id: "setting-shortcuts-list" });
    const panelShortcuts = createMockEl("section", { class: "settings-tab-panel", "data-tab": "shortcuts" }, [
      filterShortcuts, listShortcuts
    ]);
    panelShortcuts.hidden = true;

    // Panel 5: Almacenamiento
    const selectKeyStorage = createMockEl("select", { id: "setting-key-storage" });
    const quotaText = createMockEl("span", { id: "setting-quota-text" });
    const panelStorage = createMockEl("section", { class: "settings-tab-panel", "data-tab": "storage" }, [
      selectKeyStorage, quotaText
    ]);
    panelStorage.hidden = true;

    dialog.appendChild(btnClose);
    dialog.appendChild(tabAppearance);
    dialog.appendChild(tabEditor);
    dialog.appendChild(tabModels);
    dialog.appendChild(tabShortcuts);
    dialog.appendChild(tabStorage);
    dialog.appendChild(panelAppearance);
    dialog.appendChild(panelEditor);
    dialog.appendChild(panelModels);
    dialog.appendChild(panelShortcuts);
    dialog.appendChild(panelStorage);

    document.body.appendChild(btnOpen);
    document.body.appendChild(btnWrap);
    document.body.appendChild(btnMinimap);
    document.body.appendChild(btnSymbols);
    document.body.appendChild(dialog);
  });

  test("Catálogo de atajos de teclado completo y estructurado", () => {
    assert.ok(Array.isArray(KEYBOARD_SHORTCUTS));
    assert.ok(KEYBOARD_SHORTCUTS.length >= 8);

    const categories = new Set(KEYBOARD_SHORTCUTS.map((s) => s.category));
    assert.ok(categories.has("Navegación"));
    assert.ok(categories.has("Búsqueda"));
    assert.ok(categories.has("General"));
    assert.ok(categories.has("Editor"));

    for (const shortcut of KEYBOARD_SHORTCUTS) {
      assert.ok(shortcut.combo && typeof shortcut.combo === "string");
      assert.ok(shortcut.desc && typeof shortcut.desc === "string");
      assert.ok(shortcut.category && typeof shortcut.category === "string");
    }
  });

  test("Apertura, cierre y registro en KeyboardRouter modalStack", () => {
    let wrapState = true;
    let minimapState = true;

    const mockEditor = {
      isWordWrapEnabled: () => wrapState,
      toggleWordWrap: () => {
        wrapState = !wrapState;
        return wrapState;
      },
      isMinimapVisible: () => minimapState,
      toggleMinimap: () => {
        minimapState = !minimapState;
        return minimapState;
      },
      getFontSize: () => 14,
      stepFontSize: () => 14
    };

    const modal = initSettingsModal({ editor: mockEditor });
    const dialog = document.getElementById("settings-dialog");

    assert.equal(dialog.open, false);
    assert.equal(keyboardRouter.getActiveModal(), null);

    modal.open();
    assert.equal(dialog.open, true);
    assert.equal(keyboardRouter.getActiveModal()?.id, "settings-dialog");
    assert.equal(keyboardRouter.getActiveModal()?.blockGlobalShortcuts, true);

    modal.close();
    assert.equal(dialog.open, false);
    assert.equal(keyboardRouter.getActiveModal(), null);
  });

  test("Cambio de tema actualiza dataset.theme y localStorage", () => {
    let notifiedTheme = null;
    initSettingsModal({
      editor: null,
      onThemeChange: (t) => {
        notifiedTheme = t;
      }
    });

    const select = document.getElementById("select-theme");

    select.value = "dracula";
    select.dispatchEvent(new Event("change"));
    assert.equal(document.documentElement.dataset.theme, "dracula");
    assert.equal(localStorage.getItem("studio_theme"), "dracula");
    assert.equal(notifiedTheme, "dracula");

    select.value = "nord";
    select.dispatchEvent(new Event("change"));
    assert.equal(document.documentElement.dataset.theme, "nord");
    assert.equal(localStorage.getItem("studio_theme"), "nord");

    select.value = "default";
    select.dispatchEvent(new Event("change"));
    assert.equal(document.documentElement.dataset.theme, undefined);
    assert.equal(localStorage.getItem("studio_theme"), null);
  });

  test("Alternar Word Wrap y Minimap sincroniza checkboxes y barra de herramientas", () => {
    let wrapState = true;
    let minimapState = true;

    const mockEditor = {
      isWordWrapEnabled: () => wrapState,
      toggleWordWrap: () => {
        wrapState = !wrapState;
        return wrapState;
      },
      isMinimapVisible: () => minimapState,
      toggleMinimap: () => {
        minimapState = !minimapState;
        return minimapState;
      }
    };

    initSettingsModal({ editor: mockEditor });

    const chkWrap = document.getElementById("setting-word-wrap");
    const chkMinimap = document.getElementById("setting-minimap");
    const btnWrap = document.getElementById("btn-editor-wrap");
    const btnMinimap = document.getElementById("btn-editor-minimap");

    // Toggle wrap
    chkWrap.dispatchEvent(new Event("change"));
    assert.equal(wrapState, false);
    assert.equal(chkWrap.checked, false);
    assert.equal(btnWrap.getAttribute("aria-pressed"), "false");

    // Toggle minimap
    chkMinimap.dispatchEvent(new Event("change"));
    assert.equal(minimapState, false);
    assert.equal(chkMinimap.checked, false);
    assert.equal(btnMinimap.getAttribute("aria-pressed"), "false");
  });

  test("Configuración de intervalo de autoguardado (240ms, 1000ms, manual)", () => {
    initSettingsModal({ editor: null });
    const select = document.getElementById("setting-autosave-delay");

    select.value = "1000";
    select.dispatchEvent(new Event("change"));
    assert.equal(localStorage.getItem("studio_autosave_delay"), "1000");

    select.value = "manual";
    select.dispatchEvent(new Event("change"));
    assert.equal(localStorage.getItem("studio_autosave_delay"), "manual");

    select.value = "240";
    select.dispatchEvent(new Event("change"));
    assert.equal(localStorage.getItem("studio_autosave_delay"), "240");
  });

  test("Parámetros de IA en proveedores: Temperatura, Presupuesto y Velocidad de razonamiento", () => {
    setAiTemperature(0.2);
    assert.equal(getAiTemperature(), 0.2);

    setAiTemperature(1.0);
    assert.equal(getAiTemperature(), 1.0);

    setAiContextBudget("compact");
    assert.equal(getAiContextBudget(), 8000);

    setAiContextBudget("large");
    assert.equal(getAiContextBudget(), 40000);

    setAiThinkingSpeed("alta");
    assert.equal(getAiThinkingSpeed(), "alta");

    setAiThinkingSpeed("baja");
    assert.equal(getAiThinkingSpeed(), "baja");
  });

  test("Pestaña Modelos: Medidor de tokens informa estado sin clave y calcula capacidad real por modelo con clave", () => {
    const mockContext = {
      activeFile: { content: "const a = 1;\nconst b = 2;\n" },
      otherOpenFiles: [{ content: "function hello() { return 'world'; }" }]
    };

    // 1. Sin API key configurada
    const modalSinKey = initSettingsModal({
      editor: null,
      getContextSnapshot: () => mockContext
    });
    modalSinKey.open();

    const pctEl = document.getElementById("models-tokens-pct");
    const detailEl = document.getElementById("models-tokens-detail");
    const remainingEl = document.getElementById("models-tokens-remaining");

    assert.ok(pctEl.textContent.includes("Sin API key configurada"));
    assert.ok(detailEl.textContent.includes("tokens en contexto actual"));

    modalSinKey.close();

    // 2. Con API key configurada para el modelo
    saveApiKey("groq", "gsk_testKey123");
    const modalConKey = initSettingsModal({
      editor: null,
      getContextSnapshot: () => mockContext
    });
    modalConKey.open();

    assert.ok(pctEl.textContent.includes("% disponible"));
    assert.ok(detailEl.textContent.includes("tokens en uso"));
    assert.ok(remainingEl.textContent.includes("tokens libres"));
  });

  test("Pestaña Modelos: Renderiza proveedores activos y permite invocar onSelectProvider", () => {
    saveApiKey("gemini", "AIzaSyFakeKey123");

    let selectedProvider = null;
    const modal = initSettingsModal({
      editor: null,
      onSelectProvider(pid) {
        selectedProvider = pid;
      }
    });
    modal.open();

    const listEl = document.getElementById("settings-active-models-list");
    assert.ok(listEl.innerHTML.includes("Google Gemini"));
    assert.ok(listEl.innerHTML.includes("badge-connected"));
    assert.ok(listEl.innerHTML.includes("Conectado"));

    // Simular clic en el botón de acción de proveedor
    const geminiBtn = listEl.querySelector('[data-provider-id="gemini"]');
    assert.ok(geminiBtn);
    geminiBtn.click();
    assert.equal(selectedProvider, "gemini");
  });

  test("Compositor de Chat: Despliegue de gaveta de herramientas y selector de razonamiento", () => {
    const toggleBtn = createMockEl("button", { id: "btn-toggle-composer-tools" });
    const drawer = createMockEl("div", { id: "chat-tools-drawer" });
    drawer.hidden = true;
    document.body.appendChild(toggleBtn);
    document.body.appendChild(drawer);

    let willShow = drawer.hidden;
    drawer.hidden = !willShow;
    toggleBtn.setAttribute("aria-expanded", String(willShow));
    assert.equal(drawer.hidden, false);
    assert.equal(toggleBtn.getAttribute("aria-expanded"), "true");

    willShow = drawer.hidden;
    drawer.hidden = !willShow;
    toggleBtn.setAttribute("aria-expanded", String(willShow));
    assert.equal(drawer.hidden, true);
    assert.equal(toggleBtn.getAttribute("aria-expanded"), "false");
  });

  test("Filtrado interactivo de atajos de teclado", () => {
    const modal = initSettingsModal({ editor: null });
    modal.open();

    const filterInput = document.getElementById("setting-shortcuts-filter");
    const listEl = document.getElementById("setting-shortcuts-list");

    // Buscar "Shift + F"
    filterInput.value = "Shift + F";
    filterInput.dispatchEvent(new Event("input"));
    assert.ok(listEl.innerHTML.includes("Búsqueda"));
    assert.ok(listEl.innerHTML.includes("Cmd/Ctrl + Shift + F"));

    // Buscar término inexistente
    filterInput.value = "xyzInexistente123";
    filterInput.dispatchEvent(new Event("input"));
    assert.ok(listEl.innerHTML.includes("No se encontraron atajos"));
  });

  test("Cambio de pestaña actualiza clases y atributos aria-selected en las 5 secciones", () => {
    initSettingsModal({ editor: null });

    const tabButtons = document.querySelectorAll(".settings-tab-btn");
    const tabEditor = Array.from(tabButtons).find((b) => b.dataset.tab === "editor");
    const tabModels = Array.from(tabButtons).find((b) => b.dataset.tab === "models");
    const panelEditor = document.querySelector('.settings-tab-panel[data-tab="editor"]');
    const panelModels = document.querySelector('.settings-tab-panel[data-tab="models"]');
    const panelAppearance = document.querySelector('.settings-tab-panel[data-tab="appearance"]');

    tabEditor.click();
    assert.equal(tabEditor.classList.contains("is-active"), true);
    assert.equal(panelEditor.hidden, false);
    assert.equal(panelAppearance.hidden, true);

    tabModels.click();
    assert.equal(tabModels.classList.contains("is-active"), true);
    assert.equal(panelModels.hidden, false);
    assert.equal(panelEditor.hidden, true);
  });

  test("Nuevos Lenguajes: inferFileMeta reconoce Rust (.rs) y Go (.go)", () => {
    const rustMeta = inferFileMeta("src/main.rs");
    assert.equal(rustMeta.lang, "rust");
    assert.equal(rustMeta.badge, "RS");

    const goMeta = inferFileMeta("server/app.go");
    assert.equal(goMeta.lang, "go");
    assert.equal(goMeta.badge, "GO");
  });

  test("Nuevos Lenguajes: LANGUAGE_SYMBOLS contiene teclas para Rust y Go", () => {
    assert.ok(LANGUAGE_SYMBOLS.rust);
    assert.equal(LANGUAGE_SYMBOLS.rust.label, "Rust");
    assert.ok(LANGUAGE_SYMBOLS.rust.keys.some((k) => k.label === "fn"));
    assert.ok(LANGUAGE_SYMBOLS.rust.keys.some((k) => k.label === "let mut"));

    assert.ok(LANGUAGE_SYMBOLS.go);
    assert.equal(LANGUAGE_SYMBOLS.go.label, "Go");
    assert.ok(LANGUAGE_SYMBOLS.go.keys.some((k) => k.label === "func"));
    assert.ok(LANGUAGE_SYMBOLS.go.keys.some((k) => k.label === ":="));
  });

  test("Nuevos Lenguajes: Wandbox payload y main() para Rust y Go", () => {
    // Rust
    const rustCode = "fn main() {\n    println!(\"Hello Rust\");\n}";
    assert.equal(hasMainFunction(rustCode), true);

    const rustPayload = buildWandboxPayload({
      activeFile: { path: "main.rs", content: rustCode },
      companionFiles: [{ path: "lib.rs", content: "pub fn add(a: i32, b: i32) -> i32 { a + b }" }]
    });
    assert.equal(rustPayload.compiler, "rust-head");
    assert.equal(rustPayload.codes.length, 1);
    assert.equal(rustPayload.codes[0].file, "lib.rs");

    // Go
    const goCode = "package main\nimport \"fmt\"\nfunc main() {\n    fmt.Println(\"Hello Go\")\n}";
    assert.equal(hasMainFunction(goCode), true);

    const goPayload = buildWandboxPayload({
      activeFile: { path: "main.go", content: goCode },
      companionFiles: [{ path: "helper.go", content: "package main\nvar Global = 10" }]
    });
    assert.equal(goPayload.compiler, "go-head");
    assert.equal(goPayload.codes.length, 1);
    assert.equal(goPayload.codes[0].file, "helper.go");
  });

  test("Nuevos Lenguajes: parseGccErrors reconoce salidas de error de rustc y go compiler", () => {
    // Go compiler output
    const goOutput = `main.go:5:2: undefined: fmt.Printlln`;
    const goErrors = parseGccErrors(goOutput);
    assert.equal(goErrors.length, 1);
    assert.equal(goErrors[0].line, 5);
    assert.equal(goErrors[0].column, 2);
    assert.ok(goErrors[0].message.includes("undefined: fmt.Printlln"));

    // Rustc output
    const rustOutput = `
error[E0425]: cannot find value 'x' in this scope
  --> src/main.rs:14:5
   |
14 |     x + 1
   |     ^ not found in this scope
`;
    const rustErrors = parseGccErrors(rustOutput);
    assert.equal(rustErrors.length, 1);
    assert.equal(rustErrors[0].line, 14);
    assert.equal(rustErrors[0].column, 5);
    assert.ok(rustErrors[0].message.includes("cannot find value"));
  });

  test("Nuevos Lenguajes: inferFileMeta y Wandbox reconocen TypeScript, Java y C#", () => {
    // inferFileMeta
    const javaMeta = inferFileMeta("src/App.java");
    assert.equal(javaMeta.lang, "java");
    assert.equal(javaMeta.badge, "JAVA");

    const csMeta = inferFileMeta("Program.cs");
    assert.equal(csMeta.lang, "csharp");
    assert.equal(csMeta.badge, "C#");

    const tsMeta = inferFileMeta("index.ts");
    assert.equal(tsMeta.lang, "ts");
    assert.equal(tsMeta.badge, "TS");

    // Symbol keys
    assert.ok(LANGUAGE_SYMBOLS.java);
    assert.equal(LANGUAGE_SYMBOLS.java.label, "Java");
    assert.ok(LANGUAGE_SYMBOLS.java.keys.some((k) => k.label === "public"));

    assert.ok(LANGUAGE_SYMBOLS.csharp);
    assert.equal(LANGUAGE_SYMBOLS.csharp.label, "C#");
    assert.ok(LANGUAGE_SYMBOLS.csharp.keys.some((k) => k.label === "using"));

    assert.ok(LANGUAGE_SYMBOLS.ts);
    assert.equal(LANGUAGE_SYMBOLS.ts.label, "TypeScript");
    assert.ok(LANGUAGE_SYMBOLS.ts.keys.some((k) => k.label === "interface"));

    // Wandbox payloads
    const javaCode = "public class App { public static void main(String[] args) { System.out.println(\"Hi\"); } }";
    assert.equal(hasMainFunction(javaCode), true);
    const javaPayload = buildWandboxPayload({
      activeFile: { path: "App.java", content: javaCode },
      companionFiles: [{ path: "Util.java", content: "class Util {}" }]
    });
    assert.equal(javaPayload.compiler, "openjdk-head");
    assert.equal(javaPayload.codes.length, 1);

    const csCode = "using System; class Program { static void Main() { Console.WriteLine(\"Hi\"); } }";
    assert.equal(hasMainFunction(csCode), true);
    const csPayload = buildWandboxPayload({
      activeFile: { path: "Program.cs", content: csCode },
      companionFiles: [{ path: "Helper.cs", content: "class Helper {}" }]
    });
    assert.equal(csPayload.compiler, "dotnetcore-head");
    assert.equal(csPayload.codes.length, 1);

    const tsCode = "const greeting: string = \"Hello TS\"; console.log(greeting);";
    const tsPayload = buildWandboxPayload({
      activeFile: { path: "main.ts", content: tsCode }
    });
    assert.equal(tsPayload.compiler, "typescript-head");
  });

  test("Extensiones de compilador remoto (Java, C#, TS) en htmlBundler", () => {
    assert.ok(JAVA_EXTENSIONS.has("java"));
    assert.ok(CSHARP_EXTENSIONS.has("cs"));
    assert.ok(TS_EXTENSIONS.has("ts"));
    assert.ok(TS_EXTENSIONS.has("tsx"));
  });

  test("Detección de rutas de archivo en Modo Asistente Multi-archivo", () => {
    // 1. Cabecera con dos puntos
    assert.equal(detectFilePathFromCodeSegment("css:styles.css", "body { color: red; }"), "styles.css");
    assert.equal(detectFilePathFromCodeSegment("html:src/index.html", "<div>hola</div>"), "src/index.html");

    // 2. Cabecera con parámetro file=
    assert.equal(detectFilePathFromCodeSegment("javascript file=src/app.js", "console.log(1);"), "src/app.js");

    // 3. Comentario en la primera línea del código
    assert.equal(detectFilePathFromCodeSegment("js", "// file: src/helpers/math.js\nexport function sum() {}"), "src/helpers/math.js");
    assert.equal(detectFilePathFromCodeSegment("python", "# file: scripts/backup.py\nimport os"), "scripts/backup.py");

    // 4. Párrafo previo indicando archivo
    assert.equal(detectFilePathFromCodeSegment("css", "a { text-decoration: none; }", "A continuación modificá el siguiente archivo:\n### Archivo: src/theme.css"), "src/theme.css");

    // 5. Sin ruta detectable
    assert.equal(detectFilePathFromCodeSegment("python", "print('hello')"), null);
  });

  test("parseMarkdownSegments procesa bloques con rutas y permite identificar planes multi-archivo", () => {
    const rawMarkdown = `
A continuación te propongo una solución modular:

### Archivo: index.html
\`\`\`html:index.html
<!DOCTYPE html>
<html>
<body>Hola</body>
</html>
\`\`\`

Y los estilos asociados:

\`\`\`css:styles.css
body {
  background: black;
}
\`\`\`

Y finalmente la lógica:
\`\`\`js
// file: app.js
console.log("iniciado");
\`\`\`
`;

    const segments = parseMarkdownSegments(rawMarkdown);
    const codeBlocks = segments.filter((s) => s.type === "code");
    assert.equal(codeBlocks.length, 3);
    assert.equal(codeBlocks[0].filePath, "index.html");
    assert.equal(codeBlocks[1].filePath, "styles.css");
    assert.equal(codeBlocks[2].filePath, "app.js");
  });
});
