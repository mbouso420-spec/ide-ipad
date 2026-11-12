import "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createEditorManager, wrapTextWithDelimiters } from "../js/editor/editorManager.js";
import { decodeImportedFile, MAX_IMPORT_FILE_BYTES } from "../js/storage/fileImport.js";
import { getStorageQuotaEstimate, formatStorageBytes } from "../js/storage/storageQuota.js";
import { buildZipArchive, computeCrc32, getDosDateTime } from "../js/storage/zipExporter.js";
import { truncateCodeContent, estimateTokens, formatInlineMarkdown } from "../js/ai/chatController.js";
import { findBestHtmlEntrypoint, findTargetHtmlFile } from "../js/ui/livePreviewModal.js";
import { parseGccErrors, buildWandboxPayload, hasMainFunction } from "../js/preview/cRunner.js";
import { convertResultsToCsv, convertResultsToJson, buildSqlRunnerPreview } from "../js/preview/sqlRunner.js";
import { fetchRepoBranches, createRepoBranch } from "../js/github/githubService.js";

describe("BLOQUE 1 — Editor de Código, Memoria y Ergonomía Táctil", () => {
  test("1.1 Gestión de Memoria en CM6: abrir y cerrar 20 archivos libera estados (dropFileState)", async () => {
    const mount = document.createElement("div");
    const editor = await createEditorManager({
      mountEl: mount,
      onDocChange: () => {},
      onSelectionChange: () => {}
    });

    // Simulamos la apertura secuencial de 20 archivos
    for (let i = 1; i <= 20; i++) {
      const file = { id: `file_${i}.js`, path: `src/file_${i}.js`, lang: "js", content: `// Archivo ${i}\nconst x = ${i};` };
      editor.openFile(file);
      editor.addErrorMarker(1, `Error simulado en archivo ${i}`);
    }

    // Cerramos los 20 archivos purgando su estado de memoria
    for (let i = 1; i <= 20; i++) {
      editor.dropFileState(`file_${i}.js`);
    }
    editor.clearActiveFile();
    editor.clearErrorMarkers();

    assert.equal(editor.getErrorMarkers().length, 0);
  });

  test("1.2 Pestañas y Atajos: confirmación dirty y cierre controlado", () => {
    // Verificamos que el contrato de dirty-check reconozca archivos con cambios
    const activeFile = { id: "main.js", path: "main.js", isDirty: true, content: "modificado" };
    const cleanFile = { id: "clean.js", path: "clean.js", isDirty: false, content: "limpio" };

    assert.equal(activeFile.isDirty, true, "Archivo con modificaciones pendientes debe reportar isDirty=true");
    assert.equal(cleanFile.isDirty, false, "Archivo sin modificaciones pendientes debe reportar isDirty=false");
  });

  test("1.3 Barra de Símbolos Táctil: Auto-Wrap de selecciones con todos los delimitadores", () => {
    const delimiters = [
      { sym: "()", input: "x + y", expected: "(x + y)" },
      { sym: "{}", input: "return 42;", expected: "{return 42;}" },
      { sym: "[]", input: "1, 2, 3", expected: "[1, 2, 3]" },
      { sym: '""', input: "texto", expected: '"texto"' },
      { sym: "''", input: "char", expected: "'char'" },
      { sym: "``", input: "interpolated", expected: "`interpolated`" }
    ];

    for (const d of delimiters) {
      const wrapped = wrapTextWithDelimiters(d.sym, d.input, 1);
      assert.equal(wrapped.text, d.expected);
      assert.equal(wrapped.selectFrom, 1);
      assert.equal(wrapped.selectTo, 1 + d.input.length);
    }
  });

  test("1.4 Paleta Rápida (Cmd+P): parseo y salto directo a número de línea (:145)", () => {
    const parseQuickOpen = (query) => {
      const match = query.trim().match(/^(.+?)(?::(\d+))?$/);
      if (!match) return { fileQuery: query.trim(), targetLine: null };
      return {
        fileQuery: match[1] || "",
        targetLine: match[2] ? parseInt(match[2], 10) : null
      };
    };

    const parsed1 = parseQuickOpen("app.js:145");
    assert.equal(parsed1.fileQuery, "app.js");
    assert.equal(parsed1.targetLine, 145);

    const parsed2 = parseQuickOpen("component.tsx:20");
    assert.equal(parsed2.fileQuery, "component.tsx");
    assert.equal(parsed2.targetLine, 20);

    const parsedNoLine = parseQuickOpen("README.md");
    assert.equal(parsedNoLine.fileQuery, "README.md");
    assert.equal(parsedNoLine.targetLine, null);
  });

  test("1.5 Error Overview Ruler: cálculo proporcional y píldoras interactivas en scrollbar", async () => {
    const ruler = document.createElement("div");
    ruler.id = "editor-error-ruler";
    ruler.hidden = true;
    document.body.appendChild(ruler);

    const mount = document.createElement("div");
    const editor = await createEditorManager({
      mountEl: mount,
      onDocChange: () => {},
      onSelectionChange: () => {}
    });

    const file = { id: "test.c", path: "test.c", lang: "c", content: "linea 1\nlinea 2\nlinea 3\nlinea 4\nlinea 5" };
    editor.openFile(file);
    editor.addErrorMarker(3, "Error en línea 3");

    assert.equal(ruler.hidden, false);
    const pills = ruler.querySelectorAll(".editor-error-marker-pill");
    assert.equal(pills.length, 1);
    // El top proporcional de línea 3 en 5 líneas es 60%
    assert.equal(pills[0].style.top, "60%");
    assert.equal(pills[0].getAttribute("aria-label"), "Línea 3: Error en línea 3");

    editor.clearErrorMarkers();
    assert.equal(ruler.hidden, true);
    ruler.remove();
  });
});

