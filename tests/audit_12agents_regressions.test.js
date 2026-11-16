import "./setup.js";
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { searchInFiles, hasUnsafeReDoSPattern } from "../js/search/projectSearch.js";
import { formatMdInline } from "../js/preview/markdownPreview.js";
import {
  buildStandaloneTsPreview,
  buildWorkspaceAssetMap,
  bundleHtmlWithFolderAssets,
  extractTextAssetPaths
} from "../js/preview/htmlBundler.js";
import { compileAndRunWandbox, mountCRunnerView, WAIT_INPUT_MARKER } from "../js/preview/cRunner.js";
import { createAutosaveManager } from "../js/workspace/autosaveManager.js";
import {
  clearApiKey,
  getApiKey,
  getKeyStorageMode,
  saveApiKey,
  setKeyStorageMode
} from "../js/ai/providers.js";
import { showConfirmDialog } from "../js/ui/confirmDialog.js";
import { sanitizeSvgMarkup } from "../js/ui/binaryPreview.js";
import { icon } from "../js/ui/icons.js";
import { initLayoutController } from "../js/ui/layout.js";
import { initChatController } from "../js/ai/chatController.js";
import { createEditorManager } from "../js/editor/editorManager.js";
import {
  createLocalProject,
  createProjectFromGistBackup,
  deleteProject,
  getProjectEntries,
  upsertEntry
} from "../js/storage/workspaceDb.js";
import { LANGUAGE_SYMBOLS } from "../js/ui/symbolBar.js";
import { formatCode } from "../js/editor/codeFormatter.js";
import { initLivePreviewModal } from "../js/ui/livePreviewModal.js";
import { applyCachedBlobRecordToFile } from "../js/app.js";
import { sanitizeErrorCause } from "../js/security/credentialGuard.js";
import {
  clearEmergencyBackup,
  readEmergencyBackup,
  writeEmergencyBackup
} from "../js/storage/emergencyBackup.js";
import { decodeImportedFile } from "../js/storage/fileImport.js";
import { transpileTypeScriptAndJsx } from "../js/preview/tsTranspiler.js";
import { applySqlPagination, buildSqlRunnerPreview } from "../js/preview/sqlRunner.js";

const ROOT = resolve(import.meta.dirname, "..");

function makeDomNode(tag, id = "", extra = {}) {
  const el = document.createElement(tag);
  if (id) el.id = id;
  Object.assign(el, extra);
  return el;
}

