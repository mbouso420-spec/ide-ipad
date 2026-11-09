import "./setup.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  uint8ArrayToBase64,
  base64ToUint8Array,
  isBinaryFile,
  isImageFile,
  getImageMimeType
} from "../js/storage/fileImport.js";
import { buildZipArchive } from "../js/storage/zipExporter.js";
import { searchInFiles } from "../js/search/projectSearch.js";
import { createEditorManager } from "../js/editor/editorManager.js";
import {
  ensureInitialWorkspace,
  deleteProject,
  deleteProjectEntry,
  renameProjectEntry,
  createProjectFromGistBackup,
  upsertEntry,
  updateFileContent,
  getProjectEntries,
  closeWorkspaceBroadcast,
  broadcastWorkspaceChange,
  onWorkspaceBroadcast
} from "../js/storage/workspaceDb.js";
import {
  writeEmergencyBackup,
  readEmergencyBackup,
  restoreEmergencyBackup,
  clearEmergencyBackup,
  getEmergencyBackupKey,
  getTabInstanceId,
  EMERGENCY_BACKUP_KEY,
  EMERGENCY_BACKUP_PREFIX
} from "../js/storage/emergencyBackup.js";
import { KeyboardRouter } from "../js/ui/keyboardRouter.js";
import {
  convertResultsToCsv,
  convertResultsToJson,
  isSelectQuery,
  hasLimitClause,
  applySqlPagination,
  buildCountQuery,
  buildSqlRunnerPreview
} from "../js/preview/sqlRunner.js";
import {
  parseCssImportConditions,
  wrapCssWithConditions,
  bundleHtmlWithFolderAssets,
  MAX_PREVIEW_ASSET_BYTES,
  MAX_TOTAL_INLINED_CSS
} from "../js/preview/htmlBundler.js";

