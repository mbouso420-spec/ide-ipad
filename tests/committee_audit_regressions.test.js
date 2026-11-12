import "./setup.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as domUtils from "../js/utils/dom.js";
import * as previewUtils from "../js/preview/previewUtils.js";
import * as cRunner from "../js/preview/cRunner.js";
import * as credentialGuard from "../js/security/credentialGuard.js";
import {
  buildStandaloneImagePreview,
  buildWorkspaceAssetMap,
  bundleHtmlWithFolderAssets
} from "../js/preview/htmlBundler.js";
import { renderMarkdownDocumentHtml } from "../js/preview/markdownPreview.js";
import { createBinaryPreview, sanitizeSvgMarkup } from "../js/ui/binaryPreview.js";
import { initDiffModal } from "../js/ui/diffModal.js";
import { initLivePreviewModal } from "../js/ui/livePreviewModal.js";
import { initSymbolBar } from "../js/ui/symbolBar.js";
import { initGithubController } from "../js/github/githubController.js";
import { createGithubLazySync } from "../js/workspace/githubLazySync.js";
import {
  decryptKeysPayload,
  encryptKeysPayload,
  MAX_PASSPHRASE_LENGTH,
  MAX_VAULT_JSON_BYTES
} from "../js/security/keyVaultCrypto.js";
import { MAX_IMPORT_FILE_BYTES } from "../js/storage/fileImport.js";
import { downloadZip } from "../js/storage/zipExporter.js";

const ROOT = resolve(import.meta.dirname, "..");

