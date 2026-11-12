import "./setup.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import * as acorn from "acorn";
import { fileURLToPath } from "node:url";

import { KeyboardRouter } from "../js/ui/keyboardRouter.js";
import { initLayoutController } from "../js/ui/layout.js";
import { createMinimapController } from "../js/editor/minimap.js";
import { formatInlineMarkdown } from "../js/ai/chatController.js";
import { formatMdInline } from "../js/preview/markdownPreview.js";
import { buildZipArchive } from "../js/storage/zipExporter.js";
import { bundleHtmlWithFolderAssets } from "../js/preview/htmlBundler.js";
import { inspectModuleUsage, buildVirtualModuleBundle } from "../js/preview/moduleBundler.js";
import { transpileTypeScriptAndJsx } from "../js/preview/tsTranspiler.js";
import {
  isSelectQuery,
  convertResultsToCsv,
  convertResultsToJson
} from "../js/preview/sqlRunner.js";
import { encryptKeysPayload, decryptKeysPayload } from "../js/security/keyVaultCrypto.js";
import { computeTokenFingerprint, redactSensitiveTokens } from "../js/security/credentialGuard.js";
import {
  setKeyStorageMode,
  getKeyStorageMode,
  streamAiCompletion,
  setAiThinkingSpeed,
  getThinkingBudget
} from "../js/ai/providers.js";
import {
  hydrateLazyGithubProject,
  cacheSingleGithubFileContent,
  deleteProjectEntry,
  updateFileContent,
  getProjectEntries,
  markProjectSynced,
  getProject
} from "../js/storage/workspaceDb.js";
import { writeEmergencyBackup, readEmergencyBackup } from "../js/storage/emergencyBackup.js";
import { compileAndRunWandbox } from "../js/preview/cRunner.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeMockNode(tag = "div", id = "") {
  const el = document.createElement(tag);
  if (id) el.id = id;
  el.inert = false;
  return el;
}

