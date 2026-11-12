/* global document */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const REAL_ROOT_DIR = fs.realpathSync(ROOT_DIR);
const ROOT_PREFIX = REAL_ROOT_DIR.endsWith(path.sep) ? REAL_ROOT_DIR : REAL_ROOT_DIR + path.sep;
const OUT_DIR = path.join(ROOT_DIR, "docs", "screenshots");

const puppeteerModulePath = path.join(
  ROOT_DIR,
  "tests",
  "node_modules",
  "puppeteer-core",
  "lib",
  "puppeteer",
  "puppeteer-core.js"
);
const { default: puppeteer } = await import(pathToFileURL(puppeteerModulePath).href);

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
  const envCandidates = [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH].filter(Boolean);
  for (const candidate of envCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const platformCandidates = {
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ],
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium"
    ]
  };

  for (const candidate of platformCandidates[process.platform] || []) {
    if (fs.existsSync(candidate)) return candidate;
  }

  if (process.platform !== "win32") {
    for (const bin of ["google-chrome", "chromium-browser", "chromium"]) {
      try {
        const resolved = execFileSync("which", [bin], { encoding: "utf8" }).trim();
        if (resolved && fs.existsSync(resolved)) return resolved;
      } catch {
        // Probar siguiente candidato en PATH
      }
    }
  }

  throw new Error(
    "No se encontró Chrome, Chromium ni Edge. Definí CHROME_PATH o PUPPETEER_EXECUTABLE_PATH."
  );
}

let server = null;
let browser = null;
let tempUserDataDir = null;

try {
  server = http.createServer((req, res) => {
    let decodedPath;
    try {
      decodedPath = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    const relativePath = decodedPath.replace(/^\/+/, "") || "index.html";
    let filePath = path.resolve(REAL_ROOT_DIR, relativePath);

    if (filePath !== REAL_ROOT_DIR && !filePath.startsWith(ROOT_PREFIX)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    let stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      if (!filePath.startsWith(ROOT_PREFIX) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      stat = fs.statSync(filePath);
    }

    const realFilePath = fs.realpathSync(filePath);
    if (realFilePath !== REAL_ROOT_DIR && !realFilePath.startsWith(ROOT_PREFIX)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(realFilePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache"
    });
    fs.createReadStream(realFilePath).pipe(res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8088, "127.0.0.1", resolve);
  });
  console.log("Local HTTP server running at http://127.0.0.1:8088");

  const executablePath = findBrowserExecutable();
  console.log("Launching browser from:", executablePath);

  tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ide-chrome-"));

  const launchArgs = [
    ...(process.platform === "linux" ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--window-size=1280,820"
  ];

  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: tempUserDataDir,
    args: launchArgs
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 });

  console.log("Navigating to Studio IDE...");
  await page.goto("http://127.0.0.1:8088/index.html", { waitUntil: "networkidle0", timeout: 15000 });

  await page.waitForSelector(".ide-workspace", { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 2500));

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const clickEntryByExtension = async (extensions) =>
    page.evaluate((exts) => {
      const candidates = Array.from(
        document.querySelectorAll("#file-tree .tree-node-btn, #editor-tabs .editor-tab-trigger")
      );
      const match = candidates.find((el) => {
        const nameEl = el.querySelector(".file-tree-name") || el;
        const label = (nameEl.textContent || "").trim().toLowerCase();
        return exts.some((ext) => label.endsWith(ext));
      });
      if (!match) return false;
      match.click();
      return true;
    }, extensions);

  // 1. CAPTURE MAIN OVERVIEW
  console.log("Capturing 01-studio-ide-overview.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "01-studio-ide-overview.png") });

  // 2. CAPTURE LIVE PREVIEW (WEB)
  console.log("Opening web preview...");
  await clickEntryByExtension([".html"]);
  await new Promise((r) => setTimeout(r, 800));

  await page.click("#btn-live-preview");
  await page.waitForSelector("#preview-dialog[open]", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 2500));

  console.log("Capturing 02-live-preview-responsive.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "02-live-preview-responsive.png") });

  await page.click("#btn-close-preview");
  await new Promise((r) => setTimeout(r, 800));

  // 3. CAPTURE C/C++ RUNNER PREVIEW
  console.log("Opening C/C++ runner preview...");
  await clickEntryByExtension([".cpp", ".c"]);
  await new Promise((r) => setTimeout(r, 800));

  await page.click("#btn-live-preview");
  await page.waitForSelector("#preview-dialog[open]", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 2500));

  console.log("Capturing 03-c-runner-interactive.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "03-c-runner-interactive.png") });

  await page.click("#btn-close-preview");
  await new Promise((r) => setTimeout(r, 800));

  // 4. CAPTURE AI ASSISTANT IN ACTION
  console.log("Preparing AI Assistant chat panel...");
  await page.evaluate(() => {
    const chatInput = document.getElementById("chat-prompt-input");
    if (chatInput) {
      chatInput.value = "¿Podrías optimizar este código en C++ para que use memoria dinámica eficientemente?";
      chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await new Promise((r) => setTimeout(r, 800));

  console.log("Capturing 04-ai-assistant.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "04-ai-assistant.png") });

  // 5. CAPTURE GITHUB DIALOG
  console.log("Opening GitHub dialog...");
  await page.click("#btn-open-github");
  await page.waitForSelector("#github-dialog[open]", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 1200));

  console.log("Capturing 05-github-branches-sync.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "05-github-branches-sync.png") });

  await page.click("#btn-close-github");
  await new Promise((r) => setTimeout(r, 800));

  // 6. CAPTURE QUICK OPEN PALETTE (Cmd+P)
  console.log("Opening Quick Open palette...");
  await page.click("#btn-quick-open");
  await page.waitForSelector("#quick-open-dialog[open]", { timeout: 8000 });
  await page.evaluate(() => {
    const input = document.getElementById("quick-open-input");
    if (input) {
      input.value = ":15";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await new Promise((r) => setTimeout(r, 800));

  console.log("Capturing 06-quick-open.png...");
  await page.screenshot({ path: path.join(OUT_DIR, "06-quick-open.png") });

  await page.click("#btn-close-quick-open").catch(() => undefined);

  console.log("All real browser screenshots captured successfully!");
} catch (err) {
  console.error("Error capturing screenshots:", err);
  process.exitCode = 1;
} finally {
  if (browser) {
    await browser.close().catch(() => undefined);
  }
  if (server) {
    server.close();
  }
  if (tempUserDataDir) {
    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true });
    } catch {
      // Ignorar limpieza residual en Windows si Chrome aún libera handles
    }
  }
}
