import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webkit } from "playwright-core";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TESTS_DIR, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function createStaticServer(rootDir) {
  return http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      let relPath = decodeURIComponent(reqUrl.pathname);
      if (relPath === "/") relPath = "/index.html";
      const target = path.resolve(rootDir, "." + relPath);
      if (!target.startsWith(rootDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const stat = await fs.stat(target);
      const filePath = stat.isDirectory() ? path.join(target, "index.html") : target;
      const ext = path.extname(filePath).toLowerCase();
      const body = await fs.readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

describe("Studio IDE — Pruebas E2E Cross-Engine en WebKit (Motor Safari / iPadOS)", () => {
  let server;
  let baseUrl;
  let browser;
  let context;

  before(async () => {
    server = createStaticServer(ROOT_DIR);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;

    browser = await webkit.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 820, height: 1180 },
      hasTouch: true,
      isMobile: true
    });
  });

  after(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await new Promise((resolve) => server?.close(resolve));
  });

  test("Render iPadOS táctil, IndexedDB, SW v30, Formateo, Bundler ES Modules en CSP y WebCrypto en WebKit", async () => {
    const page = await context.newPage();
    const pageErrors = [];
    const coldBootRequests = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const onColdRequest = (req) => coldBootRequests.push(req.url());
    page.on("request", onColdRequest);

    await page.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector(".editor-tab-item", { timeout: 20000 });
    await page.waitForSelector(".tree-node-btn", { timeout: 15000 });
    page.off("request", onColdRequest);

    const eagerHeavyDownloads = coldBootRequests.filter((url) =>
      /pyodide|sql\.js|sql-wasm|wandbox|typescript/i.test(url)
    );
    assert.deepEqual(
      eagerHeavyDownloads,
      [],
      "WebKit no debe descargar runtimes pesados (Pyodide/SQLite/tsc) durante el arranque en frío"
    );

    // 1. Verificar Service Worker v30 accesible y sin desborde horizontal en iPad vertical (820x1180)
    const swAssetOk = await page.evaluate(async () => {
      const res = await fetch("./sw.js");
      if (!res.ok) return false;
      const text = await res.text();
      return text.includes("studio-ide-shell-v30");
    });
    assert.equal(swAssetOk, true, "sw.js debe servir studio-ide-shell-v30 en WebKit");

    const portraitOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    assert.equal(portraitOverflow, false, "iPad portrait en WebKit no debe desbordar horizontalmente");

    // 2. Rotar a paisaje iPad (1180x820) y verificar re-clamp limpio
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.waitForTimeout(250);
    const landscapeOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    assert.equal(landscapeOverflow, false, "iPad landscape en WebKit no debe desbordar horizontalmente");

    // 3. Crear proyecto multi-archivo TS/CSS/JSON en IndexedDB y recargar en WebKit
    await page.evaluate(async () => {
      const dbMod = await import("./js/storage/workspaceDb.js");
      await dbMod.upsertEntry("espacio-local", "wk_fmt.js", {
        isFolder: false,
        content: "function doble(x){\nreturn x*2;\n}"
      });
      await dbMod.upsertEntry("espacio-local", "wk_mod/cfg.json", {
        isFolder: false,
        content: '{"engine":"WebKit"}'
      });
      await dbMod.upsertEntry("espacio-local", "wk_mod/style.css", {
        isFolder: false,
        content: ".wk-box { color: rgb(56, 189, 248); }"
      });
      await dbMod.upsertEntry("espacio-local", "wk_mod/helper.ts", {
        isFolder: false,
        content: 'export default function wrap(v: string): string { return "<" + v + ">"; }'
      });
      await dbMod.upsertEntry("espacio-local", "wk_mod/main.ts", {
        isFolder: false,
        content:
          'import wrap from "./helper";\nimport cfg from "./cfg.json";\nimport "./style.css";\nconst d = document.createElement("div");\nd.className = "wk-box";\nd.textContent = wrap(cfg.engine);\ndocument.body.appendChild(d);\nconsole.log("WK_MULTI_OK", d.textContent, getComputedStyle(d).color);'
      });
    });

    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector(".tree-node-btn", { timeout: 15000 });

    // Formatear wk_fmt.js en UI real WebKit
    const clickedFmt = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll(".tree-node-btn")).find((el) =>
        (el.textContent || "").includes("wk_fmt.js")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    assert.equal(clickedFmt, true, "wk_fmt.js debe aparecer en Explorador en WebKit");
    await page.waitForTimeout(300);
    await page.click("#btn-editor-format");
    await page.waitForFunction(
      async () => {
        const dbMod = await import("./js/storage/workspaceDb.js");
        const entries = await dbMod.getProjectEntries("espacio-local");
        const content = entries.find((e) => e.path === "wk_fmt.js")?.content || "";
        return content.includes("  return x*2;");
      },
      null,
      { timeout: 6000 }
    );

    // 4. Probar Multi-File ES Modules (TS + JSON + CSS) en <iframe srcdoc sandbox> de WebKit + Mini-REPL
    const clickedWkMain = await page.evaluate(() => {
      const folder = Array.from(document.querySelectorAll(".tree-node-btn")).find((el) =>
        (el.textContent || "").includes("wk_mod")
      );
      if (folder && folder.getAttribute("aria-expanded") === "false") {
        folder.click();
      }
      const btn = Array.from(document.querySelectorAll(".tree-node-btn")).find((el) =>
        (el.textContent || "").includes("main.ts")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    assert.equal(clickedWkMain, true, "wk_mod/main.ts debe abrirse en WebKit");
    await page.waitForTimeout(350);

    await page.click("#btn-live-preview");
    await page.waitForSelector("#preview-dialog[open]", { timeout: 10000 });
    await page.waitForFunction(
      () => (document.getElementById("preview-console-list")?.textContent || "").includes("WK_MULTI_OK"),
      null,
      { timeout: 12000 }
    );
    const wkConsoleText = await page.evaluate(
      () => document.getElementById("preview-console-list")?.textContent || ""
    );
    assert.match(wkConsoleText, /WK_MULTI_OK <WebKit> rgb\(56, 189, 248\)/);

    await page.fill("#preview-repl-input", "6 * 7");
    await page.click("#btn-preview-repl-run");
    await page.waitForFunction(
      () => (document.getElementById("preview-console-list")?.textContent || "").includes("42"),
      null,
      { timeout: 8000 }
    );
    await page.click("#btn-close-preview");
    await page.waitForTimeout(250);

    // 5. Verificar Web Crypto AES-GCM 256 en WebKit real
    const vaultOk = await page.evaluate(async () => {
      const providers = await import("./js/ai/providers.js");
      const cryptoMod = await import("./js/security/keyVaultCrypto.js");
      providers.saveApiKey("groq", "gsk_webkit_e2e_test_1234567890abcdef");
      const bundle = providers.exportKeysBundle();
      const encrypted = await cryptoMod.encryptKeysPayload(bundle, "SafariVault2026!", { iterations: 20000 });
      providers.clearApiKey("groq");
      const decrypted = await cryptoMod.decryptKeysPayload(encrypted, "SafariVault2026!");
      providers.importKeysBundle(decrypted);
      return providers.getApiKey("groq") === "gsk_webkit_e2e_test_1234567890abcdef";
    });
    assert.equal(vaultOk, true, "WebCrypto AES-GCM 256 debe funcionar sin errores en WebKit");

    assert.deepEqual(pageErrors, [], `Errores JS detectados en WebKit: ${pageErrors.join("; ")}`);
  });
});