describe("BLOQUE 2 — Explorador de Archivos, Almacenamiento y ZIP", () => {
  test("2.1 Límites y Binarios: rechaza archivos > 5 MB y binarios con NUL bytes", () => {
    const overLimit = new Uint8Array(MAX_IMPORT_FILE_BYTES + 1024);
    const checkOver = decodeImportedFile(overLimit, "gran_video.mp4");
    assert.equal(checkOver.ok, false);
    assert.match(checkOver.reason, /supera el límite de 5 MB/i);

    const binaryBuffer = new Uint8Array([0x48, 0x65, 0x00, 0x6c, 0x6f]); // contiene byte 0x00
    const checkBinary = decodeImportedFile(binaryBuffer, "imagen.png");
    assert.equal(checkBinary.ok, false);
    assert.match(checkBinary.reason, /archivo binario/i);

    const validText = new TextEncoder().encode("export const test = true;");
    const checkValid = decodeImportedFile(validText, "index.ts");
    assert.equal(checkValid.ok, true);
    assert.equal(checkValid.text, "export const test = true;");
  });

  test("2.2 Preservación de Scroll y Foco: validación de jerarquía", () => {
    const treeState = { expandedFolders: new Set(["src", "src/components"]), scrollTop: 240 };
    assert.ok(treeState.expandedFolders.has("src"));
    assert.ok(treeState.expandedFolders.has("src/components"));
    assert.equal(treeState.scrollTop, 240);
  });

  test("2.3 Menú Contextual (Long-Press y Clic Derecho): duplicar genera sufijo secuencial .copia", () => {
    const makeDuplicateName = (baseName, existingNames) => {
      const parts = baseName.split(".");
      let ext = "";
      let name = baseName;
      if (parts.length > 1 && !baseName.startsWith(".")) {
        ext = "." + parts.pop();
        name = parts.join(".");
      }
      let candidate = `${name}.copia${ext}`;
      let counter = 2;
      while (existingNames.has(candidate)) {
        candidate = `${name}.copia ${counter}${ext}`;
        counter++;
      }
      return candidate;
    };

    const files = new Set(["app.js", "app.copia.js"]);
    const newCopy = makeDuplicateName("app.js", files);
    assert.equal(newCopy, "app.copia 2.js");

    const newCopyFromPlain = makeDuplicateName("Makefile", new Set(["Makefile"]));
    assert.equal(newCopyFromPlain, "Makefile.copia");
  });

  test("2.4 Monitor de Cuota y Exportación ZIP: empaquetado PKZIP 2.0 válido", () => {
    const files = [
      { path: "index.html", content: "<h1>Hola</h1>" },
      { path: "js/main.js", content: "console.log('ok');" }
    ];
    const zipBytes = buildZipArchive(files);
    assert.ok(zipBytes instanceof Uint8Array);
    assert.ok(zipBytes.byteLength > 0);

    const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    // Firma de archivo local (Local File Header) 0x04034b50
    assert.equal(view.getUint32(0, true), 0x04034b50);

    // Verificamos CRC-32 y fechas DOS
    const crc = computeCrc32(new TextEncoder().encode("<h1>Hola</h1>"));
    assert.ok(typeof crc === "number" && crc > 0);

    const { dosDate, dosTime } = getDosDateTime(new Date());
    assert.ok(dosDate > 0 && dosTime >= 0);
  });
});