describe("Regresiones de Auditoría Integral", () => {
  describe("1. UI, Accesibilidad, Atajos, Layout y HiDPI", () => {
    test("KeyboardRouter conserva onEnter cuando observeDialogs envuelve dialog.showModal", () => {
      const router = new KeyboardRouter();
      const dialog = makeMockNode("dialog", "confirm-regression");
      dialog.open = false;
      dialog.showModal = function () {
        this.open = true;
      };
      dialog.close = function () {
        this.open = false;
      };

      const originalQuerySelectorAll = document.querySelectorAll;
      document.querySelectorAll = (sel) => (sel === "dialog" ? [dialog] : []);
      try {
        router.observeDialogs();
        let entered = false;
        router.pushModal({
          id: "confirm-regression",
          dialog,
          blockGlobalShortcuts: true,
          onEnter: () => {
            entered = true;
          }
        });
        dialog.showModal();

        const active = router.getActiveModal();
        assert.ok(active);
        assert.equal(active.blockGlobalShortcuts, true);
        active.onEnter?.();
        assert.equal(entered, true);
      } finally {
        document.querySelectorAll = originalQuerySelectorAll;
      }
    });

    test("initLayoutController expone API de paneles y gestiona inert en modo compacto", () => {
      const ids = {
        "btn-toggle-left": makeMockNode("button", "btn-toggle-left"),
        "btn-toggle-right": makeMockNode("button", "btn-toggle-right"),
        "btn-close-left": makeMockNode("button", "btn-close-left"),
        "btn-close-right": makeMockNode("button", "btn-close-right"),
        "btn-toggle-zen": makeMockNode("button", "btn-toggle-zen"),
        "btn-exit-zen": makeMockNode("button", "btn-exit-zen"),
        "drawer-backdrop": makeMockNode("div", "drawer-backdrop"),
        "panel-explorer": makeMockNode("aside", "panel-explorer"),
        "panel-assistant": makeMockNode("aside", "panel-assistant"),
        "resizer-left": makeMockNode("div", "resizer-left"),
        "resizer-right": makeMockNode("div", "resizer-right")
      };
      const origGetById = document.getElementById;
      const origMatchMedia = window.matchMedia;
      localStorage.clear();
      document.getElementById = (id) => ids[id] || null;
      window.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });

      try {
        const ctrl = initLayoutController();
        assert.equal(typeof ctrl.isLeftPanelOpen, "function");
        assert.equal(typeof ctrl.isRightPanelOpen, "function");
        assert.equal(typeof ctrl.toggleLeftPanel, "function");
        assert.equal(typeof ctrl.toggleRightPanel, "function");
        assert.equal(typeof ctrl.isZenMode, "function");
        assert.equal(typeof ctrl.toggleZenMode, "function");

        // En compacto ambos paneles inician cerrados
        assert.equal(ctrl.isRightPanelOpen(), false);
        assert.equal(ids["panel-assistant"].inert, true);

        ctrl.toggleRightPanel();
        assert.equal(ctrl.isRightPanelOpen(), true);
        assert.equal(ids["panel-assistant"].inert, false);

        ctrl.toggleRightPanel();
        assert.equal(ctrl.isRightPanelOpen(), false);
        assert.equal(ids["panel-assistant"].inert, true);

        // Modo Zen (Enfoque Total)
        assert.equal(ctrl.isZenMode(), false);
        assert.equal(document.body.dataset.zenMode, "false");
        assert.equal(ids["btn-toggle-zen"].getAttribute("aria-pressed"), "false");

        ctrl.toggleZenMode(true);
        assert.equal(ctrl.isZenMode(), true);
        assert.equal(document.body.dataset.zenMode, "true");
        assert.equal(ids["btn-toggle-zen"].getAttribute("aria-pressed"), "true");
        assert.equal(ids["btn-exit-zen"].hidden, false);

        ctrl.toggleZenMode(false);
        assert.equal(ctrl.isZenMode(), false);
        assert.equal(document.body.dataset.zenMode, "false");
        assert.equal(ids["btn-toggle-zen"].getAttribute("aria-pressed"), "false");
        assert.equal(ids["btn-exit-zen"].hidden, true);
      } finally {
        document.getElementById = origGetById;
        window.matchMedia = origMatchMedia;
      }
    });

    test("minimap escala canvas por devicePixelRatio y limpia pointercancel", async () => {
      const mount = makeMockNode("div", "minimap-host");
      mount.clientWidth = 60;
      mount.clientHeight = 200;
      let transformArgs = null;
      let capturedId = null;
      let releasedId = null;

      const origDpr = window.devicePixelRatio;
      const origCreateElement = document.createElement.bind(document);
      window.devicePixelRatio = 2;

      let createdCanvas = null;
      document.createElement = (tag) => {
        const el = origCreateElement(tag);
        if (tag === "canvas") {
          createdCanvas = el;
          el.getContext = () => ({
            clearRect: () => {},
            fillRect: () => {},
            setTransform: (...args) => {
              transformArgs = args;
            }
          });
        } else if (tag === "div" && !el.setPointerCapture) {
          el.clientWidth = 60;
          el.clientHeight = 200;
          el.setPointerCapture = (id) => {
            capturedId = id;
          };
          el.releasePointerCapture = (id) => {
            releasedId = id;
          };
          el.getBoundingClientRect = () => ({ top: 0, height: 200 });
        }
        return el;
      };

      const windowListeners = new Map();
      const origAddWin = window.addEventListener;
      const origRemWin = window.removeEventListener;
      window.addEventListener = (type, fn) => {
        windowListeners.set(type, fn);
      };
      window.removeEventListener = (type, fn) => {
        if (windowListeners.get(type) === fn) windowListeners.delete(type);
      };

      try {
        const minimap = createMinimapController({
          mountEl: mount,
          getDocLines: () => ["const a = 1;", "const b = 2;"],
          getViewport: () => ({ top: 0, height: 100, totalHeight: 400 }),
          onScrollToRatio: () => {}
        });
        minimap.toggle(true);
        await new Promise((resolve) => setTimeout(resolve, 40));

        assert.equal(createdCanvas.width, 120);
        assert.equal(createdCanvas.height, 400);
        assert.deepEqual(transformArgs, [2, 0, 0, 2, 0, 0]);

        const container = mount.children[0];
        container.dispatchEvent({ type: "pointerdown", pointerId: 7, clientY: 50, preventDefault: () => {} });
        assert.equal(capturedId, 7);
        assert.equal(typeof windowListeners.get("pointercancel"), "function");
        windowListeners.get("pointercancel")();
        assert.equal(releasedId, 7);
        assert.equal(windowListeners.has("pointercancel"), false);
        minimap.destroy();
      } finally {
        window.devicePixelRatio = origDpr;
        document.createElement = origCreateElement;
        window.addEventListener = origAddWin;
        window.removeEventListener = origRemWin;
      }
    });

    test("index.html, manifest.json y CSS cumplen CSP, aria-modal, contraste Dracula y reglas táctiles", async () => {
      const [html, manifestRaw, tokensCss, layoutCss, workspaceCss] = await Promise.all([
        fs.readFile(path.join(ROOT_DIR, "index.html"), "utf-8"),
        fs.readFile(path.join(ROOT_DIR, "manifest.json"), "utf-8"),
        fs.readFile(path.join(ROOT_DIR, "css", "tokens.css"), "utf-8"),
        fs.readFile(path.join(ROOT_DIR, "css", "layout.css"), "utf-8"),
        fs.readFile(path.join(ROOT_DIR, "css", "workspace.css"), "utf-8")
      ]);

      assert.match(html, /worker-src 'self' blob:/);
      assert.match(html, /form-action 'self'/);
      assert.match(html, /id="preview-iframe"[^>]*sandbox="allow-scripts allow-modals allow-downloads allow-popups"/);
      assert.equal(html.includes('inputmode="none"'), false);

      const dialogMatches = html.match(/<dialog\b[^>]*>/g) || [];
      assert.equal(dialogMatches.length, 7);
      for (const tag of dialogMatches) {
        assert.match(tag, /aria-modal="true"/, `Diálogo sin aria-modal="true": ${tag}`);
      }

      const manifest = JSON.parse(manifestRaw);
      for (const icon of manifest.icons || []) {
        assert.notEqual(icon.purpose, "any maskable");
      }

      assert.match(tokensCss, /\[data-theme="dracula"\][\s\S]*--color-accent-ink:\s*oklch\(15%/);
      assert.match(layoutCss, /pointer-events:\s*none;/);
      assert.equal(layoutCss.includes('body[data-left-open="false"] .panel-title,'), false);
      assert.match(workspaceCss, /@media \(pointer: coarse\)[\s\S]*\.c-terminal-input/);
    });
  });

  describe("2. Markdown, ZIP, HTML/SVG y ModuleBundler", () => {
    test("formatInlineMarkdown y formatMdInline preservan asteriscos en URLs y code dentro de links", () => {
      const md = "Ver [docs de *glob* con `code`](https://example.com/a*b/c*d) y *italica*.";
      const chatHtml = formatInlineMarkdown(md);
      const previewHtml = formatMdInline(md);

      for (const html of [chatHtml, previewHtml]) {
        assert.ok(html.includes('href="https://example.com/a*b/c*d"'));
        assert.ok(html.includes("<em>glob</em>"));
        assert.ok(html.includes(">code</code>"));
        assert.ok(html.includes("<em>italica</em>"));
      }
    });

    test("buildZipArchive normaliza prefijos seguros y rechaza traversal ../", () => {
      const zip = buildZipArchive([
        { path: "./src/./index.js", content: "console.log(1);" },
        { path: "assets\\note.txt", content: "ok" }
      ]);
      const text = new TextDecoder().decode(zip);
      assert.ok(text.includes("src/index.js"));
      assert.ok(text.includes("assets/note.txt"));

      assert.throws(() => buildZipArchive([{ path: "../escape.txt", content: "bad" }]), /traversal/i);
      assert.throws(() => buildZipArchive([{ path: "a/../../secret.txt", content: "bad2" }]), /traversal/i);
    });

    test("bundleHtmlWithFolderAssets bloquea ./../ sin permiso, escapa comilla simple SVG y transpila inline text/tsx", () => {
      const fileMap = new Map([
        ["secret.css", { path: "secret.css", content: "body { color: red; }" }],
        ["sub/style.css", { path: "sub/style.css", content: '@import "./../secret.css"; body { margin: 0; }' }],
        ["sub/icon.svg", { path: "sub/icon.svg", content: "<svg data-msg='hola'></svg>" }],
        ["sub/helper.tsx", { path: "sub/helper.tsx", content: "export const Box = (n: number) => <span data-n={n}/>;" }]
      ]);

      const html = [
        '<link rel="stylesheet" href="./../secret.css">',
        '<link rel="stylesheet" href="style.css">',
        '<img src="icon.svg">',
        '<script type="text/tsx">import { Box } from "./helper"; const el = <Box/>;</script>'
      ].join("\n");

      const bundled = bundleHtmlWithFolderAssets("sub/index.html", html, fileMap);

      assert.equal(bundled.includes("color: red"), false);
      assert.ok(bundled.includes("margin: 0"));
      assert.ok(bundled.includes("%27"));
      assert.ok(bundled.includes('__studioJsx("span"'));
      assert.ok(bundled.includes("__studioJsx(Box"));
    });

    test("inspectModuleUsage y buildVirtualModuleBundle no marcan arrow concisa async como TLA ni elevan import() dinámico CDN", () => {
      const arrowUsage = inspectModuleUsage("export const getData = async (u) => await fetch(u);");
      assert.equal(arrowUsage.hasTopLevelAwait, false);

      const exactMap = new Map([
        [
          "main.js",
          {
            path: "main.js",
            content: [
              'import { x } from "https://cdn.example/static.js";',
              'const loadDyn = async () => await import("https://cdn.example/dynamic.js");',
              "export { x, loadDyn };"
            ].join("\n")
          }
        ]
      ]);
      const bundle = buildVirtualModuleBundle({
        entryPath: "main.js",
        entryCode: exactMap.get("main.js").content,
        exactMap
      });
      assert.equal(bundle.isAsync, false);
      assert.deepEqual(bundle.externalSpecifiers, ["https://cdn.example/static.js"]);
    });
  });

  describe("3. TypeScript Transpiler (8 Edge Cases)", () => {
    test("soporta comparaciones encadenadas, enums complejos, métodos de objeto, import type con alias, ASI ! y &&/?? objeto", () => {
      const samples = [
        {
          in: "const cmp = a < b && c > (1); const fn = <T,>(x: T): T => x;",
          check: (out) => {
            assert.ok(out.includes("a < b && c > (1)"));
            assert.ok(out.includes("(x) => x"));
          }
        },
        {
          in: "enum Estado { Idle = 1, /* a, b */ Busy = helper(1, 2), Done }",
          check: (out) => {
            assert.ok(out.includes("Idle: 1"));
            assert.ok(out.includes("Busy: helper(1, 2)"));
            assert.ok(out.includes("Done: 2"));
          }
        },
        {
          in: "const api = { greet(name: string): string { return name; }, cb: (x: number): number => x * 2, [dynKey]: 1 };",
          check: (out) => {
            assert.ok(out.includes("greet(name) { return name; }"));
            assert.ok(out.includes("cb: (x) => x * 2"));
            assert.ok(out.includes("[dynKey]: 1"));
          }
        },
        {
          in: 'import { type Foo as Bar, type as Kind, baz } from "./mod";',
          check: (out) => {
            assert.equal(out.includes("Foo"), false);
            assert.equal(out.includes("Bar"), false);
            assert.ok(out.includes("type as Kind"));
            assert.ok(out.includes("baz"));
          }
        },
        {
          in: "const a = obj.as; const b = obj?.satisfies; const c = val as number;",
          check: (out) => {
            assert.ok(out.includes("obj.as"));
            assert.ok(out.includes("obj?.satisfies"));
            assert.equal(out.includes("as number"), false);
          }
        },
        {
          in: "const x = foo\n!bar;\nconst y = ptr!;",
          check: (out) => {
            assert.ok(out.includes("foo\n!bar;"));
            assert.ok(out.includes("const y = ptr;"));
          }
        },
        {
          in: "for (const item: string of items) { log(item); }",
          check: (out) => {
            assert.ok(out.includes("for (const item of items)"));
          }
        },
        {
          in: "const o = flag && { k: 1 }; const p = val ?? { m: 2 };",
          check: (out) => {
            assert.ok(out.includes("flag && { k: 1 }"));
            assert.ok(out.includes("val ?? { m: 2 }"));
          }
        }
      ];

      for (const sample of samples) {
        const res = transpileTypeScriptAndJsx(sample.in, { jsx: false, fileName: "edge.ts" });
        sample.check(res.code);
        acorn.parse(res.code, { ecmaVersion: "latest", sourceType: "module" });
      }
    });
  });

  describe("4. SQL Runner, Crypto Vault, Redacción e IA Providers", () => {
    test("sqlRunner distingue comentarios dentro de strings, multi-sentencias, CSV fórmula-safe y __proto__", () => {
      assert.equal(isSelectQuery("SELECT '-- ; DROP TABLE' AS msg"), true);
      assert.equal(isSelectQuery("SELECT 1; DROP TABLE users;"), false);

      const csv = convertResultsToCsv([
        {
          columns: ["formula", "neg", "cmd"],
          values: [["=SUM(A1)", -42.5, "+cmd"]]
        }
      ]);
      assert.ok(csv.includes("'=SUM(A1)"));
      assert.ok(csv.includes(",-42.5,"));
      assert.ok(csv.includes("'+cmd"));

      const protoBefore = {}.polluted;
      const json = convertResultsToJson([
        {
          columns: ["__proto__", "name"],
          values: [[{ polluted: true }, "ok"]]
        }
      ]);
      assert.equal({}.polluted, protoBefore);
      assert.equal(Object.keys(json[0]).includes("__proto__"), true);
      assert.equal(json[0].name, "ok");
    });

    test("keyVaultCrypto detecta manipulación en AAD/kdf/cipher y mantiene compatibilidad con v1 legacy sin AAD", async () => {
      const payload = JSON.stringify({ gemini: "AIzaSyExampleKeyValue123456" });
      const encrypted = await encryptKeysPayload(payload, "clave-segura-123");
      const parsed = JSON.parse(encrypted);
      assert.equal(parsed.aad, "metadata-v1");

      const ok = await decryptKeysPayload(encrypted, "clave-segura-123");
      assert.equal(ok, payload);

      await assert.rejects(
        decryptKeysPayload(JSON.stringify({ ...parsed, kdf: "PBKDF2-SHA1" }), "clave-segura-123")
      );
      await assert.rejects(
        decryptKeysPayload(JSON.stringify({ ...parsed, cipher: "AES-CBC" }), "clave-segura-123")
      );
      await assert.rejects(
        decryptKeysPayload(JSON.stringify({ ...parsed, aad: "tampered" }), "clave-segura-123")
      );

      // Legacy v1 sin campo aad (AES-GCM cifrado sin additionalData)
      const legacySalt = new Uint8Array(16).fill(3);
      const legacyIv = new Uint8Array(12).fill(5);
      const keyMat = await globalThis.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("clave-legacy-99"),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
      );
      const aesKey = await globalThis.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: legacySalt, iterations: 100000, hash: "SHA-256" },
        keyMat,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
      );
      const ct = await globalThis.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: legacyIv },
        aesKey,
        new TextEncoder().encode(payload)
      );
      const b64 = (bytes) => Buffer.from(bytes).toString("base64");
      const legacyVault = JSON.stringify({
        format: "studio-ide-key-vault",
        version: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 100000,
        cipher: "AES-GCM-256",
        salt: b64(legacySalt),
        iv: b64(legacyIv),
        ciphertext: b64(new Uint8Array(ct))
      });
      const legacyDecrypted = await decryptKeysPayload(legacyVault, "clave-legacy-99");
      assert.equal(legacyDecrypted, payload);
    });

    test("credentialGuard produce fingerprints de longitud fija y redacta cabeceras/claves", () => {
      const fp1 = computeTokenFingerprint("short");
      const fp2 = computeTokenFingerprint("a-very-long-credential-string-0123456789abcdef");
      assert.match(fp1, /^fp_[0-9a-f]{24}$/);
      assert.equal(fp1.length, fp2.length);

      const scrubbed = redactSensitiveTokens(
        "Authorization: token ghp_secretToken12345678 x-goog-api-key: AIzaMySecretKey999999 sk-proj-abcdEFGH1234567890"
      );
      assert.equal(scrubbed.includes("ghp_secretToken"), false);
      assert.equal(scrubbed.includes("AIzaMySecretKey"), false);
      assert.equal(scrubbed.includes("sk-proj-abcd"), false);
    });

    test("providers.js migra ide.github.userLogin, envía thinkingConfig correcto y libera lock SSE ante errores", async () => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("ide.github.userLogin", "octocat");
      setKeyStorageMode("session");
      assert.equal(getKeyStorageMode(), "session");
      assert.equal(localStorage.getItem("ide.github.userLogin"), null);
      assert.equal(sessionStorage.getItem("ide.github.userLogin"), "octocat");

      setKeyStorageMode("local");
      setAiThinkingSpeed("baja");

      const calls = [];
      let lockReleased = false;
      let streamCancelled = false;
      const origFetch = globalThis.fetch;

      try {
        // 1. Gemini 2.5 Flash debe enviar thinkingConfig; Gemma no debe enviar thinkingConfig ni systemInstruction
        globalThis.fetch = async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(init.body) });
          const encoder = new TextEncoder();
          const body = {
            getReader() {
              let sent = false;
              return {
                async read() {
                  if (!sent) {
                    sent = true;
                    return {
                      done: false,
                      value: encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"Hola"}]}}]}\n\n')
                    };
                  }
                  return { done: true, value: undefined };
                },
                releaseLock() {}
              };
            }
          };
          return { ok: true, status: 200, body };
        };

        const chunks = [];
        await streamAiCompletion({
          providerId: "gemini",
          model: "gemini-2.5-flash",
          apiKey: "AIzaSyFakeValidFormatKey1234567890abcd",
          systemPrompt: "Sys",
          history: [{ role: "user", content: "Hi" }],
          onChunk: (c) => chunks.push(c)
        });
        assert.deepEqual(chunks, ["Hola"]);
        const geminiCall = calls.find((c) => c.url.includes("gemini-2.5-flash"));
        assert.equal(geminiCall.body.generationConfig.thinkingConfig.thinkingBudget, getThinkingBudget("baja"));
        assert.ok(geminiCall.body.systemInstruction);

        await streamAiCompletion({
          providerId: "gemini",
          model: "gemma-3-27b-it",
          apiKey: "AIzaSyFakeValidFormatKey1234567890abcd",
          systemPrompt: "Sys",
          history: [{ role: "user", content: "Hi" }],
          onChunk: () => {}
        });
        const gemmaCall = calls.find((c) => c.url.includes("gemma-3-27b-it"));
        assert.equal(gemmaCall.body.generationConfig.thinkingConfig, undefined);
        assert.equal(gemmaCall.body.systemInstruction, undefined);

        // 2. Error durante lectura de SSE debe cancelar y liberar reader lock
        globalThis.fetch = async () => ({
          ok: true,
          status: 200,
          body: {
            getReader() {
              return {
                async read() {
                  throw new Error("stream broken");
                },
                async cancel() {
                  streamCancelled = true;
                },
                releaseLock() {
                  lockReleased = true;
                }
              };
            }
          }
        });

        await assert.rejects(
          streamAiCompletion({
            providerId: "gemini",
            model: "gemini-2.5-flash",
            apiKey: "AIzaSyFakeValidFormatKey1234567890abcd",
            systemPrompt: "Sys",
            history: [{ role: "user", content: "Hi" }],
            onChunk: () => {}
          }),
          /stream broken/
        );
        assert.equal(streamCancelled, true);
        assert.equal(lockReleased, true);

        // 3. AbortController abortado justo en backoff 503/429 (waitAbortable sin bloqueo)
        const ac = new AbortController();
        globalThis.fetch = async () => {
          ac.abort(new DOMException("cancelado", "AbortError"));
          return {
            ok: false,
            status: 429,
            json: async () => ({ error: { message: "resource_exhausted" } })
          };
        };
        const t0 = Date.now();
        await assert.rejects(
          streamAiCompletion({
            providerId: "gemini",
            model: "gemini-2.5-flash",
            apiKey: "AIzaSyFakeValidFormatKey1234567890abcd",
            systemPrompt: "Sys",
            history: [{ role: "user", content: "Hi" }],
            signal: ac.signal,
            onChunk: () => {}
          }),
          (err) => err?.name === "AbortError"
        );
        assert.ok(Date.now() - t0 < 500);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("compileAndRunWandbox aborta limpiamente al vencer el timeout", async () => {
      const slowFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });

      await assert.rejects(
        compileAndRunWandbox({ compiler: "gcc-head", code: "int main(){return 0;}" }, slowFetch, 25),
        /Tiempo de espera agotado/i
      );
    });
  });

  describe("5. Storage, Emergency Backup y Service Worker v30", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    test("workspaceDb evita resucitar borrados en cacheSingleGithubFileContent/updateFileContent y marca commitSha atómico", async () => {
      const repoName = `reg-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      const project = await hydrateLazyGithubProject({
        owner: "org",
        repo: repoName,
        branch: "main",
        commitSha: "sha-0",
        entries: [
          { path: "a.js", blobSha: "b1" },
          { path: "b.js", blobSha: "b2" }
        ]
      });

      await deleteProjectEntry(project.id, "a.js", false);
      const resCacheDeleted = await cacheSingleGithubFileContent(project.id, "a.js", "revived", "b1");
      assert.equal(resCacheDeleted.deleted, true);

      const resUpdateDeleted = await updateFileContent(project.id, "a.js", "revived-2");
      assert.equal(resUpdateDeleted.deleted, true);

      const resCacheLive = await cacheSingleGithubFileContent(project.id, "b.js", "const ok = 1;", "b2");
      assert.equal(resCacheLive.deleted, false);
      assert.equal(resCacheLive.contentLoaded, true);

      const activeEntries = await getProjectEntries(project.id);
      assert.deepEqual(
        activeEntries.map((e) => e.path),
        ["b.js"]
      );

      await markProjectSynced(project.id, "sha-1");
      const refreshedProject = await getProject(project.id);
      assert.equal(refreshedProject.github.commitSha, "sha-1");
    });

    test("readEmergencyBackup desduplica por timestamp más reciente entre pestañas", () => {
      const futureTs = Date.now() + 60_000;
      localStorage.setItem(
        "studio_ide_emergency_backup_p1_tabA",
        JSON.stringify({
          savedAt: 1000,
          projectId: "p1",
          instanceId: "tabA",
          items: [{ projectId: "p1", filePath: "app.js", content: "viejo" }]
        })
      );
      writeEmergencyBackup([
        { projectId: "p1", filePath: "app.js", content: "intermedio" }
      ]);
      localStorage.setItem(
        "studio_ide_emergency_backup_p1_tabB",
        JSON.stringify({
          savedAt: futureTs,
          projectId: "p1",
          instanceId: "tabB",
          items: [{ projectId: "p1", filePath: "app.js", content: "nuevo" }]
        })
      );

      const merged = readEmergencyBackup();
      const appEntry = merged.find((item) => item.projectId === "p1" && item.filePath === "app.js");
      assert.equal(appEntry.content, "nuevo");
    });

    test("sw.js exige core shell en install y responde HTTP 503 o fallback offline sin lanzar Error crudo", async () => {
      const swCode = await fs.readFile(path.join(ROOT_DIR, "sw.js"), "utf-8");
      const listeners = new Map();
      const cacheStores = new Map();
      const getCache = (name) => {
        if (!cacheStores.has(name)) {
          const entries = new Map();
          cacheStores.set(name, {
            async match(req) {
              const key = typeof req === "string" ? req : req.url;
              return entries.get(key) || entries.get(key.replace("https://ide.local/", "./"));
            },
            async put(req, res) {
              const key = typeof req === "string" ? req : req.url;
              entries.set(key, res);
            }
          });
        }
        return cacheStores.get(name);
      };

      let shouldFailCoreInstall = false;
      const ctx = {
        URL,
        Set,
        Promise,
        Map,
        Error,
        setTimeout,
        console: { warn: () => {} },
        Request: class MockRequest {
          constructor(url, init = {}) {
            this.url = url;
            Object.assign(this, init);
          }
        },
        Response: class MockResponse {
          constructor(body, init = {}) {
            this.body = body;
            this.status = init.status ?? 200;
            this.statusText = init.statusText ?? "OK";
            this.ok = this.status >= 200 && this.status < 300;
            this.headers = init.headers || {};
          }
          clone() {
            return this;
          }
          async text() {
            return String(this.body || "");
          }
        },
        caches: {
          async open(name) {
            return getCache(name);
          },
          async keys() {
            return Array.from(cacheStores.keys());
          },
          async delete(name) {
            return cacheStores.delete(name);
          }
        },
        fetch: async (req) => {
          const url = typeof req === "string" ? req : req.url;
          if (shouldFailCoreInstall && url === "./js/app.js") {
            return { ok: false, status: 500 };
          }
          if (url === "./index.html" || url === "./") {
            return new ctx.Response("<html>shell</html>", { status: 200 });
          }
          throw new Error("offline");
        },
        self: {
          location: { origin: "https://ide.local" },
          addEventListener(type, fn) {
            listeners.set(type, fn);
          },
          skipWaiting: async () => {},
          clients: { claim: async () => {} }
        }
      };

      vm.runInNewContext(swCode, ctx);
      const installFn = listeners.get("install");
      const fetchFn = listeners.get("fetch");

      // 1. Fallo en recurso crítico aborta install
      shouldFailCoreInstall = true;
      let installPromise = null;
      installFn({
        waitUntil: (p) => {
          installPromise = p;
        }
      });
      await assert.rejects(installPromise, /crítico/);

      // 2. Fallback navigate offline y 503 offline limpio
      const shellCache = await ctx.caches.open("studio-ide-shell-v30");
      await shellCache.put("./index.html", new ctx.Response("<html>cached</html>", { status: 200 }));

      let navPromise = null;
      fetchFn({
        request: { method: "GET", mode: "navigate", url: "https://ide.local/subpage" },
        respondWith: (p) => {
          navPromise = p;
        }
      });
      const navRes = await navPromise;
      assert.equal(await navRes.text(), "<html>cached</html>");

      let cdnPromise = null;
      fetchFn({
        request: { method: "GET", mode: "cors", url: "https://esm.sh/pkg" },
        respondWith: (p) => {
          cdnPromise = p;
        }
      });
      const cdnRes = await cdnPromise;
      assert.equal(cdnRes.status, 503);

      let assetPromise = null;
      fetchFn({
        request: { method: "GET", mode: "cors", url: "https://ide.local/missing.js" },
        respondWith: (p) => {
          assetPromise = p;
        }
      });
      const assetRes = await assetPromise;
      assert.equal(assetRes.status, 503);
    });
  });
});
