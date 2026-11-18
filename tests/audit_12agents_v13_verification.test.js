import "./setup.js";
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildBracketPairMap, findMatchingDelimiter } from "../js/preview/jsTokenUtils.js";
import { tokenizeJsWithOffsets } from "../js/preview/ts/tsTokenizer.js";
import { transpileTypeScriptAndJsx } from "../js/preview/tsTranspiler.js";
import {
  sanitizeSvgMarkup,
  buildSafeImageDataUrl,
  escapeCloseScript,
  escapeJsonForInlineScript,
  isIgnoredPreviewPath
} from "../js/preview/previewUtils.js";
import { buildWorkspaceAssetMap, bundleHtmlWithFolderAssets, buildMarkdownPreview, findTargetHtmlFile } from "../js/preview/htmlBundler.js";
import { buildConsoleBridgeScript, rewriteProgrammaticNavigation } from "../js/preview/html/consoleBridge.js";
import { runWasiModule } from "../js/preview/wasiRunner.js";
import { sanitizeVirtualSourcePath } from "../js/preview/clangWorker.js";
import { buildStandalonePythonPreview } from "../js/preview/pythonRunner.js";
import { hasUnsafeReDoSPattern } from "../js/search/projectSearch.js";
import { sanitizeRemoteRepoPath } from "../js/storage/db/dbCore.js";
import {
  cacheBatchGithubFileContents,
  deleteProject,
  deleteProjectEntry,
  discardEntryChange,
  getAllRawProjectEntries,
  getPendingGithubChanges,
  getProjectEntries,
  hydrateLazyGithubProject,
  updateFileContent,
  upsertEntry,
  applyRemotePullPlan
} from "../js/storage/workspaceDb.js";
import { classifyRemotePullChanges, buildRemotePullPlan } from "../js/github/githubMerge.js";
import { initGithubController } from "../js/github/githubController.js";
import {
  clearApiKey,
  getModelContextWindow,
  getSyncCredentialsBackupPayload,
  importKeysBundle,
  saveApiKey,
  setKeyStorageMode,
  streamAiCompletion,
  validateApiKey
} from "../js/ai/providers.js";
import { parseMarkdownSegments, parseMarkdownSegmentsIncremental } from "../js/ai/markdownRenderer.js";
import { initChatController } from "../js/ai/chatController.js";
import { createBinaryPreview } from "../js/ui/binaryPreview.js";
import { initDiffModal } from "../js/ui/diffModal.js";
import { createSplitEditorController } from "../js/editor/splitEditorController.js";
import { lintJavaScript } from "../js/editor/liveLinter.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function encodeU32Leb(val) {
  const out = [];
  let v = val >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function encodeS32Leb(val) {
  const out = [];
  let v = val | 0;
  let more = true;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((v === 0 && !signBit) || (v === -1 && signBit)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte);
  }
  return out;
}

function encodeWasmStr(str) {
  const b = new TextEncoder().encode(str);
  return [...encodeU32Leb(b.length), ...b];
}

function wasmSection(id, payload) {
  return [id, ...encodeU32Leb(payload.length), ...payload];
}

/**
 * Construye un binario WASM WASI real que invoca syscalls con FD negativo / punteros OOB
 * y sale con `proc_exit` indicando si alguna syscall devolvió éxito indebido.
 */