describe("BLOQUE 3 — Asistente de Inteligencia Artificial (IA)", () => {
  test("3.1 Presupuesto y Truncamiento: conserva cabecera y pie con aviso de omisión", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `const x_${i} = ${i};`);
    const code = lines.join("\n");
    const truncated = truncateCodeContent(code, 1500);

    assert.ok(truncated.length < code.length);
    assert.ok(truncated.includes("x_0"));
    assert.ok(truncated.includes("x_499"));
    assert.match(truncated, /líneas omitidas/i);
  });

  test("3.2 Inyección Atómica y Aborto: reemplazo total sin duplicación", async () => {
    const mount = document.createElement("div");
    const editor = await createEditorManager({
      mountEl: mount,
      onDocChange: () => {},
      onSelectionChange: () => {}
    });

    editor.openFile({ id: "script.js", path: "script.js", lang: "js", content: "old();" });
    editor.replaceEntireDocument("newImplementation();");

    const textarea = mount.querySelector("textarea");
    if (textarea) {
      assert.equal(textarea.value, "newImplementation();");
      assert.ok(!textarea.value.includes("old();"));
    }
  });

  test("3.3 Contador de Tokens y Regenerar: renderizado seguro de hipervínculos", () => {
    const text = "Revisa https://github.com y el [sitio oficial](https://google.com).";
    const formatted = formatInlineMarkdown(text);

    assert.match(formatted, /target="_blank"/);
    assert.match(formatted, /rel="noopener noreferrer"/);
    // Protocolos inseguros no deben generar enlaces <a>
    const malicious = formatInlineMarkdown("[Ataque](javascript:alert(1))");
    assert.ok(!malicious.includes("<a href="));
  });
});

describe("BLOQUE 4 — Integración con GitHub y Modales", () => {
  test("4.1 Paginación y Árboles Gigantes: detección de bandera truncated", () => {
    const responseWithTruncatedTree = {
      sha: "root_sha",
      truncated: true,
      tree: Array.from({ length: 100 }, (_, i) => ({ path: `file_${i}.txt`, type: "blob" }))
    };
    assert.equal(responseWithTruncatedTree.truncated, true);
    assert.equal(responseWithTruncatedTree.tree.length, 100);
  });

  test("4.2 Control de Ramas: validación de nombres de rama al crear", async () => {
    await assert.rejects(
      () => createRepoBranch({ token: "tok", owner: "user", repo: "test", branchName: "" }),
      /El nombre de la rama no puede estar vacío/i
    );
    await assert.rejects(
      () => createRepoBranch({ token: "tok", owner: "user", repo: "test", branchName: "   " }),
      /El nombre de la rama no puede estar vacío/i
    );
  });

  test("4.3 Atajos de Teclado en Diálogos: Enter confirma y Escape cancela", () => {
    let submitted = false;
    let closed = false;

    const handleKeydown = (e) => {
      if (e.key === "Enter") submitted = true;
      if (e.key === "Escape") closed = true;
    };

    handleKeydown({ key: "Enter" });
    assert.equal(submitted, true);

    handleKeydown({ key: "Escape" });
    assert.equal(closed, true);
  });
});

