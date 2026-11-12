import "./setup.js";
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import * as acorn from "acorn";

import { hasUnsafeReDoSPattern, searchInFiles } from "../js/search/projectSearch.js";
import {
  verifyGithubToken,
  parseRepoFullName,
  isValidGithubRepoSegment,
  fetchRepoTreeIndex,
  fetchSingleRepoBlob,
  saveProjectToGist
} from "../js/github/githubService.js";
import {
  resetAuthSecurityState,
  sanitizeErrorCause,
  formatSafeErrorMessage,
  isTokenRejectedInSession
} from "../js/security/credentialGuard.js";
import { base64ToBytes, bytesToBase64 } from "../js/utils/encoding.js";
import { decodeImportedFile } from "../js/storage/fileImport.js";
import {
  isEncryptedKeyVault,
  decryptKeysPayload,
  MAX_VAULT_JSON_BYTES
} from "../js/security/keyVaultCrypto.js";
import {
  buildZipBlob,
  buildZipArchive,
  getDosDateTime,
  downloadZip
} from "../js/storage/zipExporter.js";
import {
  bundleHtmlWithFolderAssets,
  buildConsoleBridgeScript
} from "../js/preview/htmlBundler.js";
import {
  isBlockedPreviewUrlScheme,
  normalizePreviewUrlRef
} from "../js/preview/previewUtils.js";
import {
  detectFilePathFromCodeSegment,
  initChatController
} from "../js/ai/chatController.js";
import {
  buildWandboxPayload,
  injectInteractiveInputGuard
} from "../js/preview/cRunner.js";
import {
  saveApiKey,
  getApiKey,
  importKeysBundle,
  isAbortError,
  streamAiCompletion,
  saveProviderId,
  setKeyStorageMode
} from "../js/ai/providers.js";
import { sanitizeSvgMarkup, createBinaryPreview } from "../js/ui/binaryPreview.js";
import { icon } from "../js/ui/icons.js";
import { initLivePreviewModal } from "../js/ui/livePreviewModal.js";
import {
  ensureInitialWorkspace,
  deleteProject,
  hydrateGithubProject,
  upsertEntry,
  getAllRawProjectEntries,
  renameProjectEntry,
  countPendingGithubChanges,
  getPendingGithubChanges,
  applyRemotePullPlan
} from "../js/storage/workspaceDb.js";
import { classifyRemotePullChanges, buildRemotePullPlan } from "../js/github/githubMerge.js";
import { transpileTypeScriptAndJsx } from "../js/preview/tsTranspiler.js";
import { instrumentLoops } from "../js/preview/loopGuard.js";
import {
  buildExactModuleMap,
  buildVirtualModuleBundle,
  formatVirtualModuleExecution
} from "../js/preview/moduleBundler.js";
import { computeSmartReplacement } from "../js/editor/smartReplace.js";
import {
  extractDocumentIdentifiers,
  getLanguageCompletions
} from "../js/editor/autocompleteCatalog.js";
import { KeyboardRouter } from "../js/ui/keyboardRouter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const ORIG_FETCH = globalThis.fetch;

function restoreGlobals() {
  globalThis.fetch = ORIG_FETCH;
  localStorage.clear();
  sessionStorage.clear();
  resetAuthSecurityState();
}

function makeTrackedEl(tag, id = "", props = {}) {
  const el = document.createElement(tag);
  if (id) el.id = id;
  for (const [k, v] of Object.entries(props)) {
    el[k] = v;
  }
  return el;
}