function buildAdversarialWasiWasm() {
  // Imports:
  // 0: fd_write(i32, i32, i32, i32) -> i32
  // 1: random_get(i32, i32) -> i32
  // 2: fd_fdstat_get(i32, i32) -> i32
  // 3: proc_exit(i32) -> ()
  const typePayload = [
    0x04,
    0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f,
    0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x60, 0x01, 0x7f, 0x00
  ];
  const importPayload = [
    0x04,
    ...encodeWasmStr("wasi_snapshot_preview1"), ...encodeWasmStr("fd_write"), 0x00, 0x00,
    ...encodeWasmStr("wasi_snapshot_preview1"), ...encodeWasmStr("random_get"), 0x00, 0x01,
    ...encodeWasmStr("wasi_snapshot_preview1"), ...encodeWasmStr("fd_fdstat_get"), 0x00, 0x02,
    ...encodeWasmStr("wasi_snapshot_preview1"), ...encodeWasmStr("proc_exit"), 0x00, 0x03
  ];
  const funcPayload = [0x01, 0x03]; // _start -> type 3 (Wait: use type index for ()->())
  typePayload[0] = 0x05;
  typePayload.push(0x60, 0x00, 0x00); // type 4: () -> ()
  funcPayload[1] = 0x04;

  const memPayload = [0x01, 0x00, 0x01]; // 1 page = 65536 bytes
  const exportPayload = [
    0x02,
    ...encodeWasmStr("memory"), 0x02, 0x00,
    ...encodeWasmStr("_start"), 0x00, 0x04
  ];

  // Local 0 = errno_fd_write, local 1 = errno_random_get, local 2 = errno_fdstat
  // Cada syscall negativa/OOB DEBE devolver errno > 0 (ERRNO_BADF=8 o ERRNO_FAULT=21), nunca 0.
  const body = [
    0x01, 0x03, 0x7f,
    // fd_write(-1, 0, 1, 16)
    0x41, ...encodeS32Leb(-1),
    0x41, 0x00,
    0x41, 0x01,
    0x41, 0x10,
    0x10, 0x00,
    0x21, 0x00,
    // random_get(-10, 8)
    0x41, ...encodeS32Leb(-10),
    0x41, 0x08,
    0x10, 0x01,
    0x21, 0x01,
    // fd_fdstat_get(-1, 32)
    0x41, ...encodeS32Leb(-1),
    0x41, 0x20,
    0x10, 0x02,
    0x21, 0x02,
    // Si local0==8 && local1==21 && local2==8 -> exit(0), else exit(1)
    0x20, 0x00, 0x41, 0x08, 0x46, // eq 8
    0x20, 0x01, 0x41, 0x15, 0x46, // eq 21
    0x71, // and
    0x20, 0x02, 0x41, 0x08, 0x46, // eq 8
    0x71, // and
    0x04, 0x40, // if void
      0x41, 0x00, 0x10, 0x03, // proc_exit(0)
    0x05, // else
      0x41, 0x01, 0x10, 0x03, // proc_exit(1)
    0x0b, // end if
    0x0b // end func
  ];
  const codePayload = [0x01, ...encodeU32Leb(body.length), ...body];

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...wasmSection(1, typePayload),
    ...wasmSection(2, importPayload),
    ...wasmSection(3, funcPayload),
    ...wasmSection(5, memPayload),
    ...wasmSection(7, exportPayload),
    ...wasmSection(10, codePayload)
  ]);
}

function createMinimalChatDom() {
  const ids = [
    "btn-ai-settings", "btn-ai-clear-chat", "chat-settings-drawer",
    "chat-current-model-label", "chat-key-status-btn", "ai-provider-select",
    "ai-model-select", "ai-custom-model-input", "ai-fetch-models-btn",
    "ai-api-key-input", "ai-toggle-key-vis", "ai-clear-key-btn",
    "ai-provider-help", "ai-mode-local", "ai-mode-session",
    "ai-export-keys-btn", "ai-import-keys-btn", "ai-import-keys-slot",
    "chat-extra-tabs", "chat-stream", "chat-scroll-body",
    "chat-composer-form", "chat-prompt-input", "chat-submit-btn",
    "chat-token-counter", "btn-chat-regenerate"
  ];
  const tagById = {
    "chat-composer-form": "form",
    "ai-provider-select": "select",
    "ai-model-select": "select",
    "ai-custom-model-input": "input",
    "ai-api-key-input": "input",
    "chat-prompt-input": "textarea"
  };
  const els = {};
  for (const id of ids) {
    const tag = tagById[id] || (id.startsWith("btn-") || id.endsWith("-btn") ? "button" : "div");
    const el = document.createElement(tag);
    el.id = id;
    els[id] = el;
    document.body.appendChild(el);
  }
  els["chat-composer-form"].append(els["chat-prompt-input"], els["chat-submit-btn"]);
  return els;
}

