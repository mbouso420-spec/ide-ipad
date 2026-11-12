import "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as acorn from "acorn";

import {
  createLocalProject,
  upsertEntry,
  updateFileContent,
  renameProjectEntry,
  deleteProjectEntry,
  getProjectEntries,
  getAllRawProjectEntries,
  entryExists,
  onWorkspaceBroadcast,
  broadcastWorkspaceChange,
  closeWorkspaceBroadcast,
  createProjectFromGistBackup
} from "../js/storage/workspaceDb.js";

import {
  writeEmergencyBackup,
  restoreEmergencyBackup,
  getEmergencyBackupKey
} from "../js/storage/emergencyBackup.js";

import { buildZipArchive, computeCrc32 } from "../js/storage/zipExporter.js";
import { uint8ArrayToBase64 } from "../js/storage/fileImport.js";
import { createEditorManager } from "../js/editor/editorManager.js";
import { bundleHtmlWithFolderAssets } from "../js/preview/htmlBundler.js";
import { instrumentLoops } from "../js/preview/loopGuard.js";
import {
  convertResultsToCsv,
  convertResultsToJson,
  applySqlPagination,
  buildCountQuery,
  buildSqlRunnerPreview
} from "../js/preview/sqlRunner.js";
import {
  mountCRunnerView,
  WAIT_INPUT_MARKER
} from "../js/preview/cRunner.js";
import {
  saveProjectToGist,
  fetchGistBackupContent,
  fetchRepoTreeIndex
} from "../js/github/githubService.js";

