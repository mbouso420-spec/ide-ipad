import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

import "./setup.js";

import * as tsFacade from "../js/preview/tsTranspiler.js";
import * as bundlerFacade from "../js/preview/moduleBundler.js";
import * as htmlFacade from "../js/preview/htmlBundler.js";
import * as workspaceFacade from "../js/storage/workspaceDb.js";
import * as chatFacade from "../js/ai/chatController.js";

import {
  MAX_AI_ATTACHMENTS,
  extractMentionQuery,
  filterMentionCandidates,
  createMentionPopover
} from "../js/ai/mentionPopover.js";
import { initDiffModal } from "../js/ui/diffModal.js";
import { runWasiModule, WasiExitError } from "../js/preview/wasiRunner.js";
import { compileAndRunWithClang, sanitizeVirtualSourcePath } from "../js/preview/clangWorker.js";
import {
  COMPILER_MODES,
  buildClangWasmPayload,
  compileAndRunWithFallback
} from "../js/preview/cRunner.js";
import {
  LIVE_LINT_DEBOUNCE_MS,
  isLiveLintablePath,
  lintJson,
  lintHtml,
  lintJavaScript,
  lintDocument
} from "../js/editor/liveLinter.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Construye un módulo binario WebAssembly WASI mínimo y válido (sin dependencias externas)
 * que escribe `message` en `fd 1` vía `fd_write` y finaliza llamando a `proc_exit(exitCode)`.
 */
function buildMinimalWasiWasm(message = "Hi WASI\n", exitCode = 0) {
  const msgBytes = new TextEncoder().encode(message);

  const encodeU32 = (val) => {
    const out = [];
    let v = val >>> 0;
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v !== 0) byte |= 0x80;
      out.push(byte);
    } while (v !== 0);
    return out;
  };

  const encodeStr = (str) => {
    const b = new TextEncoder().encode(str);
    return [...encodeU32(b.length), ...b];
  };

  const section = (id, payload) => [id, ...encodeU32(payload.length), ...payload];

  // Type section:
  // 0: (i32, i32, i32, i32) -> (i32) [fd_write]
  // 1: (i32) -> () [proc_exit]
  // 2: () -> () [_start]
  const typePayload = [
    0x03,
    0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f,
    0x60, 0x01, 0x7f, 0x00,
    0x60, 0x00, 0x00
  ];

  const importPayload = [
    0x02,
    ...encodeStr("wasi_snapshot_preview1"), ...encodeStr("fd_write"), 0x00, 0x00,
    ...encodeStr("wasi_snapshot_preview1"), ...encodeStr("proc_exit"), 0x00, 0x01
  ];

  const funcPayload = [0x01, 0x02];
  const memPayload = [0x01, 0x00, 0x01];
  const exportPayload = [
    0x02,
    ...encodeStr("memory"), 0x02, 0x00,
    ...encodeStr("_start"), 0x00, 0x02
  ];

  // iovec en offset 32 (<64, single-byte SLEB128): { buf: 0, buf_len: msgBytes.length }, nwritten en offset 40
  const body = [
    0x00, // 0 locals
    0x41, 0x01, // fd = 1
    0x41, 0x20, // iovsPtr = 32
    0x41, 0x01, // iovsLen = 1
    0x41, 0x28, // nwrittenPtr = 40
    0x10, 0x00, // call fd_write
    0x1a, // drop
    0x41, ...encodeU32(exitCode), // exit code (<64)
    0x10, 0x01, // call proc_exit
    0x0b // end
  ];
  const codePayload = [0x01, ...encodeU32(body.length), ...body];

  const msgSegment = [
    0x00, 0x41, 0x00, 0x0b, // active mem 0, offset 0
    ...encodeU32(msgBytes.length),
    ...msgBytes
  ];
  const iovBytes = [
    0x00, 0x00, 0x00, 0x00, // ptr = 0
    msgBytes.length & 0xff,
    (msgBytes.length >> 8) & 0xff,
    (msgBytes.length >> 16) & 0xff,
    (msgBytes.length >> 24) & 0xff
  ];
  const iovSegment = [
    0x00, 0x41, 0x20, 0x0b,
    ...encodeU32(iovBytes.length),
    ...iovBytes
  ];
  const dataPayload = [0x02, ...msgSegment, ...iovSegment];

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, typePayload),
    ...section(2, importPayload),
    ...section(3, funcPayload),
    ...section(5, memPayload),
    ...section(7, exportPayload),
    ...section(10, codePayload),
    ...section(11, dataPayload)
  ]);
}