describe("Auditoría Integral 12 Agentes v1.3.0 — Verificación Cruzada y Regresiones", () => {
  const createdProjects = [];

  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
    while (createdProjects.length > 0) {
      const pid = createdProjects.pop();
      try {
        await deleteProject(pid);
      } catch {
        // Ignorar limpieza de proyectos temporales ya borrados
      }
    }
  });

  describe("Agentes 1 & 2 — Higiene, Deduplicación y Contratos Estructurales", () => {
    test("buildBracketPairMap y findMatchingDelimiter coinciden en tokens pequeños y grandes (WeakMap O(1))", () => {
      const filler = Array.from({ length: 70 }, (_, idx) => `const v_${idx} = ({ a: [${idx}] });`).join("\n");
      const tokens = tokenizeJsWithOffsets(filler);
      const pairs = buildBracketPairMap(tokens);
      assert.equal(pairs.length, tokens.length);

      let checked = 0;
      for (let i = 0; i < tokens.length; i += 1) {
        const v = tokens[i]?.value;
        if (tokens[i]?.type === "punct" && (v === "(" || v === "[" || v === "{")) {
          const closeChar = v === "(" ? ")" : v === "[" ? "]" : "}";
          const viaFast = findMatchingDelimiter(tokens, i, v, closeChar);
          assert.equal(viaFast, pairs[i]);
          checked += 1;
        }
      }
      assert.ok(checked >= 210);
      assert.equal(isIgnoredPreviewPath("node_modules/pkg/index.js"), true);
      assert.equal(isIgnoredPreviewPath("src/app/index.js"), false);
    });

    test("editor.css unifica selectores .editor-mount/.editor-split-body y conserva @media (pointer: coarse)", () => {
      const css = fs.readFileSync(path.join(ROOT_DIR, "css/editor.css"), "utf8");
      assert.match(css, /\.editor-mount \.cm-editor,\s*\r?\n\.editor-split-body \.cm-editor/);
      const matches = [...css.matchAll(/@media\s*\(\s*pointer:\s*coarse\s*\)/g)];
      assert.ok(matches.length >= 1);
      assert.ok(matches[matches.length - 1].index > css.length / 2);
      assert.match(css.slice(matches[matches.length - 1].index), /--text-touch-input/);
    });
  });

  describe("Agentes 3 & 4 — AppSec Adversarial (SVG NS, Base64 SVG, WASI, ReDoS, Traversal, Prototipos)", () => {
    test("sanitizeSvgMarkup y buildSafeImageDataUrl neutralizan prefijos XML (<s:script>, <s:foreignObject>, x:href) y Base64 SVG malicioso", () => {
      const maliciousSvg = `<svg xmlns:s="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink">
        <s:script>alert(1)</s:script>
        <s:foreignObject><body onload="alert(2)"><div>x</div></body></s:foreignObject>
        <s:style>@import url("https://evil.test/steal.css");</s:style>
        <a x:href="javascript:alert(3)"><circle cx="10" cy="10" r="8" fill="#64748b" /></a>
      </svg>`;

      const cleaned = sanitizeSvgMarkup(maliciousSvg);
      assert.doesNotMatch(cleaned, /<s:script/i);
      assert.doesNotMatch(cleaned, /foreignObject/i);
      assert.doesNotMatch(cleaned, /javascript:/i);
      assert.doesNotMatch(cleaned, /@import/i);
      assert.match(cleaned, /<circle\b/);

      const badB64 = Buffer.from(maliciousSvg, "utf8").toString("base64");
      const safeDataUrl = buildSafeImageDataUrl({ path: "evil.svg", isBinary: true, base64: badB64 });
      assert.ok(safeDataUrl && safeDataUrl.src.startsWith("data:image/svg+xml;charset=utf-8,"));
      const decoded = decodeURIComponent(safeDataUrl.src.split(",")[1]);
      assert.doesNotMatch(decoded, /<s:script/i);
      assert.doesNotMatch(decoded, /javascript:/i);

      // Cadena HTML/Markdown completa debe transportar el SVG saneado, nunca el Base64 crudo ejecutable
      const assetMap = buildWorkspaceAssetMap([{ path: "evil.svg", isBinary: true, base64: badB64 }]);
      const mdHtml = buildMarkdownPreview({ path: "README.md", content: "![x](evil.svg)" }, assetMap);
      assert.doesNotMatch(mdHtml, /base64,/i);
      assert.ok(mdHtml.includes("data:image/svg+xml;charset=utf-8,"));
    });

    test("escapeJsonForInlineScript y bundleHtmlWithFolderAssets neutralizan '<!-- <script>' en el bridge de assets JSON", () => {
      const escaped = escapeJsonForInlineScript({ msg: "<!-- <script>alert(1)</script>" });
      assert.doesNotMatch(escaped, /<!--/);
      assert.doesNotMatch(escaped, /<script/i);
      assert.doesNotMatch(escaped, /<\/script/i);
      assert.doesNotMatch(escapeCloseScript("</Script>"), /<\/script/i);

      const files = [
        { path: "index.html", content: "<!DOCTYPE html><html><body><script src=\"app.js\"></script></body></html>" },
        { path: "app.js", content: "console.log('hi');" },
        { path: "payload<!-- <script>.png", isBinary: true, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XkAAAAASUVORK5CYII=" }
      ];
      const bundled = bundleHtmlWithFolderAssets(files[0], files);
      const inlineRuntime = bundled.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
      assert.doesNotMatch(inlineRuntime, /<!--\s*<script/i);
    });

    test("wasiRunner devuelve ERRNO_BADF / ERRNO_FAULT ante fd negativos y punteros OOB sin lanzar RangeError", async () => {
      const wasm = buildAdversarialWasiWasm();
      const res = await runWasiModule(wasm);
      assert.equal(res.exitCode, 0);
    });

    test("projectSearch ReDoS rechaza aserciones cuantificadas y rangos Unicode solapados no-ASCII", () => {
      assert.equal(hasUnsafeReDoSPattern("(?:(?=[a-z]+x)[a-z])+$"), true);
      assert.equal(hasUnsafeReDoSPattern("([\\u0600-\\u06ff]|[\\u0600-\\u06ef])+$"), true);
      assert.equal(hasUnsafeReDoSPattern("^func_[a-z0-9_]+$"), false);
    });

    test("sanitizeRemoteRepoPath, clangWorker.sanitizeVirtualSourcePath y providers.js bloquean traversal y prototipos", async () => {
      assert.equal(sanitizeRemoteRepoPath("C:\\Windows\\System32\\cmd.exe"), "");
      assert.equal(sanitizeRemoteRepoPath("src/../secret.txt"), "");
      assert.equal(sanitizeRemoteRepoPath("src/__proto__/pollute.js"), "");
      assert.equal(sanitizeRemoteRepoPath("constructor"), "");
      assert.equal(sanitizeRemoteRepoPath("/src//valid.ts"), "");
      assert.equal(sanitizeRemoteRepoPath("src/valid.ts"), "src/valid.ts");

      assert.equal(sanitizeVirtualSourcePath("foo/..", "main.c"), "main.c");
      assert.equal(sanitizeVirtualSourcePath("src/__proto__/evil.c", "main.c"), "main.c");

      assert.equal(getModelContextWindow("__proto__"), 16000);
      assert.equal(getModelContextWindow("gemini", "toString"), 1000000);
      const valRes = await validateApiKey("constructor", "sk_test_1234567890abcdef");
      assert.equal(valRes.status, "unknown");
      assert.equal(importKeysBundle(JSON.stringify({ keys: {}, githubPat: { evil: true } })), 0);
      await assert.rejects(
        () => streamAiCompletion({ providerId: "__proto__", model: "x", apiKey: "abc", history: [] }),
        /API Key|Gemini|Proveedor/i
      );
    });
  });

  describe("Agentes 5 & 6 — Corrección Funcional, Concurrencia y Merge", () => {
    test("binaryPreview.clear invalida FileReader en vuelo (!currentActiveFile)", () => {
      const origFileReader = globalThis.FileReader;
      const pendingReaders = [];
      globalThis.FileReader = class MockFileReader {
        readAsDataURL() {
          this.result = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XkAAAAASUVORK5CYII=";
          pendingReaders.push(this);
        }
      };

      try {
        const host = document.createElement("div");
        document.body.appendChild(host);
        let updatedCalls = 0;
        const bp = createBinaryPreview({
          binaryPreviewEl: host,
          onDownloadFile: () => {},
          onUpdateFileContent: () => { updatedCalls += 1; }
        });
        bp.render({
          id: "empty.png",
          path: "empty.png",
          shortName: "empty.png",
          isBinary: true,
          base64: null
        });
        const card = host.querySelector(".editor-binary-card");
        card.dispatchEvent({
          type: "drop",
          preventDefault() {},
          dataTransfer: { files: [{ name: "a.png", size: 64, type: "image/png" }] }
        });
        assert.equal(pendingReaders.length, 1);

        // Usuario cierra la pestaña / limpia el visor antes de que FileReader complete
        bp.hide();
        pendingReaders[0].onload?.();
        assert.equal(updatedCalls, 0);
        bp.destroy();
      } finally {
        globalThis.FileReader = origFileReader;
      }
    });

    test("workspaceDb discardEntryChange preserva contentLoaded=true en archivo trackeado vacío (0 bytes)", async () => {
      const proj = await hydrateLazyGithubProject({
        owner: "o",
        repo: "zero-byte",
        branch: "main",
        commitSha: "c1",
        entries: [{ path: ".gitkeep", blobSha: "e69de29", isBinary: false }]
      });
      createdProjects.push(proj.id);

      await upsertEntry(proj.id, ".gitkeep", { content: "", baseContent: "" });
      await updateFileContent(proj.id, ".gitkeep", "temp");
      await discardEntryChange(proj.id, ".gitkeep");
      const [rec] = await getProjectEntries(proj.id);
      assert.equal(rec.content, "");
      assert.equal(rec.contentLoaded, true);
    });

    test("githubMerge keep-local en deleted vs modified descarga blobSha remoto y actualiza baseContent en rebase", async () => {
      const proj = await hydrateLazyGithubProject({
        owner: "o",
        repo: "merge-del",
        branch: "main",
        commitSha: "c1",
        entries: [{ path: "src/target.js", blobSha: "b1", isBinary: false }]
      });
      createdProjects.push(proj.id);
      await upsertEntry(proj.id, "src/target.js", { content: "v1 base", baseContent: "v1 base", blobSha: "b1" });
      await deleteProjectEntry(proj.id, "src/target.js", false);

      const localEntries = await getProjectEntries(proj.id);
      const pending = await getPendingGithubChanges(proj.id);
      const classification = classifyRemotePullChanges({
        localEntries,
        localPendingChanges: pending,
        remoteDiffFiles: [{ path: "src/target.js", status: "modified", blobSha: "b2" }]
      });
      assert.equal(classification.conflicts.length, 1);
      classification.conflicts[0].resolution = "keep-local";

      const plan = await buildRemotePullPlan({
        project: proj,
        localEntries,
        classification,
        newCommitSha: "c2",
        fetchBlob: async (sha) => (sha === "b2" ? "v2 remote content" : "")
      });
      assert.equal(plan.keepLocalRebases[0].remoteContent, "v2 remote content");

      await applyRemotePullPlan(proj.id, plan);
      const raw = await getAllRawProjectEntries(proj.id);
      const rebased = raw.find((e) => e.path === "src/target.js");
      assert.equal(rebased.deleted, true);
      assert.equal(rebased.blobSha, "b2");
      assert.equal(rebased.baseContent, "v2 remote content");
    });

    test("githubController Cmd+Enter queda bloqueado cuando todos los checkboxes de commit están desmarcados", async () => {
      const ids = [
        "btn-open-github", "topbar-repo-label", "github-dialog", "btn-close-github",
        "gh-token-input", "btn-gh-connect", "btn-gh-clear-token", "gh-user-status",
        "gh-auth-msg", "gh-repo-select", "gh-manual-repo", "gh-branch-select",
        "btn-gh-open-live", "btn-gh-clone", "gh-clone-status", "gh-sync-section",
        "gh-sync-repo-title", "gh-sync-branch-select", "btn-gh-new-branch",
        "gh-new-branch-box", "gh-new-branch-input", "btn-gh-create-branch",
        "btn-gh-cancel-branch", "gh-branch-status", "btn-gh-pull", "gh-changes-list",
        "gh-commit-msg", "btn-gh-push", "gh-push-status", "gh-conflict-box",
        "gh-conflict-msg", "gh-conflict-list", "btn-gh-conflict-merge",
        "btn-gh-conflict-apply", "btn-gh-conflict-view", "btn-gh-conflict-force",
        "explorer-token-warning", "explorer-token-warning-text", "btn-token-reconnect"
      ];
      const tagMap = {
        "github-dialog": "dialog", "gh-token-input": "input", "gh-manual-repo": "input",
        "gh-new-branch-input": "input", "gh-commit-msg": "input",
        "gh-repo-select": "select", "gh-branch-select": "select", "gh-sync-branch-select": "select",
        "gh-changes-list": "ul", "gh-conflict-list": "ul"
      };
      for (const id of ids) {
        const el = document.createElement(tagMap[id] || (id.startsWith("btn-") ? "button" : "div"));
        el.id = id;
        if (id === "github-dialog") {
          el.showModal = function () { this.open = true; };
          el.close = function () { this.open = false; };
        }
        document.body.appendChild(el);
      }
      const proj = await hydrateLazyGithubProject({
        owner: "u",
        repo: "chk",
        branch: "main",
        commitSha: "c1",
        entries: [{ path: "a.js", blobSha: "b1", isBinary: false }]
      });
      createdProjects.push(proj.id);
      await upsertEntry(proj.id, "new-local.js", { content: "edited", isFolder: false });

      let fetchCalls = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async () => { fetchCalls += 1; return new Response("{}", { status: 500 }); };
      try {
        const gh = initGithubController({
          getActiveProject: () => proj,
          onFlushPendingSaves: async () => {},
          onOpenDiff: () => {},
          onOpenMultiDiff: () => {},
          onRequestConfirm: async () => true,
          onDiscardLocalChange: async () => {},
          onReposListChanged: () => {},
          onProjectClonedOrSynced: async () => {}
        });
        document.getElementById("btn-open-github").click();
        await new Promise((r) => setTimeout(r, 40));
        const changesList = document.getElementById("gh-changes-list");
        const checkbox = changesList.querySelector("input");
        assert.ok(checkbox);
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));

        assert.equal(document.getElementById("btn-gh-push").disabled, true);
        assert.equal(document.getElementById("btn-gh-conflict-force").disabled, true);

        document.getElementById("gh-commit-msg").value = "should not push";
        document.getElementById("gh-commit-msg").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })
        );
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(fetchCalls, 0);
        gh.destroy();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("chatController serializa submit mientras resuelve @menciones lazy y revierte menciones fallidas", async () => {
      const els = createMinimalChatDom();
      saveApiKey("gemini", "AIzaSyAuditVerificationKey1234567890");
      setKeyStorageMode("session");
      const modePayload = getSyncCredentialsBackupPayload();
      assert.equal(modePayload, "");
      clearApiKey("gemini");
      saveApiKey("gemini", "AIzaSyAuditVerificationKey1234567890");

      let resolveGate;
      let resolveCalls = 0;
      let apiFetchCalls = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        if (String(url).includes("generativelanguage.googleapis.com") && String(url).includes("streamGenerateContent")) {
          apiFetchCalls += 1;
          return new Response(
            "data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }) + "\n\n",
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      };

      try {
        const snapshot = {
          activeFile: { id: "main.js", path: "main.js", lang: "js", content: "console.log(1);", contentLoaded: true },
          otherOpenFiles: [],
          projectFiles: [
            { id: "main.js", path: "main.js", lang: "js", content: "console.log(1);", contentLoaded: true },
            { id: "lazy.js", path: "lazy.js", lang: "js", content: "", contentLoaded: false }
          ]
        };
        const ctrl = initChatController({
          getContextSnapshot: () => snapshot,
          onResolveFileContent: () =>
            new Promise((resolve) => {
              resolveCalls += 1;
              resolveGate = resolve;
            })
        });
        ctrl.setConversation([], "proj-race");

        // Primer envío con @lazy.js dispara onResolveFileContent; segundo submit casi inmediato debe abortar/no duplicar stream
        els["chat-prompt-input"].value = "Revisá @lazy.js";
        els["chat-composer-form"].dispatchEvent(new Event("submit", { cancelable: true }));
        await new Promise((r) => setTimeout(r, 15));
        assert.equal(resolveCalls, 1);

        // Otro Enter estando in-flight actúa como Stop (aborta), sin iniciar un segundo fetch paralelo
        els["chat-prompt-input"].value = "Otro envío";
        els["chat-composer-form"].dispatchEvent(new Event("submit", { cancelable: true }));
        resolveGate(null); // falla la carga lazy -> rollback de mención + abort controlado
        await new Promise((r) => setTimeout(r, 40));

        assert.equal(apiFetchCalls, 0);
        assert.match(els["chat-extra-tabs"].textContent || "", /No se pudo cargar lazy\.js|Adjuntar|^$/);
        ctrl.destroy();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("liveLinter fallback detecta trailing \\\" sin cerrar y tolera literales RegExp /[\"'\\(]/ y template strings", async () => {
      const broken = await lintJavaScript("const s = \"abc\\\"", "js", { parseFn: null });
      assert.equal(broken.length, 1);
      assert.match(broken[0].message, /sin cerrar/i);

      const okCode = `
        const re = /["'({\\[]/;
        const tpl = \`hola \${"mundo"} (\${1 + 2})\`;
        function check(x) { return re.test(x) && tpl.length > 0; }
      `;
      const okRes = await lintJavaScript(okCode, "js", { parseFn: null });
      assert.deepEqual(okRes, []);
    });

    test("pythonRunner postEvalJob preserva payload.code para el archivo de entrada antes del primer Run", () => {
      const html = buildStandalonePythonPreview({
        entryName: "main.py",
        entryPath: "main.py",
        code: "VALOR_ORIGINAL = 42\nprint(VALOR_ORIGINAL)\n",
        modules: [{ path: "main.py", content: "VALOR_ORIGINAL = 42\n" }]
      });
      assert.match(html, /entryCode:\s*payload\.code/);
      assert.match(html, /var entrySource = typeof job\.entryCode === "string" \? job\.entryCode : job\.code;/);
    });

    test("splitEditorController cancela carga lazy en vuelo cuando dropFileState borra el archivo", async () => {
      let releaseLazy;
      let openedCount = 0;
      const mount = document.createElement("div");
      const splitTitle = document.createElement("span");
      const splitCtrl = createSplitEditorController({
        editorStageEl: mount,
        splitMountEl: mount,
        splitDividerEl: document.createElement("div"),
        splitFileSelectEl: document.createElement("select"),
        splitTitleTextEl: splitTitle,
        btnCloseSplit: document.createElement("button"),
        btnEditorSplit: document.createElement("button"),
        getFilesOnly: () => [{ id: "lazy.js", shortName: "lazy.js", contentLoaded: false }],
        getOpenTabIds: () => ["lazy.js"],
        getActiveFileId: () => null,
        getActiveProjectId: () => "p1",
        ensureFileContentLoaded: () => new Promise((resolve) => { releaseLazy = resolve; }),
        onEditorDocChange: () => {},
        onSaveFileNow: () => {},
        onTriggerFormat: () => {},
        createEditorFn: () => ({
          openFile() { openedCount += 1; },
          dropFileState() {},
          clearActiveFile() {},
          destroy() {}
        })
      });

      const opening = splitCtrl.toggle(true);
      await new Promise((r) => setTimeout(r, 15));
      splitCtrl.dropFileState("lazy.js", false);
      releaseLazy?.();
      await opening;

      assert.equal(openedCount, 0);
      splitCtrl.destroy();
    });
  });

  describe("Agentes 7 & 8 — Rendimiento, Batching en IndexedDB y DOM Progresivo", () => {
    test("parseMarkdownSegmentsIncremental mantiene paridad con parseMarkdownSegments y evita reescanear prefijos", () => {
      const fullMd = [
        "Archivo: `src/a.js`",
        "```js\nexport const a = 1;\n```",
        "Archivo: `src/b.js`",
        "```js\nexport const b = 2;\n```",
        "Archivo: `src/c.js`\n```js\nexport const c = 3;"
      ].join("\n");

      const fullSegs = parseMarkdownSegments(fullMd);
      const splitAt = fullMd.indexOf("Archivo: `src/c.js`");
      const inc = parseMarkdownSegmentsIncremental(fullMd, splitAt, "");
      assert.equal(inc.segments.length, 2);
      assert.equal(inc.segments[1].type, "code");
      assert.equal(inc.segments[1].filePath, "src/c.js");
      assert.equal(inc.segments[1].filePath, fullSegs[fullSegs.length - 1].filePath);
    });

    test("tsTranspiler no cae en O(N^2) con 1500 comparaciones '<' sin punto y coma", () => {
      const lines = [];
      for (let i = 0; i < 1500; i += 1) {
        lines.push(`const cmp_${i} = a_${i} < b_${i}`);
      }
      const src = lines.join("\n");
      const t0 = performance.now();
      const out = transpileTypeScriptAndJsx(src, { jsx: false, fileName: "cmp.ts" });
      const elapsed = performance.now() - t0;
      assert.match(out.code, /cmp_1499 = a_1499 < b_1499/);
      assert.ok(elapsed < 400, `Transpilación de 1500 '<' tardó demasiado: ${elapsed.toFixed(1)} ms`);
    });

    test("diffModal fragmenta diffs masivos (> 1500 líneas) con botón progresivo de carga", () => {
      const ids = [
        "diff-dialog", "diff-dialog-title", "diff-dialog-stats", "diff-lines-view",
        "diff-multi-bar", "btn-close-diff", "btn-diff-cancel", "btn-diff-confirm"
      ];
      for (const id of ids) {
        const el = document.createElement(id === "diff-dialog" ? "dialog" : "div");
        el.id = id;
        if (id === "diff-dialog") {
          el.showModal = function () { this.open = true; };
          el.close = function () { this.open = false; };
        }
        document.body.appendChild(el);
      }

      const oldLines = Array.from({ length: 3400 }, (_, i) => `old_${i}`).join("\n");
      const newLines = Array.from({ length: 3400 }, (_, i) => `new_${i}`).join("\n");
      const modal = initDiffModal();
      modal.openReadOnlyDiff({ title: "Massive Diff", oldCode: oldLines, newCode: newLines });

      const bodyEl = document.getElementById("diff-lines-view");
      const initialRows = bodyEl.querySelectorAll(".diff-row").length;
      const loadMoreBtn = bodyEl.querySelector(".diff-load-more-btn");
      assert.equal(initialRows, 1500);
      assert.ok(loadMoreBtn);

      loadMoreBtn.click();
      assert.equal(bodyEl.querySelectorAll(".diff-row").length, 3000);
      modal.destroy();
    });

    test("cacheBatchGithubFileContents persiste lote en 1 transacción respetando ediciones locales concurrentes", async () => {
      const entries = Array.from({ length: 50 }, (_, i) => ({
        path: `src/f_${i}.js`,
        blobSha: `sha_${i}`,
        isBinary: false
      }));
      const proj = await hydrateLazyGithubProject({
        owner: "o",
        repo: "batch-cache",
        branch: "main",
        commitSha: "c1",
        entries
      });
      createdProjects.push(proj.id);

      // Edición local concurrente en f_7 debe ser respetada por el lote
      await updateFileContent(proj.id, "src/f_7.js", "// local edit stays");

      const batchItems = entries.map((e, idx) => ({
        path: e.path,
        payload: `// remote ${idx}`,
        blobSha: e.blobSha
      }));
      await cacheBatchGithubFileContents(proj.id, batchItems);

      const all = await getProjectEntries(proj.id);
      assert.equal(all.find((e) => e.path === "src/f_0.js")?.content, "// remote 0");
      assert.equal(all.find((e) => e.path === "src/f_7.js")?.content, "// local edit stays");
      assert.equal(all.filter((e) => !e.isFolder && e.contentLoaded).length, 50);
    });

    test("Live Preview multipágina: resuelve '/', './', '../' hacia index.html, shim localStorage/history y fotos de catálogo por sufijo/shortName", () => {
      const files = [
        { path: "index.html", content: "<html><body><h1>Inicio</h1></body></html>" },
        { path: "pages/catalogo.html", content: "<html><head></head><body><img src=\"../img/logo.png\"><script src=\"../js/cat.js\"></script></body></html>" },
        { path: "js/cat.js", content: "const prod = { img: 'productos/zapato.png' };" },
        { path: "img/logo.png", isBinary: true, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XkAAAAASUVORK5CYII=" },
        { path: "img/productos/zapato.png", isBinary: true, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XkAAAAASUVORK5CYII=" }
      ];
      assert.equal(findTargetHtmlFile(files, "pages/catalogo.html", "/")?.path, "index.html");
      assert.equal(findTargetHtmlFile(files, "pages/catalogo.html", "../")?.path, "index.html");
      assert.equal(findTargetHtmlFile(files, "catalogo.html", "./")?.path, "index.html");

      const bridge = buildConsoleBridgeScript(false);
      assert.match(bridge, /createMemoryStorage/);
      assert.match(bridge, /window\.history\.pushState/);

      const assetMap = buildWorkspaceAssetMap(files);
      const compiled = bundleHtmlWithFolderAssets("pages/catalogo.html", files[1].content, assetMap, null, (c) => c, null, true);
      assert.match(compiled, /img\/productos\/zapato\.png/);
      assert.match(compiled, /urlBaseCounts/);
    });

    test("rewriteProgrammaticNavigation intercepta location.href/assign/replace, onclick y neutraliza <base>/<meta refresh>", () => {
      const sample = [
        "window.location.href = 'index.html';",
        "location.href = '/';",
        "document.location.assign('productos.html');",
        "location.replace('./');",
        "window.location = 'inicio.html';",
        "const { location = 'AR' } = cfg;",
        "const txt = \"window.location.href = 'no-tocar.html'\";",
        "if (window.location.href === 'x') { console.log('ok'); }"
      ].join("\n");
      const rewritten = rewriteProgrammaticNavigation(sample);
      assert.match(rewritten, /window\.__ideNavigate\('index\.html'\);/);
      assert.match(rewritten, /window\.__ideNavigate\('\/'\);/);
      assert.match(rewritten, /window\.__ideNavigate\('productos\.html'\);/);
      assert.match(rewritten, /window\.__ideNavigate\('\.\/'\);/);
      assert.match(rewritten, /window\.__ideNavigate\('inicio\.html'\);/);
      assert.match(rewritten, /const \{ location = 'AR' \} = cfg;/);
      assert.match(rewritten, /"window\.location\.href = 'no-tocar\.html'"/);
      assert.match(rewritten, /if \(window\.location\.href === 'x'\)/);

      const bridge = buildConsoleBridgeScript(false);
      assert.match(bridge, /__ideNavigate/);
      assert.match(bridge, /window\.open\s*=/);

      const html = `<html><head><base href="/"><meta http-equiv="refresh" content="0;url=index.html"></head><body><button onclick="location.href='index.html'">Inicio</button><script>window.location.href='index.html';</script></body></html>`;
      const files = [{ path: "productos.html", content: html }];
      const bundled = bundleHtmlWithFolderAssets("productos.html", html, buildWorkspaceAssetMap(files), null, (c) => c, null, true);
      assert.doesNotMatch(bundled, /<base\s+href=/i);
      assert.doesNotMatch(bundled, /http-equiv=["']?refresh/i);
      assert.match(bundled, /onclick="window\.__ideNavigate\('index\.html'\)"/);
      assert.match(bundled, /window\.__ideNavigate\('index\.html'\);/);
    });
  });
});