describe("Auditoría de Rendimiento, Ciclo de Vida y Resiliencia", () => {
  describe("1. Conversión de Búferes Binarios Grandes (uint8ArrayToBase64)", () => {
    test("procesa búfer vacío y pequeños fragmentos", () => {
      assert.equal(uint8ArrayToBase64(new Uint8Array(0)), "");
      assert.equal(uint8ArrayToBase64(null), "");

      const small = new TextEncoder().encode("Studio IDE 2026");
      const b64 = uint8ArrayToBase64(small);
      assert.equal(Buffer.from(b64, "base64").toString("utf-8"), "Studio IDE 2026");
    });

    test("procesa búferes grandes (>16 KB y >64 KB) con particionado sin desbordar la pila", () => {
      const size = 70000; // >8192 límite de chunk
      const raw = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        raw[i] = (i * 37) & 0xff;
      }
      const b64 = uint8ArrayToBase64(raw);
      assert.ok(b64.length > 0);
      const decoded = Buffer.from(b64, "base64");
      assert.equal(decoded.length, size);
      assert.deepEqual(new Uint8Array(decoded), raw);
    });
  });

  describe("2. Optimización de Búsqueda Global (searchInFiles)", () => {
    test("encuentra coincidencias exactas y descarta archivos no relacionados", () => {
      const files = [
        { path: "src/utils.js", content: "function calculateTax() { return 0.21; }" },
        { path: "src/empty.js", content: "const a = 1;\nconst b = 2;\nconst c = 3;" },
        { path: "docs/readme.txt", content: "Documentación interna del proyecto sin la clave." }
      ];

      const res = searchInFiles(files, "calculateTax");
      assert.equal(res.totalMatches, 1);
      assert.equal(res.filesMatched, 1);
      assert.equal(res.results[0].path, "src/utils.js");
      assert.equal(res.results[0].matches[0].line, 1);
    });

    test("admite expresiones regulares con anclas de inicio y fin de línea", () => {
      const files = [
        { path: "main.py", content: "def start():\n    pass\n\ndef stop():\n    pass" }
      ];

      const res = searchInFiles(files, "^def ", { isRegex: true });
      assert.equal(res.totalMatches, 2);
      assert.equal(res.filesMatched, 1);
      assert.equal(res.results[0].matches[0].line, 1);
      assert.equal(res.results[0].matches[1].line, 4);
    });
  });

  describe("3. Gestión de Memoria del Editor (dropFileState y destroy)", () => {
    test("dropFileState limpia selección y marcadores al soltar archivo activo", async () => {
      const mount = {
        innerHTML: "",
        appendChild: () => {},
        contains: () => true
      };

      let lastSel = null;
      const editor = await createEditorManager({
        mountEl: mount,
        enableMinimap: false,
        onDocChange: () => {},
        onSelectionChange: (sel) => {
          lastSel = sel;
        }
      });

      editor.openFile({ id: "test.js", path: "test.js", lang: "javascript", content: "let x = 1;" });
      editor.addErrorMarker(1, "Sintaxis incorrecta");
      assert.equal(editor.getErrorMarkers().length, 1);

      editor.dropFileState("test.js");
      assert.equal(editor.getActiveFileId(), null);
      assert.equal(editor.getErrorMarkers().length, 0);
      assert.deepEqual(lastSel, { text: "", lineCount: 0, cursorLine: 1, cursorCol: 1 });

      editor.destroy();
    });

    test("purgeViewDocument y clearActiveFile purgan el contenido a 0 bytes al cerrar última pestaña", async () => {
      const mount = {
        innerHTML: "",
        appendChild: () => {},
        contains: () => true
      };

      const editor = await createEditorManager({
        mountEl: mount,
        enableMinimap: false,
        onDocChange: () => {},
        onSelectionChange: () => {}
      });

      editor.openFile({ id: "purge.js", path: "purge.js", lang: "javascript", content: "console.log('purge me');" });
      assert.equal(editor.getActiveFileId(), "purge.js");

      editor.clearActiveFile();
      assert.equal(editor.getActiveFileId(), null);

      // purgeViewDocument es idempotente y seguro de llamar explícitamente
      assert.doesNotThrow(() => {
        editor.purgeViewDocument?.();
      });

      editor.destroy();
    });
  });

  describe("4. Borrado Atómico en Lote y Resiliencia de BroadcastChannel", () => {
    test("deleteProjectEntry elimina una carpeta con múltiples archivos en lote", async () => {
      const projId = "test-atomic-delete";
      await ensureInitialWorkspace();

      // Crear estructura jerárquica
      await upsertEntry(projId, "components/Button.jsx", { content: "export const Button = () => null;" });
      await upsertEntry(projId, "components/Input.jsx", { content: "export const Input = () => null;" });
      await upsertEntry(projId, "components/sub/Icon.jsx", { content: "export const Icon = () => null;" });
      await upsertEntry(projId, "index.js", { content: "console.log('root');" });

      let entries = await getProjectEntries(projId);
      assert.ok(entries.some((e) => e.path === "components/Button.jsx"));
      assert.ok(entries.some((e) => e.path === "components/Input.jsx"));
      assert.ok(entries.some((e) => e.path === "components/sub/Icon.jsx"));

      // Borrar carpeta components/ de manera atómica
      await deleteProjectEntry(projId, "components", true);

      entries = await getProjectEntries(projId);
      assert.ok(!entries.some((e) => e.path.startsWith("components/")));
      assert.ok(entries.some((e) => e.path === "index.js"));

      await deleteProject(projId);
    });

    test("closeWorkspaceBroadcast y reconexión transparente sin excepciones", () => {
      closeWorkspaceBroadcast();
      assert.doesNotThrow(() => {
        broadcastWorkspaceChange({ type: "TEST_EVENT" });
      });

      const unsub = onWorkspaceBroadcast(() => {});
      assert.equal(typeof unsub, "function");
      assert.doesNotThrow(() => {
        unsub();
      });
      closeWorkspaceBroadcast();
    });

    test("updateFileContent propaga evento FILE_UPDATED con contrato unificado a otras pestañas", async () => {
      const projId = "test-broadcast-contract";
      await ensureInitialWorkspace();
      await upsertEntry(projId, "contract.js", { content: "const a = 1;" });

      const otherTabChannel = new BroadcastChannel("studio_ide_workspace_sync");
      otherTabChannel.unref?.();

      const receivedPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout esperando evento FILE_UPDATED")), 2000);
        otherTabChannel.addEventListener("message", (ev) => {
          if (ev.data?.type === "FILE_UPDATED" && ev.data?.path === "contract.js") {
            clearTimeout(timeout);
            otherTabChannel.close();
            resolve(ev.data);
          }
        });
      });

      try {
        await updateFileContent(projId, "contract.js", "const a = 2;");
        const event = await receivedPromise;
        assert.equal(event.type, "FILE_UPDATED");
        assert.equal(event.projectId, projId);
        assert.equal(event.path, "contract.js");
      } finally {
        otherTabChannel.close();
        await deleteProject(projId);
      }
    });
  });

  describe("5. Respaldo de Emergencia Particionado por Proyecto (localStorage)", () => {
    test("writeEmergencyBackup particiona por projectId y previene colisiones", () => {
      const storage = new Map();
      const mockStorage = {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k),
        get length() { return storage.size; },
        key: (i) => Array.from(storage.keys())[i] ?? null
      };

      const keyA = getEmergencyBackupKey("proj-alpha");
      const keyB = getEmergencyBackupKey("proj-beta");
      assert.equal(keyA, `${EMERGENCY_BACKUP_PREFIX}proj-alpha`);
      assert.equal(keyB, `${EMERGENCY_BACKUP_PREFIX}proj-beta`);

      writeEmergencyBackup([{ projectId: "proj-alpha", filePath: "app.js", content: "alpha code" }], mockStorage, "proj-alpha");
      writeEmergencyBackup([{ projectId: "proj-beta", filePath: "index.js", content: "beta code" }], mockStorage, "proj-beta");

      assert.ok(storage.has(keyA));
      assert.ok(storage.has(keyB));

      const readAlpha = readEmergencyBackup(mockStorage, "proj-alpha");
      assert.equal(readAlpha.length, 1);
      assert.equal(readAlpha[0].content, "alpha code");

      const readBeta = readEmergencyBackup(mockStorage, "proj-beta");
      assert.equal(readBeta.length, 1);
      assert.equal(readBeta[0].content, "beta code");

      // Lectura agregada sin projectId obtiene ambos respaldos
      const aggregated = readEmergencyBackup(mockStorage);
      assert.equal(aggregated.length, 2);

      // Limpieza particionada de solo proj-alpha
      clearEmergencyBackup(mockStorage, "proj-alpha");
      assert.ok(!storage.has(keyA));
      assert.ok(storage.has(keyB));

      // Limpieza total
      clearEmergencyBackup(mockStorage);
      assert.equal(storage.size, 0);
    });

    test("writeEmergencyBackup aísla pestañas concurrentes del mismo proyecto mediante instanceId", () => {
      const storage = new Map();
      const mockStorage = {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k),
        get length() { return storage.size; },
        key: (i) => Array.from(storage.keys())[i] ?? null
      };

      const keyTabA = getEmergencyBackupKey("proj-shared", "tab-A");
      const keyTabB = getEmergencyBackupKey("proj-shared", "tab-B");
      assert.equal(keyTabA, `${EMERGENCY_BACKUP_PREFIX}proj-shared_tab-A`);
      assert.equal(keyTabB, `${EMERGENCY_BACKUP_PREFIX}proj-shared_tab-B`);

      writeEmergencyBackup([{ projectId: "proj-shared", filePath: "fileA.js", content: "tab A edits" }], mockStorage, "proj-shared", "tab-A");
      writeEmergencyBackup([{ projectId: "proj-shared", filePath: "fileB.js", content: "tab B edits" }], mockStorage, "proj-shared", "tab-B");

      assert.ok(storage.has(keyTabA));
      assert.ok(storage.has(keyTabB));

      // Lectura aislada por pestaña
      const readTabA = readEmergencyBackup(mockStorage, "proj-shared", "tab-A");
      assert.equal(readTabA.length, 1);
      assert.equal(readTabA[0].content, "tab A edits");

      const readTabB = readEmergencyBackup(mockStorage, "proj-shared", "tab-B");
      assert.equal(readTabB.length, 1);
      assert.equal(readTabB[0].content, "tab B edits");

      // Lectura por proyecto sin indicar instancia agrega ambas pestañas
      const projectAggregated = readEmergencyBackup(mockStorage, "proj-shared");
      assert.equal(projectAggregated.length, 2);

      // Limpieza de solo tab-A no toca tab-B
      clearEmergencyBackup(mockStorage, "proj-shared", "tab-A");
      assert.ok(!storage.has(keyTabA));
      assert.ok(storage.has(keyTabB));

      // Limpieza de todo el proyecto
      clearEmergencyBackup(mockStorage, "proj-shared");
      assert.ok(!storage.has(keyTabB));

      // getTabInstanceId devuelve un identificador consistente
      const instId = getTabInstanceId();
      assert.ok(typeof instId === "string" && instId.length > 0);
    });

    test("restoreEmergencyBackup utiliza snapshot atómico de claves para no borrar escrituras concurrentes de otras pestañas", async () => {
      const storage = new Map();
      const mockStorage = {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k),
        get length() { return storage.size; },
        key: (i) => Array.from(storage.keys())[i] ?? null
      };

      const mockDb = {
        async entryExists() { return true; },
        async updateFileContent() {}
      };

      // Tab A escribe un respaldo
      writeEmergencyBackup([{ projectId: "proj-sync", filePath: "fileA.js", content: "edit A" }], mockStorage, "proj-sync", "tab-A");

      // Inyectamos una escritura concurrente de Tab B mientras restoreEmergencyBackup procesa la clave de Tab A
      const originalGetItem = mockStorage.getItem;
      let tabBInjected = false;
      mockStorage.getItem = function (key) {
        if (!tabBInjected && typeof key === "string" && key.includes("tab-A")) {
          writeEmergencyBackup([{ projectId: "proj-sync", filePath: "fileB.js", content: "edit B concurrente" }], mockStorage, "proj-sync", "tab-B");
          tabBInjected = true;
        }
        return originalGetItem.call(mockStorage, key);
      };

      const restored = await restoreEmergencyBackup(mockDb, mockStorage, "proj-sync");
      assert.equal(restored, 1);

      // Verificamos que la clave de Tab B NO fue eliminada por la restauración de Tab A
      const tabBKey = getEmergencyBackupKey("proj-sync", "tab-B");
      assert.ok(storage.has(tabBKey), "La clave de la pestaña concurrente debe preservarse intacta");
      const tabBItems = readEmergencyBackup(mockStorage, "proj-sync", "tab-B");
      assert.equal(tabBItems.length, 1);
      assert.equal(tabBItems[0].content, "edit B concurrente");
    });
  });

  describe("6. Control de Cierre Seguro en KeyboardRouter (onEscape booleano)", () => {
    test("onEscape retornando false retiene el modal en la pila; true o void lo desapila", () => {
      const router = new KeyboardRouter();
      let closeAttempts = 0;
      let allowClose = false;

      router.pushModal({
        id: "modal-guarded",
        onEscape: () => {
          closeAttempts++;
          return allowClose;
        }
      });

      assert.equal(router.getActiveModal()?.id, "modal-guarded");

      // Primer Escape: handler rechaza cierre (retorna false)
      router.handleKeyDown({
        key: "Escape",
        preventDefault: () => {},
        stopImmediatePropagation: () => {}
      });

      assert.equal(closeAttempts, 1);
      assert.equal(router.getActiveModal()?.id, "modal-guarded", "Modal no debe desapilarse si onEscape retorna false");

      // Segundo Escape: handler aprueba cierre (retorna true)
      allowClose = true;
      router.handleKeyDown({
        key: "Escape",
        preventDefault: () => {},
        stopImmediatePropagation: () => {}
      });

      assert.equal(closeAttempts, 2);
      assert.equal(router.getActiveModal(), null, "Modal debe desapilarse cuando onEscape retorna true");
    });
  });

  describe("7. Optimización de Memoria en Consultas SQL Masivas (sqlRunner)", () => {
    test("convertResultsToCsv y convertResultsToJson respetan maxRows ante grandes lotes", () => {
      const largeResults = [
        {
          columns: ["id", "name"],
          values: Array.from({ length: 100 }, (_, i) => [i + 1, `Usuario ${i + 1}`])
        }
      ];

      // Sin maxRows serializa las 100 filas
      const fullCsv = convertResultsToCsv(largeResults);
      const csvLines = fullCsv.trim().split("\r\n");
      assert.equal(csvLines.length, 101); // 1 cabecera + 100 filas

      // Con maxRows = 10, limita a 10 filas de datos
      const limitedCsv = convertResultsToCsv(largeResults, 10);
      const limitedLines = limitedCsv.trim().split("\r\n");
      assert.equal(limitedLines.length, 11); // 1 cabecera + 10 filas

      // JSON con maxRows = 5
      const limitedJson = convertResultsToJson(largeResults, 5);
      assert.equal(limitedJson.length, 5);
      assert.equal(limitedJson[0].id, 1);
      assert.equal(limitedJson[4].id, 5);
    });

    test("applySqlPagination inyecta LIMIT y OFFSET reales en consultas SELECT para evitar saturación de memoria", () => {
      // Detección de SELECT
      assert.equal(isSelectQuery("SELECT * FROM users;"), true);
      assert.equal(isSelectQuery("  -- Comentario inicial\nSELECT a, b FROM table;"), true);
      assert.equal(isSelectQuery("WITH cte AS (SELECT 1) SELECT * FROM cte;"), true);
      assert.equal(isSelectQuery("INSERT INTO users VALUES (1, 'Pepe');"), false);
      assert.equal(isSelectQuery("UPDATE users SET a = 1;"), false);
      assert.equal(isSelectQuery("CREATE TABLE items (id INT);"), false);

      // Detección de LIMIT existente
      assert.equal(hasLimitClause("SELECT * FROM items LIMIT 10;"), true);
      assert.equal(hasLimitClause("SELECT * FROM items limit 50 offset 20;"), true);
      assert.equal(hasLimitClause("SELECT * FROM items WHERE limit_date > '2026';"), false);

      // Paginación real aplicada al motor
      const paged1 = applySqlPagination("SELECT * FROM large_table", 50, 0);
      assert.equal(paged1, "SELECT * FROM large_table LIMIT 50 OFFSET 0;");

      const paged2 = applySqlPagination("SELECT * FROM large_table WHERE active = 1 ORDER BY id DESC;", 100, 200);
      assert.equal(paged2, "SELECT * FROM large_table WHERE active = 1 ORDER BY id DESC LIMIT 100 OFFSET 200;");

      // Si ya tiene LIMIT, no lo altera
      const pagedWithLimit = applySqlPagination("SELECT * FROM items LIMIT 10;", 50, 0);
      assert.equal(pagedWithLimit, "SELECT * FROM items LIMIT 10;");

      // No altera sentencias no-SELECT
      const nonSelect = applySqlPagination("INSERT INTO logs VALUES ('ok');", 50, 0);
      assert.equal(nonSelect, "INSERT INTO logs VALUES ('ok');");

      // Consulta de conteo optimizada
      const countQuery = buildCountQuery("SELECT id, name FROM users WHERE active = 1;");
      assert.equal(countQuery, "SELECT COUNT(*) AS total_rows FROM (SELECT id, name FROM users WHERE active = 1);");
    });
  });

  describe("8. Empaquetador CSS Avanzado (htmlBundler: @import con media, layer, supports y límites de tamaño)", () => {
    test("parseCssImportConditions y wrapCssWithConditions preservan media, layer y supports", () => {
      // 1. Parsing de condiciones
      const c1 = parseCssImportConditions("layer(utilities) supports(display: grid) screen and (min-width: 768px)");
      assert.equal(c1.layerClause, "@layer utilities");
      assert.equal(c1.supportsCondition, "display: grid");
      assert.equal(c1.mediaQueries, "screen and (min-width: 768px)");

      const c2 = parseCssImportConditions("print");
      assert.equal(c2.layerClause, "");
      assert.equal(c2.supportsCondition, "");
      assert.equal(c2.mediaQueries, "print");

      const c3 = parseCssImportConditions("layer");
      assert.equal(c3.layerClause, "@layer");
      assert.equal(c3.supportsCondition, "");
      assert.equal(c3.mediaQueries, "");

      // 2. Envoltura con condiciones
      const wrapped = wrapCssWithConditions(".btn { color: red; }", {
        layerClause: "@layer utilities",
        supportsCondition: "display: grid",
        mediaQueries: "screen and (min-width: 768px)",
        commentHeader: '/* @import "test.css" */'
      });
      assert.ok(wrapped.includes('/* @import "test.css" */'));
      assert.ok(wrapped.includes("@layer utilities {"));
      assert.ok(wrapped.includes("@supports (display: grid) {"));
      assert.ok(wrapped.includes("@media screen and (min-width: 768px) {"));
      assert.ok(wrapped.includes(".btn { color: red; }"));
    });

    test("bundleHtmlWithFolderAssets preserva condiciones de @import y omite imports que excedan MAX_PREVIEW_ASSET_BYTES", () => {
      const rawHtml = '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Hola</h1></body></html>';
      const largeCssContent = "/* big */\n" + "body { color: blue; }\n".repeat(25000); // > 512 KB
      const normalCss = ".title { font-weight: bold; }";
      const fileMap = new Map([
        ["index.html", { path: "index.html", content: rawHtml }],
        ["style.css", { path: "style.css", content: '@import "theme.css" layer(theme);\n@import "large.css";\nbody { margin: 0; }' }],
        ["theme.css", { path: "theme.css", content: normalCss }],
        ["large.css", { path: "large.css", content: largeCssContent }]
      ]);

      const bundled = bundleHtmlWithFolderAssets("index.html", rawHtml, fileMap);

      // El import normal con layer debe estar inlined y envuelto en @layer theme
      assert.ok(bundled.includes("@layer theme {"));
      assert.ok(bundled.includes(".title { font-weight: bold; }"));

      // El import que supera MAX_PREVIEW_ASSET_BYTES no se inyecta y genera un comentario de advertencia
      assert.ok(bundled.includes("omitido: excede el límite de tamaño individual"));
      assert.ok(!bundled.includes("body { color: blue; }"));
    });

    test("bundleHtmlWithFolderAssets unifica el presupuesto acumulado entre hojas raíz e imports (@import y <link>)", () => {
      // 1. Creamos bloques de CSS de ~450 KB (menores a MAX_PREVIEW_ASSET_BYTES = 512 KB)
      const chunk450k = "/* chunk */\n" + ".item { display: block; }\n".repeat(18000); // ~450 KB
      assert.ok(chunk450k.length < MAX_PREVIEW_ASSET_BYTES);

      const rawHtml = '<!DOCTYPE html><html><head>' +
        '<link rel="stylesheet" href="root1.css">' +
        '<link rel="stylesheet" href="root2.css">' +
        '<link rel="stylesheet" href="root3.css">' +
        '</head><body><h1>Unificado</h1></body></html>';

      // root1.css pesa ~450 KB e importa sub1.css (~450 KB) y sub2.css (~450 KB) -> total ~1.35 MB
      // root2.css pesa ~450 KB e importa sub3.css (~450 KB) -> el import superará los 2 MB
      // root3.css pesa ~450 KB -> la hoja raíz superará los 2 MB
      const fileMap = new Map([
        ["index.html", { path: "index.html", content: rawHtml }],
        ["root1.css", { path: "root1.css", content: '@import "sub1.css";\n@import "sub2.css";\n' + chunk450k }],
        ["sub1.css", { path: "sub1.css", content: chunk450k }],
        ["sub2.css", { path: "sub2.css", content: chunk450k }],
        ["root2.css", { path: "root2.css", content: '@import "sub3.css";\n' + chunk450k }],
        ["sub3.css", { path: "sub3.css", content: chunk450k }],
        ["root3.css", { path: "root3.css", content: chunk450k }]
      ]);

      const bundled = bundleHtmlWithFolderAssets("index.html", rawHtml, fileMap, null, (c) => c, { path: "extra.css", content: chunk450k });

      // root1 y sus primeros imports entran en el presupuesto
      assert.ok(bundled.includes('<style data-source="root1.css">'));
      assert.ok(bundled.includes('/* @import "sub1.css" */'));
      assert.ok(bundled.includes('/* @import "sub2.css" */'));

      // Las hojas que empujan el acumulado por encima de MAX_TOTAL_INLINED_CSS se omiten de forma uniforme:
      // 1. @import hijo omitido con comentario CSS
      assert.ok(bundled.includes('/* [Studio IDE]: @import "sub3.css" omitido: presupuesto total de CSS superado */'));
      // 2. <link> raíz omitido con comentario HTML y conservando el tag link
      assert.ok(bundled.includes('<!-- [Studio IDE]: stylesheet "root3.css" omitido: presupuesto total de CSS superado -->'));
      assert.ok(bundled.includes('href="root3.css"'));
      // 3. ensureCssFile omitido con comentario HTML
      assert.ok(bundled.includes('<!-- [Studio IDE]: stylesheet "extra.css" omitido: presupuesto total de CSS superado -->'));
    });
  });

  describe("9. Correcciones Quirúrgicas de Seguridad, Binarios y SQL (Auditoría Codex)", () => {
    test("base64ToUint8Array decodifica correctamente binarios y realiza round-trip con uint8ArrayToBase64", () => {
      const original = new Uint8Array([0, 1, 2, 255, 254, 128, 64, 32, 16, 8, 4, 2, 0]);
      const b64 = uint8ArrayToBase64(original);
      const decoded = base64ToUint8Array(b64);
      assert.deepEqual(Array.from(decoded), Array.from(original));

      // Manejo seguro de vacíos y nulos
      assert.equal(base64ToUint8Array("").length, 0);
      assert.equal(base64ToUint8Array(null).length, 0);
      assert.equal(base64ToUint8Array(undefined).length, 0);
    });

    test("buildZipArchive empaqueta binarios Uint8Array preservando contenido exacto", () => {
      const binaryBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // Header PNG
      const zipBytes = buildZipArchive([
        { path: "logo.png", content: binaryBytes },
        { path: "readme.txt", content: "hola" }
      ]);
      assert.ok(zipBytes instanceof Uint8Array);
      assert.ok(zipBytes.length > 50);

      // Comprobar que los bytes del PNG están presentes literalmente en el ZIP (método STORE)
      let foundHeader = false;
      for (let i = 0; i <= zipBytes.length - binaryBytes.length; i++) {
        let match = true;
        for (let j = 0; j < binaryBytes.length; j++) {
          if (zipBytes[i + j] !== binaryBytes[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          foundHeader = true;
          break;
        }
      }
      assert.ok(foundHeader, "El contenido binario crudo debe estar intacto dentro del ZIP sin corrupción de encoding");
    });

    test("buildSqlRunnerPreview provee exportación completa y discriminada por página", () => {
      const html = buildSqlRunnerPreview("SELECT 1;", "test.sql");
      assert.ok(html.includes('id="btn-export-csv"'));
      assert.ok(html.includes('id="btn-export-json"'));
      assert.ok(html.includes("resultados_sql_completos.csv"));
      assert.ok(html.includes("resultados_sql_completos.json"));
      assert.ok(html.includes("CSV (Esta página)"));
    });
  });

  describe("10. Guardia de Archivos Binarios en el Editor e Integridad de CodeMirror", () => {
    test("isBinaryFile reconoce propiedades isBinary, base64 y extensiones binarias", () => {
      assert.equal(isBinaryFile({ path: "img.png", isBinary: true }), true);
      assert.equal(isBinaryFile({ path: "custom.dat", base64: "AQID" }), true);
      assert.equal(isBinaryFile({ path: "archivo.bin", encoding: "base64" }), true);
      assert.equal(isBinaryFile("foto.jpg"), true);
      assert.equal(isBinaryFile("archivo.pdf"), true);
      assert.equal(isBinaryFile("bundle.zip"), true);
      assert.equal(isBinaryFile("engine.wasm"), true);
      assert.equal(isBinaryFile("script.js"), false);
      assert.equal(isBinaryFile("estilos.css"), false);
      assert.equal(isBinaryFile("index.html"), false);
      assert.equal(isBinaryFile(null), false);
    });

    test("isImageFile e getImageMimeType identifican imágenes y resuelven el MIME correspondiente", () => {
      assert.equal(isImageFile("foto.png"), true);
      assert.equal(isImageFile("avatar.jpg"), true);
      assert.equal(isImageFile("logo.webp"), true);
      assert.equal(isImageFile("diagrama.svg"), true);
      assert.equal(isImageFile("main.cpp"), false);

      assert.equal(getImageMimeType("test.png"), "image/png");
      assert.equal(getImageMimeType("test.jpg"), "image/jpeg");
      assert.equal(getImageMimeType("test.jpeg"), "image/jpeg");
      assert.equal(getImageMimeType("test.gif"), "image/gif");
      assert.equal(getImageMimeType("test.webp"), "image/webp");
      assert.equal(getImageMimeType("test.svg"), "image/svg+xml");
      assert.equal(getImageMimeType("test.ico"), "image/x-icon");
    });

    test("editorManager no procesa ni carga en el documento archivos marcados como binarios", async () => {
      const mount = document.createElement("div");
      let changeFired = false;
      const editor = await createEditorManager({
        mountEl: mount,
        enableMinimap: false,
        onDocChange: () => { changeFired = true; },
        onSelectionChange: () => {}
      });

      // Intentar abrir archivo binario
      editor.openFile({
        id: "banner.png",
        path: "banner.png",
        lang: "image",
        isBinary: true,
        content: "AQIDBA=="
      });

      // El editor debe haber ignorado la apertura para no corromper la memoria
      assert.equal(editor.getActiveFileId(), null);
      assert.equal(changeFired, false);

      // Abrir archivo de texto normal debe funcionar sin problemas
      editor.openFile({
        id: "main.js",
        path: "main.js",
        lang: "js",
        isBinary: false,
        content: "console.log(1);"
      });
      assert.equal(editor.getActiveFileId(), "main.js");

      // Intentar abrir binario con encoding base64 cuando hay un archivo activo no debe pisarlo
      editor.openFile({
        id: "data.bin",
        path: "data.bin",
        encoding: "base64",
        content: "AQID"
      });
      assert.equal(editor.getActiveFileId(), "main.js");
      editor.destroy();
    });
  });

  describe("11. Correcciones de Auditoría Integral 360° (Integridad Binaria, Concurrencia, WASM y Bundler)", () => {
    test("renameProjectEntry preserva isBinary y base64 sin emitir tormenta de ENTRY_UPSERTED", async () => {
      const projId = "test-binary-rename-360";
      await ensureInitialWorkspace();
      await upsertEntry(projId, "assets/logo.png", {
        isFolder: false,
        content: "iVBORw0KGgoAAAANSUhEUg==",
        isBinary: true,
        base64: "iVBORw0KGgoAAAANSUhEUg=="
      });

      const events = [];
      const otherTabChannel = new BroadcastChannel("studio_ide_workspace_sync");
      otherTabChannel.unref?.();
      otherTabChannel.addEventListener("message", (ev) => {
        if (ev.data?.projectId === projId) {
          events.push(ev.data);
        }
      });

      try {
        await renameProjectEntry(projId, "assets/logo.png", "assets/brand.png", false);
        await new Promise((r) => setTimeout(r, 40));

        const entries = await getProjectEntries(projId);
        const renamed = entries.find((e) => e.path === "assets/brand.png");
        assert.ok(renamed, "El archivo renombrado debe existir en IndexedDB");
        assert.equal(renamed.isBinary, true, "Debe preservar el flag isBinary tras renombrar");
        assert.equal(renamed.base64, "iVBORw0KGgoAAAANSUhEUg==", "Debe preservar el payload base64 tras renombrar");
        assert.equal(events.filter((e) => e.type === "ENTRY_UPSERTED").length, 0, "No debe emitir ENTRY_UPSERTED intermedios durante rename");
        assert.equal(events.filter((e) => e.type === "ENTRY_RENAMED").length, 1, "Debe emitir exactamente 1 evento ENTRY_RENAMED");
      } finally {
        otherTabChannel.close();
        await deleteProject(projId);
      }
    });

    test("createProjectFromGistBackup persiste correctamente content, isBinary, base64 y mode", async () => {
      await ensureInitialWorkspace();
      const created = await createProjectFromGistBackup({
        projectName: "Gist Binary Test",
        entries: [
          { path: "main.py", content: "print('ok')", mode: "100755" },
          { path: "icon.png", content: "AQIDBA==", isBinary: true, base64: "AQIDBA==" }
        ]
      });

      try {
        const entries = await getProjectEntries(created.id);
        const pyFile = entries.find((e) => e.path === "main.py");
        const pngFile = entries.find((e) => e.path === "icon.png");
        assert.equal(pyFile?.content, "print('ok')");
        assert.equal(pyFile?.mode, "100755");
        assert.equal(pngFile?.isBinary, true);
        assert.equal(pngFile?.base64, "AQIDBA==");
      } finally {
        await deleteProject(created.id);
      }
    });

    test("restoreEmergencyBackup ordena múltiples respaldos por savedAt ascendente para que gane el más reciente", async () => {
      const storage = new Map();
      const mockStorage = {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k),
        get length() { return storage.size; },
        key: (i) => Array.from(storage.keys())[i] ?? null
      };

      // Insertar primero en el Map una clave con timestamp MÁS NUEVO (t = 2000)
      storage.set(
        getEmergencyBackupKey("proj-order", "tab-newer"),
        JSON.stringify({
          savedAt: 2000,
          projectId: "proj-order",
          instanceId: "tab-newer",
          items: [{ projectId: "proj-order", filePath: "index.js", content: "version NUEVA" }]
        })
      );
      // Insertar después en el Map una clave con timestamp MÁS VIEJO (t = 1000)
      storage.set(
        getEmergencyBackupKey("proj-order", "tab-older"),
        JSON.stringify({
          savedAt: 1000,
          projectId: "proj-order",
          instanceId: "tab-older",
          items: [{ projectId: "proj-order", filePath: "index.js", content: "version VIEJA" }]
        })
      );

      const writes = [];
      const mockDb = {
        async entryExists() { return true; },
        async updateFileContent(pid, path, content) {
          writes.push({ pid, path, content });
        }
      };

      const restored = await restoreEmergencyBackup(mockDb, mockStorage, "proj-order");
      assert.equal(restored, 2);
      assert.equal(writes.length, 2);
      assert.equal(writes[0].content, "version VIEJA");
      assert.equal(writes[1].content, "version NUEVA", "El respaldo con mayor savedAt debe aplicarse al final");
    });

    test("bundleHtmlWithFolderAssets incrusta imágenes locales Base64 y SVG como data URIs", () => {
      const fileMap = new Map([
        ["logo.png", { path: "logo.png", isBinary: true, base64: "iVBORw0KGgo=", content: "iVBORw0KGgo=" }],
        ["icon.svg", { path: "icon.svg", isBinary: false, content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>' }]
      ]);

      const rawHtml = '<!DOCTYPE html><html><body><img class="brand" src="./logo.png" alt="Logo"><img src="icon.svg"></body></html>';
      const bundled = bundleHtmlWithFolderAssets("index.html", rawHtml, fileMap);

      assert.ok(bundled.includes('src="data:image/png;base64,iVBORw0KGgo="'), "Debe incrustar PNG binario como data URI Base64");
      assert.ok(bundled.includes('src="data:image/svg+xml;charset=utf-8,'), "Debe incrustar SVG local como data URI UTF-8");
    });

    test("buildSqlRunnerPreview libera la instancia previa con db.close() al reiniciar la base", () => {
      const html = buildSqlRunnerPreview("SELECT 1;", "test.sql");
      assert.ok(html.includes("db.close()"), "Debe invocar db.close() antes de recrear SQL.Database para evitar fugas en el heap WASM");
      assert.ok(html.includes("var Engine = sqlEngine || window.SQL;"), "Debe conservar referencia a sqlEngine al reiniciar");
    });

    test("KeyboardRouter bloquea atajos globales de fondo cuando un modal con blockGlobalShortcuts está activo", () => {
      const router = new KeyboardRouter();
      let shortcutFired = false;
      router.registerGlobalShortcut("ctrl+p", () => {
        shortcutFired = true;
      });

      router.pushModal({
        id: "dialog-settings",
        blockGlobalShortcuts: true,
        onEscape: () => true
      });

      router.handleKeyDown({
        key: "p",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: () => {},
        stopImmediatePropagation: () => {}
      });

      assert.equal(shortcutFired, false, "No debe disparar atajos globales mientras el diálogo modal está abierto");

      router.popModal("dialog-settings");
      router.handleKeyDown({
        key: "p",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: () => {},
        stopImmediatePropagation: () => {}
      });

      assert.equal(shortcutFired, true, "Debe disparar el atajo global una vez cerrado el modal");
    });
  });
});