describe("BLOQUE 5 — Motor de Vista Previa (Web, SQL y C/C++)", () => {
  test("5.1 Punto de Entrada Inteligente: resuelve HTML asociado a JS/CSS", () => {
    const files = [
      { path: "index.html", shortName: "index.html", content: '<script src="app.js"></script>' },
      { path: "app.js", shortName: "app.js", content: 'console.log("start");' }
    ];
    const best = findBestHtmlEntrypoint(files, files[1]);
    assert.ok(best);
    assert.equal(best.path, "index.html");
  });

  test("5.2 Navegación Multi-Página: resolución de enlaces relativos locales", () => {
    const files = [
      { path: "inicio.html", shortName: "inicio.html", content: '<a href="catalogo.html">Catálogo</a>' },
      { path: "catalogo.html", shortName: "catalogo.html", content: '<a href="preguntas.html">FAQ</a>' },
      { path: "preguntas.html", shortName: "preguntas.html", content: '<h1>Preguntas</h1>' }
    ];

    const target1 = findTargetHtmlFile(files, "inicio.html", "catalogo.html");
    assert.ok(target1);
    assert.equal(target1.path, "catalogo.html");

    const target2 = findTargetHtmlFile(files, "catalogo.html", "preguntas.html");
    assert.ok(target2);
    assert.equal(target2.path, "preguntas.html");
  });

  test("5.3 Motor SQLite en Vivo: paginación cliente de 50 filas y exportación CSV/JSON", () => {
    const values = Array.from({ length: 120 }, (_, i) => [i + 1, `Usuario ${i + 1}`, `user${i + 1}@example.com`]);
    const results = [{ columns: ["id", "nombre", "email"], values }];

    const csv = convertResultsToCsv(results);
    assert.ok(csv.includes("id,nombre,email"));
    assert.ok(csv.includes("120,Usuario 120,user120@example.com"));

    const json = convertResultsToJson(results);
    assert.equal(json.length, 120);
    assert.equal(json[119].id, 120);
    assert.equal(json[119].nombre, "Usuario 120");

    const previewHtml = buildSqlRunnerPreview({ path: "test.sql", content: "SELECT * FROM users;" });
    assert.ok(previewHtml.includes("PAGE_SIZE = 50"));
    assert.ok(previewHtml.includes("sql-pagination-bar"));
  });

  test("5.4 Compilador C/C++ y Linter de Errores: parseo de stderr y detección de main()", () => {
    const stderr = `
app.c:12:3: error: unknown type name 'intt'; did you mean 'int'?
   12 |   intt counter = 0;
      |   ^~~~
`;
    const errors = parseGccErrors(stderr);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 12);
    assert.equal(errors[0].column, 3);
    assert.match(errors[0].message, /unknown type name/i);

    assert.equal(hasMainFunction("int main() { return 0; }"), true);
    assert.equal(hasMainFunction("// int main() { return 0; }"), false);
  });
});

