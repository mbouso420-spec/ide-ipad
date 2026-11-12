import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

describe("Studio IDE — Pruebas E2E Reales en Navegador (Chromium/Edge)", () => {
  let server;
  let baseUrl;
  let browser;
  let tempUserDataDir;

  before(async () => {
    const executablePath = findBrowserExecutable();
    assert.ok(executablePath, "No se encontró ningún ejecutable Chrome/Chromium/Edge en el sistema.");

    server = http.createServer((req, res) => {
      const cleanUrl = (req.url || "/").split("?")[0];
      const relPath = cleanUrl === "/" ? "index.html" : decodeURIComponent(cleanUrl.replace(/^\/+/, ""));
      const resolved = path.resolve(ROOT_DIR, relPath);
      if (!resolved.startsWith(ROOT_DIR)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      if (!fs.existsSync(resolved)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const stat = fs.statSync(resolved);
      const target = stat.isDirectory() ? path.join(resolved, "index.html") : resolved;
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-cache"
      });
      fs.createReadStream(target).pipe(res);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const puppeteerPath = path.join(
      ROOT_DIR,
      "tests",
      "node_modules",
      "puppeteer-core",
      "lib",
      "puppeteer",
      "puppeteer-core.js"
    );
    const { default: puppeteer } = await import(pathToFileURL(puppeteerPath).href);

    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ide-e2e-"));
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      userDataDir: tempUserDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--window-size=1280,820"
      ]
    });
  });

  after(async () => {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (tempUserDataDir && fs.existsSync(tempUserDataDir)) {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true });
    }
  });

  test("Arranque sin errores, IndexedDB, Service Worker, Formateo + Recarga, TS/JSX Offline + REPL y Bóveda AES-GCM", async () => {
    const page = await browser.newPage();
    const pageErrors = [];
    const coldBootRequests = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    const onColdRequest = (req) => coldBootRequests.push(req.url());
    page.on("request", onColdRequest);

    await page.setViewport({ width: 1280, height: 820 });
    await page.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded", timeout: 15000 });

    // 1. Verificar arranque completo y semilla inicial en Explorador + Editor
    await page.waitForSelector(".editor-tab-item", { timeout: 20000 });
    await page.waitForSelector(".tree-node-btn", { timeout: 15000 });
    page.off("request", onColdRequest);

    const eagerHeavyDownloads = coldBootRequests.filter((url) =>
      /pyodide|sql\.js|sql-wasm|wandbox|typescript/i.test(url)
    );
    assert.deepEqual(
      eagerHeavyDownloads,
      [],
      "En arranque frío no debe descargarse ningún runtime pesado (Pyodide/SQLite/tsc)"
    );

    // Verificar sw.js accesible, versión v29 y API de Cache Storage activa en localhost
    const swAssetOk = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator) || !("caches" in window)) return false;
      const res = await fetch("./sw.js");
      if (!res.ok) return false;
      const text = await res.text();
      return text.includes("studio-ide-shell-v29");
    });
    assert.equal(swAssetOk, true, "sw.js debe responder HTTP 200 con studio-ide-shell-v29");

    // 2. Crear archivos E2E vía IndexedDB, recargar, abrir desde árbol, formatear y comprobar persistencia
    await page.evaluate(async () => {
      const dbMod = await import("./js/storage/workspaceDb.js");
      await dbMod.upsertEntry("espacio-local", "e2e_demo.tsx", {
        isFolder: false,
        content:
          "const titulo: string = 'E2E TSX OK';\nconst Card = ({ txt }: { txt: string }) => <div className='card'><span>{txt}</span></div>;\nconst node = <Card txt={titulo} />;\nconsole.log(titulo, node.tagName);"
      });
      await dbMod.upsertEntry("espacio-local", "e2e_fmt.js", {
        isFolder: false,
        content: "function suma(a,b){\nreturn a+b;\n}"
      });
    });

    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForSelector(".tree-node-btn", { timeout: 15000 });

    // Abrir e2e_fmt.js desde el árbol
    const clickedFmt = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".tree-node-btn"));
      const target = items.find((el) => (el.textContent || "").includes("e2e_fmt.js"));
      if (!target) return false;
      target.click();
      return true;
    });
    assert.equal(clickedFmt, true, "e2e_fmt.js debe aparecer en el Explorador");
    await new Promise((r) => setTimeout(r, 400));

    // Formatear con botón #btn-editor-format y esperar autoguardado IndexedDB
    await page.click("#btn-editor-format");
    await new Promise((r) => setTimeout(r, 600));

    const formattedContent = await page.evaluate(async () => {
      const dbMod = await import("./js/storage/workspaceDb.js");
      const entries = await dbMod.getProjectEntries("espacio-local");
      return entries.find((e) => e.path === "e2e_fmt.js")?.content || "";
    });
    assert.equal(formattedContent, "function suma(a,b){\n  return a+b;\n}\n");

    // Probar Deshacer (#btn-editor-undo) después de formatear en editor real
    await page.click("#btn-editor-undo");
    await new Promise((r) => setTimeout(r, 450));
    const revertedContent = await page.evaluate(async () => {
      const dbMod = await import("./js/storage/workspaceDb.js");
      const entries = await dbMod.getProjectEntries("espacio-local");
      return entries.find((e) => e.path === "e2e_fmt.js")?.content || "";
    });
    assert.equal(revertedContent, "function suma(a,b){\nreturn a+b;\n}");

    // 3. Abrir e2e_demo.tsx, iniciar Live Preview offline y ejecutar expresión en el Mini-REPL
    const clickedTsx = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".tree-node-btn"));
      const target = items.find((el) => (el.textContent || "").includes("e2e_demo.tsx"));
      if (!target) return false;
      target.click();
      return true;
    });
    assert.equal(clickedTsx, true, "e2e_demo.tsx debe abrirse desde el Explorador");
    await new Promise((r) => setTimeout(r, 400));

    await page.click("#btn-live-preview");
    await page.waitForSelector("#preview-dialog[open]", { timeout: 10000 });
    await page.waitForFunction(
      () => {
        const list = document.getElementById("preview-console-list");
        return list && (list.textContent || "").includes("E2E TSX OK");
      },
      { timeout: 12000 }
    );

    const previewConsoleText = await page.evaluate(
      () => document.getElementById("preview-console-list")?.textContent || ""
    );
    assert.match(previewConsoleText, /E2E TSX OK DIV/);

    // Probar Mini-REPL enviando expresión real al iframe
    await page.type("#preview-repl-input", "20 + 22");
    await page.click("#btn-preview-repl-run");
    await page.waitForFunction(
      () => (document.getElementById("preview-console-list")?.textContent || "").includes("42"),
      { timeout: 8000 }
    );

    await page.click("#btn-close-preview");
    await new Promise((r) => setTimeout(r, 300));

    // 3b. Multi-archivo ES Modules (.ts/.json/.css) en Live Preview sin blob: ni errores CSP
    await page.evaluate(async () => {
      const dbMod = await import("./js/storage/workspaceDb.js");
      await dbMod.upsertEntry("espacio-local", "mod_e2e/cfg.json", {
        isFolder: false,
        content: '{"brand":"StudioWeb"}'
      });
      await dbMod.upsertEntry("espacio-local", "mod_e2e/styles.css", {
        isFolder: false,
        content: ".e2e-banner { color: rgb(16, 185, 129); }"
      });
      await dbMod.upsertEntry("espacio-local", "mod_e2e/util.ts", {
        isFolder: false,
        content: 'export const SCALE = 3;\nexport default function mkTag(s: string) { return "[" + s + "]"; }'
      });
      await dbMod.upsertEntry("espacio-local", "mod_e2e/entry.ts", {
        isFolder: false,
        content:
          'import mkTag, { SCALE } from "./util.js";\nimport cfg from "./cfg.json";\nimport "./styles.css";\nconst el = document.createElement("div");\nel.className = "e2e-banner";\nel.textContent = mkTag(cfg.brand) + ":" + (SCALE * 4);\ndocument.body.appendChild(el);\nconsole.log("MULTI_MOD_OK", el.textContent, getComputedStyle(el).color);'
      });
    });

    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForSelector(".tree-node-btn", { timeout: 15000 });

    const modFolderPresent = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll(".tree-node-btn")).find((el) =>
        (el.textContent || "").includes("mod_e2e")
      );
      if (btn && btn.getAttribute("aria-expanded") === "false") {
        btn.click();
      }
      return Boolean(btn);
    });
    assert.equal(modFolderPresent, true, "Carpeta mod_e2e debe aparecer en el Explorador");
    await new Promise((r) => setTimeout(r, 300));

    const clickedEntryTs = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll(".tree-node-btn")).find((el) =>
        (el.textContent || "").includes("entry.ts")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    assert.equal(clickedEntryTs, true, "mod_e2e/entry.ts debe abrirse en el Explorador");
    await new Promise((r) => setTimeout(r, 400));

    await page.click("#btn-live-preview");
    await page.waitForSelector("#preview-dialog[open]", { timeout: 10000 });
    await page.waitForFunction(
      () => (document.getElementById("preview-console-list")?.textContent || "").includes("MULTI_MOD_OK"),
      { timeout: 12000 }
    );
    const multiConsoleText = await page.evaluate(
      () => document.getElementById("preview-console-list")?.textContent || ""
    );
    assert.match(multiConsoleText, /MULTI_MOD_OK \[StudioWeb\]:12 rgb\(16, 185, 129\)/);
    await page.click("#btn-close-preview");
    await new Promise((r) => setTimeout(r, 300));

    // Ahora agregar HTML con <script type="module" src="./dom_entry.ts"> en <head> y verificar disponibilidad DOM
    await page.evaluate(async () => {
      const dbMod = await import("./js/storage/workspaceDb.js");
      await dbMod.upsertEntry("espacio-local", "mod_e2e/app.html", {
        isFolder: false,
        content:
          '<!DOCTYPE html><html><head><script type="module" src="./dom_entry.ts"></script></head><body><div id="mount-box">DOM_READY</div></body></html>'
      });
      await dbMod.upsertEntry("espacio-local", "mod_e2e/dom_entry.ts", {
        isFolder: false,
        content:
          'import mkTag from "./util";\nconst txt = document.getElementById("mount-box")?.textContent || "MISS";\nconsole.log("HTML_MOD_OK", mkTag(txt));'
      });
    });

    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForSelector(".tree-node-btn", { timeout: 15000 });

    const clickedAppHtml = await page.evaluate(() => {
      const folderBtn = Array.from(document.querySelectorAll(".tree-node-btn")).find((el) =>
        (el.textContent || "").includes("mod_e2e")
      );
      if (folderBtn && folderBtn.getAttribute("aria-expanded") === "false") {
        folderBtn.click();
      }
      const btn = Array.from(document.querySelectorAll(".tree-node-btn")).find((el) =>
        (el.textContent || "").includes("app.html")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    assert.equal(clickedAppHtml, true, "mod_e2e/app.html debe abrirse en el Explorador");
    await new Promise((r) => setTimeout(r, 400));

    await page.click("#btn-live-preview");
    await page.waitForSelector("#preview-dialog[open]", { timeout: 10000 });
    await page.waitForFunction(
      () => (document.getElementById("preview-console-list")?.textContent || "").includes("HTML_MOD_OK"),
      { timeout: 12000 }
    );
    const htmlModConsole = await page.evaluate(
      () => document.getElementById("preview-console-list")?.textContent || ""
    );
    assert.match(htmlModConsole, /HTML_MOD_OK \[DOM_READY\]/);
    await page.click("#btn-close-preview");
    await new Promise((r) => setTimeout(r, 300));

    // 4. Bóveda Cifrada AES-GCM 256 en el navegador real (Settings -> Almacenamiento)
    const vaultRoundTripOk = await page.evaluate(async () => {
      const providers = await import("./js/ai/providers.js");
      const cryptoMod = await import("./js/security/keyVaultCrypto.js");
      providers.saveApiKey("gemini", "AIzaSyBrowserE2EVaultKey1234567890");
      const bundle = providers.exportKeysBundle();
      const encrypted = await cryptoMod.encryptKeysPayload(bundle, "PassBrowser99!", { iterations: 20000 });
      providers.clearApiKey("gemini");
      let rejectedWrong = false;
      try {
        await cryptoMod.decryptKeysPayload(encrypted, "WrongPass99!");
      } catch (_) {
        rejectedWrong = true;
      }
      const decrypted = await cryptoMod.decryptKeysPayload(encrypted, "PassBrowser99!");
      providers.importKeysBundle(decrypted);
      return rejectedWrong && providers.getApiKey("gemini") === "AIzaSyBrowserE2EVaultKey1234567890";
    });
    assert.equal(vaultRoundTripOk, true, "Web Crypto AES-GCM debe funcionar en navegador real");

    // Abrir diálogo de Configuración -> pestaña Almacenamiento y comprobar UI de bóveda
    await page.click("#btn-open-settings");
    await page.waitForSelector("#settings-dialog[open]", { timeout: 5000 });
    await page.click('.settings-tab-btn[data-tab="storage"]');
    await page.waitForSelector("#vault-passphrase-input", { visible: true, timeout: 5000 });
    await page.type("#vault-passphrase-input", "123");
    await page.click("#btn-export-keys-encrypted");
    await page.waitForFunction(
      () => (document.getElementById("vault-transfer-status")?.textContent || "").includes("al menos 6 caracteres"),
      { timeout: 5000 }
    );
    await page.click("#btn-close-settings");
    await new Promise((r) => setTimeout(r, 200));

    // 5. Probar rotación responsive iPadOS (820x1180 <-> 1180x820) sin desbordes ni errores
    await page.setViewport({ width: 820, height: 1180 });
    await new Promise((r) => setTimeout(r, 250));
    const portraitOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    assert.equal(portraitOverflow, false, "No debe haber desborde horizontal en iPad vertical (820px)");
    await page.setViewport({ width: 1180, height: 820 });
    await new Promise((r) => setTimeout(r, 250));
    const landscapeOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    assert.equal(landscapeOverflow, false, "No debe haber desborde horizontal en iPad horizontal (1180px)");

    assert.deepEqual(pageErrors, [], `Se detectaron errores JS en navegador: ${pageErrors.join("; ")}`);
  });
});