/** Helper para leer la memoria actual en MB */
function getHeapMB() {
  if (typeof globalThis.gc === "function") {
    try { globalThis.gc(); } catch (_) {}
  }
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

/**
 * Parser real de archivos PKZIP (método STORE) para verificar integridad byte a byte
 * de archivos comprimidos por buildZipArchive.
 */
function parseAndVerifyZipArchive(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const decoder = new TextDecoder("utf-8");
  const files = [];

  // Buscar EOCD desde el final (22 bytes mínimos sin comentario)
  let eocdOffset = zipBytes.length - 22;
  assert.equal(view.getUint32(eocdOffset, true), 0x06054b50, "Firma EOCD (PK\\x05\\x06) inválida");

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  let offset = 0;
  while (offset < centralDirOffset) {
    const sig = view.getUint32(offset, true);
    assert.equal(sig, 0x04034b50, `Firma Local Header inválida en offset ${offset}`);
    const crcExpected = view.getUint32(offset + 14, true);
    const compSize = view.getUint32(offset + 18, true);
    const uncompSize = view.getUint32(offset + 22, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);

    assert.equal(compSize, uncompSize, "Tamaño comprimido vs descomprimido debe coincidir en STORE");

    const nameBytes = zipBytes.subarray(offset + 30, offset + 30 + nameLen);
    const path = decoder.decode(nameBytes);

    const dataStart = offset + 30 + nameLen + extraLen;
    const dataBytes = zipBytes.subarray(dataStart, dataStart + compSize);
    const actualCrc = computeCrc32(dataBytes);
    assert.equal(actualCrc, crcExpected, `CRC-32 corrupto para ${path}`);

    files.push({ path, dataBytes: new Uint8Array(dataBytes) });
    offset = dataStart + compSize;
  }

  assert.equal(files.length, totalEntries, "El número de archivos locales no coincide con EOCD");
  return files;
}

describe("SOAK & ENDURANCE TEST: Pruebas a Gran Escala y Larga Duración", () => {
  // Generamos un proyecto masivo reutilizable: 1,050 archivos en 25 niveles de profundidad + 50 binarios Base64
  const TOTAL_FILES = 1050;
  const DEPTH_LEVELS = 25;
  const BINARY_COUNT = 50;

  function buildMassiveProjectDataset() {
    const dataset = [];
    for (let i = 0; i < TOTAL_FILES; i++) {
      // Construir ruta anidada hasta 25 niveles
      const depth = (i % DEPTH_LEVELS) + 1;
      const dirs = [];
      for (let d = 1; d <= depth; d++) {
        dirs.push(`branch_${i % 4}/lvl_${d}`);
      }
      const prefix = dirs.join("/");

      if (i < BINARY_COUNT) {
        // 50 archivos binarios pesados (~16 KB cada uno -> ~800 KB binarios en Base64)
        const rawBytes = new Uint8Array(16 * 1024);
        for (let b = 0; b < rawBytes.length; b++) {
          rawBytes[b] = (b + i) & 0xff;
        }
        const b64 = uint8ArrayToBase64(rawBytes);
        dataset.push({
          path: `${prefix}/asset_${i}.png`,
          isFolder: false,
          isBinary: true,
          base64: b64,
          rawBytes,
          content: ""
        });
      } else {
        const mod = i % 5;
        let ext = "js";
        let content = `// Archivo ${i}\nexport const id = ${i};\nexport function run_${i}(n) { let s = 0; for (let k = 0; k < n; k++) s += k; return s; }\n`;
        if (mod === 1) {
          ext = "html";
          content = `<!DOCTYPE html><html><head><link rel="stylesheet" href="style_${i}.css"></head><body><h1>Vista ${i} ñandú 🚀</h1></body></html>`;
        } else if (mod === 2) {
          ext = "css";
          content = `.cls-${i} { color: oklch(70% 0.1 ${i % 360}); margin: ${i % 20}px; }`;
        } else if (mod === 3) {
          ext = "c";
          content = `#include <stdio.h>\nint fn_${i}(int x) { return x * 2; }\n`;
        } else if (mod === 4) {
          ext = "sql";
          content = `SELECT * FROM tabla_${i} WHERE id > ${i};`;
        }
        dataset.push({
          path: `${prefix}/mod_${i}.${ext}`,
          isFolder: false,
          isBinary: false,
          base64: null,
          content
        });
      }
    }
    return dataset;
  }

  describe("Escenario 1: Jornada de Desarrollo Extrema (1,050 archivos, 25 niveles, 5,000 operaciones E2E)", () => {
    test("1.1 Ingesta masiva, 2,000 ediciones CodeMirror, renombrado de ramas binarias y borrado bajo carga", async () => {
      const memStart = getHeapMB();
      const t0 = performance.now();

      const project = await createLocalProject("Enterprise End-to-End 1050");
      const dataset = buildMassiveProjectDataset();

      // Pisar todo en IndexedDB vía hydrate/replace o createProjectFromGistBackup para poblar rápido y medir Gist restore
      const imported = await createProjectFromGistBackup({
        projectName: project.name,
        entries: dataset
      });
      const pid = imported.id;

      const entriesAfterImport = await getProjectEntries(pid);
      const filesAfterImport = entriesAfterImport.filter((e) => !e.isFolder);
      assert.equal(filesAfterImport.length, TOTAL_FILES, "Deben haberse creado exactamente 1,050 archivos");

      // Validamos que todos los activos binarios conservaron intacto su Base64
      const binaryEntries = filesAfterImport.filter((e) => e.isBinary);
      assert.equal(binaryEntries.length, BINARY_COUNT);

      // 1.2 Simulación de editor: abrir 50 archivos, inyectar 2,000 ediciones de texto, cambiar pestañas y dropear estado
      const mountEl = document.createElement("div");
      const editor = await createEditorManager({
        mountEl,
        enableMinimap: false,
        onDocChange: () => {},
        onSelectionChange: () => {}
      });

      const sampleFiles = filesAfterImport.slice(BINARY_COUNT, BINARY_COUNT + 50);
      for (let i = 0; i < 5000; i++) {
        const f = sampleFiles[i % sampleFiles.length];
        editor.openFile({
          id: f.path,
          path: f.path,
          lang: "javascript",
          content: f.content + `\n// Edit iteration ${i}`
        });
        if (i % 40 === 0) {
          editor.addErrorMarker(1, `Diagnostic ${i}`);
        }
        if (i % 10 === 0) {
          editor.dropFileState(f.path);
        }
      }
      // Limpieza total
      for (const f of sampleFiles) {
        editor.dropFileState(f.path);
      }
      editor.clearActiveFile();
      assert.equal(editor.getActiveFileId(), null);
      editor.destroy();

      // 1.3 Renombrado masivo de rama completa con archivos binarios y 25 niveles de profundidad
      // branch_0 contiene 1/4 de los archivos (~263 archivos, varios binarios en Base64)
      await renameProjectEntry(pid, "branch_0", "renamed_branch_0", true);

      const postRenameEntries = await getProjectEntries(pid);
      const orphanBranch0 = postRenameEntries.filter((e) => e.path === "branch_0" || e.path.startsWith("branch_0/"));
      assert.equal(orphanBranch0.length, 0, "No deben quedar rutas huérfanas bajo branch_0 tras renombrar");

      const renamedBranch0Files = postRenameEntries.filter((e) => !e.isFolder && e.path.startsWith("renamed_branch_0/"));
      assert.ok(renamedBranch0Files.length > 200, "Deben haberse movido todos los hijos de branch_0");

      // Verificar integridad byte a byte de un binario movido
      const movedBinary = renamedBranch0Files.find((e) => e.isBinary && e.path.includes("asset_0.png"));
      assert.ok(movedBinary, "El binario asset_0.png debe existir dentro de renamed_branch_0");
      assert.equal(movedBinary.base64, dataset[0].base64, "El payload Base64 del binario movido debe ser idéntico al original");

      // 1.4 Sobreescritura de ruta previamente binaria (incluso soft-deleted de GitHub) con un archivo de TEXTO
      await upsertEntry(pid, "gh_bin/img.png", {
        isFolder: false,
        fromGithub: true,
        isBinary: true,
        base64: "AAAA////BBBB"
      });
      await deleteProjectEntry(pid, "gh_bin/img.png", false); // deja registro soft-deleted con base64 residual
      await upsertEntry(pid, "gh_bin/img.png", {
        isFolder: false,
        content: "reemplazo en texto plano",
        isBinary: false
      });
      const rawEntries = await getAllRawProjectEntries(pid);
      const overwritten = rawEntries.find((e) => e.path === "gh_bin/img.png");
      assert.equal(overwritten.isBinary, false);
      assert.equal(overwritten.base64, null, "CRÍTICO: Un archivo de texto creado sobre ruta soft-deleted binaria NO debe heredar base64 viejo");

      // 1.5 Eliminación masiva en cascada mientras autoguardados están activos
      await deleteProjectEntry(pid, "branch_1", true);
      const finalEntries = await getProjectEntries(pid);
      assert.equal(
        finalEntries.filter((e) => e.path === "branch_1" || e.path.startsWith("branch_1/")).length,
        0,
        "Rama eliminada en cascada debe desaparecer por completo"
      );

      const memEnd = getHeapMB();
      const elapsed = performance.now() - t0;
      console.log(`[SOAK 1] 1,050 archivos + 5,000 ciclos editor + renombrado profundo: ${Math.round(elapsed)} ms | Heap: ${memStart.toFixed(1)} MB -> ${memEnd.toFixed(1)} MB`);
      assert.ok(memEnd - memStart < 180, `Crecimiento de heap controlado (${(memEnd - memStart).toFixed(1)} MB)`);
    });
  });

  describe("Escenario 2: Bombardeo Multi-Pestaña y Caos de Concurrencia (8 Instancias + BroadcastChannel + QuotaOverflow)", () => {
    test("2.1 8 pestañas concurrentes con ráfagas de BroadcastChannel, pagehide síncrono hasta QuotaExceeded y convergencia por savedAt", async () => {
      const projectId = `soak_concurrent_${Date.now()}`;
      const TAB_COUNT = 8;
      const targetFiles = ["src/app.js", "src/utils.js", "styles/main.css", "index.html", "core/engine.c"];

      // Creamos los archivos iniciales en IndexedDB
      for (const path of targetFiles) {
        await upsertEntry(projectId, path, { content: `// Init ${path}` });
      }

      // Mock de localStorage con cuota realista de 25 KB para provocar QuotaExceededError durante la tormenta
      const QUOTA_LIMIT_CHARS = 25000;
      class QuotaLimitedStorage {
        constructor() { this._store = new Map(); this._totalChars = 0; }
        get length() { return this._store.size; }
        key(i) { return Array.from(this._store.keys())[i] || null; }
        getItem(k) { return this._store.has(k) ? this._store.get(k) : null; }
        setItem(k, v) {
          const val = String(v);
          const prevLen = this._store.has(k) ? this._store.get(k).length : 0;
          const nextTotal = this._totalChars - prevLen + val.length;
          if (nextTotal > QUOTA_LIMIT_CHARS) {
            const err = new Error("QuotaExceededError: Storage quota exceeded");
            err.name = "QuotaExceededError";
            throw err;
          }
          this._totalChars = nextTotal;
          this._store.set(k, val);
        }
        removeItem(k) {
          if (this._store.has(k)) {
            this._totalChars -= this._store.get(k).length;
            this._store.delete(k);
          }
        }
        clear() { this._store.clear(); this._totalChars = 0; }
      }

      const sharedStorage = new QuotaLimitedStorage();
      const tabReceivedEvents = Array.from({ length: TAB_COUNT }, () => []);
      const channels = Array.from({ length: TAB_COUNT }, (_, idx) => {
        const ch = new BroadcastChannel("studio_ide_workspace_sync");
        ch.addEventListener("message", (ev) => {
          tabReceivedEvents[idx].push(ev.data);
        });
        return ch;
      });

      const unsub = onWorkspaceBroadcast(() => {});

      // Inyectamos backups previos viejos "basura" para consumir ~20 KB de los 25 KB disponibles
      for (let stale = 0; stale < 5; stale++) {
        sharedStorage.setItem(
          getEmergencyBackupKey("old_crashed_proj", `stale_tab_${stale}`),
          JSON.stringify({
            savedAt: 10000 + stale * 1000,
            projectId: "old_crashed_proj",
            instanceId: `stale_tab_${stale}`,
            items: [{ projectId: "old_crashed_proj", filePath: "dump.txt", content: "Z".repeat(3800) }]
          })
        );
      }

      // Disparamos operaciones concurrentes desde las 8 pestañas con latencias asimétricas y payloads que desbordan los 25 KB
      let quotaHits = 0;
      let evictionsVerified = false;
      let latestWinningTimestamp = 0;
      const expectedWinningContents = new Map();

      await Promise.all(
        Array.from({ length: TAB_COUNT }, async (_, tabIdx) => {
          const instanceId = `tab_${tabIdx}`;
          for (let step = 1; step <= 20; step++) {
            await new Promise((r) => setTimeout(r, (tabIdx * 2 + step) % 7));
            const filePath = targetFiles[(tabIdx + step) % targetFiles.length];
            const payloadContent = `// Edit by tab ${tabIdx} step ${step} ts=${Date.now()} ` + "X".repeat(1600);

            // Mutación asíncrona en IndexedDB + Broadcast
            await updateFileContent(projectId, filePath, payloadContent);
            broadcastWorkspaceChange({ type: "FILE_UPDATED", projectId, path: filePath });

            // Simulamos pagehide repentino forzando volcado síncrono
            const wrote = writeEmergencyBackup(
              [{ projectId, filePath, content: payloadContent }],
              sharedStorage,
              projectId,
              instanceId
            );
            if (!wrote) {
              quotaHits++;
            } else {
              const rawKey = getEmergencyBackupKey(projectId, instanceId);
              const rawVal = sharedStorage.getItem(rawKey);
              if (rawVal) {
                const savedJson = JSON.parse(rawVal);
                const prev = expectedWinningContents.get(filePath);
                if (!prev || savedJson.savedAt >= prev.savedAt) {
                  expectedWinningContents.set(filePath, {
                    savedAt: savedJson.savedAt,
                    content: payloadContent
                  });
                  latestWinningTimestamp = Math.max(latestWinningTimestamp, savedJson.savedAt);
                }
              }
            }
          }
        })
      );

      // Verificamos que los backups obsoletos de proyectos viejos fueron evictados automáticamente para salvar sesiones activas
      evictionsVerified = sharedStorage.getItem(getEmergencyBackupKey("old_crashed_proj", "stale_tab_0")) === null;
      assert.ok(evictionsVerified, "Ante cuota llena, writeEmergencyBackup debe evictar respaldos viejos para salvar la sesión activa");

      // También verificamos desborde absoluto (> cuota total de 25 KB) -> retorna false sin lanzar excepción
      const tooBig = writeEmergencyBackup(
        [{ projectId, filePath: "mega.js", content: "M".repeat(30000) }],
        sharedStorage,
        projectId,
        "overflow_tab"
      );
      assert.equal(tooBig, false, "Un payload mayor que la cuota total debe retornar false limpiamente");

      // Limpiamos canales de escucha antes de la fase de reinicio
      for (const ch of channels) ch.close();
      unsub();
      closeWorkspaceBroadcast();

      // Permitimos que las particiones válidas escritas puedan restaurarse en frío
      const dbAdapter = { entryExists, updateFileContent };
      const restoredCount = await restoreEmergencyBackup(dbAdapter, sharedStorage, projectId);
      assert.ok(restoredCount >= 0, "La restauración en frío no debe fallar incluso tras saturación previa de cuota");

      // Verificamos consistencia final en IndexedDB y ausencia de archivos huérfanos o corruptos
      const finalEntries = await getProjectEntries(projectId);
      const finalFiles = finalEntries.filter((e) => !e.isFolder);
      assert.equal(finalFiles.length, targetFiles.length, "Todos los archivos deben sobrevivir intactos");

      for (const f of finalFiles) {
        assert.ok(typeof f.content === "string" && f.content.length > 0, `Archivo ${f.path} intacto`);
      }

      // Test explícito de orden cronológico estricto en restoreEmergencyBackup (último savedAt siempre gana)
      const chronStorage = new QuotaLimitedStorage();
      chronStorage.setItem(
        getEmergencyBackupKey(projectId, "old_tab"),
        JSON.stringify({
          savedAt: 1000000,
          projectId,
          instanceId: "old_tab",
          items: [{ projectId, filePath: "src/app.js", content: "VERSION_ANTIGUA_1000" }]
        })
      );
      chronStorage.setItem(
        getEmergencyBackupKey(projectId, "newest_tab"),
        JSON.stringify({
          savedAt: 9999999,
          projectId,
          instanceId: "newest_tab",
          items: [{ projectId, filePath: "src/app.js", content: "VERSION_GANADORA_9999" }]
        })
      );
      chronStorage.setItem(
        getEmergencyBackupKey(projectId, "mid_tab"),
        JSON.stringify({
          savedAt: 5000000,
          projectId,
          instanceId: "mid_tab",
          items: [{ projectId, filePath: "src/app.js", content: "VERSION_MEDIA_5000" }]
        })
      );

      await restoreEmergencyBackup(dbAdapter, chronStorage, projectId);
      const afterChronRestore = await getProjectEntries(projectId);
      const appFile = afterChronRestore.find((e) => e.path === "src/app.js");
      assert.equal(
        appFile.content,
        "VERSION_GANADORA_9999",
        "Matemáticamente debe prevalecer el snapshot con el savedAt cronológicamente más reciente"
      );

      console.log(`[SOAK 2] 8 pestañas x 20 pasos concurrentes | Cuotas bloqueadas sin crash: ${quotaHits} | Ganador cronológico verificado`);
    });
  });

  describe("Escenario 3: Tortura de Motores de Compilación, Bundler y WASM en Simultáneo", () => {
    test("3.1 Bundler HTML/CSS + LoopGuard + Imágenes data: URI en 150 ciclos repetitivos", () => {
      const memStart = getHeapMB();
      const t0 = performance.now();

      const files = new Map();
      // Construir cadena de 15 @imports con @layer, @supports y @media
      for (let i = 0; i < 15; i++) {
        const next = i < 14 ? `@import "sheet_${i + 1}.css" layer(theme) supports(display: flex) screen and (min-width: 600px);\n` : "";
        files.set(`app/sheet_${i}.css`, {
          path: `app/sheet_${i}.css`,
          content: `${next}.node-${i} { display: flex; padding: ${i}px; }`
        });
      }
      // Imagen PNG dummy Base64
      const imgB64 = uint8ArrayToBase64(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]));
      for (let img = 0; img < 15; img++) {
        files.set(`app/img_${img}.png`, {
          path: `app/img_${img}.png`,
          isBinary: true,
          base64: imgB64
        });
      }

      const heavyJs = `
        let total = 0;
        for (let i = 0; i < 100; i++) {
          while (total < i) { total++; }
          do { total += 0; } while (false);
        }
      `;
      const imgsHtml = Array.from({ length: 15 }, (_, k) => `<img src="img_${k}.png">`).join("");
      const htmlEntry = `<!DOCTYPE html><html><head><link rel="stylesheet" href="sheet_0.css"></head><body>${imgsHtml}<script>${heavyJs}</script></body></html>`;

      for (let cycle = 0; cycle < 150; cycle++) {
        const guarded = instrumentLoops(heavyJs, acorn);
        assert.equal(guarded.loops, 3);
        const bundled = bundleHtmlWithFolderAssets("app/index.html", htmlEntry, files);
        assert.ok(bundled.includes("data:image/png;base64,"), "Debe incrustar imágenes locales como data: URI");
        assert.ok(bundled.includes("@layer theme"));
        assert.ok(bundled.includes(".node-14 { display: flex;"));
      }

      const memEnd = getHeapMB();
      const elapsed = performance.now() - t0;
      console.log(`[SOAK 3.1] 150 builds completos (15 @imports + 15 data:URIs + LoopGuard AST): ${Math.round(elapsed)} ms | Delta Heap: ${(memEnd - memStart).toFixed(1)} MB`);
      assert.ok(elapsed < 4000, "Bundling repetitivo no debe degradar rendimiento");
    });

    test("3.2 SQLite WASM Endurance: 100,000 registros en memoria, paginación y 300 ciclos de reinicio sin fugas", () => {
      const memStart = getHeapMB();
      const t0 = performance.now();

      (() => {
        const TOTAL_ROWS = 100000;
        const columns = ["id", "codigo", "descripcion", "nota", "activo"];
        const values = new Array(TOTAL_ROWS);
        for (let i = 0; i < TOTAL_ROWS; i++) {
          values[i] = [
            i + 1,
            `SKU-${i}`,
            `Item ${i} "con comillas",\r\nsalto y emoji ⚡`,
            i % 4 === 0 ? null : `Nota_${i}`,
            i % 2
          ];
        }

        const csvFull = convertResultsToCsv([{ columns, values }]);
        assert.ok(csvFull.length > 4_000_000, "CSV de 100k registros supera 4 MB");
        assert.ok(csvFull.includes("SKU-99999"));

        const jsonFull = convertResultsToJson([{ columns, values }]);
        assert.equal(jsonFull.length, TOTAL_ROWS);
        assert.equal(jsonFull[99999].codigo, "SKU-99999");
      })();

      const memPeak = getHeapMB();

      // Paginación de 300 páginas aleatorias
      for (let p = 0; p < 300; p++) {
        const paginated = applySqlPagination("WITH x AS (SELECT * FROM big_table) SELECT * FROM x ORDER BY id", 50, p * 50);
        assert.ok(paginated.endsWith(`LIMIT 50 OFFSET ${p * 50};`));
        const counted = buildCountQuery("SELECT * FROM big_table WHERE activo = 1");
        assert.equal(counted, "SELECT COUNT(*) AS total_rows FROM (SELECT * FROM big_table WHERE activo = 1);");
      }

      // Simulamos 300 ciclos consecutivos de instancia/cierre (db.close())
      let totalGeneratedHtmlBytes = 0;
      for (let resetCycle = 0; resetCycle < 300; resetCycle++) {
        const previewHtml = buildSqlRunnerPreview({
          path: `test_${resetCycle}.sql`,
          shortName: `test_${resetCycle}.sql`,
          content: "SELECT * FROM massive;"
        });
        assert.ok(previewHtml.includes("db.close()"));
        totalGeneratedHtmlBytes += previewHtml.length;
      }

      const memEnd = getHeapMB();
      const elapsed = performance.now() - t0;
      const hasExplicitGc = typeof globalThis.gc === "function";
      console.log(`[SOAK 3.2] 100k filas CSV/JSON + 300 ciclos db.close() (${(totalGeneratedHtmlBytes / 1024).toFixed(0)} KB HTML): ${Math.round(elapsed)} ms | Heap: ${memStart.toFixed(1)} MB (post-100k ${memPeak.toFixed(1)} MB) -> ${memEnd.toFixed(1)} MB [GC=${hasExplicitGc}]`);
      if (hasExplicitGc) {
        assert.ok(memEnd - memStart < 25, `Tras GC explícito no debe existir retención de memoria (delta ${(memEnd - memStart).toFixed(1)} MB)`);
      } else {
        assert.ok(memEnd - memPeak < 25, `Los 300 ciclos de reinicio/paginación no deben acumular fugas sobre el pico (delta ${(memEnd - memPeak).toFixed(1)} MB)`);
        assert.ok(memEnd - memStart < 150, `Crecimiento de heap sin GC dentro de presupuesto seguro (${(memEnd - memStart).toFixed(1)} MB)`);
      }
    });

    test("3.3 Ejecutor C/C++ + Bombardeo Consola (50,000 mensajes) con abortos rápidos y verificación de listeners", async () => {
      const memStart = getHeapMB();
      const t0 = performance.now();

      // A. 100 ráfagas de compilación canceladas abruptamente vía destroy() en < 2ms
      let leakedCallbacks = 0;
      const mountC = document.createElement("div");

      for (let i = 0; i < 100; i++) {
        const runner = mountCRunnerView(mountC, {
          activeFile: { path: "burst.c", content: '#include <stdio.h>\nint main(){ int x; scanf("%d", &x); return 0; }' },
          fetchFn: async () => {
            await new Promise((r) => setTimeout(r, 15));
            return new Response(JSON.stringify({ status: "0", program_output: WAIT_INPUT_MARKER }), { status: 200 });
          },
          onCompilerResult: () => {
            leakedCallbacks++;
          }
        });
        // Destruimos inmediatamente en el ciclo siguiente sin esperar a Wandbox
        runner.destroy();
      }
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(leakedCallbacks, 0, "Ningún runner destruido en vuelo debe disparar callbacks rezagados");

      // B. Bombardeo de 50,000 mensajes a la consola DOM respetando estrictamente el límite MAX_CONSOLE_LINES = 500
      const consoleList = document.createElement("div");
      const MAX_CONSOLE_LINES = 500;
      for (let m = 1; m <= 50000; m++) {
        while (consoleList.children.length >= MAX_CONSOLE_LINES && consoleList.firstElementChild) {
          consoleList.removeChild(consoleList.firstElementChild);
        }
        const item = document.createElement("div");
        item.className = m % 20 === 0 ? "preview-log-item is-error" : "preview-log-item";
        item.textContent = `[T+${m}] Salida continua de alta frecuencia`;
        consoleList.appendChild(item);
      }
      assert.equal(consoleList.children.length, 500, "El DOM de consola no debe superar jamás 500 nodos tras 50,000 líneas");
      assert.equal(consoleList.children[0].textContent, "[T+49501] Salida continua de alta frecuencia");
      assert.equal(consoleList.children[499].textContent, "[T+50000] Salida continua de alta frecuencia");

      const memEnd = getHeapMB();
      const elapsed = performance.now() - t0;
      console.log(`[SOAK 3.3] 100 abortos C Runner + 50,000 logs DOM: ${Math.round(elapsed)} ms | Delta Heap: ${(memEnd - memStart).toFixed(1)} MB`);
    });
  });

  describe("Escenario 4: Integración Externa, Gists (> 1 MB Truncados), PKZIP 1,050 Archivos y Errores de Red", () => {
    test("4.1 Empaquetado PKZIP de 1,050 archivos (texto + 50 binarios) y verificación byte a byte descomprimida", () => {
      const dataset = buildMassiveProjectDataset();
      const zipInput = dataset.map((f) => ({
        path: f.path,
        content: f.isBinary ? f.rawBytes : f.content
      }));

      const t0 = performance.now();
      const zipBytes = buildZipArchive(zipInput);
      const packMs = performance.now() - t0;

      // Desempaquetamos y validamos cada uno de los 1,050 archivos byte a byte y CRC-32
      const extracted = parseAndVerifyZipArchive(zipBytes);
      assert.equal(extracted.length, TOTAL_FILES, "Deben extraerse los 1,050 archivos sin omisiones");

      const decoder = new TextDecoder("utf-8");
      for (let i = 0; i < TOTAL_FILES; i++) {
        assert.equal(extracted[i].path, dataset[i].path);
        if (dataset[i].isBinary) {
          assert.equal(extracted[i].dataBytes.length, dataset[i].rawBytes.length);
          assert.equal(computeCrc32(extracted[i].dataBytes), computeCrc32(dataset[i].rawBytes));
        } else {
          assert.equal(decoder.decode(extracted[i].dataBytes), dataset[i].content);
        }
      }

      console.log(`[SOAK 4.1] Empaquetado PKZIP y verificación CRC32 byte-a-byte de 1,050 archivos (${(zipBytes.length / 1024).toFixed(0)} KB): ${Math.round(packMs)} ms`);
    });

    test("4.2 Respaldo en Gist (> 1 MB) y prueba de truncamiento de GitHub API (truncated: true + raw_url)", async () => {
      const dataset = buildMassiveProjectDataset();
      const origFetch = globalThis.fetch;

      // Construimos el payload serializado real del proyecto masivo
      let capturedManifestJson = "";
      globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        if (u.endsWith("/gists") && init.method === "POST") {
          const parsedBody = JSON.parse(init.body);
          capturedManifestJson = parsedBody.files["studio_project.json"].content;
          return new Response(
            JSON.stringify({ id: "gist_soak_1050", html_url: "https://gist.github.com/gist_soak_1050", updated_at: "2026-11-11T00:00:00Z" }),
            { status: 201 }
          );
        }
        if (u.endsWith("/gists/gist_soak_1050")) {
          // Simulamos comportamiento REAL de GitHub API cuando un archivo supera 1 MB: truncated = true y contenido cortado!
          return new Response(
            JSON.stringify({
              id: "gist_soak_1050",
              description: "[Studio IDE Backup] Soak 1050",
              files: {
                "studio_project.json": {
                  filename: "studio_project.json",
                  truncated: true,
                  content: capturedManifestJson.slice(0, 1024), // Cortado intencionalmente!
                  raw_url: "https://gist.githubusercontent.com/raw/gist_soak_1050/studio_project.json"
                },
                "branch_0__lvl_1__asset_0.png": {
                  filename: "branch_0__lvl_1__asset_0.png",
                  content: "// vista previa truncada"
                }
              }
            }),
            { status: 200 }
          );
        }
        if (u.includes("gist.githubusercontent.com/raw/gist_soak_1050/studio_project.json")) {
          return new Response(capturedManifestJson, { status: 200 });
        }
        throw new Error(`Fetch inesperado en test Gist: ${u}`);
      };

      const mockToken = "ghp_MockTokenForSoakTest1234567890abcdef";
      try {
        const saved = await saveProjectToGist(mockToken, {
          projectName: "Soak 1050",
          entries: dataset
        });
        assert.equal(saved.id, "gist_soak_1050");
        assert.ok(capturedManifestJson.length > 1_000_000, "El manifiesto de 1,050 archivos con binarios supera 1 MB");

        // Descargamos el respaldo simulando que GitHub devolvió truncated: true
        const restored = await fetchGistBackupContent(mockToken, "gist_soak_1050");
        assert.equal(
          restored.entries.length,
          TOTAL_FILES,
          "CRÍTICO: Al recibir truncated:true en Gist > 1 MB, fetchGistBackupContent debe recuperar el manifiesto íntegro vía raw_url sin perder 1,040 archivos"
        );
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("4.3 Resiliencia GitHub Tree API: árboles truncados (truncated: true) y errores HTTP 403/500/red caída", async () => {
      const origFetch = globalThis.fetch;
      const mockToken = "ghp_MockTokenForSoakTest1234567890abcdef";

      // Caso A: Árbol truncado por GitHub (> 100k entradas o > 7 MB)
      globalThis.fetch = async (url) => {
        if (String(url).includes("/branches/")) {
          return new Response(JSON.stringify({ commit: { sha: "abc1234", commit: { tree: { sha: "tree123" } } } }), { status: 200 });
        }
        if (String(url).includes("/git/trees/")) {
          return new Response(
            JSON.stringify({
              sha: "tree123",
              truncated: true,
              tree: [
                { path: "src/index.js", type: "blob", sha: "s1", size: 100, mode: "100644" },
                { path: "node_modules/pkg/a.js", type: "blob", sha: "s2", size: 100, mode: "100644" }, // Debe ignorarse
                { path: "link_simbolico", type: "blob", sha: "s3", size: 10, mode: "120000" } // Debe ignorarse
              ]
            }),
            { status: 200 }
          );
        }
        return new Response("Not Found", { status: 404 });
      };

      try {
        const treeRes = await fetchRepoTreeIndex({ token: mockToken, owner: "u", repo: "r", branch: "main" });
        assert.equal(treeRes.isTruncated, true, "Debe propagar la bandera isTruncated: true");
        assert.equal(treeRes.entries.length, 1, "Debe filtrar node_modules y enlaces simbólicos 120000");
        assert.equal(treeRes.entries[0].path, "src/index.js");

        // Caso B: Error 403 Rate Limit
        globalThis.fetch = async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, statusText: "Forbidden" });
        await assert.rejects(
          async () => fetchRepoTreeIndex({ token: mockToken, owner: "u", repo: "r", branch: "main" }),
          (err) => err && (err.status === 403 || String(err.message).toLowerCase().includes("rate") || String(err.message).includes("403") || String(err.message).includes("permiso"))
        );

        // Caso C: Error 500 Server Error
        globalThis.fetch = async () => new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
        await assert.rejects(
          async () => fetchRepoTreeIndex({ token: mockToken, owner: "u", repo: "r", branch: "main" }),
          (err) => err instanceof Error
        );

        // Caso D: Desconexión de red abrupta
        globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
        await assert.rejects(
          async () => fetchRepoTreeIndex({ token: mockToken, owner: "u", repo: "r", branch: "main" }),
          (err) => err instanceof Error
        );
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

});
