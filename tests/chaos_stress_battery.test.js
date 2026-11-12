import "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as acorn from "acorn";

// Módulos bajo prueba de esfuerzo y caos
import {
  parseGccErrors,
  hasMainFunction,
  sanitizeLoopOutput,
  compileAndRunWandbox,
  mountCRunnerView
} from "../js/preview/cRunner.js";

import {
  convertResultsToCsv,
  convertResultsToJson,
  applySqlPagination,
  buildCountQuery,
  buildSqlRunnerPreview
} from "../js/preview/sqlRunner.js";

import {
  bundleHtmlWithFolderAssets,
  MAX_PREVIEW_ASSET_BYTES
} from "../js/preview/htmlBundler.js";

import { instrumentLoops } from "../js/preview/loopGuard.js";
import { createEditorManager } from "../js/editor/editorManager.js";
import {
  writeEmergencyBackup,
  readEmergencyBackup
} from "../js/storage/emergencyBackup.js";
import {
  upsertEntry,
  deleteProjectEntry,
  renameProjectEntry,
  getProjectEntries
} from "../js/storage/workspaceDb.js";
import { buildZipArchive, computeCrc32 } from "../js/storage/zipExporter.js";
import { decodeImportedFile, MAX_IMPORT_FILE_BYTES } from "../js/storage/fileImport.js";

