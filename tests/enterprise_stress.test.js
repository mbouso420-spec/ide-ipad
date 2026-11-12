import "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { searchInFiles, escapeRegExp } from "../js/search/projectSearch.js";
import { createMinimapController } from "../js/editor/minimap.js";
import {
  findBestHtmlEntrypoint,
  findTargetHtmlFile,
  bundleHtmlWithFolderAssets
} from "../js/preview/htmlBundler.js";
import {
  convertResultsToCsv,
  convertResultsToJson,
  buildSqlRunnerPreview
} from "../js/preview/sqlRunner.js";
import {
  parseGccErrors,
  buildWandboxPayload,
  hasMainFunction
} from "../js/preview/cRunner.js";

describe("Simulación y Prueba de Estrés: Proyecto Enterprise a Gran Escala", () => {
  describe("1. Navegación y Empaquetado Multi-Página y Multi-Módulo (4 HTMLs + 25 JS anidados)", () => {
    // Generamos 25 módulos anidados en diferentes subcarpetas
    const jsModules = Array.from({ length: 25 }, (_, i) => ({
      path: `src/modules/sub_${i % 5}/module_${i}.js`,
      content: `export const val_${i} = ${i};\nexport function get_${i}() { return val_${i} * 2; }`
    }));

    const htmlPages = [
      { path: "public/index.html", content: '<link rel="stylesheet" href="./styles.css"><script src="../src/modules/sub_0/module_0.js"></script><a href="catalogo.html">Catálogo</a>' },
      { path: "public/catalogo.html", content: '<a href="preguntas.html">FAQ</a><script src="../src/modules/sub_1/module_1.js"></script>' },
      { path: "public/preguntas.html", content: '<a href="contacto.html">Contacto</a><h1>FAQ</h1>' },
      { path: "public/contacto.html", content: '<a href="index.html">Inicio</a><form id="contact"></form>' },
      { path: "public/styles.css", content: "body { background: #000; color: #fff; }" }
    ];

    const allProjectFiles = [...htmlPages, ...jsModules];

    test("1.1 Resolución de enlaces cruzados entre las 4 páginas del proyecto", () => {
      assert.equal(findTargetHtmlFile(allProjectFiles, "public/index.html", "catalogo.html")?.path, "public/catalogo.html");
      assert.equal(findTargetHtmlFile(allProjectFiles, "public/catalogo.html", "preguntas.html")?.path, "public/preguntas.html");
      assert.equal(findTargetHtmlFile(allProjectFiles, "public/preguntas.html", "contacto.html")?.path, "public/contacto.html");
      assert.equal(findTargetHtmlFile(allProjectFiles, "public/contacto.html", "index.html")?.path, "public/index.html");
    });

    test("1.2 Resolución del mejor entrypoint HTML asociado a cualquier módulo JS anidado", () => {
      const bestForMod0 = findBestHtmlEntrypoint(allProjectFiles, jsModules[0]);
      assert.ok(bestForMod0);
      assert.ok(bestForMod0.path.includes(".html"));
    });

    test("1.3 Empaquetado en memoria de assets con inlining relativas sin degradación", () => {
      const fileMap = new Map();
      allProjectFiles.forEach((f) => fileMap.set(f.path, f));
      fileMap.set("public/styles.css", htmlPages[4]);

      const bundled = bundleHtmlWithFolderAssets("public/index.html", htmlPages[0].content, fileMap);
      assert.ok(bundled.includes("body { background: #000; color: #fff; }"));
      assert.ok(bundled.includes("studio-ide-preview"));
    });
  });

  describe("2. Estrés SQLite Masivo: 5,000 registros y paginación cliente de 50 filas", () => {
    // Generamos 5,000 registros corporativos simulados
    const TOTAL_ROWS = 5000;
    const columns = ["id", "sku", "producto", "precio", "stock", "categoria"];
    const rows = Array.from({ length: TOTAL_ROWS }, (_, i) => [
      i + 1,
      `SKU-${100000 + i}`,
      `Item Corporativo ${i + 1}`,
      (10.5 + (i % 50)).toFixed(2),
      (i * 3) % 200,
      i % 2 === 0 ? "Hardware" : "Software"
    ]);

    const results = [{ columns, values: rows }];

    test("2.1 Exportación CSV de 5,000 registros genera cabecera y filas completas", () => {
      const csv = convertResultsToCsv(results);
      assert.ok(csv.startsWith("id,sku,producto,precio,stock,categoria"));
      assert.ok(csv.includes("5000,SKU-104999,Item Corporativo 5000"));
      const lineCount = csv.split("\n").filter((l) => l.trim()).length;
      assert.equal(lineCount, TOTAL_ROWS + 1);
    });

    test("2.2 Exportación JSON de 5,000 registros conserva tipos y llaves", () => {
      const json = convertResultsToJson(results);
      assert.equal(json.length, TOTAL_ROWS);
      assert.equal(json[0].id, 1);
      assert.equal(json[0].sku, "SKU-100000");
      assert.equal(json[4999].id, 5000);
      assert.equal(json[4999].sku, "SKU-104999");
    });

    test("2.3 Runner preview inyecta paginador de 50 filas con controles interactivos", () => {
      const preview = buildSqlRunnerPreview({
        path: "database/massive_seed.sql",
        content: "SELECT * FROM inventario;"
      });
      assert.ok(preview.includes("PAGE_SIZE = 50"));
      assert.ok(preview.includes("sql-pagination-bar"));
      assert.ok(preview.includes("sql-pagination-actions"));
    });
  });

  describe("3. Compilación C/C++ Multi-Archivo: 15 fuentes y cabeceras con Wandbox", () => {
    const cppSources = [
      { path: "src/main.cpp", content: '#include "app.h"\n#include "utils.h"\nint main() { run(); return 0; }' },
      { path: "src/app.h", content: "#pragma once\nvoid run();" },
      { path: "src/app.cpp", content: '#include "app.h"\n#include <iostream>\nvoid run() { std::cout << "OK"; }' },
      { path: "src/utils.h", content: "#pragma once\nint add(int a, int b);" },
      { path: "src/utils.cpp", content: '#include "utils.h"\nint add(int a, int b) { return a + b; }' }
    ];

    for (let i = 1; i <= 10; i++) {
      cppSources.push({
        path: `src/helper_${i}.cpp`,
        content: `// Helper ${i}\nint helper_val_${i} = ${i};`
      });
    }

    test("3.1 Detección precisa de main() en múltiples archivos C/C++", () => {
      assert.equal(hasMainFunction(cppSources[0].content), true);
      assert.equal(hasMainFunction(cppSources[1].content), false);
      assert.equal(hasMainFunction(cppSources[2].content), false);
      assert.equal(hasMainFunction(cppSources[3].content), false);
      assert.equal(hasMainFunction(cppSources[5].content), false);
    });

    test("3.2 Ensamblado de payload multi-archivo para compilación remota con Wandbox", () => {
      const payload = buildWandboxPayload({
        activeFile: cppSources[0],
        companionFiles: cppSources.slice(1)
      });
      assert.equal(payload.compiler, "gcc-head");
      assert.equal(payload.code, cppSources[0].content);
      assert.ok(Array.isArray(payload.codes));
      // Debe incluir todos los archivos secundarios
      assert.equal(payload.codes.length, cppSources.length - 1);
      assert.ok(payload.codes.some((c) => c.file === "app.h"));
      assert.ok(payload.codes.some((c) => c.file === "utils.cpp"));
    });

    test("3.3 Parseo de múltiples advertencias y errores de compilación GCC con columna y línea", () => {
      const gccOutput = `
src/app.cpp:4:15: error: 'cout' is not a member of 'std'
    4 |   std::cout << "OK";
      |        ^~~~
src/utils.cpp:12:3: warning: unused variable 'unused_x' [-Wunused-variable]
   12 |   int unused_x = 42;
      |   ^~~
`;
      const issues = parseGccErrors(gccOutput);
      assert.equal(issues.length, 2);
      assert.equal(issues[0].line, 4);
      assert.equal(issues[0].column, 15);
      assert.equal(issues[0].severity, "error");
      assert.match(issues[0].message, /not a member of 'std'/);

      assert.equal(issues[1].line, 12);
      assert.equal(issues[1].column, 3);
      assert.equal(issues[1].severity, "warning");
      assert.match(issues[1].message, /unused variable/);
    });
  });

  describe("4. Nueva Característica: Buscador Global Asíncrono en Archivos (Cmd/Ctrl + Shift + F)", () => {
    const filesToSearch = [
      { path: "src/auth/authService.js", content: "export function authenticateUser(token) {\n  if (!token) throw new Error('Invalid token');\n  return { ok: true, role: 'admin' };\n}" },
      { path: "src/auth/roles.js", content: "export const ROLES = ['admin', 'editor', 'viewer'];\nexport function isAdmin(role) { return role === 'admin'; }" },
      { path: "src/database/client.js", content: "import { authenticateUser } from '../auth/authService.js';\n// Connect to database\nexport function connect() { return true; }" },
      { path: "assets/logo.png", content: "", isBinary: true },
      { path: "docs/manual.pdf", content: "", isBinary: true }
    ];

    test("4.1 Búsqueda insensible a mayúsculas encuentra todas las ocurrencias agrupadas", () => {
      const res = searchInFiles(filesToSearch, "admin", { caseSensitive: false });
      assert.equal(res.error, null);
      assert.equal(res.filesMatched, 2);
      assert.equal(res.totalMatches, 4); // 1 en authService, 3 en roles (admin, isAdmin, admin)
      assert.equal(res.results[0].path, "src/auth/authService.js");
      assert.equal(res.results[0].matches[0].line, 3);
    });

    test("4.2 Búsqueda sensible a mayúsculas (Case Sensitive)", () => {
      const res1 = searchInFiles(filesToSearch, "ROLES", { caseSensitive: true });
      assert.equal(res1.totalMatches, 1);
      assert.equal(res1.results[0].path, "src/auth/roles.js");

      const res2 = searchInFiles(filesToSearch, "role", { caseSensitive: true });
      assert.equal(res2.totalMatches, 3); // 1 en authService, 2 en roles
    });

    test("4.3 Búsqueda por palabra completa (Whole Word)", () => {
      const res = searchInFiles(filesToSearch, "token", { matchWholeWord: true });
      assert.equal(res.totalMatches, 3); // 3 ocurrencias exactas de 'token' en authService
      assert.equal(res.results[0].matches.length, 3);
    });

    test("4.4 Búsqueda por expresión regular (RegEx)", () => {
      const res = searchInFiles(filesToSearch, "function\\s+([a-zA-Z0-9_]+)", { isRegex: true });
      assert.equal(res.error, null);
      assert.ok(res.totalMatches >= 3);
      assert.ok(res.results.some((r) => r.path === "src/auth/authService.js"));
      assert.ok(res.results.some((r) => r.path === "src/auth/roles.js"));
      assert.ok(res.results.some((r) => r.path === "src/database/client.js"));
    });

    test("4.5 Ignora archivos binarios automáticamente", () => {
      const res = searchInFiles(filesToSearch, "pdf", { caseSensitive: false });
      assert.equal(res.totalMatches, 0);
    });

    test("4.6 Expresión regular inválida devuelve error legible sin lanzar excepción", () => {
      const res = searchInFiles(filesToSearch, "[unclosed-bracket", { isRegex: true });
      assert.ok(res.error);
      assert.match(res.error, /Expresión regular inválida/);
      assert.equal(res.totalMatches, 0);
    });

    test("4.7 escapeRegExp neutraliza caracteres especiales correctamente", () => {
      const escaped = escapeRegExp("app.component(test)[0]+{x}*?");
      assert.equal(escaped, "app\\.component\\(test\\)\\[0\\]\\+\\{x\\}\\*\\?");
    });
  });

  describe("5. Nueva Característica: Minimap en CodeMirror 6", () => {
    test("5.1 Ciclo de vida: inicializa, computa proporciones y alterna visibilidad", () => {
      const mount = document.createElement("div");
      let scrolledRatio = null;

      const minimap = createMinimapController({
        mountEl: mount,
        getDocLines: () => Array.from({ length: 150 }, (_, i) => `// Linea ${i + 1}\nconst x = ${i};`),
        getViewport: () => ({ top: 200, height: 400, totalHeight: 3000 }),
        onScrollToRatio: (r) => { scrolledRatio = r; }
      });

      assert.equal(typeof minimap.render, "function");
      assert.equal(typeof minimap.updateSlider, "function");
      assert.equal(typeof minimap.toggle, "function");

      const visibleInit = minimap.isVisible();
      const toggled = minimap.toggle();
      assert.equal(toggled, !visibleInit);
      assert.equal(minimap.isVisible(), !visibleInit);

      minimap.toggle(true);
      assert.equal(minimap.isVisible(), true);
      assert.equal(scrolledRatio, null);

      minimap.destroy();
    });
  });
});