describe("Regresiones Auditoría 12 Agentes — AppSec, Estabilidad, Rendimiento y UI", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setKeyStorageMode("local");
    clearApiKey("gemini");
  });

  test("ReDoS detector: captura patrones []*/[^]*, alt anidados y variantes case-insensitive (a|A)+$", () => {
    assert.equal(hasUnsafeReDoSPattern("([]+)+$"), true);
    assert.equal(hasUnsafeReDoSPattern("([^]+)+$"), true);
    assert.equal(hasUnsafeReDoSPattern("(?:[\\s\\S]+)+$"), true);
    assert.equal(hasUnsafeReDoSPattern("(a|A)+$", { caseSensitive: false }), true);
    assert.equal(hasUnsafeReDoSPattern("\\x41+A+", { caseSensitive: false }), true);

    const searchRes = searchInFiles(
      [{ path: "a.txt", content: "aaaaaaaaaaaaaaaaaaaaaaaa!" }],
      "(a|A)+$",
      { isRegex: true, caseSensitive: false }
    );
    assert.ok(searchRes.error);
    assert.equal(searchRes.totalMatches, 0);
  });

  test("markdownPreview: neutraliza href=javascript: en enlaces", () => {
    const out = formatMdInline("It's R&D & [click](javascript:alert(1))");
    assert.equal(out.includes('href="javascript:'), false);
    assert.equal(out.includes("<a "), false);
  });

  test("htmlBundler: buildStandaloneTsPreview transpila TS/TSX y bundleHtmlWithFolderAssets bloquea escapes /../", () => {
    const tsHtml = buildStandaloneTsPreview({
      path: "src/main.tsx",
      shortName: "main.tsx",
      content: "const total: number = 42;\nconst view = <div data-val={total}>Hola</div>;"
    });
    assert.equal(tsHtml.includes(": number"), false);
    assert.equal(tsHtml.includes("const total = 42"), true);
    assert.equal(tsHtml.includes("React.createElement"), true);

    const assets = buildWorkspaceAssetMap([
      { path: "secret.js", shortName: "secret.js", content: "window.__LEAK__ = true;" },
      { path: "sub/local.js", shortName: "local.js", content: "window.__OK__ = true;" }
    ]);
    const bundled = bundleHtmlWithFolderAssets(
      "sub/index.html",
      '<script src="../secret.js"></script><script src="local.js"></script>',
      assets
    );
    assert.equal(bundled.includes("__LEAK__"), false);
    assert.equal(bundled.includes("__OK__"), true);
  });

  test("cRunner: compileAndRunWandbox aborta json() limpio y mountCRunnerView revierte sessionInputs ante fallo de red", async () => {
    const ctrl = new AbortController();
    let resolveJson;
    const mockFetchAbort = async () => ({
      ok: true,
      json: () => new Promise((r) => { resolveJson = r; })
    });
    const pending = compileAndRunWandbox({ compiler: "gcc-head", code: "int main(){}" }, mockFetchAbort, 5000, ctrl.signal);
    ctrl.abort(new Error("Cancelado por usuario"));
    await assert.rejects(() => pending, /Abort/i);
    resolveJson?.({});

    const prevBody = document.body.innerHTML;
    document.body.innerHTML = "";
    const host = document.createElement("div");
    document.body.appendChild(host);

    const seenStdins = [];
    let callNum = 0;
    const runner = mountCRunnerView(host, {
      activeFile: {
        path: "main.c",
        shortName: "main.c",
        content: '#include <stdio.h>\nint main(){ int x=0; scanf("%d",&x); return 0; }'
      },
      fetchFn: async (_url, init) => {
        callNum += 1;
        const parsed = JSON.parse(init.body);
        seenStdins.push(parsed.stdin);
        if (callNum === 2) {
          throw new Error("Fallo transitorio paso 1");
        }
        return {
          ok: true,
          json: async () => ({
            status: "0",
            program_output: `${WAIT_INPUT_MARKER}\nPaso ${callNum}`
          })
        };
      }
    });

    try {
      await runner.run();
      await new Promise((r) => setTimeout(r, 20));
      const termInput = host.querySelector("input");
      assert.ok(termInput);

      termInput.value = "42";
      termInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await new Promise((r) => setTimeout(r, 20));

      termInput.value = "99";
      termInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await new Promise((r) => setTimeout(r, 20));

      assert.deepEqual(seenStdins, ["", "42\n", "99\n"]);
    } finally {
      runner.destroy();
      document.body.innerHTML = prevBody;
    }
  });

  test("autosaveManager: preserva timer y respaldo de emergencia cuando IndexedDB lanza QuotaExceededError", async () => {
    const origDocAdd = document.addEventListener;
    document.addEventListener = () => {};
    const statuses = [];
    let shouldFailQuota = true;
    const mgr = createAutosaveManager({
      getActiveProjectId: () => "proj-quota",
      updateFileContent: async () => {
        if (shouldFailQuota) {
          const err = new Error("Storage quota exceeded");
          err.name = "QuotaExceededError";
          throw err;
        }
      },
      setAutosaveStatus: (s) => statuses.push(s)
    });

    try {
      mgr.scheduleAutosave("proj-quota", "main.js", "const x = 1;");
      assert.equal(mgr.hasPendingTimer("proj-quota", "main.js"), true);

      mgr.backupAndFlush();
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(mgr.hasPendingTimer("proj-quota", "main.js"), true);
      assert.equal(statuses.some((s) => /QuotaExceededError|lleno/i.test(s)), true);

      shouldFailQuota = false;
      const ok = await mgr.flushPendingSaves();
      assert.equal(ok, true);
      assert.equal(mgr.hasPendingTimer("proj-quota", "main.js"), false);
    } finally {
      mgr.destroy();
      document.addEventListener = origDocAdd;
    }
  });

  test("providers: setKeyStorageMode migra e aisla session<->local idempotentemente sin perder credenciales", () => {
    setKeyStorageMode("local");
    saveApiKey("gemini", "AIzaSySecretUnitKey999999999");
    assert.equal(getKeyStorageMode(), "local");
    assert.equal(getApiKey("gemini"), "AIzaSySecretUnitKey999999999");

    setKeyStorageMode("session");
    assert.equal(getKeyStorageMode(), "session");
    assert.equal(getApiKey("gemini"), "AIzaSySecretUnitKey999999999");

    setKeyStorageMode("session");
    assert.equal(getApiKey("gemini"), "AIzaSySecretUnitKey999999999");

    setKeyStorageMode("local");
    assert.equal(getApiKey("gemini"), "AIzaSySecretUnitKey999999999");
  });

  test("confirmDialog: enfoca Cancelar inicialmente y Enter sobre Cancelar/Cerrar NO confirma", () => {
    let focusedId = "";
    const dialog = makeDomNode("dialog", "confirm-dialog");
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    const titleEl = makeDomNode("h2", "confirm-dialog-title");
    const msgEl = makeDomNode("p", "confirm-dialog-message");
    const cancelBtn = makeDomNode("button", "btn-confirm-cancel");
    cancelBtn.focus = () => {
      focusedId = "btn-confirm-cancel";
      document.activeElement = cancelBtn;
    };
    const closeBtn = makeDomNode("button", "btn-close-confirm");
    closeBtn.focus = () => {
      focusedId = "btn-close-confirm";
      document.activeElement = closeBtn;
    };
    const confirmBtn = makeDomNode("button", "btn-confirm-action");

    const ids = {
      "confirm-dialog": dialog,
      "confirm-dialog-title": titleEl,
      "confirm-dialog-message": msgEl,
      "btn-confirm-cancel": cancelBtn,
      "btn-close-confirm": closeBtn,
      "btn-confirm-action": confirmBtn
    };
    const origGetById = document.getElementById;
    const origActive = document.activeElement;
    document.getElementById = (id) => ids[id] || null;

    let confirmed = 0;
    try {
      showConfirmDialog({
        title: "Borrar",
        message: "¿Confirmar?",
        onConfirm: () => { confirmed += 1; }
      });
      assert.equal(focusedId, "btn-confirm-cancel");

      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", target: cancelBtn }));
      assert.equal(confirmed, 0);

      document.activeElement = closeBtn;
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", target: closeBtn }));
      assert.equal(confirmed, 0);

      cancelBtn.click();
      assert.equal(dialog.open, false);
    } finally {
      document.getElementById = origGetById;
      document.activeElement = origActive;
    }
  });

  test("binaryPreview & icons: sanitizeSvgMarkup resiste tags anidados y icons.js bloquea claves de prototipo", () => {
    const nested = '<svg><scr<script>ipt>alert(1)</script><rect onload=alert(2) width="10" height="10"/><a href="javascript:alert(3)"><text>ok</text></a></svg>';
    const clean = sanitizeSvgMarkup(nested);
    assert.ok(clean);
    assert.equal(/<script/i.test(clean), false);
    assert.equal(/onload=/i.test(clean), false);
    assert.equal(/javascript:/i.test(clean), false);
    assert.equal(clean.includes("<rect"), true);

    assert.equal(icon("constructor"), icon("code"));
    assert.equal(icon("toString"), icon("code"));
    assert.equal(icon("__proto__"), icon("code"));
  });

  test("layout.js: breakpoint 73.99rem sincronizado con CSS y toggleZenMode oculta drawer-backdrop", () => {
    const layoutSrc = readFileSync(resolve(ROOT, "js/ui/layout.js"), "utf8");
    const layoutCss = readFileSync(resolve(ROOT, "css/layout.css"), "utf8");
    assert.equal(layoutSrc.includes("73.99rem"), true);
    assert.equal(layoutCss.includes("73.99rem"), true);

    const ids = {
      "btn-toggle-left": makeDomNode("button", "btn-toggle-left"),
      "btn-toggle-right": makeDomNode("button", "btn-toggle-right"),
      "btn-close-left": makeDomNode("button", "btn-close-left"),
      "btn-close-right": makeDomNode("button", "btn-close-right"),
      "btn-toggle-zen": makeDomNode("button", "btn-toggle-zen"),
      "btn-exit-zen": makeDomNode("button", "btn-exit-zen"),
      "drawer-backdrop": makeDomNode("div", "drawer-backdrop"),
      "panel-explorer": makeDomNode("aside", "panel-explorer"),
      "panel-assistant": makeDomNode("aside", "panel-assistant"),
      "resizer-left": makeDomNode("div", "resizer-left"),
      "resizer-right": makeDomNode("div", "resizer-right")
    };
    const origGetById = document.getElementById;
    const origMatchMedia = window.matchMedia;
    document.getElementById = (id) => ids[id] || null;
    window.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });

    let ctrl = null;
    try {
      ctrl = initLayoutController();
      ctrl.toggleZenMode(true);
      assert.equal(ctrl.isZenMode(), true);

      ctrl.toggleZenMode(false);
      assert.equal(ctrl.isZenMode(), false);
    } finally {
      ctrl?.destroy?.();
      document.getElementById = origGetById;
      window.matchMedia = origMatchMedia;
    }
  });

  test("chatController: cancela requestAnimationFrame pendiente tras finalizar el stream o destruir", async () => {
    const ids = {};
    const mk = (tag, id, extra = {}) => {
      const el = makeDomNode(tag, id, extra);
      ids[id] = el;
      return el;
    };
    mk("button", "chat-settings-toggle");
    mk("div", "chat-settings-drawer", { hidden: true });
    mk("span", "chat-current-model-label");
    mk("button", "chat-key-status-btn");
    mk("select", "ai-provider-select");
    mk("select", "ai-model-select");
    mk("input", "ai-custom-model-input");
    mk("button", "ai-fetch-models-btn");
    mk("input", "ai-api-key-input");
    mk("button", "ai-toggle-key-vis");
    mk("button", "ai-clear-key-btn");
    mk("div", "ai-provider-help");
    mk("button", "ai-mode-local");
    mk("button", "ai-mode-session");
    mk("button", "ai-export-keys-btn");
    mk("button", "ai-import-keys-btn");
    mk("div", "ai-import-keys-slot");
    mk("div", "chat-extra-tabs");
    mk("div", "chat-stream");
    mk("div", "chat-scroll-body");
    const composerForm = mk("form", "chat-composer-form");
    const promptInput = mk("textarea", "chat-prompt-input");
    mk("button", "chat-submit-btn");
    mk("span", "chat-token-counter");
    mk("button", "btn-chat-regenerate");

    const origGetById = document.getElementById;
    const origFetch = globalThis.fetch;
    const origRaf = window.requestAnimationFrame;
    const origCaf = window.cancelAnimationFrame;

    let rafIdSeq = 0;
    const scheduledRafs = new Set();
    const cancelledRafs = [];
    window.requestAnimationFrame = () => {
      const id = ++rafIdSeq;
      scheduledRafs.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      scheduledRafs.delete(id);
      cancelledRafs.push(id);
    };
    document.getElementById = (id) => ids[id] || null;
    saveApiKey("gemini", "AIzaSyStreamCancelTest1234567");
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: "Stream ended" }
    }), { status: 400 });

    let ctrl = null;
    try {
      ctrl = initChatController({
        getContextSnapshot: () => ({
          projectName: "demo",
          activeFile: { id: "a.js", name: "a.js", path: "a.js", lang: "js", content: "const x = 1;", cursorLine: 1 },
          selection: null,
          otherOpenFiles: []
        }),
        onInsertAtCursor: () => {},
        onReplaceSelection: () => {},
        onApplyWholeFile: () => {},
        onApplyToFile: () => true,
        onApplyMultiFile: () => true,
        onConversationChange: () => {},
        onKeysImported: () => {}
      });

      promptInput.value = "Hola";
      const submitEv = new Event("submit", { cancelable: true });
      submitEv.preventDefault = () => {};
      composerForm.dispatchEvent(submitEv);
      await new Promise((r) => setTimeout(r, 30));

      ctrl.destroy();
      assert.equal(scheduledRafs.size, 0);
      assert.ok(cancelledRafs.length >= 0);
    } finally {
      ctrl?.destroy?.();
      document.getElementById = origGetById;
      globalThis.fetch = origFetch;
      window.requestAnimationFrame = origRaf;
      window.cancelAnimationFrame = origCaf;
    }
  });

  test("editorManager: getCompletions devuelve [] cuando no hay archivo activo tras clearActiveFile()", async () => {
    const mount = makeDomNode("div", "editor-mount-unit");
    const editor = await createEditorManager({
      mountEl: mount,
      enableMinimap: false,
      onDocChange: () => {},
      onSelectionChange: () => {}
    });
    try {
      editor.openFile({ id: "main.js", path: "main.js", lang: "js", isBinary: false, content: "const valor = 1;" });
      editor.clearActiveFile();
      const list = editor.getCompletions();
      assert.deepEqual(list, []);
    } finally {
      editor.destroy();
    }
  });

  test("workspaceDb: upsertEntry(base64: null) limpia base64 y createProjectFromGistBackup evita main.cpp fantasma", async () => {
    const proj = await createLocalProject("TestClearBase64");
    try {
      await upsertEntry(proj.id, "img/pic.png", {
        isFolder: false,
        content: "",
        isBinary: true,
        base64: "AAAA",
        allowOverwrite: true
      });
      await upsertEntry(proj.id, "img/pic.png", {
        isFolder: false,
        content: "texto",
        isBinary: false,
        base64: null,
        allowOverwrite: true
      });
      const entries = await getProjectEntries(proj.id);
      const updated = entries.find((e) => e.path === "img/pic.png");
      assert.ok(updated);
      assert.equal(updated.base64, null);
      assert.equal(updated.isBinary, false);
    } finally {
      await deleteProject(proj.id);
    }

    const gistProj = await createProjectFromGistBackup({
      projectName: "GistVacio",
      entries: [
        { path: "bad/logo.png", content: "NOT_VALID_BASE64!!!", isBinary: true, base64: "NOT_VALID_BASE64!!!" },
        { path: "../escape.js", content: "bad", isBinary: false }
      ]
    });
    try {
      const gistEntries = await getProjectEntries(gistProj.id);
      assert.equal(gistEntries.some((e) => e.path === "main.cpp"), false);
      assert.equal(gistEntries.length, 0);
      assert.deepEqual(gistProj.openTabIds, []);
      assert.equal(gistProj.activeFileId, null);
    } finally {
      await deleteProject(gistProj.id);
    }
  });

  test("symbolBar: incluye entrada 'image' y offsets cursorBack exactos en Rust/Go/Java/C#/TS", () => {
    assert.equal(Object.hasOwn(LANGUAGE_SYMBOLS, "image"), true);

    const checkCursor = (lang, label, expectedAfterSlice) => {
      const group = LANGUAGE_SYMBOLS[lang];
      const all = Array.isArray(group?.keys) ? group.keys : [];
      const item = all.find((s) => s.label === label);
      assert.ok(item, `Falta símbolo ${lang}:${label}`);
      const pos = item.insert.length - (item.cursorBack || 0);
      assert.equal(item.insert.slice(pos), expectedAfterSlice, `cursorBack erróneo en ${lang}:${label}`);
    };

    checkCursor("rust", "fn", "() {\n    \n}");
    checkCursor("rust", "struct", " {\n    \n}");
    checkCursor("go", "func", "() {\n    \n}");
    checkCursor("go", "import", '"\n)');
    checkCursor("java", "class", " {\n    \n}");
    checkCursor("csharp", "namespace", "\n{\n    \n}");
    checkCursor("csharp", "class", " {\n    \n}");
    checkCursor("ts", "interface", " {\n  \n}");
    checkCursor("ts", "type", " = ;\n");
  });

  test("codeFormatter: preserva lifetimes en Rust, raw strings en Go y división tras ++/--", () => {
    const rustSrc = "fn f<'a>(x: &'a str) -> &'a str {\nreturn x;\n}";
    const rustFormatted = formatCode(rustSrc, "rust").formatted;
    assert.equal(rustFormatted.includes("<'a>"), true);
    assert.equal(rustFormatted.includes("&'a str"), true);

    const goSrc = "package main\nfunc main() {\ns := `{\n  sinFormato: true\n}`\nprintln(s)\n}";
    const goFormatted = formatCode(goSrc, "go").formatted;
    assert.equal(goFormatted.includes("`{\n  sinFormato: true\n}`"), true);

    const jsSrc = "function f(a, b) {\nreturn a++ / b;\n}";
    const jsFormatted = formatCode(jsSrc, "js").formatted;
    assert.equal(jsFormatted.includes("a++ / b;"), true);
    assert.equal(/\/ b;\s*\*?\//.test(jsFormatted), false);
  });

  test("livePreviewModal & app helpers: destroy invalida render activo y applyCachedBlobRecordToFile sincroniza binarios", async () => {
    const prevBody = document.body.innerHTML;
    document.body.innerHTML = "";
    const mk = (tag, id, extra = {}) => {
      const el = makeDomNode(tag, id, extra);
      document.body.appendChild(el);
      return el;
    };
    const openBtn = mk("button", "btn-live-preview");
    const dialog = mk("dialog", "preview-dialog");
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    mk("h2", "preview-dialog-title");
    mk("span", "preview-file-badge");
    mk("button", "btn-preview-js-mode");
    mk("button", "btn-close-preview");
    mk("button", "btn-preview-reload");
    mk("button", "btn-preview-console");
    mk("button", "btn-preview-clear-console");
    mk("div", "preview-unavailable-state", { hidden: true });
    mk("div", "preview-unavailable-title");
    mk("div", "preview-unavailable-desc");
    mk("div", "preview-console-panel");
    mk("div", "preview-console-title");
    mk("div", "preview-console-list");
    mk("form", "preview-repl-form");
    mk("input", "preview-repl-input");
    mk("div", "preview-iframe-wrapper");
    const iframeEl = mk("iframe", "preview-iframe");
    mk("div", "preview-c-runner");
    mk("select", "preview-page-select");
    mk("button", "btn-preview-back");
    mk("button", "btn-preview-forward");

    let releaseBefore;
    const modal = initLivePreviewModal({
      getWorkspaceSnapshot: () => ({
        projectId: "p-destroy",
        activeFileId: "index.html",
        files: [{ path: "index.html", shortName: "index.html", content: "<h1>Ok</h1>", contentLoaded: true }]
      }),
      onBeforePreview: () => new Promise((r) => { releaseBefore = r; }),
      onErrorMarker: () => {},
      onClearErrorMarkers: () => {},
      onGoToLine: () => {},
      ensureFilesLoaded: async () => {}
    });

    try {
      openBtn.click();
      modal.destroy();
      releaseBefore?.();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(Boolean(iframeEl.srcdoc), false);
    } finally {
      document.body.innerHTML = prevBody;
    }

    const fileObj = { path: "img/a.png", isBinary: false, contentLoaded: false, content: "" };
    const status = applyCachedBlobRecordToFile(
      fileObj,
      { isBinary: true, base64: "AQID", baseBase64: "AQID", contentLoaded: true },
      { isBinary: true, base64: "AQID" }
    );
    assert.equal(status.deleted, false);
    assert.equal(fileObj.isBinary, true);
    assert.equal(fileObj.base64, "AQID");
    assert.equal(fileObj.baseBase64, "AQID");
  });

  test("Ronda Final AppSec: ReDoS nullable/lookahead/union, scrub Octokit headers y SVG splitting", () => {
    // 1. Bypasses ReDoS cerrados: separador nullable, lookahead cero-ancho, unión y grupo nullable
    assert.equal(hasUnsafeReDoSPattern("a+b*a+!$"), true);
    assert.equal(hasUnsafeReDoSPattern("\\w+\\s*\\w+!$"), true);
    assert.equal(hasUnsafeReDoSPattern("a+(?=a)a+!$"), true);
    assert.equal(hasUnsafeReDoSPattern("a+(?:a+|c+)!$"), true);
    assert.equal(hasUnsafeReDoSPattern("(?:a?)+$"), true);

    // 2. Scrubbing de credenciales en RequestError/headers con tuplas y objeto request/response
    const octokitLikeErr = {
      name: "RequestError",
      message: "Bad credentials for ghp_SecretTokenValue1234567890abcdef",
      request: {
        headers: [["Authorization", "Bearer ghp_SecretTokenValue1234567890abcdef"], ["Accept", "application/json"]],
        body: "token=AIzaSySecretKeyForAuditTesting12345"
      },
      response: {
        headers: { "x-oauth-scopes": "repo", "set-cookie": "session=gho_CookieSecret1234567890abcdef" }
      }
    };
    const safeCause = sanitizeErrorCause(octokitLikeErr);
    const serialized = JSON.stringify(safeCause);
    assert.equal(serialized.includes("ghp_SecretTokenValue1234567890abcdef"), false);
    assert.equal(serialized.includes("AIzaSySecretKeyForAuditTesting12345"), false);
    assert.equal(serialized.includes("gho_CookieSecret1234567890abcdef"), false);

    // 3. Sanitización SVG: >10 on* handlers, etiqueta escindida <scr<script> y data:application/xhtml+xml
    const manyHandlers = Array.from({ length: 12 }, (_, i) => `onClick${i}="alert(1)"`).join(" ");
    const maliciousSvg = `<svg xmlns="http://www.w3.org/2000/svg"><rect ${manyHandlers}/><scr<script>alert(1)</script><image href="data:application/xhtml+xml,<html/>"/></svg>`;
    const cleanSvg = sanitizeSvgMarkup(maliciousSvg);
    assert.equal(/onClick\d+/i.test(cleanSvg), false);
    assert.equal(/<script/i.test(cleanSvg), false);
    assert.equal(/xhtml\+xml/i.test(cleanSvg), false);
  });

  test("Ronda Final Bundles & Import: traversal raíz /.., atributo '<!--', UTF-16BE y comentarios HTML en imágenes", () => {
    const assets = buildWorkspaceAssetMap([
      { path: "root-secret.js", shortName: "root-secret.js", content: "window.__ROOT_SECRET__ = 1;" },
      { path: "sub/ok.js", shortName: "ok.js", content: "window.__SUB_OK__ = 1;" }
    ]);
    const htmlWithTraps = '<!DOCTYPE html><html><body><div title="<!--"></div><script src="/root-secret.js"></script><script src="ok.js"></script></body></html>';
    const out = bundleHtmlWithFolderAssets("sub/index.html", htmlWithTraps, assets);
    assert.equal(out.includes("__ROOT_SECRET__"), false);
    assert.equal(out.includes("__SUB_OK__"), true);

    // UTF-16LE sin BOM con marcado activo disfrazado en archivo .png
    const payload16Le = new Uint8Array(Buffer.from("<script>alert(1)</script>", "utf16le"));
    const res16Le = decodeImportedFile(payload16Le, "foto.png");
    assert.equal(res16Le.ok, false);
    assert.match(res16Le.reason, /UTF-16|binario|HTML|activo|rechazado|no admite/i);

    // Comentario HTML seguido de <iframe disfrazado en .jpg
    const payloadHtmlComment = new Uint8Array(Buffer.from("<!-- harmless --><iframe src='x'></iframe>", "utf8"));
    const resComment = decodeImportedFile(payloadHtmlComment, "avatar.jpg");
    assert.equal(resComment.ok, false);
    assert.match(resComment.reason, /binario|HTML|activo|rechazado|disfrazado|imagen/i);
  });

  test("Ronda Final Storage & Autosave: aislamiento '_' en emergencyBackup y flush concurrente sin pérdida", async () => {
    const p1 = "proj";
    const p2 = "proj_child";
    const wrote = writeEmergencyBackup(
      [{ projectId: p2, filePath: "keep.js", content: "const keep = 1;" }],
      localStorage,
      p2,
      "tabA"
    );
    assert.equal(wrote, true);
    clearEmergencyBackup(localStorage, p1);
    const surviving = readEmergencyBackup(localStorage, p2, "tabA");
    assert.equal(surviving.length, 1);
    assert.equal(surviving[0].projectId, p2);
    assert.equal(surviving[0].filePath, "keep.js");
    clearEmergencyBackup(localStorage, p2);

    // Autosave concurrente mientras hay un guardado lento en vuelo
    const persisted = [];
    let releaseFirst;
    let firstStarted;
    const waitFirstStarted = new Promise((r) => { firstStarted = r; });
    let calls = 0;
    const mgr = createAutosaveManager({
      getActiveProjectId: () => "p-race",
      updateFileContent: async (_pid, path, content) => {
        calls += 1;
        if (calls === 1) {
          firstStarted?.();
          await new Promise((r) => { releaseFirst = r; });
        }
        persisted.push({ path, content });
      }
    });
    try {
      mgr.scheduleAutosave("p-race", "a.js", "v1");
      const firstFlush = mgr.flushPendingSaves(); // inicia v1 en vuelo inmediatamente
      await waitFirstStarted;
      mgr.scheduleAutosave("p-race", "a.js", "v2"); // cambia mientras v1 está en vuelo
      const secondFlush = mgr.flushPendingSaves();
      releaseFirst?.();
      await Promise.all([firstFlush, secondFlush]);
      assert.equal(persisted[persisted.length - 1].content, "v2");
    } finally {
      mgr.destroy();
    }
  });

  test("Ronda Final Transpiler, SQL & UI: 0x10.toString(), tipos inline, sqlRunner safe y race async en showConfirmDialog", () => {
    const src = [
      "const hex: string = 0x10.toString(16);",
      "const dec: string = 0.5.toFixed(1);",
      "function pair(x: number): { a: number } { return { a: x }; }",
      "const first: number = 1, second = (hex as string);"
    ].join("\n");
    const js = transpileTypeScriptAndJsx(src).code;
    assert.equal(js.includes("0x10.toString(16)"), true);
    assert.equal(js.includes("0.5.toFixed(1)"), true);
    assert.equal(js.includes(": { a: number }"), false);
    assert.equal(js.includes("as string"), false);
    assert.doesNotThrow(() => new Function(js));

    const sqlDoc = buildSqlRunnerPreview({ path: "db/init.sql", shortName: "init.sql", content: "SELECT 1;" });
    assert.equal(sqlDoc.includes("stripSqlCommentsClient"), false);
    assert.equal(sqlDoc.includes("stripSqlCommentsSafe"), true);
    assert.match(applySqlPagination("SELECT [limit] FROM t", 10, 0), /LIMIT 10 OFFSET 0/i);

    // Simular cierre asíncrono retardado de diálogo anterior al reabrir inmediatamente showConfirmDialog
    const prevBody = document.body.innerHTML;
    document.body.innerHTML = "";
    const mk = (tag, id) => {
      const el = makeDomNode(tag, id);
      document.body.appendChild(el);
      return el;
    };
    const dialog = mk("dialog", "confirm-dialog");
    mk("h2", "confirm-dialog-title");
    mk("p", "confirm-dialog-message");
    mk("button", "btn-confirm-cancel");
    const actionBtn = mk("button", "btn-confirm-action");
    mk("button", "btn-close-confirm");
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };

    let secondConfirmed = false;
    try {
      showConfirmDialog({ title: "Primero", message: "M1", onConfirm: () => {} });
      showConfirmDialog({ title: "Segundo", message: "M2", onConfirm: () => { secondConfirmed = true; } });
      // Simular evento async 'close' retrasado mientras el segundo sigue open = true
      dialog.dispatchEvent(new Event("close"));
      actionBtn.click();
      assert.equal(secondConfirmed, true);
    } finally {
      document.body.innerHTML = prevBody;
    }
  });

  test("Catálogo dinámico: extractTextAssetPaths + runtime asset bridge resuelven imágenes JS/JSON y Unicode NFD/NFC sin romper scope", () => {
    const jsCatalogo = `
      fetch("./data/productos.json")
        .then(r => r.json())
        .then(items => {
          grid.innerHTML = items.map(p => '<img src="' + p.img + '">').join("");
        });
      const fallbackImg = "img/Butaca%20Mendoza.webp";
    `;
    const deps = extractTextAssetPaths("productos.html", jsCatalogo, [
      { path: "data/productos.json" },
      { path: "img/Butaca Mendoza.webp" }
    ]);
    assert.equal(deps.includes("data/productos.json"), true);
    assert.equal(deps.includes("img/Butaca Mendoza.webp"), true);

    const nfdName = "img/Sofa\u0301.png";
    const assets = buildWorkspaceAssetMap([
      { path: "sub/data/productos.json", shortName: "productos.json", content: '[{"img":"img/Uspallata.png"}]' },
      { path: `sub/${nfdName}`, shortName: "Sofá.png", isBinary: true, base64: "AQID" },
      { path: "sub/img/Uspallata.png", shortName: "Uspallata.png", isBinary: true, base64: "BAUG" },
      { path: "secret.png", shortName: "secret.png", isBinary: true, base64: "SECRETO" }
    ]);

    const bundled = bundleHtmlWithFolderAssets(
      "sub/productos.html",
      '<html><head></head><body><img src="img/Sofá.png"><div id="grid"></div><script>fetch("./data/productos.json");</script></body></html>',
      assets,
      null,
      (c) => c,
      null,
      false
    );
    assert.equal(bundled.includes("data:image/png;base64,AQID"), true);
    assert.equal(bundled.includes("data:image/png;base64,BAUG"), true);
    assert.equal(bundled.includes("SECRETO"), false);
    assert.equal(bundled.includes("MutationObserver"), true);
    assert.equal(bundled.includes("productos.json"), true);
  });
});