describe("Fase 3 QA: AppSec, Integridad, Concurrencia y Estrés", () => {
  beforeEach(() => {
    restoreGlobals();
  });

  afterEach(() => {
    restoreGlobals();
  });

  describe("A. AppSec: projectSearch.js (ReDoS, no-ASCII, pares sustitutos UTF-16)", () => {
    test("detecta variantes ReDoS críticas y permite patrones seguros", () => {
      assert.equal(hasUnsafeReDoSPattern("(a?b|b)+"), true);
      assert.equal(hasUnsafeReDoSPattern("(a|b?a)+"), true);
      assert.equal(hasUnsafeReDoSPattern("(a+)\\1+"), true);
      assert.equal(hasUnsafeReDoSPattern("(foo)\\1*"), true);

      // Cascada >10 opcionales contiguos vs <=10
      const twelveOptionals = "a?".repeat(12);
      const tenOptionals = "a?".repeat(10);
      assert.equal(hasUnsafeReDoSPattern(twelveOptionals), true);
      assert.equal(hasUnsafeReDoSPattern(tenOptionals), false);

      // Muestras no-ASCII: clases negadas o rangos Unicode solapados
      assert.equal(hasUnsafeReDoSPattern("([^\\x00-\\x7f]|α)+"), true);
      assert.equal(hasUnsafeReDoSPattern("([^\\x00-\\x7f]|😀)+"), true);
      assert.equal(hasUnsafeReDoSPattern("([á-ú]|ñ)+"), true);
      assert.equal(hasUnsafeReDoSPattern("(\\W|ñ)+"), true);

      // Patrones seguros no deben dar falsos positivos
      assert.equal(hasUnsafeReDoSPattern("(foo|bar)+"), false);
      assert.equal(hasUnsafeReDoSPattern("^[a-z0-9_]+$"), false);

      // searchInFiles bloquea la ejecución de los patrones ReDoS
      const blocked = searchInFiles(
        [{ path: "test.txt", content: "aaaaaaaaaaaaaaaaaaaaaaaa!" }],
        "(a?b|b)+",
        { isRegex: true }
      );
      assert.equal(blocked.totalMatches, 0);
      assert.match(blocked.error || "", /inseguros/i);
    });

    test("searchInFiles avanza un code point completo sobre pares sustitutos UTF-16 en matches de longitud cero", () => {
      const files = [
        { path: "emoji.txt", content: "😀😀target😀\r\nαβ😀end" }
      ];
      // `z*` produce matches de longitud 0 en cada posición antes de encontrar "target" o cualquier carácter
      // Si avanzara +1 unidad UTF-16 partiría el par sustituto 😀 (\uD83D\uDE00) y el regex podría atascarse o corromper índices.
      const resEmptySafe = searchInFiles(files, "z*", { isRegex: true });
      assert.equal(resEmptySafe.error, null);

      // Match real después de pares sustitutos con `x?`
      const resAfterEmoji = searchInFiles(
        [{ path: "u16.txt", content: "😀😀abc" }],
        "z*abc",
        { isRegex: true }
      );
      assert.equal(resAfterEmoji.error, null);
      assert.equal(resAfterEmoji.totalMatches, 1);
      assert.equal(resAfterEmoji.results[0].matches[0].column, 5);
      assert.equal(resAfterEmoji.results[0].matches[0].matchText, "abc");

      // Verifica que un patrón que solo hace match vacío no produce bucle infinito ni cuelga en surrogates
      const zeroWidth = searchInFiles(
        [{ path: "surr.txt", content: "😀😀😀" }],
        "(?:)",
        { isRegex: true }
      );
      assert.equal(zeroWidth.error, null);
      assert.equal(zeroWidth.totalMatches, 0);
    });
  });

  describe("B. AppSec: githubService.js + credentialGuard.js", () => {
    const VALID_GH_TOKEN = "ghp_Phase3ValidTestToken1234567890ab";

    test("403 de credencial marcada -> verifyGithubToken devuelve invalid y bloquea reintento en sesión", async () => {
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 403 });
      };

      const res1 = await verifyGithubToken(VALID_GH_TOKEN);
      assert.equal(res1.status, "invalid");
      assert.equal(fetchCalls, 1);
      assert.equal(isTokenRejectedInSession("github", VALID_GH_TOKEN), true);

      // Segunda llamada con el mismo token marcado no vuelve a golpear la red
      const res2 = await verifyGithubToken(VALID_GH_TOKEN);
      assert.equal(res2.status, "invalid");
      assert.equal(res2.rejectedInSession, true);
      assert.equal(fetchCalls, 1);
    });

    test("parseRepoFullName y cliente raw bloquean '..', '.' y >2 segmentos en owner/repo/branch", async () => {
      assert.equal(parseRepoFullName("a/b/c"), null);
      assert.equal(parseRepoFullName("../repo"), null);
      assert.equal(parseRepoFullName("./repo"), null);
      assert.equal(parseRepoFullName("owner/.."), null);
      assert.equal(parseRepoFullName("owner/."), null);
      assert.equal(isValidGithubRepoSegment(".."), false);
      assert.equal(isValidGithubRepoSegment("."), false);
      assert.equal(isValidGithubRepoSegment("a/b"), false);
      assert.deepEqual(parseRepoFullName("octocat/hello-world"), { owner: "octocat", repo: "hello-world" });

      let networkHit = 0;
      globalThis.fetch = async () => {
        networkHit += 1;
        return new Response("{}", { status: 200 });
      };

      const badCases = [
        { owner: "..", repo: "ok", branch: "main" },
        { owner: ".", repo: "ok", branch: "main" },
        { owner: "a/b", repo: "ok", branch: "main" },
        { owner: "ok", repo: "..", branch: "main" },
        { owner: "ok", repo: "a/b", branch: "main" },
        { owner: "ok", repo: "ok", branch: "feat/../main" },
        { owner: "ok", repo: "ok", branch: "./main" }
      ];
      for (const params of badCases) {
        await assert.rejects(
          fetchRepoTreeIndex({ token: VALID_GH_TOKEN, ...params }),
          /inválid|no permitido/i
        );
      }
      assert.equal(networkHit, 0, "Las rutas maliciosas deben rechazarse antes de abrir red");
    });

    test("saveProjectToGist usa prototipo nulo (__proto__/constructor seguros) y omite binarios del preview", async () => {
      let sentBody = null;
      globalThis.fetch = async (_url, init) => {
        sentBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: "gist123", html_url: "https://gist.github.com/gist123" }), {
          status: 201
        });
      };

      const res = await saveProjectToGist(VALID_GH_TOKEN, {
        projectName: "demo-sec",
        entries: [
          { path: "__proto__", content: "polluted", isBinary: false },
          { path: "constructor", content: "polluted", isBinary: false },
          { path: "prototype", content: "polluted", isBinary: false },
          { path: "studio_project.json", content: "fake-manifest", isBinary: false },
          { path: "assets/logo.png", content: "", base64: "iVBORw0KGgo=", isBinary: true },
          { path: "src/app.js", content: "export const x = 1;", isBinary: false }
        ]
      });

      assert.equal(res.id, "gist123");
      assert.ok(sentBody && sentBody.files);
      assert.equal(Object.hasOwn(sentBody.files, "__proto__"), false);
      assert.equal(Object.hasOwn(sentBody.files, "constructor"), false);
      assert.equal(Object.hasOwn(sentBody.files, "prototype"), false);
      assert.equal(Object.hasOwn(sentBody.files, "assets__logo.png"), false);
      assert.equal(Object.hasOwn(sentBody.files, "src__app.js"), true);

      const parsedManifest = JSON.parse(sentBody.files["studio_project.json"].content);
      assert.equal(parsedManifest.schema, "studio_ide_gist_backup_v1");
      assert.ok(parsedManifest.entries.some((e) => e.path === "assets/logo.png" && e.isBinary === true));
    });

    test("sanitizeErrorCause y formatSafeErrorMessage ocultan Authorization, cookies y PATs", () => {
      const secretPat = "ghp_SecretPatValue9876543210abcdef";
      const customSecret = "super_secret_token_999";
      const rawErr = new Error(`Falló request con Bearer ${secretPat} y ${customSecret}`);
      rawErr.status = 403;
      rawErr.headers = {
        Authorization: `Bearer ${secretPat}`,
        "X-Api-Key": "AIzaSecretApiKey1234567890",
        "Content-Type": "application/json"
      };
      rawErr.request = {
        url: `https://api.example.com/v1?access_token=${secretPat}`,
        headers: new Headers({
          authorization: `token ${secretPat}`,
          cookie: "session=abc123",
          "x-custom": "ok"
        })
      };
      rawErr.cause = {
        message: `Nested ${secretPat}`,
        headers: { "proxy-authorization": "Basic dXNlcjpwYXNz" }
      };

      const sanitized = sanitizeErrorCause(rawErr, [customSecret]);
      assert.equal(sanitized instanceof Error, true);
      assert.equal(sanitized.message.includes(secretPat), false);
      assert.equal(sanitized.message.includes(customSecret), false);
      assert.equal(Object.hasOwn(sanitized.headers, "Authorization"), false);
      assert.equal(Object.hasOwn(sanitized.headers, "X-Api-Key"), false);
      assert.equal(sanitized.headers["Content-Type"], "application/json");
      assert.equal(Object.hasOwn(sanitized.request.headers, "authorization"), false);
      assert.equal(Object.hasOwn(sanitized.request.headers, "cookie"), false);
      assert.equal(sanitized.request.headers["x-custom"], "ok");
      assert.equal(sanitized.request.url.includes(secretPat), false);
      assert.equal(sanitized.cause.message.includes(secretPat), false);
      assert.equal(Object.hasOwn(sanitized.cause.headers, "proxy-authorization"), false);

      const safeMsg = formatSafeErrorMessage(rawErr, [customSecret]);
      assert.equal(safeMsg.includes(secretPat), false);
      assert.equal(safeMsg.includes(customSecret), false);
      assert.equal(formatSafeErrorMessage(null, [], "Fallback seguro"), "Fallback seguro");
    });
  });

  describe("C. AppSec: encoding.js / fileImport.js / keyVaultCrypto.js", () => {
    test("parseGithubBlobPayload y base64ToBytes fallan ante Base64 corrupto (no devuelven '')", async () => {
      assert.throws(() => base64ToBytes("not!valid===b64", { strict: true }), /corrupta|inválido/i);
      assert.throws(() => base64ToBytes("abc"), /corrupta|inválido/i);

      globalThis.fetch = async () =>
        new Response(JSON.stringify({ encoding: "base64", content: "@@@corrupt_base64@@@" }), { status: 200 });

      await assert.rejects(
        fetchSingleRepoBlob({
          token: "ghp_ValidTestToken1234567890abcdef",
          owner: "octo",
          repo: "demo",
          blobSha: "sha1"
        }),
        /corrupta|inválido/i
      );
    });

    test("decodeImportedFile rechaza SVG/HTML activo disfrazado como imagen/PDF y acepta binario real", () => {
      const enc = new TextEncoder();
      const disguised = [
        ["evil.png", "<svg onload='alert(1)'></svg>"],
        ["evil.jpg", "  <!DOCTYPE html><html><script>alert(1)</script></html>"],
        ["evil.webp", "<?xml version='1.0'?><svg xmlns='http://www.w3.org/2000/svg'></svg>"],
        ["evil.pdf", "<script>fetch('https://evil.test')</script>"]
      ];
      for (const [name, payload] of disguised) {
        const res = decodeImportedFile(enc.encode(payload), name, { allowBinaryAssets: true });
        assert.equal(res.ok, false, `Debe rechazar ${name} con markup activo`);
      }

      const realPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      const okRes = decodeImportedFile(realPng, "photo.png", { allowBinaryAssets: true });
      assert.equal(okRes.ok, true);
      assert.equal(okRes.isBinary, true);
      assert.deepEqual(base64ToBytes(okRes.base64), realPng);
    });

    test("keyVaultCrypto rechaza JSON > 1 MB en isEncryptedKeyVault y decryptKeysPayload", async () => {
      const padding = "x".repeat(MAX_VAULT_JSON_BYTES + 128);
      const hugeJson = JSON.stringify({
        format: "studio-ide-key-vault",
        version: 1,
        iterations: 210000,
        salt: bytesToBase64(new Uint8Array(16)),
        iv: bytesToBase64(new Uint8Array(12)),
        ciphertext: padding
      });
      assert.ok(hugeJson.length > MAX_VAULT_JSON_BYTES);
      assert.equal(isEncryptedKeyVault(hugeJson), false);
      await assert.rejects(
        decryptKeysPayload(hugeJson, "clave-segura-123"),
        /tamaño máximo permitido/i
      );
    });
  });

  describe("D. AppSec: zipExporter.js", () => {
    test("ignora carpetas isFolder, rechaza ':', acota años DOS 1980..2107, sanea descarga y genera Blob ZIP válido", async () => {
      assert.throws(() => buildZipArchive([{ path: "C:evil.txt", content: "x" }]), /caracteres no permitidos/i);
      assert.throws(() => buildZipArchive([{ path: "a:b.txt", content: "x" }]), /caracteres no permitidos/i);
      assert.throws(() => buildZipArchive([{ path: "src/../../evil.txt", content: "x" }]), /traversal/i);

      const minDos = getDosDateTime(new Date(1965, 0, 1, 12, 0, 0));
      assert.equal(((minDos.dosDate >> 9) & 0x7f) + 1980, 1980);
      const maxDos = getDosDateTime(new Date(2200, 6, 10, 12, 0, 0));
      assert.equal(((maxDos.dosDate >> 9) & 0x7f) + 1980, 2107);

      const blob = buildZipBlob([
        { path: "src", isFolder: true, content: "" },
        { path: "src/main.js", isFolder: false, content: "console.log(42);" }
      ]);
      assert.equal(blob instanceof Blob, true);
      assert.equal(blob.type, "application/zip");

      const bytes = new Uint8Array(await blob.arrayBuffer());
      const view = new DataView(bytes.buffer);
      // Firma PKZIP Local File Header (0x04034b50)
      assert.equal(view.getUint32(0, true), 0x04034b50);
      // Firma EOCD al final (últimos 22 bytes) con exactamente 1 entrada (la carpeta fue ignorada)
      const eocdOffset = bytes.length - 22;
      assert.equal(view.getUint32(eocdOffset, true), 0x06054b50);
      assert.equal(view.getUint16(eocdOffset + 8, true), 1);
      assert.equal(view.getUint16(eocdOffset + 10, true), 1);

      // Sanitización de nombre en downloadZip
      const origCreateObjectUrl = URL.createObjectURL;
      const origRevokeObjectUrl = URL.revokeObjectURL;
      const origCreateElement = document.createElement;
      let capturedLink = null;
      URL.createObjectURL = () => "blob:mock-zip";
      URL.revokeObjectURL = () => {};
      document.createElement = (tag) => {
        const el = origCreateElement(tag);
        if (tag === "a") capturedLink = el;
        return el;
      };
      try {
        downloadZip(blob, '..\\..\\evil:repo*?"<>|\x01');
        assert.ok(capturedLink);
        assert.equal(capturedLink.download.includes("/"), false);
        assert.equal(capturedLink.download.includes("\\"), false);
        assert.equal(capturedLink.download.includes(":"), false);
        assert.equal(/[\x00-\x1f*?"<>|]/.test(capturedLink.download), false);
        assert.equal(capturedLink.download.endsWith(".zip"), true);
      } finally {
        URL.createObjectURL = origCreateObjectUrl;
        URL.revokeObjectURL = origRevokeObjectUrl;
        document.createElement = origCreateElement;
      }
    });
  });

  describe("E. AppSec: htmlBundler.js & previewUtils.js", () => {
    test("bundleHtmlWithFolderAssets no reescribe <style>/<img> dentro de strings JS ni corta <script> en '<\\/script>'", () => {
      const files = new Map([
        ["logo.png", { path: "logo.png", isBinary: true, base64: "AQID", content: "" }]
      ]);
      const rawHtml = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <img id="real" src="logo.png">
  <script>
    const htmlStr = '<style>@import "missing.css";</style><img src="logo.png">';
    const escapedClose = "<\\/script><img src='logo.png'>";
    const rawCloseInStr = "</script>";
    console.log(htmlStr, escapedClose, rawCloseInStr);
  </script>
</body>
</html>`;

      const out = bundleHtmlWithFolderAssets("index.html", rawHtml, files);
      // El <img> real fuera de <script> sí se incrusta en data:image/png;base64,AQID
      assert.ok(out.includes('<img id="real" src="data:image/png;base64,AQID">'));
      // Los literales dentro de <script> NO deben haberse reescrito a data:image/png
      assert.ok(out.includes(`const htmlStr = '<style>@import "missing.css";</style><img src="logo.png">';`));
      assert.ok(out.includes(`const escapedClose = "<\\/script><img src='logo.png'>";`));
      // El string literal "</script>" debe quedar escapado como "<\/script>" sin partir la etiqueta <script>
      assert.ok(out.includes(`const rawCloseInStr = "<\\/script>";`));
    });

    test("inlineCssImports escapa '*/', soporta @import diamante, ignora comentados y corta ciclos reales", () => {
      const files = new Map([
        [
          "main.css",
          {
            path: "main.css",
            content: [
              '/* @import "commented.css"; */',
              '@import "left.css";',
              '@import "right.css";',
              '@import "cycleA.css";',
              '@import "shared.css" screen and (min-width: 1px) /*evil*/ */break;'
            ].join("\n")
          }
        ],
        ["commented.css", { path: "commented.css", content: ".should-not-appear { color: red; }" }],
        ["left.css", { path: "left.css", content: '@import "shared.css";\n.left { color: blue; }' }],
        ["right.css", { path: "right.css", content: '@import "shared.css";\n.right { color: green; }' }],
        ["shared.css", { path: "shared.css", content: ".shared { display: block; }" }],
        ["cycleA.css", { path: "cycleA.css", content: '@import "cycleB.css";\n.ca { opacity: 1; }' }],
        ["cycleB.css", { path: "cycleB.css", content: '@import "cycleA.css";\n.cb { opacity: 0.5; }' }]
      ]);

      const out = bundleHtmlWithFolderAssets(
        "index.html",
        '<html><head><link rel="stylesheet" href="main.css"></head><body></body></html>',
        files
      );

      assert.equal(out.includes(".should-not-appear"), false);
      const sharedMatches = out.match(/\.shared\s*\{\s*display:\s*block;\s*\}/g) || [];
      assert.equal(sharedMatches.length, 3, "Diamante (left+right) + import condicional deben incluir shared.css");
      assert.ok(out.includes(".ca { opacity: 1; }"));
      assert.ok(out.includes(".cb { opacity: 0.5; }"));
      assert.ok(out.includes("* /break"), "Secuencia '*/' en condiciones de @import debe escaparse como '* /'");
    });

    test("previewUtils y buildConsoleBridgeScript bloquean vbscript:, ' javascript:...' con control chars y data:", () => {
      const maliciousUrls = [
        "vbscript:msgbox(1)",
        "  \x00\n\tjavascript:alert(1)",
        "JAVASCRIPT:alert(document.domain)",
        "data:text/html,<script>alert(1)</script>"
      ];
      for (const u of maliciousUrls) {
        assert.equal(isBlockedPreviewUrlScheme(u), true, `Debe bloquear ${JSON.stringify(u)}`);
      }
      assert.equal(isBlockedPreviewUrlScheme("https://example.com"), false);
      assert.equal(normalizePreviewUrlRef(" \x01VbScRiPt:1 "), "vbscript:1");

      // Ejecutar realmente el script del puente en VM para validar bloqueo en runtime
      const bridgeHtml = buildConsoleBridgeScript(false);
      const scriptBody = bridgeHtml.replace(/^<script>/, "").replace(/<\/script>$/, "");

      const docListeners = new Map();
      const posted = [];
      let opened = 0;
      const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        document: {
          getElementById: () => null,
          addEventListener(type, fn) {
            if (!docListeners.has(type)) docListeners.set(type, []);
            docListeners.get(type).push(fn);
          }
        },
        window: {
          addEventListener() {},
          open() { opened += 1; },
          location: {}
        },
        parent: {
          postMessage(msg) { posted.push(msg); }
        }
      };
      sandbox.window.parent = sandbox.parent;
      vm.runInNewContext(scriptBody, sandbox);

      const clickHandler = docListeners.get("click")[0];
      const submitHandler = docListeners.get("submit")[0];

      for (const badHref of maliciousUrls) {
        let prevented = false;
        let stopped = false;
        clickHandler({
          target: { closest: () => ({ getAttribute: () => badHref, setAttribute() {} }) },
          preventDefault() { prevented = true; },
          stopPropagation() { stopped = true; }
        });
        assert.equal(prevented && stopped, true, `Click en ${badHref} debe cancelarse`);

        let formPrevented = false;
        submitHandler({
          target: { getAttribute: () => badHref },
          preventDefault() { formPrevented = true; },
          stopPropagation() {}
        });
        assert.equal(formPrevented, true, `Submit a ${badHref} debe cancelarse`);

        sandbox.window.navigate(badHref);
      }

      assert.equal(posted.length, 0, "Ningún esquema bloqueado debe emitir navigate al padre");
      assert.equal(opened, 0, "Ningún esquema bloqueado debe abrir ventana");
    });
  });

  describe("F. AppSec: chatController.js & cRunner.js & providers.js", () => {
    test("detectFilePathFromCodeSegment bloquea ../, /abs y __proto__/constructor/prototype", () => {
      assert.equal(detectFilePathFromCodeSegment("js:../secret.js", ""), null);
      assert.equal(detectFilePathFromCodeSegment("js:/etc/passwd.txt", ""), null);
      assert.equal(detectFilePathFromCodeSegment("js:__proto__/a.js", ""), null);
      assert.equal(detectFilePathFromCodeSegment("js:src/constructor/a.js", ""), null);
      assert.equal(detectFilePathFromCodeSegment("js", "// file: ../escape.c\nint main(){}"), null);
      assert.equal(detectFilePathFromCodeSegment("js", "console.log(1);", "Archivo: `/abs/path.js`"), null);
      assert.equal(detectFilePathFromCodeSegment("js:src/app.js", "console.log(1);"), "src/app.js");
    });

    test("cRunner: buildWandboxPayload protege -flag.c con ./-flag.c y injectInteractiveInputGuard limpia \\r\\n en #line", () => {
      const payload = buildWandboxPayload({
        activeFile: { path: "main.c", content: "int main(){return 0;}" },
        companionFiles: [
          { path: "-O0.c", content: "int helper(){return 1;}" },
          { path: "@evil.c", content: "int helper2(){return 2;}" }
        ]
      });
      const filesInCodes = payload.codes.map((c) => c.file);
      assert.ok(filesInCodes.includes("./-O0.c"));
      assert.ok(filesInCodes.includes("./@evil.c"));
      assert.ok(payload["compiler-option-raw"].includes("./-O0.c"));
      assert.ok(payload["compiler-option-raw"].includes("./@evil.c"));

      const guarded = injectInteractiveInputGuard(
        'int main(){int x; scanf("%d",&x); return 0;}',
        'evil.c"\r\n#include "/etc/passwd\n',
        true
      );
      const lineDirective = guarded.split("\n").find((l) => l.startsWith("#line "));
      assert.ok(lineDirective);
      assert.equal(lineDirective, '#line 1 "evil.c#include /etc/passwd"');
    });

    test("providers valida Object.hasOwn en saveApiKey/importKeysBundle y detecta AbortError con isAbortError", () => {
      saveApiKey("__proto__", "evil");
      saveApiKey("constructor", "evil");
      saveApiKey("toString", "evil");
      assert.equal(getApiKey("__proto__"), "");
      assert.equal(getApiKey("constructor"), "");
      assert.equal(getApiKey("toString"), "");
      assert.equal(localStorage.getItem("ide.ai.key.__proto__"), null);

      const imported = importKeysBundle(
        JSON.stringify({
          __proto__: "evil-proto",
          constructor: "evil-ctor",
          toString: "evil-tostr",
          gemini: "AIzaSyValidKey1234567890abcdef"
        })
      );
      assert.equal(imported, 1);
      assert.equal(getApiKey("gemini"), "AIzaSyValidKey1234567890abcdef");
      assert.equal(localStorage.getItem("ide.ai.key.toString"), null);

      assert.equal(isAbortError(new DOMException("Aborted", "AbortError")), true);
      assert.equal(isAbortError({ name: "AbortError" }), true);
      assert.equal(isAbortError(new Error("Network error")), false);
      assert.equal(isAbortError(null), false);
    });
  });

  describe("G. AppSec: binaryPreview.js & icons.js & livePreviewModal.js", () => {
    test("sanitizeSvgMarkup y createBinaryPreview bloquean XSS en SVG y Base64 inválido", () => {
      const dirtySvg =
        '<svg onload="alert(1)"><script>alert(2)</script><foreignObject><iframe src="x"></iframe></foreignObject><a xlink:href="javascript:alert(3)"><rect onclick=alert(4) /></a></svg>';
      const cleanSvg = sanitizeSvgMarkup(dirtySvg);
      assert.ok(cleanSvg);
      assert.equal(/<script/i.test(cleanSvg), false);
      assert.equal(/<foreignObject/i.test(cleanSvg), false);
      assert.equal(/<iframe/i.test(cleanSvg), false);
      assert.equal(/on(?:load|click)=/i.test(cleanSvg), false);
      assert.equal(/javascript:/i.test(cleanSvg), false);
      assert.equal(sanitizeSvgMarkup("<script>alert(1)</script>"), null);

      const container = document.createElement("div");
      const preview = createBinaryPreview({ binaryPreviewEl: container, onDownloadFile: () => {} });
      preview.render({
        path: "evil.png",
        shortName: "evil.png",
        isBinary: true,
        base64: 'not!valid"><img onerror=alert(1)>'
      });
      // Base64 inválido no debe renderizar <img> con data:image/png;base64,...
      assert.equal(container.querySelectorAll("img").length, 0);
      assert.ok(container.querySelector(".editor-empty-mark"));
    });

    test("icon() sanea extraClass contra ruptura de atributos HTML", () => {
      const markup = icon("code", 'btn" onclick="alert(1)" data-x=\'y');
      const match = markup.match(/^<svg class="([^"]*)"/);
      assert.ok(match);
      assert.equal(match[1].includes('"'), false);
      assert.equal(match[1].includes("'"), false);
      assert.equal(match[1].includes("="), false);
      assert.equal(markup.includes('onclick="alert(1)"'), false);
    });

    test("livePreviewModal ignora postMessage con event.origin !== 'null' o tras salir del srcdoc controlado", async () => {
      const origWindowAdd = window.addEventListener;
      const origWindowRemove = window.removeEventListener;
      const origSetTimeout = window.setTimeout;
      const origClearTimeout = window.clearTimeout;
      const winListeners = new Map();

      window.addEventListener = (type, fn, opts) => {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add(fn);
        if (opts && typeof opts === "object" && opts.signal) {
          opts.signal.addEventListener("abort", () => winListeners.get(type)?.delete(fn), { once: true });
        }
      };
      window.removeEventListener = (type, fn) => {
        winListeners.get(type)?.delete(fn);
      };
      window.setTimeout = globalThis.setTimeout;
      window.clearTimeout = globalThis.clearTimeout;

      const emitWindowMessage = (evt) => {
        for (const fn of [...(winListeners.get("message") || [])]) {
          fn(evt);
        }
      };

      const prevBodyChildren = [...document.body.children];
      const host = makeTrackedEl("div", "phase3-preview-host");
      const dlg = makeTrackedEl("dialog", "preview-dialog", {
        open: false,
        showModal() { this.open = true; },
        close() { this.open = false; }
      });
      const fakeIframeWin = { postMessage() {} };
      const iframe = makeTrackedEl("iframe", "preview-iframe", { contentWindow: fakeIframeWin });
      const consoleList = makeTrackedEl("div", "preview-console-list");
      const ids = [
        ["button", "btn-live-preview"],
        ["span", "preview-dialog-title"],
        ["span", "preview-file-badge"],
        ["button", "btn-preview-js-mode"],
        ["button", "btn-close-preview"],
        ["button", "btn-preview-reload"],
        ["button", "btn-preview-console"],
        ["button", "btn-preview-clear-console"],
        ["div", "preview-unavailable-state"],
        ["h3", "preview-unavailable-title"],
        ["p", "preview-unavailable-desc"],
        ["div", "preview-console-panel"],
        ["span", "preview-console-title"],
        ["form", "preview-repl-form"],
        ["input", "preview-repl-input"],
        ["div", "preview-iframe-wrapper"],
        ["div", "preview-c-runner"],
        ["select", "preview-page-select"],
        ["button", "btn-preview-back"],
        ["button", "btn-preview-forward"]
      ];
      host.append(dlg, iframe, consoleList);
      for (const [tag, id] of ids) {
        host.appendChild(makeTrackedEl(tag, id));
      }
      document.body.appendChild(host);

      const ctrl = initLivePreviewModal({
        getWorkspaceSnapshot: () => ({
          projectId: "p-sec",
          activeFileId: "index.html",
          files: [{ id: "index.html", path: "index.html", shortName: "index.html", content: "<h1>Hi</h1>" }]
        })
      });

      try {
        await ctrl.openPreview();
        // Primer load esperado del srcdoc controlado
        iframe.dispatchEvent(new Event("load"));

        // 1. Origen distinto de "null" debe ignorarse aunque source coincida
        emitWindowMessage({
          origin: "https://evil.example",
          source: fakeIframeWin,
          data: { source: "studio-ide-preview", level: "log", text: "forged-origin" }
        });
        assert.equal(consoleList.children.length, 0);

        // 2. Mensaje válido con origin === "null" y srcdoc controlado sí entra
        emitWindowMessage({
          origin: "null",
          source: fakeIframeWin,
          data: { source: "studio-ide-preview", level: "log", text: "trusted-log" }
        });
        assert.equal(consoleList.children.length, 1);
        assert.equal(consoleList.children[0].textContent, "trusted-log");

        // 2b. Navegación con esquema peligroso vía postMessage debe bloquearse en handlePreviewNavigation
        const srcdocBefore = iframe.srcdoc;
        emitWindowMessage({
          origin: "null",
          source: fakeIframeWin,
          data: { source: "studio-ide-preview", action: "navigate", href: " \n\tjavascript:alert(1)" }
        });
        assert.equal(consoleList.children.length, 2);
        assert.match(consoleList.children[1].textContent, /bloqueada por política de seguridad/i);
        assert.equal(iframe.srcdoc, srcdocBefore);

        // 3. Segundo load inesperado (iframe navegó fuera del srcdoc controlado)
        iframe.dispatchEvent(new Event("load"));
        emitWindowMessage({
          origin: "null",
          source: fakeIframeWin,
          data: { source: "studio-ide-preview", level: "log", text: "post-navigation-evil" }
        });
        assert.equal(consoleList.children.length, 2, "Tras navegar fuera de srcdoc controlado debe ignorar mensajes");
      } finally {
        ctrl.destroy();
        host.remove();
        document.body.children = prevBodyChildren;
        window.addEventListener = origWindowAdd;
        window.removeEventListener = origWindowRemove;
        window.setTimeout = origSetTimeout;
        window.clearTimeout = origClearTimeout;
      }
    });
  });

  describe("H. AppSec: sw.js (13 módulos nuevos, exclusión cdnjs, validación https: en redirección y timeout)", () => {
    test("sw.js contiene los 13 nuevos módulos en APP_SHELL_URLS, excluye cdnjs y rechaza redirecciones no-HTTPS/no-CDN", async () => {
      const swPath = path.join(ROOT_DIR, "sw.js");
      const swCode = fs.readFileSync(swPath, "utf8");

      const expected13Modules = [
        "./js/utils/encoding.js",
        "./js/utils/dom.js",
        "./js/utils/storage.js",
        "./js/preview/jsTokenUtils.js",
        "./js/editor/languageConfig.js",
        "./js/editor/errorMarkersController.js",
        "./js/editor/fallbackEditor.js",
        "./js/workspace/autosaveManager.js",
        "./js/workspace/tabManager.js",
        "./js/workspace/githubLazySync.js",
        "./js/workspace/broadcastSync.js",
        "./js/ui/confirmDialog.js",
        "./js/ui/statusBarController.js"
      ];

      assert.equal(swCode.includes("cdnjs.cloudflare.com"), false, "sw.js no debe incluir cdnjs.cloudflare.com");

      // Ejecutar sw.js en contexto VM controlado para verificar APP_SHELL_URLS y comportamiento real de fetch/cache
      const swListeners = new Map();
      const cachePuts = [];
      const mockCache = {
        match: async () => undefined,
        put: async (key, res) => { cachePuts.push({ key: String(key?.url || key), res }); }
      };
      let lastFetchInit = null;
      const sandbox = {
        URL,
        Request: class MockReq {
          constructor(u, init = {}) {
            this.url = typeof u === "string" ? u : u.url;
            this.method = init.method || "GET";
            this.mode = init.mode || "cors";
          }
        },
        Response,
        Headers,
        Set,
        Map,
        Promise,
        AbortController,
        setTimeout,
        clearTimeout,
        console,
        fetch: async (req, init) => {
          lastFetchInit = init || null;
          const reqUrl = typeof req === "string" ? req : req.url;
          if (reqUrl.includes("redirect-http")) {
            return { ok: true, status: 200, type: "basic", url: "http://esm.sh/pkg.js", clone() { return this; } };
          }
          if (reqUrl.includes("redirect-evil")) {
            return { ok: true, status: 200, type: "basic", url: "https://evil.example/pkg.js", clone() { return this; } };
          }
          return { ok: true, status: 200, type: "basic", url: reqUrl, clone() { return this; } };
        },
        caches: {
          open: async () => mockCache,
          keys: async () => [],
          delete: async () => true
        },
        self: {
          location: { origin: "https://studio-ide.local" },
          AbortController,
          addEventListener(type, fn) { swListeners.set(type, fn); },
          skipWaiting: async () => {},
          clients: { claim: async () => {} }
        }
      };

      vm.runInNewContext(`${swCode}\nglobalThis.__APP_SHELL = APP_SHELL_URLS;\nglobalThis.__hasSafeRedirectOrigin = hasSafeRedirectOrigin;\nglobalThis.__isCacheableCdnUrl = isCacheableCdnUrl;`, sandbox);

      for (const modUrl of expected13Modules) {
        assert.ok(sandbox.__APP_SHELL.includes(modUrl), `APP_SHELL_URLS debe incluir ${modUrl}`);
        const diskPath = path.join(ROOT_DIR, modUrl.replace(/^\.\//, ""));
        assert.equal(fs.existsSync(diskPath), true, `Debe existir en disco ${modUrl}`);
      }

      // Validar rechazo de redirección a http: o host externo no autorizado
      assert.equal(sandbox.__isCacheableCdnUrl(new URL("http://esm.sh/acorn@8.14.0")), false);
      assert.equal(sandbox.__isCacheableCdnUrl(new URL("https://cdnjs.cloudflare.com/x.js")), false);
      assert.equal(
        sandbox.__hasSafeRedirectOrigin({ url: "http://esm.sh/acorn" }, "https://esm.sh/acorn"),
        false
      );
      assert.equal(
        sandbox.__hasSafeRedirectOrigin({ url: "https://evil.example/a.js" }, "https://esm.sh/acorn"),
        false
      );
      assert.equal(
        sandbox.__hasSafeRedirectOrigin({ url: "https://esm.sh/acorn@8.14.0/es2022/acorn.mjs" }, "https://esm.sh/acorn@8.14.0"),
        true
      );

      // Validar que fetch handler de CDN NO cachea redirecciones inseguras y que App Shell usa fetchWithTimeout (signal)
      const fetchHandler = swListeners.get("fetch");
      assert.equal(typeof fetchHandler, "function");

      let cdnResponsePromise;
      fetchHandler({
        request: new sandbox.Request("https://esm.sh/redirect-http.js"),
        respondWith(p) { cdnResponsePromise = p; }
      });
      await cdnResponsePromise;
      assert.equal(cachePuts.length, 0, "No debe cachear redirección CDN a HTTP");

      let evilRedirectPromise;
      fetchHandler({
        request: new sandbox.Request("https://esm.sh/redirect-evil.js"),
        respondWith(p) { evilRedirectPromise = p; }
      });
      const evilRedirectRes = await evilRedirectPromise;
      assert.equal(evilRedirectRes.url, "https://evil.example/pkg.js");
      assert.equal(cachePuts.length, 0, "No debe cachear redirección CDN hacia origen externo no permitido");

      let validCdnPromise;
      fetchHandler({
        request: new sandbox.Request("https://esm.sh/acorn@8.14.0"),
        respondWith(p) { validCdnPromise = p; }
      });
      await validCdnPromise;
      assert.ok(cachePuts.some((entry) => entry.key.includes("esm.sh/acorn@8.14.0")), "CDN legítimo sin redirección insegura sí se cachea");

      let shellResponsePromise;
      fetchHandler({
        request: new sandbox.Request("https://studio-ide.local/js/app.js"),
        respondWith(p) { shellResponsePromise = p; }
      });
      await shellResponsePromise;
      assert.ok(lastFetchInit && lastFetchInit.signal instanceof AbortSignal, "App Shell debe usar fetchWithTimeout con AbortSignal");
    });
  });

  describe("I. Integridad, Concurrencia y Rendimiento / Estrés", () => {
    test("workspaceDb: renameProjectEntry conserva baseBase64, countPendingGithubChanges coincide y applyRemotePullPlan bloquea sobrescribir carpeta con hijos activos", async () => {
      await ensureInitialWorkspace();
      const proj = await hydrateGithubProject({
        owner: "qa-org",
        repo: "phase3-repo",
        branch: "main",
        commitSha: "commit-base-1",
        files: [
          { path: "assets/logo.png", isBinary: true, base64: "AQID", content: "" },
          { path: "src/app.js", isBinary: false, content: "const x = 1;" },
          { path: "docs/guide.md", isBinary: false, content: "# Guide" }
        ]
      });

      try {
        // 1. Modificar binario y renombrar ida y vuelta -> baseBase64 preservada en tombstone y al restaurar
        await upsertEntry(proj.id, "assets/logo.png", {
          isFolder: false,
          isBinary: true,
          base64: "BAUG",
          content: ""
        });

        await renameProjectEntry(proj.id, "assets/logo.png", "assets/logo-renamed.png", false);
        const afterRenameEntries = await getAllRawProjectEntries(proj.id);
        const tombstone = afterRenameEntries.find((e) => e.path === "assets/logo.png");
        assert.ok(tombstone && tombstone.deleted === true);
        assert.equal(tombstone.baseBase64, "AQID", "Tombstone tras renombrar debe conservar baseBase64 original");

        // Renombrar de vuelta al path original con contenido restaurado -> recupera baseBase64 y queda sincronizado
        await upsertEntry(proj.id, "assets/logo-renamed.png", {
          isFolder: false,
          isBinary: true,
          base64: "AQID",
          content: ""
        });
        await renameProjectEntry(proj.id, "assets/logo-renamed.png", "assets/logo.png", false);
        const restoredEntries = await getAllRawProjectEntries(proj.id);
        const restoredLogo = restoredEntries.find((e) => e.path === "assets/logo.png" && !e.deleted);
        assert.ok(restoredLogo);
        assert.equal(restoredLogo.baseBase64, "AQID", "Al volver a la ruta tracked debe restaurar baseBase64");

        // 2. countPendingGithubChanges coincide exactamente con getPendingGithubChanges().length
        await upsertEntry(proj.id, "src/app.js", { isFolder: false, content: "const x = 2;" });
        await upsertEntry(proj.id, "src/new.js", { isFolder: false, content: "export const n = 1;" });
        const pendingList = await getPendingGithubChanges(proj.id);
        const pendingCount = await countPendingGithubChanges(proj.id);
        assert.equal(pendingCount, 2);
        assert.equal(pendingCount, pendingList.length);

        // 3. applyRemotePullPlan bloquea sobrescribir carpeta ("docs") con hijos activos ("docs/guide.md")
        await assert.rejects(
          applyRemotePullPlan(proj.id, {
            newCommitSha: "commit-base-2",
            updates: [
              { path: "docs", blobSha: "b1", content: "now a file", contentLoaded: true }
            ]
          }),
          /conserve hijos activos/i
        );
      } finally {
        await deleteProject(proj.id);
      }
    });

    test("githubMerge: buildRemotePullPlan descarga 24 archivos en concurrencia acotada (<= 6) mucho más rápido que 24x latencia", async () => {
      const N = 24;
      const LATENCY_MS = 35;
      const remoteDiffFiles = Array.from({ length: N }, (_, i) => ({
        path: `src/file_${i}.js`,
        status: "added",
        blobSha: `sha_${i}`
      }));

      const classification = classifyRemotePullChanges({
        localEntries: [],
        localPendingChanges: [],
        remoteDiffFiles
      });

      let active = 0;
      let maxActive = 0;
      const start = Date.now();
      const plan = await buildRemotePullPlan({
        project: { offlineCached: true },
        localEntries: [],
        classification,
        newCommitSha: "sha-new-24",
        fetchBlob: async (blobSha, filePath) => {
          active += 1;
          if (active > maxActive) maxActive = active;
          await new Promise((r) => setTimeout(r, LATENCY_MS));
          active -= 1;
          return `// ${filePath} (${blobSha})`;
        }
      });
      const elapsedMs = Date.now() - start;

      assert.equal(plan.updates.length, N);
      assert.ok(maxActive >= 2 && maxActive <= 6, `Concurrencia observada: ${maxActive} (debe ser <= 6)`);
      assert.ok(elapsedMs < N * LATENCY_MS * 0.6, `Tiempo ${elapsedMs}ms debe ser muy inferior a ${N * LATENCY_MS}ms secuencial`);
    });

    test("tsTranspiler + loopGuard + moduleBundler procesan 600 funciones/bucles/re-exports en < 2000 ms", () => {
      const COUNT = 600;
      const tsLines = [];
      for (let i = 0; i < COUNT; i += 1) {
        tsLines.push(`export function fn_${i}(x: number): number { let s: number = 0; for (let k = 0; k < 2; k++) { s += x + k; } return s; }`);
      }
      const bigTsSource = tsLines.join("\n");

      const moduleFiles = new Map();
      const reexportLines = [];
      for (let i = 0; i < COUNT; i += 1) {
        const modPath = `mods/m_${i}.ts`;
        moduleFiles.set(modPath, {
          path: modPath,
          content: `export const val_${i}: number = ${i};`
        });
        reexportLines.push(`export { val_${i} } from "./mods/m_${i}.ts";`);
      }
      const entryCode = `${reexportLines.join("\n")}\nexport const total = ${COUNT};`;
      moduleFiles.set("index.ts", { path: "index.ts", content: entryCode });

      const t0 = performance.now();
      const transpiled = transpileTypeScriptAndJsx(bigTsSource, { jsx: false, fileName: "stress.ts" });
      const guarded = instrumentLoops(transpiled.code, acorn, { module: true });
      const exactMap = buildExactModuleMap(moduleFiles);
      const bundle = buildVirtualModuleBundle({
        entryPath: "index.ts",
        entryCode,
        exactMap,
        transformJs: (code, isMod) => instrumentLoops(code, acorn, { module: isMod }).code
      });
      const exec = formatVirtualModuleExecution(bundle);
      const elapsed = performance.now() - t0;

      assert.equal(guarded.loops, COUNT);
      assert.ok(exec.scriptCode.includes("val_599"));
      assert.ok(elapsed < 2000, `Carga combinada TS+LoopGuard+Bundler tardó ${elapsed.toFixed(1)} ms (>= 2000 ms)`);
    });

    test("editorManager LRU statesByFile respeta cota (<= 15 normal, <= 4 split), smartReplace 1500 líneas, autocompleteCatalog y keyboardRouter observeDialogs", async () => {
      // 1. Prueba de cota LRU real en editorManager.js usando hooks de módulo en Node 24 para stubear @codemirror/*
      let stateCreateCalls = 0;
      const cmStubUrl = new URL("data:text/javascript," + encodeURIComponent(`
        export class Compartment { of(e) { return e; } reconfigure(e) { return { comp: this, e }; } }
        export const StateEffect = { define: () => ({ of: (v) => ({ is: () => true, value: v }) }) };
        export const StateField = { define: (cfg) => cfg };
        export const Decoration = { none: { map: () => Decoration.none, update: () => Decoration.none }, line: () => ({ range: () => ({}) }) };
        export const HighlightStyle = { define: () => ({}) };
        export const EditorState = {
          tabSize: { of: () => ({}) },
          create({ doc = "" }) {
            globalThis.__cmStateCreateCount = (globalThis.__cmStateCreateCount || 0) + 1;
            const lines = String(doc).split("\\n");
            const docObj = {
              _text: String(doc),
              length: String(doc).length,
              lines: lines.length,
              toString() { return this._text; },
              sliceString(a, b) { return this._text.slice(a, b); },
              line(n) {
                const idx = Math.max(1, Math.min(n, lines.length)) - 1;
                let from = 0;
                for (let i = 0; i < idx; i++) from += lines[i].length + 1;
                return { number: idx + 1, from, to: from + lines[idx].length, text: lines[idx] };
              },
              lineAt(pos) {
                let acc = 0;
                for (let i = 0; i < lines.length; i++) {
                  const end = acc + lines[i].length;
                  if (pos <= end || i === lines.length - 1) return { number: i + 1, from: acc, to: end, text: lines[i] };
                  acc = end + 1;
                }
                return { number: 1, from: 0, to: 0, text: "" };
              }
            };
            const st = {
              doc: docObj,
              selection: { main: { from: 0, to: 0, anchor: 0, head: 0, empty: true } },
              sliceDoc(a, b) { return docObj.sliceString(a, b); },
              update(spec) {
                const nextSel = spec?.selection ? { ...spec.selection, from: spec.selection.anchor, to: spec.selection.head ?? spec.selection.anchor, empty: true } : st.selection.main;
                return { state: { ...st, selection: { main: nextSel } } };
              }
            };
            return st;
          }
        };
        export class EditorView {
          constructor({ state }) { this.state = state; this.scrollDOM = { addEventListener() {}, scrollTop: 0, clientHeight: 100, scrollHeight: 100 }; this.contentDOM = { setAttribute() {} }; }
          setState(s) { this.state = s; }
          dispatch(spec) {
            if (spec?.selection) {
              const a = spec.selection.anchor ?? 0;
              const h = spec.selection.head ?? a;
              this.state.selection = { main: { anchor: a, head: h, from: Math.min(a, h), to: Math.max(a, h), empty: a === h } };
            }
          }
          focus() {}
          destroy() {}
        }
        EditorView.lineWrapping = {};
        EditorView.theme = () => ({});
        EditorView.decorations = { from: () => ({}) };
        EditorView.updateListener = { of: () => ({}) };
        EditorView.contentAttributes = { of: () => ({}) };
        EditorView.scrollIntoView = () => ({});
        export const keymap = { of: () => ({}) };
        export const lineNumbers = () => ({});
        export const highlightActiveLine = () => ({});
        export const highlightActiveLineGutter = () => ({});
        export const drawSelection = () => ({});
        export const syntaxHighlighting = () => ({});
        export const foldGutter = () => ({});
        export const foldKeymap = [];
        export const bracketMatching = () => ({});
        export const indentOnInput = () => ({});
        export const indentUnit = { of: () => ({}) };
        export const defaultKeymap = [];
        export const history = () => ({});
        export const historyKeymap = [];
        export const indentWithTab = {};
        export const undo = () => false;
        export const redo = () => false;
        export const search = () => ({});
        export const searchKeymap = [];
        export const openSearchPanel = () => false;
        export const autocompletion = () => ({});
        export const completionKeymap = [];
        export const completeAnyWord = () => null;
        export const acceptCompletion = () => false;
        export const closeBrackets = () => ({});
        export const closeBracketsKeymap = [];
        export const tags = { keyword: {}, controlKeyword: {}, operatorKeyword: {}, moduleKeyword: {}, typeName: {}, className: {}, namespace: {}, function: () => ({}), variableName: {}, propertyName: {}, string: {}, special: () => ({}), number: {}, bool: {}, null: {}, atom: {}, operator: {}, punctuation: {}, tagName: {}, attributeName: {}, comment: {}, lineComment: {}, blockComment: {}, heading: {}, strong: {}, emphasis: {}, link: {}, monospace: {} };
        export const cpp = () => ({});
        export const html = () => ({});
        export const css = () => ({});
        export const javascript = () => ({});
        export const python = () => ({});
        export const markdown = () => ({});
        export const json = () => ({});
        export const sql = () => ({});
      `)).href;

      const hook = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier.startsWith("@codemirror/") || specifier === "@lezer/highlight") {
            return { shortCircuit: true, url: cmStubUrl };
          }
          return nextResolve(specifier, context);
        }
      });

      globalThis.__cmStateCreateCount = 0;
      let mainEditor;
      let splitEditor;
      try {
        const { createEditorManager: createMockedCmEditor } = await import(`../js/editor/editorManager.js?cm_lru_test=${Date.now()}`);
        const mountMain = document.createElement("div");
        const mountSplit = document.createElement("div");

        mainEditor = await createMockedCmEditor({
          mountEl: mountMain,
          enableMinimap: false,
          enableAutocomplete: false,
          onDocChange: () => {},
          onSelectionChange: () => {}
        });

        // Abrir 30 archivos en el editor principal (cota LRU = 15)
        for (let i = 1; i <= 30; i += 1) {
          mainEditor.openFile({ id: `file_${i}.js`, lang: "js", content: `const v${i} = ${i};` });
        }
        stateCreateCalls = globalThis.__cmStateCreateCount;
        assert.equal(stateCreateCalls, 30);

        // Los últimos 15 (file_16..file_30) siguen en caché -> NO incrementan EditorState.create
        const beforeHitCheck = globalThis.__cmStateCreateCount;
        for (let i = 16; i <= 30; i += 1) {
          mainEditor.openFile({ id: `file_${i}.js`, lang: "js", content: `const v${i} = ${i};` });
        }
        assert.equal(globalThis.__cmStateCreateCount, beforeHitCheck, "Los 15 más recientes deben permanecer en caché LRU");

        // file_1 fue evictado -> al reabrirlo debe reconstruirse el EditorState
        mainEditor.openFile({ id: "file_1.js", lang: "js", content: "const v1 = 1;" });
        assert.equal(globalThis.__cmStateCreateCount, beforeHitCheck + 1, "El archivo evictado (>15) debe recrear su EditorState");

        // Split instance: cota LRU = 4
        splitEditor = await createMockedCmEditor({
          mountEl: mountSplit,
          enableMinimap: false,
          isSplitInstance: true,
          enableAutocomplete: false,
          onDocChange: () => {},
          onSelectionChange: () => {}
        });
        const splitStart = globalThis.__cmStateCreateCount;
        for (let i = 1; i <= 10; i += 1) {
          splitEditor.openFile({ id: `split_${i}.js`, lang: "js", content: `let s${i} = ${i};` });
        }
        assert.equal(globalThis.__cmStateCreateCount, splitStart + 10);
        const splitAfter10 = globalThis.__cmStateCreateCount;
        for (let i = 7; i <= 10; i += 1) {
          splitEditor.openFile({ id: `split_${i}.js`, lang: "js", content: `let s${i} = ${i};` });
        }
        assert.equal(globalThis.__cmStateCreateCount, splitAfter10, "Split debe retener exactamente los 4 más recientes");
        splitEditor.openFile({ id: "split_1.js", lang: "js", content: "let s1 = 1;" });
        assert.equal(globalThis.__cmStateCreateCount, splitAfter10 + 1, "Split debe evictar estados fuera de los 4 recientes");
      } finally {
        mainEditor?.destroy();
        splitEditor?.destroy();
        delete globalThis.__cmStateCreateCount;
        hook.deregister();
      }

      // 2. smartReplace sobre 1500 líneas + autocompleteCatalog
      const doc1500 = Array.from({ length: 1500 }, (_, i) => `function item_${i}(arg_${i}) { return arg_${i} * 2; }`).join("\n");
      const tSmart = performance.now();
      const replaced = computeSmartReplacement(
        doc1500,
        "function item_1200(arg_1200) { return arg_1200 * 3; }",
        { cursorLine: 1201 }
      );
      const smartElapsed = performance.now() - tSmart;
      assert.equal(replaced.targetLineNumber, 1201);
      assert.ok(replaced.text.includes("return arg_1200 * 3;"));
      assert.ok(smartElapsed < 500, `smartReplace en 1500 líneas tardó ${smartElapsed.toFixed(1)} ms`);

      const ids = extractDocumentIdentifiers(doc1500);
      assert.ok(ids.includes("item_1499"));
      const comp = getLanguageCompletions("js", "item_149", ids, 5);
      assert.ok(comp.some((c) => c.label.startsWith("item_149")));

      // 3. keyboardRouter observeDialogs: no duplica listeners en múltiples showModal() y desapila <dialog> sin id
      const kr = new KeyboardRouter();
      const root = document.createElement("div");
      const dlgNoId = document.createElement("dialog");
      let closeListenerAdds = 0;
      const origAdd = dlgNoId.addEventListener.bind(dlgNoId);
      dlgNoId.addEventListener = (type, fn) => {
        if (type === "close") closeListenerAdds += 1;
        return origAdd(type, fn);
      };
      dlgNoId.open = false;
      dlgNoId.showModal = function () { this.open = true; };
      dlgNoId.close = function () {
        this.open = false;
        this.dispatchEvent(new Event("close"));
      };
      root.appendChild(dlgNoId);

      kr.observeDialogs(root);
      kr.observeDialogs(root);
      assert.equal(closeListenerAdds, 1, "observeDialogs no debe duplicar listener 'close'");

      dlgNoId.showModal();
      dlgNoId.showModal();
      dlgNoId.showModal();
      assert.equal(kr.modalStack.length, 1, "Múltiples showModal() no deben apilar entradas duplicadas");
      assert.equal(closeListenerAdds, 1);
      assert.ok(kr.getActiveModal()?.id);

      dlgNoId.close();
      assert.equal(kr.modalStack.length, 0, "Debe desapilar correctamente <dialog> sin id al cerrarse");
    });

    test("chatController streaming DOM incremental preserva nodos cerrados y providers consumeSseStream decodifica chunks CRLF/UTF-8 partidos", async () => {
      // Parte 1: providers consumeSseStream con chunks CRLF y UTF-8 multibyte partidos por bytes
      const ssePayload =
        ": ping\r\n" +
        'data: {"choices":[{"delta":{"content":"Hola ñandú "}}]}\r\n\r\n' +
        'data: {"choices":[{"delta":{"content":"🚀 "}}]}\r\n' +
        "\r\n" +
        'data: {"choices":[{"delta":{"content":"listo"}}]}\r\n\r\n' +
        "data: [DONE]\r\n\r\n";
      const rawBytes = new TextEncoder().encode(ssePayload);

      globalThis.fetch = async (url) => {
        if (String(url).includes("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        // Partir en trozos de 3 bytes para cortar secuencias UTF-8 (ñ, 🚀) y CRLF (\r\n)
        const stream = new ReadableStream({
          start(controller) {
            for (let i = 0; i < rawBytes.length; i += 3) {
              controller.enqueue(rawBytes.slice(i, i + 3));
            }
            controller.close();
          }
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      };

      const received = [];
      await streamAiCompletion({
        providerId: "groq",
        model: "llama-3.3-70b-versatile",
        apiKey: "gsk_ValidGroqStreamKey1234567890ab",
        systemPrompt: "sys",
        history: [{ role: "user", content: "hola" }],
        onChunk: (c) => received.push(c)
      });
      assert.equal(received.join(""), "Hola ñandú 🚀 listo");

      // Parte 2: chatController streaming DOM incremental preserva nodos cerrados entre chunks sucesivos
      setKeyStorageMode("local");
      saveProviderId("groq");
      saveApiKey("groq", "gsk_ValidGroqStreamKey1234567890ab");

      const origCreateEl = document.createElement;
      const origRaf = window.requestAnimationFrame;
      const origCancelRaf = window.cancelAnimationFrame;
      const hadHTMLElement = "HTMLElement" in globalThis;
      const prevHTMLElement = globalThis.HTMLElement;
      const probeEl = origCreateEl("div");
      if (!hadHTMLElement || !(probeEl instanceof globalThis.HTMLElement)) {
        globalThis.HTMLElement = Object.getPrototypeOf(probeEl).constructor;
      }

      // Mejorar elementos solo en el ámbito de este test para soportar firstChild, parentNode, insertBefore e innerHTML en prose
      const enhanceEl = (el) => {
        if (!("parentNode" in el)) {
          Object.defineProperty(el, "parentNode", { get() { return this.parentElement; } });
        }
        if (!("firstChild" in el)) {
          Object.defineProperty(el, "firstChild", { get() { return this.children[0] || null; } });
        }
        el.insertBefore = function (newNode, refNode) {
          if (!newNode) return newNode;
          if (newNode.parentElement) newNode.parentElement.removeChild(newNode);
          newNode.parentElement = this;
          if (!refNode) {
            this.children.push(newNode);
          } else {
            const idx = this.children.indexOf(refNode);
            if (idx === -1) this.children.push(newNode);
            else this.children.splice(idx, 0, newNode);
          }
          return newNode;
        };
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "innerHTML");
        Object.defineProperty(el, "innerHTML", {
          get() { return desc.get.call(this); },
          set(val) {
            desc.set.call(this, val);
            if (String(val || "").trim().startsWith("<")) {
              const p = enhanceEl(origCreateEl("p"));
              p.textContent = String(val);
              this.appendChild(p);
            }
          },
          configurable: true
        });
        return el;
      };

      const prevBodyChildren = [...document.body.children];
      const host = enhanceEl(origCreateEl("div"));
      host.id = "phase3-chat-host";
      const chatStream = enhanceEl(origCreateEl("div"));
      chatStream.id = "chat-stream";
      const composerForm = enhanceEl(origCreateEl("form"));
      composerForm.id = "chat-composer-form";
      const promptInput = enhanceEl(origCreateEl("textarea"));
      promptInput.id = "chat-prompt-input";

      const chatIds = [
        ["button", "btn-ai-settings"],
        ["button", "btn-ai-clear-chat"],
        ["div", "chat-settings-drawer"],
        ["span", "chat-current-model-label"],
        ["button", "chat-key-status-btn"],
        ["select", "ai-provider-select"],
        ["select", "ai-model-select"],
        ["input", "ai-custom-model-input"],
        ["button", "ai-fetch-models-btn"],
        ["input", "ai-api-key-input"],
        ["button", "ai-toggle-key-vis"],
        ["button", "ai-clear-key-btn"],
        ["div", "ai-provider-help"],
        ["button", "ai-mode-local"],
        ["button", "ai-mode-session"],
        ["button", "ai-export-keys-btn"],
        ["button", "ai-import-keys-btn"],
        ["div", "ai-import-keys-slot"],
        ["div", "chat-extra-tabs"],
        ["div", "chat-scroll-body"],
        ["button", "chat-submit-btn"],
        ["span", "chat-token-counter"],
        ["button", "btn-chat-regenerate"]
      ];
      host.append(chatStream, composerForm, promptInput);
      for (const [tag, id] of chatIds) {
        const el = enhanceEl(origCreateEl(tag));
        el.id = id;
        host.appendChild(el);
      }
      document.body.appendChild(host);

      document.createElement = (tag) => enhanceEl(origCreateEl(tag));
      const rafQueue = [];
      let rafSeq = 1;
      window.requestAnimationFrame = (cb) => {
        const id = rafSeq++;
        rafQueue.push({ id, cb });
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        const idx = rafQueue.findIndex((r) => r.id === id);
        if (idx !== -1) rafQueue.splice(idx, 1);
      };
      const flushRaf = () => {
        const pending = rafQueue.splice(0, rafQueue.length);
        for (const item of pending) item.cb(performance.now());
      };

      const enc = new TextEncoder();
      let streamController = null;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        if (String(url).includes("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        const body = new ReadableStream({
          start(c) { streamController = c; }
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      };

      let chatCtrl;
      try {
        chatCtrl = initChatController({
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

        promptInput.value = "Generá código";
        composerForm.dispatchEvent({ type: "submit", preventDefault() {} });
        await new Promise((r) => setTimeout(r, 15));
        assert.ok(streamController, "El stream SSE debe haberse iniciado");

        const sendSseText = (text) => {
          streamController.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
        };

        // Chunk 1: cierra segmento 0 (prosa) y abre segmento 1 (código)
        sendSseText("Intro estable\n\n```js\nconst a = 1;");
        await new Promise((r) => setTimeout(r, 15));
        flushRaf();

        const assistantMsg = chatStream.children[chatStream.children.length - 1];
        const msgBody = assistantMsg;
        assert.ok(msgBody && msgBody.classList.contains("chat-ai-response"));
        const closedProseNode = msgBody.children[0];
        const tailHost = msgBody.querySelector(".chat-streaming-tail");
        assert.ok(closedProseNode && tailHost);
        const activeCodeEl = tailHost.querySelector(".chat-code-pre code");
        assert.ok(activeCodeEl);
        assert.equal(activeCodeEl.textContent, "const a = 1;");

        // Chunk 2: agrega código al bloque abierto -> debe preservar el nodo cerrado Y el nodo <code> activo
        sendSseText("\nconst b = 2;");
        await new Promise((r) => setTimeout(r, 15));
        flushRaf();
        assert.equal(msgBody.children[0], closedProseNode, "El nodo de prosa cerrado NO debe recrearse en chunk 2");
        assert.equal(tailHost.querySelector(".chat-code-pre code"), activeCodeEl, "El nodo <code> activo debe actualizarse in-place");
        assert.equal(activeCodeEl.textContent, "const a = 1;\nconst b = 2;");

        // Chunk 3: cierra el bloque de código y abre prosa final
        sendSseText("\n```\n\nConclusión final");
        await new Promise((r) => setTimeout(r, 15));
        flushRaf();
        assert.equal(msgBody.children[0], closedProseNode, "El nodo de prosa cerrado NO debe recrearse en chunk 3");
        const promotedCodeBlock = msgBody.querySelector(".chat-code-block");
        assert.ok(promotedCodeBlock && promotedCodeBlock.parentNode === msgBody);

        // Cierre del stream: render final promociona sin reconstruir nodos ya cerrados
        streamController.enqueue(enc.encode("data: [DONE]\n\n"));
        streamController.close();
        await new Promise((r) => setTimeout(r, 20));
        flushRaf();

        assert.equal(msgBody.children[0], closedProseNode, "Al finalizar el stream, el nodo cerrado inicial sigue siendo la misma referencia DOM");
        assert.equal(msgBody.querySelector(".chat-code-block"), promotedCodeBlock, "El bloque de código promocionado sigue siendo la misma referencia DOM");
      } finally {
        globalThis.fetch = origFetch;
        chatCtrl?.destroy?.();
        host.remove();
        document.body.children = prevBodyChildren;
        document.createElement = origCreateEl;
        window.requestAnimationFrame = origRaf;
        window.cancelAnimationFrame = origCancelRaf;
        if (hadHTMLElement) globalThis.HTMLElement = prevHTMLElement;
        else delete globalThis.HTMLElement;
      }
    });
  });
});
