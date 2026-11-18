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

  test("Render iPadOS táctil, IndexedDB, SW v32, Formateo, Bundler ES Modules en CSP y WebCrypto en WebKit", async () => {
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

    // 1. Verificar Service Worker v32 accesible y sin desborde horizontal en iPad vertical (820x1180)
    const swAssetOk = await page.evaluate(async () => {
      const res = await fetch("./sw.js");
      if (!res.ok) return false;
      const text = await res.text();
      return text.includes("studio-ide-shell-v32");
    });
    assert.equal(swAssetOk, true, "sw.js debe servir studio-ide-shell-v32 en WebKit");

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

    // 4b. Tienda multipágina en WebKit real (iPadOS): clic en <a href>, location.href, catálogo JSON/imágenes y cero Script error
    const samplePngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.evaluate(async (pngB64) => {
      const dbMod = await import("./js/storage/workspaceDb.js");
      await dbMod.upsertEntry("espacio-local", "wk_tienda/img/logo.png", {
        isFolder: false,
        isBinary: true,
        content: "",
        base64: pngB64
      });
      await dbMod.upsertEntry("espacio-local", "wk_tienda/img/productos/zapato.png", {
        isFolder: false,
        isBinary: true,
        content: "",
        base64: pngB64
      });
      await dbMod.upsertEntry("espacio-local", "wk_tienda/img/productos/campera.png", {
        isFolder: false,
        isBinary: true,
        content: "",
        base64: pngB64
      });
      await dbMod.upsertEntry("espacio-local", "wk_tienda/data/productos.json", {
        isFolder: false,
        content: JSON.stringify([
          { name: "Zapato", img: "productos/zapato.png" },
          { name: "Campera", img: "img/productos/campera.png" }
        ])
      });
      await dbMod.upsertEntry("espacio-local", "wk_tienda/js/catalogo.js", {
        isFolder: false,
        content:
          'fetch("productos.json").then(function(r){return r.json();}).then(function(items){' +
          'var grid=document.getElementById("catalog-grid");' +
          'grid.innerHTML=items.map(function(p){return "<article><img class=\\"prod-img\\" src=\\""+p.img+"\\" alt=\\""+p.name+"\\"></article>";}).join("");' +
          'console.log("WK_CATALOG_OK", items.length);' +
          '});'
      });
      await dbMod.upsertEntry("espacio-local", "wk_tienda/index.html", {
        isFolder: false,
        content:
          '<!DOCTYPE html><html><head><title>Inicio</title></head><body>' +
          '<header><img id="logo-home" src="img/logo.png"><nav>' +
          '<a id="go-catalog" href="productos.html">Catálogo</a>' +
          '<a id="go-spa-tab" href="productos.html">Tab SPA</a>' +
          '</nav></header><h1 id="home-title">WK_INICIO</h1><div id="spa-msg"></div>' +
          '<script>document.getElementById("go-spa-tab").addEventListener("click",function(e){e.preventDefault();document.getElementById("spa-msg").textContent="SPA_OK";});</script>' +
          '</body></html>'
      });
      await dbMod.upsertEntry("espacio-local", "wk_tienda/productos.html", {
        isFolder: false,
        content:
          '<!DOCTYPE html><html><head><title>Catálogo</title></head><body>' +
          '<header><img id="logo-prod" src="img/logo.png"><nav>' +
          '<a id="go-home-link" href="./">Inicio A</a>' +
          '<button id="go-home-btn" onclick="location.href=\'index.html\'">Inicio Btn</button>' +
          '</nav></header><h1 id="cat-title">WK_CATALOGO</h1><div id="catalog-grid"></div>' +
          '<script src="js/catalogo.js" defer></script></body></html>'
      });
    }, samplePngB64);

    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector(".tree-node-btn", { timeout: 15000 });

    const wkTiendaExpanded = await page.evaluate(() => {
      const folderBtn = document.querySelector('.tree-row[data-path="wk_tienda"] .tree-node-btn');
      if (folderBtn && folderBtn.getAttribute("aria-expanded") === "false") {
        folderBtn.click();
      }
      return Boolean(folderBtn);
    });
    assert.equal(wkTiendaExpanded, true, "Carpeta wk_tienda debe aparecer en el Explorador WebKit");
    await page.waitForTimeout(250);

    const openedWkTienda = await page.evaluate(() => {
      const btn = document.querySelector('.tree-row[data-path="wk_tienda/index.html"] .tree-node-btn');
      if (!btn) return false;
      btn.click();
      return true;
    });
    assert.equal(openedWkTienda, true, "wk_tienda/index.html debe abrirse en WebKit");
    await page.waitForTimeout(350);

    await page.click("#btn-live-preview");
    await page.waitForSelector("#preview-dialog[open]", { timeout: 10000 });
    await page.waitForFunction(
      () => (document.getElementById("preview-file-badge")?.textContent || "").includes("wk_tienda/index.html"),
      null,
      { timeout: 10000 }
    );

    const wkFrame = page.frameLocator("#preview-iframe");
    await wkFrame.locator("#home-title").waitFor({ state: "visible", timeout: 8000 });

    const wkIframeBox = await page.locator("#preview-iframe").boundingBox();
    assert.ok(wkIframeBox && wkIframeBox.height >= 200 && wkIframeBox.width >= 300, `Iframe WebKit colapsado: ${JSON.stringify(wkIframeBox)}`);

    // SPA tab con preventDefault en WebKit
    await wkFrame.locator("#go-spa-tab").click();
    await wkFrame.locator("#spa-msg").waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await wkFrame.locator("#spa-msg").textContent(), "SPA_OK");

    // Ir a catálogo con <a href="productos.html">
    await wkFrame.locator("#go-catalog").click();
    await page.waitForFunction(
      () => (document.getElementById("preview-file-badge")?.textContent || "").includes("wk_tienda/productos.html"),
      null,
      { timeout: 10000 }
    );
    await page.waitForFunction(
      () => (document.getElementById("preview-console-list")?.textContent || "").includes("WK_CATALOG_OK 2"),
      null,
      { timeout: 10000 }
    );
    await wkFrame.locator(".prod-img").first().waitFor({ state: "visible", timeout: 8000 });
    const wkImgsOk = await wkFrame.locator("img").evaluateAll((imgs) =>
      imgs.length === 3 && imgs.every((im) => im.complete && im.naturalWidth > 0)
    );
    assert.equal(wkImgsOk, true, "En WebKit deben cargarse el logo y las 2 imágenes del catálogo");

    // Volver al inicio vía <a href="./">
    await wkFrame.locator("#go-home-link").click();
    await page.waitForFunction(
      () => (document.getElementById("preview-file-badge")?.textContent || "").includes("wk_tienda/index.html"),
      null,
      { timeout: 10000 }
    );
    await wkFrame.locator("#home-title").waitFor({ state: "visible", timeout: 8000 });
    assert.equal(await wkFrame.locator("#btn-live-preview").count(), 0, "Studio IDE no debe cargarse dentro de #preview-iframe en WebKit");

    // Ir a catálogo y volver por button onclick="location.href='index.html'"
    await wkFrame.locator("#go-catalog").click();
    await page.waitForFunction(
      () => (document.getElementById("preview-file-badge")?.textContent || "").includes("wk_tienda/productos.html"),
      null,
      { timeout: 10000 }
    );
    await wkFrame.locator("#go-home-btn").waitFor({ state: "visible", timeout: 8000 });
    await wkFrame.locator("#go-home-btn").click();
    await page.waitForFunction(
      () => (document.getElementById("preview-file-badge")?.textContent || "").includes("wk_tienda/index.html"),
      null,
      { timeout: 10000 }
    );
    await wkFrame.locator("#home-title").waitFor({ state: "visible", timeout: 8000 });

    const wkConsoleErrors = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#preview-console-list .is-error")).map((el) => el.textContent)
    );
    assert.deepEqual(wkConsoleErrors, [], `Consola JS en WebKit reportó errores: ${wkConsoleErrors.join("; ")}`);

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