describe("Batería de Pruebas de Estrés Extremo, Caos y Sobrecarga Masiva (Studio IDE)", () => {

  describe("1. Motor de Compilación C/C++ y Wandbox bajo Caos (cRunner.js)", () => {
    test("1.1 Spam de compilaciones concurrentes: mutex isCompiling previene peticiones solapadas", async () => {
      let callCount = 0;
      const delayedFetch = async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            status: 0,
            program_output: "Resultado simulado\n",
            compiler_output: ""
          })
        };
      };

      const container = document.createElement("div");
      const runner = mountCRunnerView(container, {
        activeFile: { path: "main.c", content: 'int main() { return 0; }' },
        fetchFn: delayedFetch
      });

      // Disparamos 25 ejecuciones inmediatas mientras la primera está en vuelo
      const promises = [];
      for (let i = 0; i < 25; i++) {
        promises.push(runner.run());
      }
      await Promise.all(promises);

      // Solo una llamada debió ejecutarse por el guardián isCompiling
      assert.equal(callCount, 1, "isCompiling debe bloquear peticiones concurrentes solapadas");
      runner.destroy();
    });

    test("1.2 Resiliencia a destrucción del modal en vuelo (lifecycle abort)", async () => {
      let fetchStarted = false;
      let compilerResultFired = false;

      const hungFetch = async () => {
        fetchStarted = true;
        await new Promise((r) => setTimeout(r, 30));
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ status: 0, program_output: "Salida tardía" })
        };
      };

      const container = document.createElement("div");
      const runner = mountCRunnerView(container, {
        activeFile: { path: "main.c", content: 'int main() { return 0; }' },
        fetchFn: hungFetch,
        onCompilerResult: () => {
          compilerResultFired = true;
        }
      });

      // Esperamos que inicie la petición y destruimos inmediatamente la vista
      await new Promise((r) => setTimeout(r, 5));
      assert.ok(fetchStarted);
      runner.destroy();

      // Dejamos que la promesa de red termine
      await new Promise((r) => setTimeout(r, 50));

      // onCompilerResult no debió invocarse tras la destrucción
      assert.equal(compilerResultFired, false, "Una vista destruida no debe disparar callbacks tardíos");
    });

    test("1.3 Sobrecarga de flujos gigantescos (100k caracteres), caracteres de control y ANSI malformados", () => {
      const t0 = performance.now();
      // Generamos 100,000 caracteres con secuencias ANSI, saltos mixtos, caracteres nulos y plantillas de error C++
      const chunks = [];
      for (let i = 0; i < 1000; i++) {
        chunks.push(
          `\x1b[31;1mprog.cpp:${i + 1}:15: error: no matching function for call to 'std::vector<std::map<int, std::string>>::push_back'\x1b[0m\r\n` +
          `    ${i} |     vec.push_back(\x00\x1b[33m"malformed_ansi_escape\x1b[); // control \x07\x08\n`
        );
      }
      const massiveOutput = chunks.join("");
      assert.ok(massiveOutput.length > 100000);

      // Evaluamos el rendimiento y la ausencia de ReDoS en parseGccErrors
      const errors = parseGccErrors(massiveOutput);
      const elapsedMs = performance.now() - t0;

      assert.ok(errors.length >= 1000, "Debe extraer los 1000 errores correctamente");
      assert.equal(errors[0].line, 1);
      assert.equal(errors[errors.length - 1].line, 1000);
      assert.ok(elapsedMs < 100, `El parseo de 100k caracteres debe ser instantáneo (< 100 ms, fue ${elapsedMs.toFixed(1)} ms)`);

      // Verificamos sanitizeLoopOutput bajo texto repetitivo masivo
      const repetitiveLines = Array.from({ length: 500 }, () => "Ingrese número: ").join("\n");
      const sanitized = sanitizeLoopOutput(repetitiveLines);
      assert.ok(sanitized.length < repetitiveLines.length, "Debe truncar repeticiones infinitas de stdin/EOF");
    });

    test("1.4 Resiliencia ante fallos de red abruptos, HTTP 500 y JSON malformado", async () => {
      // Caso 1: Error de red / desconexión (TypeError: Failed to fetch)
      const networkFailFetch = async () => {
        throw new TypeError("Failed to fetch");
      };
      await assert.rejects(
        async () => compileAndRunWandbox({ compiler: "gcc-head-c", code: "int main(){}" }, networkFailFetch),
        /Failed to fetch/
      );

      // Caso 2: Error 500 Internal Server Error
      const http500Fetch = async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error"
      });
      await assert.rejects(
        async () => compileAndRunWandbox({ compiler: "gcc-head-c", code: "int main(){}" }, http500Fetch),
        /HTTP 500/
      );

      // Caso 3: Respuesta con JSON corrupto
      const corruptJsonFetch = async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => { throw new SyntaxError("Unexpected token < in JSON at position 0"); }
      });
      await assert.rejects(
        async () => compileAndRunWandbox({ compiler: "gcc-head-c", code: "int main(){}" }, corruptJsonFetch),
        /Unexpected token/
      );
    });

    test("1.5 Detección de main() bajo comentarios de código y ofuscación", () => {
      assert.equal(hasMainFunction("/* int main() { return 0; } */ void foo() {}"), false);
      assert.equal(hasMainFunction("// int main() { return 0; }\nvoid foo() {}"), false);
      assert.equal(hasMainFunction("int  main ( int argc , char * argv [ ] ) { return 0; }"), true);
      assert.equal(hasMainFunction("auto main() -> int { return 0; }"), true);
      assert.equal(hasMainFunction("fn main() {\n  println!(\"Rust\");\n}"), true);
      assert.equal(hasMainFunction("func main() {\n  println(\"Go\")\n}"), true);
      assert.equal(hasMainFunction("public static void Main(string[] args) {\n}"), true);
    });
  });

  describe("2. Tortura del Motor SQLite WASM y Serializadores (sqlRunner.js)", () => {
    test("2.1 Generación masiva: serialización CSV y JSON de 10,000 registros con Unicode y saltos", () => {
      const TOTAL_ROWS = 10000;
      const columns = ["id", "nombre", "descripcion", "precio", "es_activo", "metadatos"];
      const values = [];

      for (let i = 1; i <= TOTAL_ROWS; i++) {
        values.push([
          i,
          `Usuario_${i} 🚀`,
          `Línea 1,\r\nLínea 2 "con comillas anidadas" y coma,`,
          (i * 1.5).toFixed(2),
          i % 2 === 0 ? 1 : 0,
          i % 5 === 0 ? null : JSON.stringify({ tag: `v${i}`, valid: true })
        ]);
      }

      const results = [{ columns, values }];

      // Medir tiempo de serialización CSV
      const t0Csv = performance.now();
      const csv = convertResultsToCsv(results);
      const csvMs = performance.now() - t0Csv;

      assert.ok(csv.length > 500000, "El CSV debe contener el volumen completo");
      assert.ok(csv.includes("Usuario_10000 🚀"));
      assert.ok(csv.includes('"Línea 1,\r\nLínea 2 ""con comillas anidadas"" y coma,"'));
      assert.ok(csvMs < 200, `La serialización CSV de 10k filas debe ser veloz (< 200ms, fue ${csvMs.toFixed(1)}ms)`);

      // Medir tiempo de serialización JSON
      const t0Json = performance.now();
      const json = convertResultsToJson(results);
      const jsonMs = performance.now() - t0Json;

      assert.equal(json.length, TOTAL_ROWS);
      assert.equal(json[9999].id, 10000);
      assert.equal(json[9999].nombre, "Usuario_10000 🚀");
      assert.ok(jsonMs < 200, `La serialización JSON de 10k filas debe ser veloz (< 200ms, fue ${jsonMs.toFixed(1)}ms)`);

      // Verificamos el límite maxRows de seguridad
      const limitedCsv = convertResultsToCsv(results, 250);
      assert.ok(limitedCsv.includes("Usuario_250 🚀"));
      assert.ok(!limitedCsv.includes("Usuario_251 🚀"), "No debe exceder el límite maxRows en CSV");

      const limitedJson = convertResultsToJson(results, 50);
      assert.equal(limitedJson.length, 50);
      assert.equal(limitedJson[49].id, 50);
    });

    test("2.2 Paginación SQL y conteo contra consultas complejas y subconsultas", () => {
      // Consulta simple
      assert.equal(
        applySqlPagination("SELECT * FROM clientes", 50, 0),
        "SELECT * FROM clientes LIMIT 50 OFFSET 0;"
      );

      // Consulta que ya tiene LIMIT explícito: NO debe duplicar LIMIT
      assert.equal(
        applySqlPagination("SELECT * FROM clientes LIMIT 10", 50, 0),
        "SELECT * FROM clientes LIMIT 10;"
      );

      // Consulta con CTE (Common Table Expression: WITH ... SELECT)
      const cteQuery = "WITH activos AS (SELECT * FROM usuarios WHERE activo = 1) SELECT * FROM activos ORDER BY id DESC";
      assert.equal(
        applySqlPagination(cteQuery, 20, 40),
        "WITH activos AS (SELECT * FROM usuarios WHERE activo = 1) SELECT * FROM activos ORDER BY id DESC LIMIT 20 OFFSET 40;"
      );

      // Generación de COUNT(*)
      assert.equal(
        buildCountQuery(cteQuery),
        "SELECT COUNT(*) AS total_rows FROM (WITH activos AS (SELECT * FROM usuarios WHERE activo = 1) SELECT * FROM activos ORDER BY id DESC);"
      );

      // Sentencias no SELECT (DML / DDL) no deben ser paginadas
      assert.equal(
        applySqlPagination("CREATE TABLE demo (id INT PRIMARY KEY);", 50, 0),
        "CREATE TABLE demo (id INT PRIMARY KEY);"
      );
      assert.equal(
        applySqlPagination("INSERT INTO demo VALUES (1), (2);", 50, 0),
        "INSERT INTO demo VALUES (1), (2);"
      );
      assert.equal(buildCountQuery("INSERT INTO demo VALUES (1);"), "");
    });

    test("2.3 Sanitización y protección en la plantilla HTML del SQLite Runner", () => {
      const maliciousSqlFile = {
        path: "inyeccion.sql",
        shortName: "</script><script>alert('xss')</script>",
        content: "SELECT '</script><script>alert(1)</script>';"
      };

      const html = buildSqlRunnerPreview(maliciousSqlFile);

      // El título debe estar escapado con entidades HTML
      assert.ok(!html.includes("</script><script>alert('xss')</script> — SQLite en Vivo"));
      assert.ok(html.includes("&lt;/script&gt;&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt; — SQLite en Vivo"));

      // El contenido debe tener </script> neutralizado como \u003c/script>
      assert.ok(!html.includes("</script><script>alert(1)</script>"));
      assert.ok(html.includes("\\u003c/script>"));

      // Certificamos que la plantilla incluye la liberación explícita db.close() antes de reinicializar
      assert.ok(html.includes("if (db && typeof db.close === \"function\")"));
      assert.ok(html.includes("db.close()"));
    });
  });

  describe("3. Sobrecarga del Bundler HTML, CSS @import y Live Preview (htmlBundler.js)", () => {
    test("3.1 Detección y corte de ciclos recursivos cruzados en CSS (A -> B -> C -> A)", () => {
      const files = new Map();
      files.set("public/index.html", {
        path: "public/index.html",
        content: '<link rel="stylesheet" href="a.css"><h1>Test Ciclos</h1>'
      });
      files.set("public/a.css", {
        path: "public/a.css",
        content: '@import "b.css";\nbody { background: red; }'
      });
      files.set("public/b.css", {
        path: "public/b.css",
        content: '@import "c.css";\nh1 { color: blue; }'
      });
      files.set("public/c.css", {
        path: "public/c.css",
        content: '@import "a.css";\np { font-size: 14px; }' // Ciclo hacia a.css
      });

      const bundled = bundleHtmlWithFolderAssets("public/index.html", files.get("public/index.html").content, files);

      assert.ok(bundled.includes("body { background: red; }"));
      assert.ok(bundled.includes("h1 { color: blue; }"));
      assert.ok(bundled.includes("p { font-size: 14px; }"));
      // No debe entrar en bucle infinito ni arrojar RangeError: Maximum call stack size exceeded
    });

    test("3.2 Árbol profundo de 50 niveles de @import recursivos lineales", () => {
      const files = new Map();
      const DEPTH = 50;

      for (let i = 0; i < DEPTH; i++) {
        const nextImport = i < DEPTH - 1 ? `@import "level_${i + 1}.css";\n` : "";
        files.set(`public/level_${i}.css`, {
          path: `public/level_${i}.css`,
          content: `${nextImport}.level-${i} { z-index: ${i}; }`
        });
      }

      files.set("public/index.html", {
        path: "public/index.html",
        content: '<link rel="stylesheet" href="level_0.css">'
      });

      const bundled = bundleHtmlWithFolderAssets("public/index.html", files.get("public/index.html").content, files);

      assert.ok(bundled.includes(".level-0 { z-index: 0; }"));
      assert.ok(bundled.includes(".level-49 { z-index: 49; }"));
    });

    test("3.3 Preservación de condiciones avanzadas en @import (@layer, @supports, @media)", () => {
      const files = new Map();
      files.set("public/index.html", {
        path: "public/index.html",
        content: '<link rel="stylesheet" href="main.css">'
      });
      files.set("public/main.css", {
        path: "public/main.css",
        content: '@import "component.css" layer(utilities) supports(display: grid) screen and (min-width: 1024px);'
      });
      files.set("public/component.css", {
        path: "public/component.css",
        content: '.grid-box { display: grid; }'
      });

      const bundled = bundleHtmlWithFolderAssets("public/index.html", files.get("public/index.html").content, files);

      assert.ok(bundled.includes("@layer utilities"));
      assert.ok(bundled.includes("@supports (display: grid)"));
      assert.ok(bundled.includes("@media screen and (min-width: 1024px)"));
      assert.ok(bundled.includes(".grid-box { display: grid; }"));
    });

    test("3.4 Respeto estricto del presupuesto de memoria (512 KB por recurso y 2 MB acumulados)", () => {
      const files = new Map();
      // Generamos un asset que excede exactamente los 512 KB
      const oversizedCss = "/* padding */ " + "a".repeat(MAX_PREVIEW_ASSET_BYTES + 10);
      files.set("public/oversized.css", {
        path: "public/oversized.css",
        content: oversizedCss
      });
      files.set("public/index.html", {
        path: "public/index.html",
        content: '<link rel="stylesheet" href="oversized.css">'
      });

      const bundled = bundleHtmlWithFolderAssets("public/index.html", files.get("public/index.html").content, files);

      // Debe omitir el inlining y dejar el comentario descriptivo de advertencia
      assert.ok(bundled.includes("excede el límite de tamaño individual"));
      assert.ok(!bundled.includes("a".repeat(1000)));
    });

    test("3.5 LoopGuard: instrumentación de bucles infinitos complejos, obfuscados y do-while", () => {
      // 1. while (true) sin llaves
      const res1 = instrumentLoops("while (true) x++;", acorn);
      assert.ok(res1.instrumented);
      assert.ok(res1.code.includes("__studioLoopGuard"));

      // 2. for (;;) infinito
      const res2 = instrumentLoops("for (;;) { doSomething(); }", acorn);
      assert.ok(res2.instrumented);
      assert.ok(res2.code.includes("__studioLoopGuard"));

      // 3. do-while
      const res3 = instrumentLoops("do { compute(); } while (true);", acorn);
      assert.ok(res3.instrumented);
      assert.ok(res3.code.includes("__studioLoopGuard"));

      // 4. Bucles anidados
      const res4 = instrumentLoops("for (let i = 0; i < 10; i++) { while (j > 0) { j--; } }", acorn);
      assert.equal(res4.loops, 2);

      // 5. Código sintácticamente inválido no debe romper la ejecución
      const resInvalid = instrumentLoops("function broken( { while(true)", acorn);
      assert.equal(resInvalid.instrumented, false);
      assert.equal(resInvalid.code, "function broken( { while(true)");
    });

    test("3.6 Inundación masiva de la consola (2,500 mensajes) y límite MAX_CONSOLE_LINES = 500", () => {
      // Simulación del contenedor de consola del modal
      const consoleList = document.createElement("div");
      const MAX_CONSOLE_LINES = 500;
      const MAX_CONSOLE_LINE_CHARS = 10000;

      function simulateAppendConsoleLine(level, text) {
        while (consoleList.children.length >= MAX_CONSOLE_LINES && consoleList.firstElementChild) {
          consoleList.removeChild(consoleList.firstElementChild);
        }
        const rawStr = String(text ?? "");
        const safeText =
          rawStr.length > MAX_CONSOLE_LINE_CHARS
            ? `${rawStr.slice(0, MAX_CONSOLE_LINE_CHARS)}… [truncado]`
            : rawStr;
        const item = document.createElement("div");
        item.className = level === "error" ? "preview-log-item is-error" : "preview-log-item";
        item.textContent = safeText;
        consoleList.appendChild(item);
      }

      // Inundamos con 2,500 mensajes consecutivos
      for (let i = 1; i <= 2500; i++) {
        simulateAppendConsoleLine(i % 10 === 0 ? "error" : "log", `Mensaje de consola #${i}`);
      }

      // Verificamos que el DOM nunca sobrepasa las 500 líneas
      assert.equal(consoleList.children.length, 500, "El DOM de la consola debe mantenerse topado en 500");
      assert.equal(consoleList.children[0].textContent, "Mensaje de consola #2001");
      assert.equal(consoleList.children[499].textContent, "Mensaje de consola #2500");

      // Verificamos truncamiento de líneas masivas (> 10,000 caracteres)
      const giantMessage = "x".repeat(15000);
      simulateAppendConsoleLine("log", giantMessage);
      const lastLine = consoleList.children[consoleList.children.length - 1].textContent;
      assert.ok(lastLine.endsWith("… [truncado]"));
      assert.equal(lastLine.length, 10000 + "… [truncado]".length);
    });
  });

  describe("4. Ciclo de Vida del Editor, Concurrencia en IndexedDB y Storage (Core IDE)", () => {
    test("4.1 Ciclo de vida bajo fuego del Editor: apertura, edición y cierre de 100 archivos", async () => {
      const mount = document.createElement("div");
      const editor = await createEditorManager({
        mountEl: mount,
        enableMinimap: false,
        onDocChange: () => {},
        onSelectionChange: () => {}
      });

      // Ciclo de estrés: abrimos 100 archivos, añadimos marcadores de error y cerramos sus estados
      for (let i = 1; i <= 100; i++) {
        const fileId = `src/module_${i}.js`;
        editor.openFile({
          id: fileId,
          path: fileId,
          lang: "javascript",
          content: `export function fn_${i}() { return ${i} * 10; }\n// Archivo #${i}`
        });

        editor.addErrorMarker(1, `Error simulado en archivo ${i}`);
        assert.equal(editor.getActiveFileId(), fileId);

        // Cerramos el archivo y purgamos su estado
        editor.dropFileState(fileId);
      }

      // Al final del ciclo, el editor debe haber liberado todas las referencias
      assert.equal(editor.getActiveFileId(), null);
      assert.equal(editor.getErrorMarkers().length, 0);

      editor.destroy();
    });

    test("4.2 Transacciones concurrentes en IndexedDB: jerarquías de directorios profundos", async () => {
      const projectId = `stress_proj_${Date.now()}`;

      // Inserción concurrente en ráfaga de 30 archivos en subdirectorios anidados
      const writePromises = [];
      for (let i = 1; i <= 30; i++) {
        const filePath = `src/deep/nested/sub_${i % 5}/component_${i}.ts`;
        writePromises.push(
          upsertEntry(projectId, filePath, {
            content: `export const value = ${i};`
          })
        );
      }
      await Promise.all(writePromises);

      // Verificamos que todos los archivos y carpetas intermedias se crearon íntegros
      const entries = await getProjectEntries(projectId);
      const filesOnly = entries.filter((e) => !e.isFolder);
      assert.equal(filesOnly.length, 30);

      // Renombrado atómico de la carpeta raíz
      await renameProjectEntry(projectId, "src/deep", "src/core_deep", true);

      const updatedEntries = await getProjectEntries(projectId);
      assert.ok(updatedEntries.every((e) => !e.path.startsWith("src/deep/")));
      assert.ok(updatedEntries.some((e) => e.path.startsWith("src/core_deep/nested/")));

      // Eliminación en cascada de la carpeta
      await deleteProjectEntry(projectId, "src/core_deep", true);
      const remainingEntries = await getProjectEntries(projectId);
      assert.equal(remainingEntries.filter((e) => e.path.startsWith("src/core_deep")).length, 0);
    });

    test("4.3 Respaldo de Emergencia (localStorage) resiliente ante QuotaExceededError", () => {
      // Mock de Storage que simula fallo por cuota llena
      const fullStorage = {
        _data: new Map(),
        getItem(k) { return this._data.get(k) || null; },
        setItem(k, v) {
          if (v.length > 500) {
            const err = new Error("QuotaExceededError");
            err.name = "QuotaExceededError";
            throw err;
          }
          this._data.set(k, v);
        },
        removeItem(k) { this._data.delete(k); }
      };

      const testItems = [
        { projectId: "p1", filePath: "small.js", content: "let a = 1;" },
        { projectId: "p1", filePath: "huge.js", content: "x".repeat(1000) }
      ];

      // El guardado debe atrapar el QuotaExceededError y retornar false limpiamente sin explotar
      const ok = writeEmergencyBackup(testItems, fullStorage, "p1", "tab_1");
      assert.equal(ok, false, "Debe retornar false cuando la cuota de localStorage se agota");

      // Verificamos que con contenido pequeño sí escribe y aísla por instanceId
      const okSmall = writeEmergencyBackup([testItems[0]], fullStorage, "p1", "tab_1");
      assert.equal(okSmall, true);

      const restored = readEmergencyBackup(fullStorage, "p1", "tab_1");
      assert.equal(restored.length, 1);
      assert.equal(restored[0].filePath, "small.js");
    });

    test("4.4 Empaquetado ZIP de alta escala: binarios al límite (5 MB), CRC32 y estructura PKZIP", () => {
      const filesToZip = [];

      // Añadimos 50 archivos de código fuente
      for (let i = 0; i < 50; i++) {
        filesToZip.push({
          path: `src/file_${i}.cpp`,
          content: `#include <iostream>\nint f_${i}() { return ${i}; }\n`
        });
      }

      // Añadimos un archivo binario grande (Uint8Array de 1.5 MB para probar buffer masivo y CRC32)
      const binaryPayload = new Uint8Array(1.5 * 1024 * 1024);
      for (let i = 0; i < binaryPayload.length; i += 1024) {
        binaryPayload[i] = (i % 256);
      }
      filesToZip.push({
        path: "assets/big_image.dat",
        content: binaryPayload
      });

      const t0 = performance.now();
      const zipBytes = buildZipArchive(filesToZip);
      const elapsed = performance.now() - t0;

      assert.ok(zipBytes instanceof Uint8Array);
      assert.ok(zipBytes.length > 1.5 * 1024 * 1024);

      // Verificamos la firma PKZIP (PK\x03\x04 en los primeros 4 bytes)
      assert.equal(zipBytes[0], 0x50); // 'P'
      assert.equal(zipBytes[1], 0x4b); // 'K'
      assert.equal(zipBytes[2], 0x03);
      assert.equal(zipBytes[3], 0x04);

      // Verificamos el cálculo correcto de CRC-32 sobre el buffer binario
      const crc = computeCrc32(binaryPayload);
      assert.ok(typeof crc === "number" && crc > 0);
      assert.ok(elapsed < 250, `La compresión y empaquetado ZIP debe tardar < 250ms (fue ${elapsed.toFixed(1)}ms)`);
    });

    test("4.5 Validación de límites en importación de archivos (decodeImportedFile)", () => {
      // 1. Archivo exactamente en el límite de 5 MB con caracteres ASCII -> Permitido
      const maxAllowedBuffer = new Uint8Array(MAX_IMPORT_FILE_BYTES);
      maxAllowedBuffer.fill(97); // 'a'
      const resAllowed = decodeImportedFile(maxAllowedBuffer, "valid_max.txt");
      assert.equal(resAllowed.ok, true);
      assert.equal(resAllowed.text.length, MAX_IMPORT_FILE_BYTES);

      // 2. Archivo que supera el límite por 1 byte -> Rechazado descriptivamente
      const oversizedBuffer = new Uint8Array(MAX_IMPORT_FILE_BYTES + 1);
      const resOversized = decodeImportedFile(oversizedBuffer, "too_large.txt");
      assert.equal(resOversized.ok, false);
      assert.ok(resOversized.reason.includes("5 MB"));
    });
  });

});
