import "./setup.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  findBestHtmlEntrypoint,
  findTargetHtmlFile,
  bundleHtmlWithFolderAssets,
  buildStandaloneJsPreview,
  buildStandalonePythonPreview,
  buildMarkdownPreview
} from "../js/preview/htmlBundler.js";

import { KeyboardRouter } from "../js/ui/keyboardRouter.js";
import { decodeImportedFile, uint8ArrayToBase64, SUPPORTED_BINARY_ASSET_EXTENSIONS } from "../js/storage/fileImport.js";
import { broadcastWorkspaceChange } from "../js/storage/workspaceDb.js";
import { createGitBlob } from "../js/github/githubService.js";

describe("Nuevas Funcionalidades y Refactorizaciones de Auditoría", () => {
  describe("1. Desacoplamiento de htmlBundler.js", () => {
    test("findBestHtmlEntrypoint resuelve entrypoint HTML adecuado", () => {
      const files = [
        { path: "src/index.html", content: "<h1>App</h1>" },
        { path: "src/main.js", content: "console.log('hi');" }
      ];
      const entry = findBestHtmlEntrypoint(files, files[1]);
      assert.ok(entry);
      assert.equal(entry.path, "src/index.html");
    });

    test("findTargetHtmlFile resuelve rutas relativas entre archivos", () => {
      const files = [
        { path: "docs/index.html", content: '<a href="about.html">About</a>' },
        { path: "docs/about.html", content: "<h1>About</h1>" }
      ];
      const target = findTargetHtmlFile(files, "docs/index.html", "about.html");
      assert.ok(target);
      assert.equal(target.path, "docs/about.html");
    });

    test("bundleHtmlWithFolderAssets incrusta CSS y JS relativos", () => {
      const fileMap = new Map();
      fileMap.set("style.css", { path: "style.css", content: "body { color: red; }" });
      fileMap.set("app.js", { path: "app.js", content: "console.log('bundled');" });
      const rawHtml = '<link rel="stylesheet" href="style.css"><script src="app.js"></script>';
      const bundled = bundleHtmlWithFolderAssets("index.html", rawHtml, fileMap);
      assert.ok(bundled.includes("body { color: red; }"));
      assert.ok(bundled.includes("console.log('bundled');"));
    });

    test("buildStandaloneJsPreview genera documento HTML con script e interceptor de consola", () => {
      const jsPreview = buildStandaloneJsPreview({ path: "test.js", content: "console.log('test');" });
      assert.ok(jsPreview.includes("studio-ide-preview"));
      assert.ok(jsPreview.includes("console.log('test');"));
    });

    test("buildStandalonePythonPreview contiene los elementos __py_payload y __py_runner_src", () => {
      const pyPreview = buildStandalonePythonPreview({ path: "main.py", content: "print('python')" });
      assert.ok(pyPreview.includes('id="__py_payload"'));
      assert.ok(pyPreview.includes('id="__py_runner_src"'));
      assert.ok(pyPreview.includes("print('python')"));
    });

    test("buildMarkdownPreview y renderMarkdownDocumentHtml compilan markdown a HTML con estilo", () => {
      const mdHtml = buildMarkdownPreview({ path: "readme.md", content: "# Titulo\n**negrita**" });
      assert.ok(mdHtml.includes("<h1>Titulo</h1>"));
      assert.ok(mdHtml.includes("<strong>negrita</strong>"));
    });
  });

  describe("2. KeyboardRouter Centralizado (Focus Stack)", () => {
    test("pushModal, popModal y getActiveModal administran la pila de modales", () => {
      const router = new KeyboardRouter();
      assert.equal(router.getActiveModal(), null);

      router.pushModal({ id: "modal-1" });
      assert.equal(router.getActiveModal()?.id, "modal-1");

      router.pushModal({ id: "modal-2" });
      assert.equal(router.getActiveModal()?.id, "modal-2");

      router.popModal("modal-2");
      assert.equal(router.getActiveModal()?.id, "modal-1");

      router.popModal("modal-1");
      assert.equal(router.getActiveModal(), null);
    });

    test("Escape solo dispara el onEscape del modal superior y detiene la propagación", () => {
      const router = new KeyboardRouter();
      let escapeCount1 = 0;
      let escapeCount2 = 0;
      let propagationStopped = false;

      router.pushModal({ id: "bottom", onEscape: () => { escapeCount1++; } });
      router.pushModal({ id: "top", onEscape: () => { escapeCount2++; } });

      const fakeEvent = {
        key: "Escape",
        preventDefault: () => {},
        stopImmediatePropagation: () => { propagationStopped = true; }
      };

      router.handleKeyDown(fakeEvent);

      assert.equal(escapeCount2, 1, "El modal superior debe recibir el evento");
      assert.equal(escapeCount1, 0, "El modal inferior NO debe recibir el evento");
      assert.equal(propagationStopped, true, "stopImmediatePropagation debe ser invocado");
      assert.equal(router.getActiveModal()?.id, "bottom", "El modal superior debe desapilarse");
    });

    test("Enter dispara el handler onEnter del modal superior", () => {
      const router = new KeyboardRouter();
      let enterFired = false;
      router.pushModal({
        id: "confirm",
        onEnter: () => { enterFired = true; return true; }
      });

      let stopProp = false;
      const fakeEvent = {
        key: "Enter",
        stopImmediatePropagation: () => { stopProp = true; }
      };

      router.handleKeyDown(fakeEvent);
      assert.equal(enterFired, true);
      assert.equal(stopProp, true);
    });
  });

  describe("3. Sincronización Multi-Pestaña con BroadcastChannel", () => {
    test("broadcastWorkspaceChange y onWorkspaceBroadcast transmiten y reciben eventos entre instancias", async () => {
      const otherTabChannel = new BroadcastChannel("studio_ide_workspace_sync");
      otherTabChannel.unref?.();

      const testPayload = { action: "update_content", projectId: "p1", path: "test.js" };

      await new Promise((resolve) => {
        otherTabChannel.addEventListener("message", (ev) => {
          assert.equal(ev.data.action, "update_content");
          assert.equal(ev.data.projectId, "p1");
          assert.equal(ev.data.path, "test.js");
          otherTabChannel.close();
          resolve();
        });
        broadcastWorkspaceChange(testPayload);
      });
    });
  });

  describe("4. Importación y Soporte de Activos Binarios (Imágenes y PDFs)", () => {
    test("uint8ArrayToBase64 codifica correctamente un buffer binario", () => {
      const raw = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const b64 = uint8ArrayToBase64(raw);
      assert.equal(b64, "SGVsbG8=");
    });

    test("decodeImportedFile admite allowBinaryAssets para extensiones multimedia soportadas", () => {
      assert.ok(SUPPORTED_BINARY_ASSET_EXTENSIONS.has("png"));
      assert.ok(SUPPORTED_BINARY_ASSET_EXTENSIONS.has("jpg"));
      assert.ok(SUPPORTED_BINARY_ASSET_EXTENSIONS.has("pdf"));

      const pngFakeBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      // Con allowBinaryAssets: false (por defecto) se rechaza como archivo no editable
      const rejected = decodeImportedFile(pngFakeBytes, "foto.png");
      assert.equal(rejected.ok, false);

      // Con allowBinaryAssets: true se acepta con bandera isBinary y contenido base64
      const accepted = decodeImportedFile(pngFakeBytes, "foto.png", { allowBinaryAssets: true });
      assert.equal(accepted.ok, true);
      assert.equal(accepted.isBinary, true);
      assert.ok(accepted.base64);
    });

    test("createGitBlob está exportada y lista para interoperar con la API REST de GitHub", () => {
      assert.equal(typeof createGitBlob, "function");
    });
  });

  describe("5. Temas de Color (Dracula, Nord, Monokai) en tokens.css", () => {
    test("tokens.css define los selectores [data-theme=dracula], [data-theme=nord] y [data-theme=monokai]", async () => {
      const cssContent = await fs.readFile(new URL("../css/tokens.css", import.meta.url), "utf-8");
      assert.ok(cssContent.includes('[data-theme="dracula"]'));
      assert.ok(cssContent.includes('[data-theme="nord"]'));
      assert.ok(cssContent.includes('[data-theme="monokai"]'));
      assert.ok(cssContent.includes("--color-paper"));
      assert.ok(cssContent.includes("--color-accent"));
    });
  });
});