describe("Studio IDE v1.3.0 — Suite Integral de Features, Refactorización y Seguridad", () => {
  describe("1. Paridad de contratos públicos tras refactorización modular", () => {
    test("fachadas conservan el 100% de las firmas exportadas", () => {
      assert.equal(typeof tsFacade.tokenizeJsWithOffsets, "function");
      assert.equal(typeof tsFacade.transpileTypeScriptAndJsx, "function");

      assert.equal(typeof bundlerFacade.rewriteEsModuleToRegistry, "function");
      assert.equal(typeof bundlerFacade.extractModuleDependencyPaths, "function");
      assert.equal(typeof bundlerFacade.buildVirtualModuleBundle, "function");
      assert.equal(typeof bundlerFacade.inspectModuleUsage, "function");
      assert.equal(typeof bundlerFacade.isRelativeModuleSpecifier, "function");

      assert.equal(typeof htmlFacade.resolveRelativePath, "function");
      assert.equal(typeof htmlFacade.bundleHtmlWithFolderAssets, "function");
      assert.equal(typeof htmlFacade.buildStandaloneTsPreview, "function");
      assert.equal(typeof htmlFacade.buildStandaloneJsPreview, "function");
      assert.equal(typeof htmlFacade.findSiblingHtmlInSameFolder, "function");
      assert.equal(typeof htmlFacade.findTargetHtmlFile, "function");
      assert.equal(typeof htmlFacade.findBestHtmlEntrypoint, "function");
      assert.equal(typeof htmlFacade.buildStandaloneImagePreview, "function");
      assert.equal(typeof htmlFacade.extractTextAssetPaths, "function");

      assert.equal(Array.isArray(workspaceFacade.PROJECT_TEMPLATES), true);
      assert.equal(typeof workspaceFacade.createLocalProject, "function");
      assert.equal(typeof workspaceFacade.discardEntryChange, "function");

      assert.equal(typeof chatFacade.initChatController, "function");
      assert.equal(chatFacade.MAX_AI_ATTACHMENTS, 8);
      assert.equal(typeof chatFacade.formatProseHtml, "function");
      assert.equal(typeof chatFacade.parseMarkdownSegments, "function");
      assert.equal(typeof chatFacade.estimateTokens, "function");
    });
  });

  describe("2. Idea 1 — Menciones @archivo (máx. 8) y Diff Multi-Archivo con checkboxes", () => {
    test("MAX_AI_ATTACHMENTS es estrictamente 8 y extractMentionQuery ignora emails", () => {
      assert.equal(MAX_AI_ATTACHMENTS, 8);
      assert.equal(extractMentionQuery("contacto dev@correo.com", 23), null);
      assert.deepEqual(extractMentionQuery("revisá @src/ut", 14), {
        query: "src/ut",
        startIndex: 7,
        endIndex: 14
      });
      assert.deepEqual(extractMentionQuery("@index.html", 11), {
        query: "index.html",
        startIndex: 0,
        endIndex: 11
      });
    });

    test("filterMentionCandidates excluye binarios, carpetas, node_modules y archivo activo", () => {
      const files = [
        { id: "main.js", path: "main.js", shortName: "main.js", isBinary: false },
        { id: "src/utils.js", path: "src/utils.js", shortName: "utils.js", isBinary: false },
        { id: "assets/logo.png", path: "assets/logo.png", shortName: "logo.png", isBinary: true },
        { id: "node_modules/pkg/index.js", path: "node_modules/pkg/index.js", shortName: "index.js", isBinary: false },
        { id: "README.md", path: "README.md", shortName: "README.md", isBinary: false }
      ];
      const results = filterMentionCandidates(files, "ut", "main.js");
      assert.deepEqual(results.map((f) => f.id), ["src/utils.js"]);
      const allAllowed = filterMentionCandidates(files, "", "main.js");
      assert.deepEqual(allAllowed.map((f) => f.id), ["README.md", "src/utils.js"]);
    });

    test("mentionPopover escapa HTML en nombres de archivo maliciosos (AppSec XSS)", () => {
      const form = document.createElement("form");
      const input = document.createElement("textarea");
      form.appendChild(input);
      document.body.appendChild(form);

      let selected = null;
      const popover = createMentionPopover({
        promptInput: input,
        composerForm: form,
        getProjectFiles: () => [
          { id: 'x/<img onerror=alert(1)>.js', path: 'x/<img onerror=alert(1)>.js', shortName: '<img onerror=alert(1)>.js' }
        ],
        getActiveFileId: () => null,
        onSelectFile: (f) => { selected = f; }
      });

      input.value = "@img";
      input.selectionStart = 4;
      popover.refresh();
      assert.equal(popover.isOpen(), true);
      const popEl = document.getElementById("chat-mention-popover");
      const btn = popEl.querySelector(".chat-mention-item");
      assert.ok(btn);
      assert.equal(btn.innerHTML.includes("<img "), false, "Debe escapar '<img' antes de inyectar innerHTML");
      assert.ok(btn.innerHTML.includes("&lt;img onerror=alert(1)&gt;.js"));

      btn.dispatchEvent(new Event("click"));
      assert.equal(selected?.id, 'x/<img onerror=alert(1)>.js');

      popover.destroy();
      popEl.remove();
      form.remove();
    });

    test("diffModal.openMultiFileApplyDiff permite desmarcar archivos y solo confirma los seleccionados", () => {
      const origCreateFrag = document.createDocumentFragment;
      document.createDocumentFragment = () => document.createElement("div");

      const dialog = document.createElement("dialog");
      dialog.id = "diff-dialog";
      dialog.open = false;
      dialog.showModal = () => { dialog.open = true; };
      dialog.close = () => { dialog.open = false; };
      const titleEl = document.createElement("h2");
      titleEl.id = "diff-dialog-title";
      const statsEl = document.createElement("div");
      statsEl.id = "diff-dialog-stats";
      const multiBar = document.createElement("div");
      multiBar.id = "diff-multi-bar";
      const bodyEl = document.createElement("div");
      bodyEl.id = "diff-lines-view";
      const closeBtn = document.createElement("button");
      closeBtn.id = "btn-close-diff";
      const cancelBtn = document.createElement("button");
      cancelBtn.id = "btn-diff-cancel";
      const confirmBtn = document.createElement("button");
      confirmBtn.id = "btn-diff-confirm";

      dialog.append(titleEl, statsEl, multiBar, bodyEl, closeBtn, cancelBtn, confirmBtn);
      document.body.appendChild(dialog);

      try {
        const diffModal = initDiffModal();
        let confirmedFiles = null;

        diffModal.openMultiFileApplyDiff({
          files: [
            { path: "a.js", oldCode: "const a = 1;", newCode: "const a = 2;" },
            { path: "b.js", oldCode: "", newCode: "export const b = 3;", isNew: true }
          ],
          onConfirm: (selected) => { confirmedFiles = selected; }
        });

        assert.equal(dialog.open, true);
        assert.equal(multiBar.hidden, false);
        assert.equal(confirmBtn.textContent, "Aplicar seleccionados (2)");

        // Desmarcar el primer archivo (a.js)
        const checkboxes = multiBar.querySelectorAll("input");
        assert.equal(checkboxes.length, 2);
        checkboxes[0].checked = false;
        checkboxes[0].dispatchEvent(new Event("change"));
        assert.equal(confirmBtn.textContent, "Aplicar seleccionados (1)");

        confirmBtn.dispatchEvent(new Event("click"));
        assert.equal(confirmedFiles?.length, 1);
        assert.equal(confirmedFiles[0].path, "b.js");

        // Probar navegación Anterior / Siguiente en diff multi-archivo read-only
        diffModal.openMultiFileReadOnlyDiff({
          title: "Pre-commit",
          items: [
            { path: "uno.js", oldCode: "1", newCode: "2" },
            { path: "dos.js", oldCode: "a", newCode: "b" }
          ],
          initialIndex: 0
        });
        assert.ok(titleEl.textContent.includes("uno.js"));
        const nextBtn = document.getElementById("btn-diff-next");
        nextBtn.dispatchEvent(new Event("click"));
        assert.ok(titleEl.textContent.includes("dos.js"));

        diffModal.destroy();
      } finally {
        dialog.remove();
        document.createDocumentFragment = origCreateFrag;
      }
    });
  });

  describe("3. Idea 2 — Fallback Offline C/C++ WASI + Clang WASM", () => {
    test("runWasiModule ejecuta un binario WebAssembly WASI real y captura stdout y exitCode", async () => {
      const wasmOk = buildMinimalWasiWasm("Hola desde WASI!\n", 0);
      const resOk = await runWasiModule(wasmOk);
      assert.equal(resOk.exitCode, 0);
      assert.equal(resOk.stdout, "Hola desde WASI!\n");
      assert.equal(resOk.truncated, false);

      const wasmExit7 = buildMinimalWasiWasm("Fallo controlado", 7);
      const resErr = await runWasiModule(wasmExit7);
      assert.equal(resErr.exitCode, 7);
      assert.equal(resErr.stdout, "Fallo controlado");
      assert.equal(new WasiExitError(3).code, 3);
    });

    test("compileAndRunWithClang sanitiza rutas y maneja compilación exitosa vs error de enlace", async () => {
      assert.equal(sanitizeVirtualSourcePath("-O0"), "./-O0");
      assert.equal(sanitizeVirtualSourcePath("../../etc/passwd", "fallback.c"), "fallback.c");

      const wasmBytes = buildMinimalWasiWasm("C multiarchivo OK\n", 0);
      const okRes = await compileAndRunWithClang({
        isC: true,
        mainFileName: "main.c",
        files: { "main.c": "int main(){}", "utils.h": "" },
        extraSources: ["utils.c"],
        runClangFn: async (args) => {
          assert.equal(args[0], "clang");
          assert.equal(args.includes("-o"), true);
          return { "program.wasm": wasmBytes };
        }
      });
      assert.equal(okRes.success, true);
      assert.equal(okRes.stdout, "C multiarchivo OK\n");
      assert.equal(okRes.engine, "wasm-clang");

      const errRes = await compileAndRunWithClang({
        isC: false,
        mainFileName: "main.cpp",
        files: { "main.cpp": "broken" },
        runClangFn: async (_args, _fs, opts) => {
          opts.stderr("main.cpp:1:1: error: expected ';'");
          const exitErr = new Error("Exit 1");
          exitErr.name = "Exit";
          exitErr.code = 1;
          throw exitErr;
        }
      });
      assert.equal(errRes.success, false);
      assert.equal(errRes.status, 1);
      assert.ok(errRes.compilerErr.includes("expected ';'"));
    });

    test("compileAndRunWithFallback conmuta de Wandbox a WASM offline, respeta modo manual y no cae tras AbortError", async () => {
      const wasmPayload = buildClangWasmPayload({
        activeFile: { path: "src/utils.h", content: "int suma(int a, int b);" },
        companionFiles: [
          { path: "src/utils.c", content: '#include "utils.h"\nint suma(int a,int b){return a+b;}' },
          { path: "src/main.c", content: '#include <stdio.h>\nint main(void){printf("ok");return 0;}' }
        ],
        stdin: ""
      });
      assert.equal(wasmPayload.mainFileName, "main.c");
      assert.ok(wasmPayload.extraSources.includes("utils.c"));
      assert.ok("utils.h" in wasmPayload.files);

      // 1. Offline directo sin llamar Wandbox
      let wandboxCalled = false;
      const offlineRes = await compileAndRunWithFallback({
        mode: COMPILER_MODES.AUTO,
        isOnline: false,
        isCppFamily: true,
        wandboxPayload: {},
        wasmPayload,
        wandboxFn: async () => { wandboxCalled = true; return {}; },
        wasmFn: async () => ({ status: 0, success: true, stdout: "offline", stderr: "", compilerOut: "", compilerErr: "" })
      });
      assert.equal(wandboxCalled, false);
      assert.equal(offlineRes.usedFallback, true);
      assert.equal(offlineRes.engine, "wasm-clang");

      // 2. Red online pero Wandbox falla -> fallback automático
      const netFallbackRes = await compileAndRunWithFallback({
        mode: COMPILER_MODES.AUTO,
        isOnline: true,
        isCppFamily: true,
        wandboxPayload: {},
        wasmPayload,
        wandboxFn: async () => { throw new Error("Wandbox 503"); },
        wasmFn: async () => ({ status: 0, success: true, stdout: "fallback-ok", stderr: "", compilerOut: "", compilerErr: "" })
      });
      assert.equal(netFallbackRes.usedFallback, true);
      assert.equal(netFallbackRes.stdout, "fallback-ok");

      // 3. AbortError del usuario NO debe disparar fallback
      const ctrl = new AbortController();
      ctrl.abort();
      let wasmCalledAfterAbort = false;
      await assert.rejects(
        () => compileAndRunWithFallback({
          mode: COMPILER_MODES.AUTO,
          isOnline: true,
          isCppFamily: true,
          wandboxPayload: {},
          wasmPayload,
          signal: ctrl.signal,
          wandboxFn: async () => {
            const e = new Error("Aborted");
            e.name = "AbortError";
            throw e;
          },
          wasmFn: async () => { wasmCalledAfterAbort = true; return {}; }
        }),
        /Aborted/
      );
      assert.equal(wasmCalledAfterAbort, false);

      // 4. Modo solo Wandbox nunca cae en WASM
      await assert.rejects(
        () => compileAndRunWithFallback({
          mode: COMPILER_MODES.WANDBOX,
          isOnline: true,
          isCppFamily: true,
          wandboxPayload: {},
          wasmPayload,
          wandboxFn: async () => { throw new Error("Wandbox down"); },
          wasmFn: async () => ({ status: 0, success: true, stdout: "nope" })
        }),
        /Wandbox down/
      );
    });
  });

  describe("4. Idea 3 — Pre-Commit Diff Panel & discardEntryChange", () => {
    test("discardEntryChange revierte editados, restaura borrados, elimina nuevos locales y restaura binarios", async () => {
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const project = await workspaceFacade.hydrateLazyGithubProject({
        owner: "u",
        repo: `discard_${suffix}`,
        branch: "main",
        commitSha: "sha1",
        entries: [
          { path: "app.js", blobSha: "s1" },
          { path: "borrar.txt", blobSha: "s2" },
          { path: "img.png", blobSha: "s3", isBinary: true }
        ]
      });
      await workspaceFacade.cacheSingleGithubFileContent(project.id, "app.js", "const orig = 1;", "s1");
      await workspaceFacade.cacheSingleGithubFileContent(project.id, "borrar.txt", "texto base", "s2");
      await workspaceFacade.cacheSingleGithubFileContent(project.id, "img.png", { isBinary: true, base64: "AAAA" }, "s3");

      await workspaceFacade.updateFileContent(project.id, "app.js", "const editado = 999;");
      await workspaceFacade.deleteProjectEntry(project.id, "borrar.txt", false);
      await workspaceFacade.upsertEntry(project.id, "nuevo_local.js", { content: "// nuevo" });
      await workspaceFacade.upsertEntry(project.id, "img.png", { isBinary: true, base64: "BBBB" });

      let pending = await workspaceFacade.getPendingGithubChanges(project.id);
      assert.equal(pending.length, 4);

      const r1 = await workspaceFacade.discardEntryChange(project.id, "app.js");
      assert.deepEqual(r1, { discarded: true, action: "reverted" });

      const r2 = await workspaceFacade.discardEntryChange(project.id, "borrar.txt");
      assert.deepEqual(r2, { discarded: true, action: "restored" });

      const r3 = await workspaceFacade.discardEntryChange(project.id, "nuevo_local.js");
      assert.deepEqual(r3, { discarded: true, action: "removed" });

      const r4 = await workspaceFacade.discardEntryChange(project.id, "img.png");
      assert.deepEqual(r4, { discarded: true, action: "reverted" });

      pending = await workspaceFacade.getPendingGithubChanges(project.id);
      assert.equal(pending.length, 0);

      const appRec = await workspaceFacade.getEntryRecord(project.id, "app.js");
      assert.equal(appRec.content, "const orig = 1;");
      const delRec = await workspaceFacade.getEntryRecord(project.id, "borrar.txt");
      assert.equal(delRec.deleted, false);
      assert.equal(delRec.content, "texto base");
      const binRec = await workspaceFacade.getEntryRecord(project.id, "img.png");
      assert.equal(binRec.base64, "AAAA");
      assert.equal(await workspaceFacade.entryExists(project.id, "nuevo_local.js"), false);
    });
  });

  describe("5. Idea 4 — 5 Plantillas de Proyecto Nuevo + Seguridad XSS/C", () => {
    test("PROJECT_TEMPLATES incluye exactamente las 5 plantillas y createLocalProject crea su estructura saneada", async () => {
      assert.deepEqual(
        workspaceFacade.PROJECT_TEMPLATES.map((t) => t.id),
        ["web", "ts", "python", "sql", "c"]
      );

      const expectedActive = {
        web: "index.html",
        ts: "src/main.ts",
        python: "main.py",
        sql: "schema.sql",
        c: "main.c"
      };

      for (const tpl of workspaceFacade.PROJECT_TEMPLATES) {
        const evilName = `MiApp <script>alert(1)</script> "dev" \\ ${tpl.id}`;
        const created = await workspaceFacade.createLocalProject(evilName, tpl.id);
        assert.equal(created.activeFileId, expectedActive[tpl.id]);
        const entries = await workspaceFacade.getProjectEntries(created.id);
        const filePaths = entries.filter((e) => !e.isFolder).map((e) => e.path);

        for (const reqFile of tpl.filesPreview) {
          assert.ok(filePaths.includes(reqFile), `Plantilla ${tpl.id} debe crear ${reqFile}`);
        }

        if (tpl.id === "web") {
          const htmlEntry = entries.find((e) => e.path === "index.html");
          assert.equal(htmlEntry.content.includes("<script>alert(1)</script>"), false, "HTML de plantilla debe escapar nombre");
        }
        if (tpl.id === "c") {
          const cEntry = entries.find((e) => e.path === "main.c");
          assert.ok(cEntry.content.includes('\\\"dev\\\"'), "C string literal debe escapar comillas");
        }
      }
    });
  });

  describe("6. Idea 5 — Diagnóstico y Linting en Vivo (JS Acorn, JSON, HTML)", () => {
    test("LIVE_LINT_DEBOUNCE_MS = 500 y detección de extensiones soportadas", () => {
      assert.equal(LIVE_LINT_DEBOUNCE_MS, 500);
      assert.equal(isLiveLintablePath("src/app.js"), true);
      assert.equal(isLiveLintablePath("data.json"), true);
      assert.equal(isLiveLintablePath("index.html"), true);
      assert.equal(isLiveLintablePath("main.c"), false);
      assert.equal(isLiveLintablePath("main.py"), false);
    });

    test("lintJson detecta errores con línea exacta e ignora archivos vacíos o válidos", () => {
      assert.deepEqual(lintJson(""), []);
      assert.deepEqual(lintJson('{"ok": [1, 2, true]}'), []);

      const err = lintJson('{\n  "a": 1\n  "b": 2\n}');
      assert.equal(err.length, 1);
      assert.equal(err[0].severity, "error");
      assert.ok(err[0].line >= 2 && err[0].line <= 3);
    });

    test("lintHtml detecta etiquetas abiertas, cierres huérfanos, comentarios sin cerrar e IDs duplicados", () => {
      const validHtml = '<!DOCTYPE html><html><body><img src="x"><br><script>const x = 1 < 2;</script><div id="a">ok</div></body></html>';
      assert.deepEqual(lintHtml(validHtml), []);

      const unclosed = lintHtml("<div>\n  <p>hola\n</div>");
      assert.ok(unclosed.some((d) => d.line === 2 && /<p>/i.test(d.message)));

      const orphan = lintHtml("<main></p></main>");
      assert.ok(orphan.some((d) => /<\/p>/i.test(d.message)));

      const dupId = lintHtml('<div id="hero">1</div>\n<span id="hero">2</span>');
      assert.equal(dupId.length, 1);
      assert.equal(dupId[0].severity, "warning");
      assert.equal(dupId[0].line, 2);
      assert.ok(/warning/i.test(dupId[0].message));
    });

    test("lintJavaScript valida ES Modules con Acorn real y usa respaldo offline sin parseFn", async () => {
      const validJs = await lintJavaScript("export const sum = (a, b) => a + b;\n", "js", { parseFn: acorn.parse });
      assert.deepEqual(validJs, []);

      const brokenJs = await lintJavaScript("const a = 1;\nconst b = ;\n", "js", { parseFn: acorn.parse });
      assert.equal(brokenJs.length, 1);
      assert.equal(brokenJs[0].line, 2);
      assert.equal(brokenJs[0].severity, "error");

      // Sin Acorn (fallback léxico offline) detecta delimitador sin cerrar sin consultar red
      const offlineIssues = await lintDocument("app.js", "function test() {\n  return 1;\n", {
        parseJsFn: null
      });
      assert.equal(offlineIssues.length, 1);
      assert.equal(offlineIssues[0].line, 1);
      const noNetworkFallback = await lintJavaScript("function test() {\n  const x = [1, 2;\n}", "js", {
        parseFn: undefined
      });
      assert.equal(noNetworkFallback.length, 1);
    });
  });

  describe("7. Auditoría Cruzada AppSec, PWA SW v31 y Código Muerto", () => {
    test("ningún nuevo módulo UI o app.js debilita CSP, sandbox ni usa eval/localStorage.setItem", () => {
      const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf-8");
      assert.match(html, /id="preview-iframe"[^>]*sandbox="allow-scripts allow-modals allow-downloads allow-popups"/);
      assert.equal(html.includes("allow-same-origin"), false);

      const appJs = fs.readFileSync(path.join(ROOT_DIR, "js/app.js"), "utf-8");
      assert.equal(/clangWorker|@yowasp\/clang/i.test(appJs), false, "app.js no debe cargar Clang WASM en arranque");
      assert.equal(/\beval\s*\(|new\s+Function\s*\(/.test(appJs), false);

      const swJs = fs.readFileSync(path.join(ROOT_DIR, "sw.js"), "utf-8");
      assert.ok(swJs.includes('SHELL_CACHE = "studio-ide-shell-v31"'));
      assert.equal(swJs.includes("@yowasp/clang"), false, "sw.js no debe precalentar ~23MB de Clang en install");
    });
  });
});