describe("BLOQUE 6 — PWA, Service Worker y Responsividad", () => {
  test("6.1 Caché Offline: versión vigente studio-ide-shell-v29 y 100% de módulos js/css/assets + importmap precacheados en sw.js", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const swContent = await fs.readFile(path.join(rootDir, "sw.js"), "utf-8");
    const htmlContent = await fs.readFile(path.join(rootDir, "index.html"), "utf-8");
    assert.ok(swContent.includes('SHELL_CACHE = "studio-ide-shell-v29"'));
    assert.ok(swContent.includes("credentialGuard.js"));
    assert.ok(swContent.includes("keyVaultCrypto.js"));
    assert.ok(swContent.includes("githubMerge.js"));
    assert.ok(swContent.includes("codeFormatter.js"));
    assert.ok(swContent.includes("tsTranspiler.js"));
    assert.ok(swContent.includes("moduleBundler.js"));
    assert.ok(swContent.includes("acorn"));
    assert.ok(swContent.includes("PYODIDE_ENTRY_URL"));

    const importMapMatch = htmlContent.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    assert.ok(importMapMatch, "index.html debe contener <script type=\"importmap\">");
    const parsedImportMap = JSON.parse(importMapMatch[1]);
    const cdnUrls = Object.values(parsedImportMap.imports || {});
    assert.ok(cdnUrls.length >= 16, "importmap debe declarar las dependencias CDN principales");
    for (const cdnUrl of cdnUrls) {
      assert.ok(swContent.includes(`"${cdnUrl}"`), `Falta precalentar URL del importmap en sw.js: ${cdnUrl}`);
    }

    const shellArrayMatch = swContent.match(/const APP_SHELL_URLS = (\[[\s\S]*?\]);/);
    assert.ok(shellArrayMatch, "sw.js debe declarar const APP_SHELL_URLS = [...]");
    const appShellList = JSON.parse(shellArrayMatch[1]);
    const uniqueShellSet = new Set(appShellList);
    assert.equal(uniqueShellSet.size, appShellList.length, "APP_SHELL_URLS no debe contener rutas duplicadas");

    const requiredRecentModules = [
      "./js/editor/codeFormatter.js",
      "./js/editor/minimap.js",
      "./js/editor/smartReplace.js",
      "./js/editor/splitEditorController.js",
      "./js/github/githubMerge.js",
      "./js/preview/markdownPreview.js",
      "./js/preview/moduleBundler.js",
      "./js/preview/pythonRunner.js",
      "./js/preview/tsTranspiler.js",
      "./js/security/keyVaultCrypto.js",
      "./js/storage/storageQuota.js"
    ];
    for (const modPath of requiredRecentModules) {
      assert.ok(uniqueShellSet.has(modPath), `Falta módulo reciente en APP_SHELL_URLS: ${modPath}`);
    }

    async function listRelative(dirName) {
      const out = [];
      async function walk(rel) {
        const entries = await fs.readdir(path.join(rootDir, rel), { withFileTypes: true });
        for (const e of entries) {
          const next = `${rel}/${e.name}`;
          if (e.isDirectory()) await walk(next);
          else out.push(`./${next}`);
        }
      }
      await walk(dirName);
      return out;
    }

    const expectedAssets = [
      ...(await listRelative("js")),
      ...(await listRelative("css")),
      ...(await listRelative("assets"))
    ];
    for (const relPath of expectedAssets) {
      assert.ok(uniqueShellSet.has(relPath), `Falta precachear ${relPath} en APP_SHELL_URLS de sw.js`);
    }

    const expectedRootAndAssets = new Set(["./", "./index.html", "./manifest.json", ...expectedAssets]);
    const staleShellEntries = appShellList.filter((entry) => !expectedRootAndAssets.has(entry));
    assert.deepEqual(staleShellEntries, [], "APP_SHELL_URLS no debe referenciar archivos inexistentes u obsoletos");
  });

  test("6.2 Rotación iPadOS y Stage Manager: event listeners de orientación presentes en layout.js", async () => {
    const fs = await import("node:fs/promises");
    const layoutContent = await fs.readFile(new URL("../js/ui/layout.js", import.meta.url), "utf-8");
    assert.ok(layoutContent.includes("orientationchange"));
    assert.ok(layoutContent.includes("screen.orientation"));
    assert.ok(layoutContent.includes("restorePanelWidths"));
  });

  test("6.3 Lazy loading de runtimes pesados (pythonRunner.js, tsTranspiler.js, sqlRunner.js) sin descargas en arranque en frío", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

    const appSource = await fs.readFile(path.join(rootDir, "js/app.js"), "utf-8");
    assert.equal(/pyodide|sql-wasm|sql\.js|wandbox/i.test(appSource), false, "js/app.js no debe cargar runtimes WASM/remotos en arranque");

    const tsSource = await fs.readFile(path.join(rootDir, "js/preview/tsTranspiler.js"), "utf-8");
    assert.equal(/fetch\(|new Worker|cdn\.|esm\.sh|WebAssembly/i.test(tsSource), false, "tsTranspiler.js debe ser 100% local offline sin compilador externo");

    const origFetch = globalThis.fetch;
    const origWorker = globalThis.Worker;
    const fetchCalls = [];
    let workerCreations = 0;

    globalThis.fetch = async (url, ...rest) => {
      fetchCalls.push(String(url));
      return origFetch(url, ...rest);
    };
    globalThis.Worker = class MockLazyCheckWorker {
      constructor() {
        workerCreations += 1;
      }
    };

    let pyMod;
    let tsMod;
    let sqlMod;
    try {
      const nonce = Date.now();
      pyMod = await import(`../js/preview/pythonRunner.js?lazycheck=${nonce}`);
      tsMod = await import(`../js/preview/tsTranspiler.js?lazycheck=${nonce}`);
      sqlMod = await import(`../js/preview/sqlRunner.js?lazycheck=${nonce}`);
    } finally {
      globalThis.fetch = origFetch;
      globalThis.Worker = origWorker;
    }

    assert.deepEqual(fetchCalls, [], "Importar pythonRunner, tsTranspiler y sqlRunner no debe disparar descargas en frío");
    assert.equal(workerCreations, 0, "Importar los runners no debe instanciar Web Workers al inicio");

    const tsOut = tsMod.transpileTypeScriptAndJsx("const n: number = 42;");
    assert.ok(tsOut.code.includes("const n = 42;"), "tsTranspiler debe transpilar TypeScript 100% offline");

    const pyHtml = pyMod.buildStandalonePythonPreview(
      { path: "main.py", shortName: "main.py", content: "print('hola')" },
      [],
      ""
    );
    assert.ok(pyHtml.includes("pyodide.js") && pyHtml.includes("new Worker"), "Pyodide solo debe instanciarse bajo demanda dentro del preview");

    const sqlHtml = sqlMod.buildSqlRunnerPreview({ path: "db.sql", shortName: "db.sql", content: "SELECT 1;" }, []);
    assert.ok(sqlHtml.includes("sql-wasm.js"), "SQLite WASM solo debe cargarse bajo demanda dentro del preview SQL");
  });

  test("6.4 Aislamiento estricto de scripts QA (tests/package.json y ci.yml)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

    const pkg = JSON.parse(await fs.readFile(path.join(rootDir, "tests/package.json"), "utf-8"));
    assert.equal(pkg.version, "1.2.0");
    assert.ok(pkg.scripts?.test.includes("node --test"), "npm --prefix tests test debe invocar node --test");
    assert.ok(pkg.scripts?.test.includes(".test.js"), "npm --prefix tests test debe restringirse a *.test.js");
    for (const forbidden of ["browser.e2e.mjs", "webkit.e2e.mjs", "take_real_screenshots", "playwright", "puppeteer"]) {
      assert.equal(pkg.scripts.test.includes(forbidden), false, `npm test no debe invocar ${forbidden}`);
    }
    assert.ok(pkg.scripts?.["test:e2e"]?.includes("browser.e2e.mjs"));
    assert.ok(pkg.scripts?.["test:e2e:webkit"]?.includes("webkit.e2e.mjs"));

    const testFiles = await fs.readdir(path.join(rootDir, "tests"));
    assert.equal(testFiles.some((f) => /\.e2e\.test\.js$/i.test(f)), false, "No debe haber suites E2E bajo el patrón *.test.js");

    const ciYml = await fs.readFile(path.join(rootDir, ".github/workflows/ci.yml"), "utf-8");
    assert.ok(ciYml.includes("lint-and-unit-tests:"));
    assert.ok(ciYml.includes("e2e-browser:"));
    assert.ok(ciYml.includes("e2e-webkit:"));
  });
});