describe("Auditoría Comité Multi-Agente — AppSec, Higiene, Ciclo de Vida y Soak", () => {
  test("Agent 1: código muerto eliminado y utilidades compartidas sin duplicación", () => {
    assert.equal(Object.hasOwn(cRunner, "buildCRunnerPreview"), false);
    assert.equal(Object.hasOwn(cRunner, "CPP_HEADER_EXTENSIONS"), false);
    assert.equal(Object.hasOwn(cRunner, "C_SOURCE_EXTENSIONS"), false);
    assert.equal(Object.hasOwn(credentialGuard, "clearRejectedTokenFromSession"), false);
    assert.strictEqual(previewUtils.escapeHtml, domUtils.escapeHtml);

    const zipSrc = readFileSync(resolve(ROOT, "js/storage/zipExporter.js"), "utf8");
    assert.equal(/downloadBlob\(/.test(zipSrc), true);
    assert.equal(/\\\/\//.test(zipSrc), false);
  });

  test("Agent 2: buildStandaloneImagePreview y bundleHtmlWithFolderAssets bloquean inyección en extensión y Base64 corrupto", () => {
    const xssImage = {
      path: 'assets/evil.<img src=x onerror=alert(1)>',
      shortName: 'evil.<img src=x onerror=alert(1)>',
      isBinary: true,
      base64: 'Zm9v" onerror="alert(1)'
    };
    const standaloneHtml = buildStandaloneImagePreview(xssImage);
    assert.equal(standaloneHtml.includes('<span class="badge"><img'), false);
    assert.equal(standaloneHtml.includes('Zm9v" onerror='), false);
    assert.equal(standaloneHtml.includes("Esta imagen está vacía o no contiene datos binarios válidos."), true);

    const validImage = {
      path: "assets/logo.png",
      shortName: "logo.png",
      isBinary: true,
      base64: "iVBORw0KGgo="
    };
    const validStandalone = buildStandaloneImagePreview(validImage);
    assert.equal(validStandalone.includes('src="data:image/png;base64,iVBORw0KGgo="'), true);

    const assetMap = buildWorkspaceAssetMap([
      {
        path: "img/bad.png",
        shortName: "bad.png",
        isBinary: true,
        base64: 'AAA") ; }</style><script>alert(1)</script>'
      },
      {
        path: "img/ok.png",
        shortName: "ok.png",
        isBinary: true,
        base64: "AAAA"
      }
    ]);
    const bundled = bundleHtmlWithFolderAssets(
      "index.html",
      '<style>.a{background:url(img/bad.png)}.b{background:url(img/ok.png)}</style><img src="img/bad.png"><img src="img/ok.png">',
      assetMap
    );
    assert.equal(bundled.includes("<script>alert(1)</script>"), false);
    assert.equal(bundled.includes('url("data:image/png;base64,AAAA")'), true);
    assert.equal(bundled.includes('<img src="data:image/png;base64,AAAA">'), true);
  });

  test("Agent 2: renderMarkdownDocumentHtml soporta '&' en títulos y bloquea esquemas inseguros en imágenes", () => {
    const assetMap = buildWorkspaceAssetMap([
      {
        path: "docs/diagram.png",
        shortName: "diagram.png",
        isBinary: true,
        base64: "iVBORw0KGgo="
      }
    ]);
    const md = [
      '![Diagrama & Info](docs/diagram.png "Arquitectura & Flujo")',
      '![XSS1](javascript:alert(1))',
      '![XSS2](vbscript:msgbox(1))',
      '![XSS3](data:text/html,<script>alert(1)</script>)',
      '![Safe](https://example.com/foto.png "R&D")'
    ].join("\n\n");

    const rendered = renderMarkdownDocumentHtml(md, { assetMap, baseDir: "" });
    assert.equal(rendered.includes('src="data:image/png;base64,iVBORw0KGgo="'), true);
    assert.equal(rendered.includes('alt="Diagrama &amp; Info"'), true);
    assert.equal(rendered.includes('title="Arquitectura &amp; Flujo"'), true);
    assert.equal(rendered.includes('&amp;amp;'), false);
    assert.equal(rendered.includes('title="R&amp;D"'), true);
    assert.equal(rendered.includes("javascript:"), false);
    assert.equal(rendered.includes("vbscript:"), false);
    assert.equal(rendered.includes("data:text/html"), false);
  });

  test("Agent 2: sanitizeSvgMarkup neutraliza <svg/onload=...>, <animate>, <set> y URIs peligrosas", () => {
    const dirtySvg =
      '<svg/onload="alert(1)"><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onmouseover"/><foreignObject><script>alert(2)</script></foreignObject><a xlink:href="data:image/svg+xml,<svg/>"><circle cx="5" cy="5" r="4"/></a></svg>';
    const cleaned = sanitizeSvgMarkup(dirtySvg);
    assert.ok(cleaned);
    assert.equal(/onload/i.test(cleaned), false);
    assert.equal(/<animate\b/i.test(cleaned), false);
    assert.equal(/<set\b/i.test(cleaned), false);
    assert.equal(/<foreignObject/i.test(cleaned), false);
    assert.equal(/<script/i.test(cleaned), false);
    assert.equal(/data:image\/svg\+xml/i.test(cleaned), false);
    assert.equal(cleaned.includes("<circle"), true);
  });

  test("Agent 2: keyVaultCrypto impone límites superiores de passphrase y tamaño JSON antes de cifrar/descifrar", async () => {
    const oversizedPass = "a".repeat(MAX_PASSPHRASE_LENGTH + 1);
    await assert.rejects(
      () => encryptKeysPayload('{"gemini":"AIzaTest123456"}', oversizedPass),
      /no puede superar/i
    );

    const oversizedPayload = JSON.stringify({ big: "x".repeat(MAX_VAULT_JSON_BYTES + 64) });
    await assert.rejects(
      () => encryptKeysPayload(oversizedPayload, "claveSegura123"),
      /tamaño máximo/i
    );
    await assert.rejects(
      () => decryptKeysPayload(oversizedPayload, oversizedPass),
      /tamaño máximo|no puede superar/i
    );
  });

  test("Agent 2 & 3: binaryPreview rechaza imágenes > 5MB, HTML disfrazado de PNG/SVG y limpia listeners en destroy()", () => {
    const addedSignals = [];
    const origWindowAdd = globalThis.window.addEventListener;
    globalThis.window.addEventListener = (type, fn, opts) => {
      if (type === "paste" && opts?.signal) {
        addedSignals.push(opts.signal);
      }
      return origWindowAdd?.call(globalThis.window, type, fn, opts);
    };

    try {
      const mount = document.createElement("div");
      const updatedCalls = [];
      const preview = createBinaryPreview({
        binaryPreviewEl: mount,
        onDownloadFile: () => {},
        onUpdateFileContent: async (f, data) => updatedCalls.push({ f, data })
      });

      const activePng = {
        path: "assets/photo.png",
        shortName: "photo.png",
        isBinary: true,
        base64: "AAAA"
      };
      preview.render(activePng);

      const fileInput = mount.querySelector("input");
      assert.ok(fileInput);

      // Archivo > 5 MB
      fileInput.files = [
        {
          size: MAX_IMPORT_FILE_BYTES + 1,
          name: "huge.png"
        }
      ];
      fileInput.dispatchEvent({ type: "change" });
      const errBanner = mount.querySelector(".editor-binary-error");
      assert.ok(errBanner);
      assert.match(errBanner.textContent, /5 MB/);
      assert.equal(updatedCalls.length, 0);

      // HTML disfrazado subido sobre archivo .svg con FileReader simulado de entorno Node
      const OrigFileReader = globalThis.FileReader;
      globalThis.FileReader = class MockReader {
        readAsText() {
          this.result = "<!DOCTYPE html><html><body><script>alert(1)</script></body></html>";
          this.onload?.();
        }
        readAsDataURL() {
          this.result = "data:image/png;base64," + Buffer.from("<!DOCTYPE html><html>").toString("base64");
          this.onload?.();
        }
      };
      try {
        preview.render({ path: "assets/icon.svg", shortName: "icon.svg", content: "<svg></svg>" });
        const svgInput = mount.querySelector("input");
        svgInput.files = [{ size: 120, name: "evil.svg" }];
        svgInput.dispatchEvent({ type: "change" });
        const svgErr = mount.querySelector(".editor-binary-error");
        assert.ok(svgErr);
        assert.match(svgErr.textContent, /HTML disfrazado/i);

        preview.render(activePng);
        const pngInput = mount.querySelector("input");
        pngInput.files = [{ size: 120, name: "evil.png" }];
        pngInput.dispatchEvent({ type: "change" });
        const pngErr = mount.querySelector(".editor-binary-error");
        assert.ok(pngErr);
        assert.match(pngErr.textContent, /marcado HTML\/SVG\/script disfrazado/i);
        assert.equal(updatedCalls.length, 0);
      } finally {
        globalThis.FileReader = OrigFileReader;
      }

      assert.equal(addedSignals.length, 1);
      assert.equal(addedSignals[0].aborted, false);
      preview.destroy();
      assert.equal(addedSignals[0].aborted, true);
    } finally {
      globalThis.window.addEventListener = origWindowAdd;
    }
  });

  test("Agent 3: createGithubLazySync.preloadForPreview precarga imágenes activas e imágenes de HTML/Markdown", async () => {
    const activeProject = {
      id: "gh-owner-repo",
      kind: "github",
      github: { owner: "owner", repo: "repo", branch: "main" }
    };
    const pngFile = {
      id: "assets/hero.png",
      path: "assets/hero.png",
      shortName: "hero.png",
      lang: "binary",
      isBinary: true,
      contentLoaded: false,
      blobSha: "sha-png-1"
    };
    const htmlFile = {
      id: "index.html",
      path: "index.html",
      shortName: "index.html",
      lang: "html",
      isBinary: false,
      contentLoaded: true,
      content: '<img src="assets/hero.png">'
    };

    const fetchedSingle = [];
    const fetchedBatch = [];
    const lazySync = createGithubLazySync({
      getActiveProject: () => activeProject,
      setProjects: () => {},
      getTreeEntries: () => [htmlFile, pngFile],
      setTreeEntries: () => {},
      getFilesOnly: () => [htmlFile, pngFile],
      setFilesOnly: () => {},
      getOpenTabIds: () => ["index.html"],
      setOpenTabIds: () => {},
      getActiveFileId: () => "index.html",
      setActiveFileId: () => {},
      persistTabsState: async () => {},
      renderWorkspaceView: () => {},
      renderTabs: () => {},
      explorer: { setOfflineRepoState: () => {}, setAutosaveStatus: () => {} },
      editor: {},
      getSplitController: () => null,
      cacheAndSyncGithubFileFn: async ({ fileObj, remotePayload }) => {
        fileObj.contentLoaded = true;
        fileObj.base64 = remotePayload?.base64 || null;
        return { deleted: false };
      },
      getGithubToken: () => "",
      fetchSingleRepoBlob: async ({ blobSha }) => {
        fetchedSingle.push(blobSha);
        return { base64: "iVBORw0KGgo=", content: "", isBinary: true };
      },
      downloadBatchBlobs: async ({ items }) => {
        fetchedBatch.push(...items.map((i) => i.path));
        return items.map((i) => ({ path: i.path, blobSha: i.blobSha, base64: "iVBORw0KGgo=", isBinary: true }));
      },
      markProjectOfflineCached: async () => {},
      listProjects: async () => [activeProject]
    });

    await lazySync.preloadForPreview(htmlFile);
    assert.deepEqual(fetchedBatch, ["assets/hero.png"]);

    pngFile.contentLoaded = false;
    await lazySync.preloadForPreview(pngFile);
    assert.deepEqual(fetchedSingle, ["sha-png-1"]);
  });

  test("Agent 3: livePreviewModal precarga dependencias de medios HTML y oculta Consola/REPL en imágenes", async () => {
    const prevBody = document.body.innerHTML;
    document.body.innerHTML = "";
    const mk = (tag, id, extra = {}) => {
      const el = document.createElement(tag);
      el.id = id;
      Object.assign(el, extra);
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
    const consoleBtn = mk("button", "btn-preview-console");
    mk("button", "btn-preview-clear-console");
    mk("div", "preview-unavailable-state", { hidden: true });
    mk("div", "preview-unavailable-title");
    mk("div", "preview-unavailable-desc");
    const consolePanel = mk("div", "preview-console-panel");
    mk("div", "preview-console-title");
    mk("div", "preview-console-list");
    const replForm = mk("form", "preview-repl-form");
    mk("input", "preview-repl-input");
    mk("div", "preview-iframe-wrapper");
    const iframeEl = mk("iframe", "preview-iframe");
    mk("div", "preview-c-runner");
    mk("select", "preview-page-select");
    mk("button", "btn-preview-back");
    mk("button", "btn-preview-forward");

    let activeId = "index.html";
    const loadedPaths = [];
    const files = [
      { path: "index.html", shortName: "index.html", content: '<img src="media/banner.png">', contentLoaded: true },
      { path: "media/banner.png", shortName: "banner.png", isBinary: true, content: "", base64: null, contentLoaded: false }
    ];

    const modal = initLivePreviewModal({
      getWorkspaceSnapshot: () => ({ projectId: "p-media", activeFileId: activeId, files }),
      onBeforePreview: async () => {},
      onErrorMarker: () => {},
      onClearErrorMarkers: () => {},
      onGoToLine: () => {},
      ensureFilesLoaded: async (arr) => {
        for (const f of arr) {
          loadedPaths.push(f.path);
          f.base64 = "iVBORw0KGgo=";
          f.content = "";
          f.contentLoaded = true;
        }
      }
    });

    try {
      openBtn.click();
      await new Promise((r) => setTimeout(r, 40));
      assert.deepEqual(loadedPaths, ["media/banner.png"]);
      assert.equal(String(iframeEl.srcdoc || "").includes("data:image/png;base64,iVBORw0KGgo="), true);

      dialog.close();
      // Proyecto sin index.html -> Vista previa standalone de Imagen (sin consola/REPL JS)
      files.shift();
      activeId = "media/banner.png";
      openBtn.click();
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(consoleBtn.hidden, true);
      assert.equal(consolePanel.hidden, true);
      assert.equal(replForm.hidden, true);
    } finally {
      modal.destroy();
      document.body.innerHTML = prevBody;
    }
  });

  test("Agent 4 Soak & Lifecycle: downloadZip delega a downloadBlob y controladores liberan listeners tras 30 ciclos", () => {
    const origCreateObjectURL = globalThis.URL?.createObjectURL;
    const origRevokeObjectURL = globalThis.URL?.revokeObjectURL;
    let createdCount = 0;
    globalThis.URL = globalThis.URL || {};
    globalThis.URL.createObjectURL = () => {
      createdCount += 1;
      return `blob:mock-${createdCount}`;
    };
    globalThis.URL.revokeObjectURL = () => {};

    try {
      const ok = downloadZip(new Uint8Array([80, 75, 5, 6]), "mi:proyecto*test");
      assert.equal(ok, true);
      assert.equal(createdCount, 1);
    } finally {
      if (origCreateObjectURL) globalThis.URL.createObjectURL = origCreateObjectURL;
      if (origRevokeObjectURL) globalThis.URL.revokeObjectURL = origRevokeObjectURL;
    }

    for (let i = 0; i < 30; i += 1) {
      const sym = initSymbolBar({ onInsert: () => {}, onToggle: () => {} });
      sym.setLanguage("html");
      sym.destroy();

      const diff = initDiffModal();
      diff.destroy();

      const gh = initGithubController({
        getActiveProject: () => null,
        onFlushPendingSaves: async () => {},
        onProjectClonedOrSynced: async () => {},
        onReposListChanged: () => {},
        onOpenDiff: () => {}
      });
      gh.destroy();
    }

    const appSrc = readFileSync(resolve(ROOT, "js/app.js"), "utf8");
    for (const call of [
      "symbolBar?.destroy?.()",
      "diffModal?.destroy?.()",
      "binaryPreview?.destroy?.()",
      "editor?.destroy?.()",
      "chat?.destroy?.()",
      "github?.destroy?.()"
    ]) {
      assert.equal(appSrc.includes(call), true, `Falta liberar ${call} en app.js destroy()`);
    }
    assert.equal(appSrc.includes("localStorage.setItem("), false);
    assert.equal(appSrc.includes("localStorage.removeItem("), false);

    // Soak rápido sobre Markdown + SVG + HTML Bundler
    const map = buildWorkspaceAssetMap([
      { path: "a.png", shortName: "a.png", isBinary: true, base64: "iVBORw0KGgo=" }
    ]);
    for (let i = 0; i < 50; i += 1) {
      const html = bundleHtmlWithFolderAssets("index.html", `<img src="a.png"><!-- ${i} -->`, map);
      assert.equal(html.includes('src="data:image/png;base64,iVBORw0KGgo="'), true);
      const md = renderMarkdownDocumentHtml(`![img ${i}](a.png "T & ${i}")`, { assetMap: map });
      assert.equal(md.includes('title="T &amp;'), true);
      assert.ok(sanitizeSvgMarkup(`<svg width="${i}"><rect/></svg>`));
    }
  });
});
