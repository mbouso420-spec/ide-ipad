import "./setup.js";
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

import * as gh from "../js/github/githubService.js";
import { buildRemotePullPlan } from "../js/github/githubMerge.js";
import { initGithubController } from "../js/github/githubController.js";
import { initGithubLocalBackupPanel } from "../js/github/githubLocalBackupPanel.js";
import {
  applyRemotePullPlan,
  convertLocalProjectToGithub,
  createLocalProject,
  deleteProject,
  deleteProjectEntry,
  getAllRawProjectEntries,
  getEntryRecord,
  getPendingGithubChanges,
  getProject,
  getProjectEntries,
  hydrateGithubProject,
  hydrateLazyGithubProject,
  updateFileContent,
  upsertEntry
} from "../js/storage/workspaceDb.js";
import { restoreEmergencyBackup, writeEmergencyBackup, getEmergencyBackupKey } from "../js/storage/emergencyBackup.js";
import {
  SUPPORTED_BINARY_ASSET_EXTENSIONS,
  base64ToUint8Array,
  decodeImportedFile
} from "../js/storage/fileImport.js";
import { buildZipArchive, downloadZip } from "../js/storage/zipExporter.js";
import {
  checkAuthLockout,
  recordAuthFailure,
  resetAuthSecurityState
} from "../js/security/credentialGuard.js";
import { encryptKeysPayload, decryptKeysPayload } from "../js/security/keyVaultCrypto.js";
import { hasUnsafeReDoSPattern, searchInFiles } from "../js/search/projectSearch.js";

import {
  detectFilePathFromCodeSegment,
  initChatController,
  parseMarkdownSegments
} from "../js/ai/chatController.js";
import { saveApiKey, saveProviderId, streamAiCompletion } from "../js/ai/providers.js";
import { transpileTypeScriptAndJsx } from "../js/preview/tsTranspiler.js";
import {
  buildExactModuleMap,
  buildVirtualModuleBundle,
  formatVirtualModuleExecution,
  resolveLocalModuleEntry
} from "../js/preview/moduleBundler.js";
import { buildWorkspaceAssetMap, bundleHtmlWithFolderAssets } from "../js/preview/htmlBundler.js";
import { buildLoopGuardRuntime, instrumentLoops } from "../js/preview/loopGuard.js";
import { buildStandalonePythonPreview } from "../js/preview/pythonRunner.js";
import { buildSqlRunnerPreview, convertResultsToCsv, hasLimitClause } from "../js/preview/sqlRunner.js";
import { injectInteractiveInputGuard, parseGccErrors } from "../js/preview/cRunner.js";

import { createEditorManager } from "../js/editor/editorManager.js";
import { createSplitEditorController } from "../js/editor/splitEditorController.js";
import { formatCode } from "../js/editor/codeFormatter.js";
import { computeSmartReplacement } from "../js/editor/smartReplace.js";
import { hydrateIcons, icon } from "../js/ui/icons.js";
import { keyboardRouter } from "../js/ui/keyboardRouter.js";
import { initGlobalSearchModal } from "../js/ui/globalSearchModal.js";
import { initLivePreviewModal } from "../js/ui/livePreviewModal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const GH_TOK = "ghp_Round2ValidToken1234567890abcdef";
const GEMINI_TOK = "AIzaSyRound2TestKey1234567890abcdefghijk";

const originalFetch = globalThis.fetch;
const originalRaf = globalThis.window.requestAnimationFrame;
const originalLocalStorage = globalThis.localStorage;
const originalSessionStorage = globalThis.sessionStorage;

function makeDomEl(tag, id = "", attrs = {}) {
  const el = document.createElement(tag);
  if (id) el.id = id;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") el.className = v;
    else if (k === "textContent") el.textContent = v;
    else if (k === "hidden") el.hidden = Boolean(v);
    else if (k === "value") el.value = v;
    else if (k === "type") el.type = v;
    else el.setAttribute(k, v);
  }
  el.showModal = () => { el.open = true; };
  el.close = () => {
    el.open = false;
    el.dispatchEvent(new Event("close"));
  };
  el.select = () => {};
  el.scrollIntoView = () => {};
  document.body.appendChild(el);
  return el;
}

function makeFakeSseResponse(chunks) {
  const encoder = new TextEncoder();
  let idx = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx++]));
      } else {
        controller.close();
      }
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

function parseOklch(tokenVal) {
  const m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i.exec(tokenVal.trim());
  if (!m) return null;
  return {
    L: parseFloat(m[1]) / 100,
    C: parseFloat(m[2]),
    h: parseFloat(m[3]),
    a: m[4] !== undefined ? parseFloat(m[4]) : 1
  };
}

function oklchToLinearSrgb({ L, C, h }) {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r: Math.max(0, Math.min(1, 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: Math.max(0, Math.min(1, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: Math.max(0, Math.min(1, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))
  };
}

function compositeOver(fg, bg) {
  const alpha = fg.a ?? 1;
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha)
  };
}

function relativeLuminance({ r, g, b }) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

beforeEach(() => {
  resetAuthSecurityState();
  globalThis.localStorage = originalLocalStorage;
  globalThis.sessionStorage = originalSessionStorage;
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
  document.body.innerHTML = "";
  globalThis.window.requestAnimationFrame = (cb) => {
    cb(0);
    return 1;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window.requestAnimationFrame = originalRaf;
  globalThis.localStorage = originalLocalStorage;
  globalThis.sessionStorage = originalSessionStorage;
  document.body.innerHTML = "";
  resetAuthSecurityState();
});

describe("Ronda 2 — Parte 1: Core, GitHub, Storage, Seguridad y Búsqueda", () => {
  test("GitHub 403 de permisos/rate-limit no dispara lockout y preserva '/' en {path}", async () => {
    const requestedUrls = [];
    globalThis.fetch = async (url, init = {}) => {
      requestedUrls.push(`${init.method || "GET"} ${String(url)}`);
      const u = new URL(url);
      if (u.pathname === "/gists") {
        return new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), {
          status: 403
        });
      }
      if (u.pathname === "/repos/o/r/branches/main") {
        return new Response(JSON.stringify({ message: "Git Repository is empty." }), { status: 409 });
      }
      if (init.method === "PUT" && u.pathname.startsWith("/repos/o/r/contents/")) {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403
        });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    };

    await assert.rejects(
      () =>
        gh.pushAtomicCommit({
          token: GH_TOK,
          owner: "o",
          repo: "r",
          branch: "main",
          message: "init",
          changes: [{ path: "src/sub/app.js", content: "console.log(1);", status: "added" }]
        }),
      (err) => err.status === 403
    );
    assert.ok(
      requestedUrls.some((u) => u.includes("PUT https://api.github.com/repos/o/r/contents/src/sub/app.js")),
      "Debe preservar '/' sin codificar como %2F"
    );

    await assert.rejects(
      () => gh.fetchUserGistBackups(GH_TOK),
      (err) => err.status === 403 && /permiso para Gists/i.test(err.message)
    );
    assert.equal(checkAuthLockout("github").failedAttempts, 0, "403 de permisos/rate-limit no debe activar lockout");
  });

  test("fetchRepoTreeIndex: 404 en rama faltante de repo con commits no reporta isEmptyRepo=true", async () => {
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/repos/o/r/branches/missing-branch") {
        return new Response(JSON.stringify({ message: "Branch not found" }), { status: 404 });
      }
      if (u.pathname === "/repos/o/r") {
        return new Response(JSON.stringify({ default_branch: "main", size: 42 }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    };

    await assert.rejects(
      () => gh.fetchRepoTreeIndex({ token: GH_TOK, owner: "o", repo: "r", branch: "missing-branch" }),
      (err) => err.status === 404
    );
  });

  test("Binarios end-to-end: fetchSingleRepoBlob -> buildRemotePullPlan -> applyRemotePullPlan -> getPendingGithubChanges", async () => {
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    const pngB64 = Buffer.from(pngBytes).toString("base64");
    const updatedPngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xab, 0xcd]);
    const updatedPngB64 = Buffer.from(updatedPngBytes).toString("base64");

    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/repos/o/binrepo/git/blobs/sha-png-2") {
        return new Response(JSON.stringify({ content: `${pngB64}\n`, encoding: "base64" }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    };

    const fetched = await gh.fetchSingleRepoBlob({
      token: GH_TOK,
      owner: "o",
      repo: "binrepo",
      blobSha: "sha-png-2",
      path: "assets/logo.png"
    });
    assert.equal(fetched.isBinary, true);
    assert.equal(fetched.base64, pngB64);
    assert.equal(fetched.content, "");

    const proj = await hydrateGithubProject({
      owner: "o",
      repo: "binrepo",
      branch: "main",
      commitSha: "C1",
      files: [{ path: "assets/logo.png", content: "", isBinary: true, base64: "AQID", sha: "sha-png-1" }]
    });

    try {
      const localEntries = await getProjectEntries(proj.id);
      const plan = await buildRemotePullPlan({
        project: { offlineCached: true },
        localEntries,
        classification: {
          safeUpdates: [{ path: "assets/logo.png", status: "modified", blobSha: "sha-png-2" }],
          safeDeletions: [],
          conflicts: []
        },
        newCommitSha: "C2",
        fetchBlob: (blobSha, filePath) =>
          gh.fetchSingleRepoBlob({ token: GH_TOK, owner: "o", repo: "binrepo", blobSha, path: filePath })
      });

      assert.equal(plan.updates.length, 1);
      assert.equal(plan.updates[0].isBinary, true);
      assert.equal(plan.updates[0].base64, pngB64);

      await applyRemotePullPlan(proj.id, plan);
      const afterPull = await getProjectEntries(proj.id);
      const pulledLogo = afterPull.find((e) => e.path === "assets/logo.png");
      assert.equal(pulledLogo.isBinary, true);
      assert.equal(pulledLogo.base64, pngB64);
      assert.equal(pulledLogo.baseBase64, pngB64);
      assert.equal((await getPendingGithubChanges(proj.id)).length, 0);

      // Editar binario localmente debe detectarse vía baseBase64
      await upsertEntry(proj.id, "assets/logo.png", {
        isFolder: false,
        content: "",
        isBinary: true,
        base64: updatedPngB64
      });
      const pending = await getPendingGithubChanges(proj.id);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].status, "modified");
      assert.equal(pending[0].isBinary, true);
      assert.equal(pending[0].base64, updatedPngB64);
    } finally {
      await deleteProject(proj.id);
    }
  });

  test("workspaceDb: convertLocalProjectToGithub preserva tombstones deleted=true y updateFileContent no los resucita", async () => {
    const localProj = await createLocalProject("Tombstone Test");
    await upsertEntry(localProj.id, "keep.js", { isFolder: false, content: "export const a = 1;" });
    await upsertEntry(localProj.id, "gone.js", { isFolder: false, content: "export const b = 2;" });
    await deleteProjectEntry(localProj.id, "gone.js");

    // updateFileContent no resucita tombstones, pero sí crea rutas completamente nuevas
    await updateFileContent(localProj.id, "gone.js", "resurrected");
    assert.equal(await getEntryRecord(localProj.id, "gone.js"), null, "Tombstone no debe volver como registro activo");
    const allBeforeConvert = await getAllRawProjectEntries(localProj.id);
    const goneBeforeConvert = allBeforeConvert.find((e) => e.path === "gone.js");
    assert.equal(goneBeforeConvert?.deleted, true);

    await updateFileContent(localProj.id, "brand-new.js", "console.log('new');");
    const brandNew = await getEntryRecord(localProj.id, "brand-new.js");
    assert.equal(brandNew?.deleted, false);
    assert.equal(brandNew?.content, "console.log('new');");

    const converted = await convertLocalProjectToGithub(localProj.id, {
      owner: "studio",
      repo: "tombstone-repo",
      branch: "main",
      commitSha: "SHA123"
    });

    try {
      assert.equal(await getProject(localProj.id), null);
      const entries = await getAllRawProjectEntries(converted.id);
      const goneEntry = entries.find((e) => e.path === "gone.js");
      assert.equal(goneEntry?.deleted, true);
      assert.notEqual(goneEntry?.trackedInGithub, true);
      const keepEntry = entries.find((e) => e.path === "keep.js");
      assert.equal(keepEntry?.trackedInGithub, true);
    } finally {
      await deleteProject(converted.id).catch(() => {});
      await deleteProject(localProj.id).catch(() => {});
    }
  });

  test("githubController: evita doble push concurrente y btnCreateBranch migra al nuevo project.id", async () => {
    const proj = await hydrateGithubProject({
      owner: "o",
      repo: "ctrl-repo",
      branch: "main",
      commitSha: "BASE_SHA_1",
      files: [{ path: "index.js", content: "console.log(1);" }]
    });
    await updateFileContent(proj.id, "index.js", "console.log(2);");

    let activeProj = await getProject(proj.id);
    const syncedIds = [];
    let releaseFlush;
    let flushCalls = 0;
    let resolveSync;
    let nextSyncPromise = new Promise((r) => { resolveSync = r; });

    makeDomEl("button", "btn-gh-push");
    makeDomEl("button", "btn-gh-conflict-force");
    makeDomEl("input", "gh-commit-msg", { value: "feat: atomic guard" });
    makeDomEl("div", "gh-push-status");
    makeDomEl("div", "gh-conflict-box", { hidden: true });
    makeDomEl("input", "gh-new-branch-input", { value: "feature/r2" });
    const newBranchBox = makeDomEl("div", "gh-new-branch-box");
    const btnCreateBranch = makeDomEl("button", "btn-gh-create-branch");
    makeDomEl("div", "gh-branch-status", { hidden: true });
    makeDomEl("select", "gh-sync-branch-select");
    makeDomEl("div", "gh-sync-section");
    makeDomEl("div", "gh-sync-repo-title");
    makeDomEl("div", "gh-changes-list");

    gh.saveGithubToken(GH_TOK);

    let commitRequests = 0;
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.pathname === "/repos/o/ctrl-repo/branches/main") {
        return new Response(
          JSON.stringify({ commit: { sha: "BASE_SHA_1", commit: { tree: { sha: "BASE_TREE_1" } } } }),
          { status: 200 }
        );
      }
      if (init.method === "POST" && u.pathname === "/repos/o/ctrl-repo/git/commits") {
        commitRequests += 1;
        return new Response(JSON.stringify({ sha: "NEW_COMMIT_SHA" }), { status: 201 });
      }
      if (init.method === "POST" && u.pathname === "/repos/o/ctrl-repo/git/trees") {
        return new Response(JSON.stringify({ sha: "NEW_TREE_SHA" }), { status: 201 });
      }
      if (init.method === "PATCH" && u.pathname === "/repos/o/ctrl-repo/git/refs/heads/main") {
        return new Response(JSON.stringify({ object: { sha: "NEW_COMMIT_SHA" } }), { status: 200 });
      }
      if (init.method === "POST" && u.pathname === "/repos/o/ctrl-repo/git/refs") {
        const body = JSON.parse(init.body);
        assert.equal(body.ref, "refs/heads/feature/r2");
        assert.equal(body.sha, "NEW_COMMIT_SHA");
        return new Response(JSON.stringify({ ref: body.ref, object: { sha: body.sha } }), { status: 201 });
      }
      if (u.pathname === "/repos/o/ctrl-repo/branches") {
        return new Response(JSON.stringify([{ name: "main" }, { name: "feature/r2" }]), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    };

    try {
      initGithubController({
        getActiveProject: () => activeProj,
        onFlushPendingSaves: async () => {
          flushCalls += 1;
          if (flushCalls === 1) {
            await new Promise((r) => { releaseFlush = r; });
          }
        },
        onProjectClonedOrSynced: async (id) => {
          syncedIds.push(id);
          activeProj = await getProject(id);
          const done = resolveSync;
          nextSyncPromise = new Promise((r) => { resolveSync = r; });
          done();
        },
        onReposListChanged: () => {},
        onOpenDiff: () => {}
      });

      const pushBtn = document.getElementById("btn-gh-push");
      pushBtn.click();
      pushBtn.click();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(flushCalls, 1, "El segundo click durante el flush pendiente debe ignorarse por isPushing");

      const firstSync = nextSyncPromise;
      releaseFlush();
      await firstSync;
      assert.equal(commitRequests, 1);
      assert.equal(activeProj.github.commitSha, "NEW_COMMIT_SHA");

      const secondSync = nextSyncPromise;
      btnCreateBranch.click();
      await secondSync;
      assert.equal(newBranchBox.hidden, true);
      assert.equal(activeProj.github.branch, "feature/r2");
      assert.equal(syncedIds[syncedIds.length - 1], activeProj.id);
    } finally {
      await deleteProject(proj.id).catch(() => {});
      if (activeProj?.id && activeProj.id !== proj.id) {
        await deleteProject(activeProj.id).catch(() => {});
      }
    }
  });

  test("githubLocalBackupPanel: 403 de Gists no invalida token y confirmPublishBtn propaga converted.id", async () => {
    const localProj = await createLocalProject("Mi App Local");
    await upsertEntry(localProj.id, "main.js", { isFolder: false, content: "console.log('hi');" });
    gh.saveGithubToken(GH_TOK);

    const dialog = makeDomEl("dialog", "github-dialog");
    const tokenInput = makeDomEl("input", "gh-token-input");
    makeDomEl("section", "gh-local-backup-section");
    makeDomEl("span", "gh-local-project-name");
    makeDomEl("button", "btn-gh-backup-gist");
    makeDomEl("span", "btn-gh-backup-gist-text");
    makeDomEl("button", "btn-gh-publish-repo");
    makeDomEl("div", "gh-publish-repo-box", { hidden: true });
    makeDomEl("input", "gh-publish-name-input", { value: "mi-app-publicada" });
    makeDomEl("select", "gh-publish-visibility-select", { value: "private" });
    const confirmPublishBtn = makeDomEl("button", "btn-gh-confirm-publish");
    makeDomEl("button", "btn-gh-cancel-publish");
    const statusEl = makeDomEl("div", "gh-local-backup-status");
    const gistSelect = makeDomEl("select", "gh-gist-select");
    makeDomEl("button", "btn-gh-restore-gist");
    makeDomEl("div", "gh-gist-restore-status");

    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.pathname === "/gists") {
        return new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), {
          status: 403
        });
      }
      if (init.method === "POST" && u.pathname === "/user/repos") {
        return new Response(JSON.stringify({
          name: "mi-app-publicada",
          full_name: "u/mi-app-publicada",
          owner: { login: "u" },
          default_branch: "main"
        }), { status: 201 });
      }
      if (init.method === "PUT" && u.pathname.startsWith("/repos/u/mi-app-publicada/contents/")) {
        return new Response(JSON.stringify({ commit: { sha: "PUB_COMMIT_1", tree: { sha: "PUB_TREE_1" } } }), {
          status: 201
        });
      }
      if (init.method === "POST" && u.pathname === "/repos/u/mi-app-publicada/git/blobs") {
        return new Response(JSON.stringify({ sha: "PUB_BLOB_1" }), { status: 201 });
      }
      if (init.method === "POST" && u.pathname === "/repos/u/mi-app-publicada/git/trees") {
        return new Response(JSON.stringify({ sha: "PUB_TREE_2" }), { status: 201 });
      }
      if (init.method === "POST" && u.pathname === "/repos/u/mi-app-publicada/git/commits") {
        return new Response(JSON.stringify({ sha: "PUB_COMMIT_1" }), { status: 201 });
      }
      if (init.method === "PATCH" && u.pathname === "/repos/u/mi-app-publicada/git/refs/heads/main") {
        return new Response(JSON.stringify({ ref: "refs/heads/main" }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    };

    const synced = [];
    let resolvePublished;
    const publishedPromise = new Promise((r) => { resolvePublished = r; });
    const panel = initGithubLocalBackupPanel({
      dialog,
      tokenInput,
      getActiveProject: () => localProj,
      onFlushPendingSaves: async () => {},
      onProjectClonedOrSynced: async (id) => {
        synced.push(id);
        resolvePublished();
      },
      onRefreshSyncPanel: async () => {}
    });

    await panel.refresh(localProj);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(gistSelect.innerHTML.includes("no tiene permiso para Gists"));
    assert.equal(gh.getGithubToken(), GH_TOK, "403 en /gists no debe borrar el token");

    confirmPublishBtn.click();
    await Promise.race([
      publishedPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout esperando publish. status="${statusEl.textContent}"`)), 1000)
      )
    ]);

    try {
      assert.equal(synced.length, 1);
      assert.notEqual(synced[0], localProj.id);
      const migrated = await getProject(synced[0]);
      assert.equal(migrated?.kind, "github");
      assert.equal(migrated?.github?.commitSha, "PUB_COMMIT_1");
      assert.ok(statusEl.textContent.includes("u/mi-app-publicada"));
    } finally {
      if (synced[0]) await deleteProject(synced[0]).catch(() => {});
      await deleteProject(localProj.id).catch(() => {});
    }
  });

  test("emergencyBackup: no pisa datos más recientes en IndexedDB y verifica igualdad exacta antes de limpiar", async () => {
    const pid = "proj-eb";
    const key = getEmergencyBackupKey(pid, "tabA");
    writeEmergencyBackup([{ projectId: pid, filePath: "a.js", content: "old_backup" }], localStorage, pid, "tabA");
    const parsed = JSON.parse(localStorage.getItem(key));
    parsed.savedAt = 1000;
    const rawOld = JSON.stringify(parsed);
    localStorage.setItem(key, rawOld);

    const written = [];
    const restored = await restoreEmergencyBackup(
      {
        entryExists: async () => true,
        getEntryRecord: async () => ({ path: "a.js", updatedAt: 5000 }),
        updateFileContent: async (p, f, c) => {
          written.push({ p, f, c });
        }
      },
      localStorage,
      pid,
      "tabA"
    );

    assert.equal(restored, 0);
    assert.equal(written.length, 0, "Backup más viejo que record.updatedAt no debe sobrescribir");
    assert.equal(localStorage.getItem(key), null);

    // Si storage cambia durante un await de updateFileContent, no debe borrar la nueva escritura
    writeEmergencyBackup([{ projectId: pid, filePath: "b.js", content: "v1" }], localStorage, pid, "tabB");
    const keyB = getEmergencyBackupKey(pid, "tabB");
    const restored2 = await restoreEmergencyBackup(
      {
        entryExists: async () => true,
        getEntryRecord: async () => ({ path: "b.js", updatedAt: 10 }),
        updateFileContent: async () => {
          localStorage.setItem(keyB, JSON.stringify({ savedAt: Date.now(), items: [{ projectId: pid, filePath: "b.js", content: "v2_concurrent" }] }));
        }
      },
      localStorage,
      pid,
      "tabB"
    );
    assert.equal(restored2, 1);
    assert.ok(localStorage.getItem(keyB).includes("v2_concurrent"));
  });

  test("fileImport, zipExporter, credentialGuard y keyVaultCrypto cumplen endurecimiento de ronda 2", async () => {
    assert.ok(SUPPORTED_BINARY_ASSET_EXTENSIONS.has("avif"));
    assert.ok(SUPPORTED_BINARY_ASSET_EXTENSIONS.has("bmp"));
    assert.equal(SUPPORTED_BINARY_ASSET_EXTENSIONS.has("svg"), false);
    assert.equal(base64ToUint8Array("%%%invalid%%%").length, 0);
    assert.deepEqual(decodeImportedFile(null, "bad.txt"), { ok: false, reason: "contenido de archivo inválido" });
    const decodedArr = decodeImportedFile([104, 105], "hi.txt");
    assert.equal(decodedArr.ok, true);
    assert.equal(decodedArr.text, "hi");

    // zipExporter: deduplicación, versión UNIX 0x0314 y atributos 0x81a40000
    const zip = buildZipArchive([
      { path: "src/app.js", content: "v1" },
      { path: "/src/./app.js", content: "v2" }
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let cdOffset = -1;
    for (let i = 0; i < zip.length - 4; i += 1) {
      if (view.getUint32(i, true) === 0x02014b50) {
        cdOffset = i;
        break;
      }
    }
    assert.ok(cdOffset > 0);
    assert.equal(view.getUint16(cdOffset + 4, true), 0x0314);
    assert.equal(view.getUint32(cdOffset + 38, true), 0x81a40000);
    assert.ok(new TextDecoder().decode(zip).includes("v2"));
    assert.equal(new TextDecoder().decode(zip).includes("v1"), false);

    // downloadZip difiere URL.revokeObjectURL
    let revokedImmediate = false;
    const origCreateUrl = URL.createObjectURL;
    const origRevokeUrl = URL.revokeObjectURL;
    URL.createObjectURL = () => "blob:mock-zip";
    URL.revokeObjectURL = () => { revokedImmediate = true; };
    try {
      downloadZip(zip, "demo.zip");
      assert.equal(revokedImmediate, false, "No debe revocar el ObjectURL sincrónicamente");
    } finally {
      URL.createObjectURL = origCreateUrl;
      URL.revokeObjectURL = origRevokeUrl;
    }

    // credentialGuard: localStorage roto no impide sessionStorage/memoria
    globalThis.localStorage = {
      getItem() { throw new Error("SecurityError"); },
      setItem() { throw new Error("QuotaExceededError"); },
      removeItem() { throw new Error("SecurityError"); }
    };
    const failState = recordAuthFailure("ai:gemini");
    assert.equal(failState.failedAttempts, 1);
    assert.equal(checkAuthLockout("ai:gemini").failedAttempts, 1);
    resetAuthSecurityState("ai:gemini");
    assert.equal(checkAuthLockout("ai:gemini").failedAttempts, 0);

    // keyVaultCrypto: rechaza iterations no finitas y cifra/descifra con iterations válidas
    await assert.rejects(
      () => encryptKeysPayload('{"gemini":"AIza..."}', "claveSegura123", { iterations: Number.NaN }),
      /iteraciones PBKDF2 inválidas/i
    );
    const vault = await encryptKeysPayload('{"gemini":"AIza123"}', "claveSegura123", { iterations: 10000 });
    const plain = await decryptKeysPayload(vault, "claveSegura123");
    assert.equal(plain, '{"gemini":"AIza123"}');
  });

  test("projectSearch: ReDoS con headers de grupo/cuantificadores adyacentes, wholeWord y offsets en líneas > 300 chars", () => {
    assert.equal(hasUnsafeReDoSPattern(".*.*!$"), true);
    assert.equal(hasUnsafeReDoSPattern("(b|.)+"), true);
    assert.equal(hasUnsafeReDoSPattern("(?<name>[a-z]+)_\\d+"), false);
    assert.equal(hasUnsafeReDoSPattern("(?:foo|bar)_baz"), false);

    const whole = searchInFiles([{ path: "a.js", content: "cat scatter dog bulldog" }], "cat|dog", {
      isRegex: true,
      matchWholeWord: true
    });
    assert.equal(whole.totalMatches, 2);
    assert.deepEqual(whole.results[0].matches.map((m) => m.matchText), ["cat", "dog"]);

    const longLine = `${"x".repeat(380)}TARGET_TOKEN${"y".repeat(60)}`;
    const res = searchInFiles([{ path: "long.txt", content: longLine }], "TARGET_TOKEN");
    assert.equal(res.totalMatches, 1);
    const m = res.results[0].matches[0];
    assert.equal(m.lineText.slice(m.start, m.end), "TARGET_TOKEN");
  });

  test("app.js + workspaceDb: cacheAndSyncGithubFile persiste binarios lazy (con/sin extensión), texto lazy, ediciones locales y tombstones deleted", async () => {
    const prevDocAddListener = document.addEventListener;
    if (typeof document.addEventListener !== "function") {
      document.addEventListener = () => {};
    }
    let applyCachedBlobRecordToFile;
    let cacheAndSyncGithubFile;
    try {
      ({ applyCachedBlobRecordToFile, cacheAndSyncGithubFile } = await import("../js/app.js"));
    } finally {
      if (prevDocAddListener === undefined) {
        delete document.addEventListener;
      } else {
        document.addEventListener = prevDocAddListener;
      }
    }

    const proj = await hydrateLazyGithubProject({
      owner: "r2owner",
      repo: "r2-lazy-blobs",
      branch: "main",
      commitSha: "COMMIT_LAZY_1",
      entries: [
        { path: "assets/logo.png", blobSha: "SHA_PNG", isBinary: true, isFolder: false },
        { path: "bin/rawdata", blobSha: "SHA_RAW", isBinary: false, isFolder: false },
        { path: "src/util.js", blobSha: "SHA_TXT", isBinary: false, isFolder: false },
        { path: "src/edited.js", blobSha: "SHA_ED", isBinary: false, isFolder: false },
        { path: "src/removed.js", blobSha: "SHA_DEL", isBinary: false, isFolder: false }
      ]
    });

    try {
      await updateFileContent(proj.id, "src/edited.js", "LOCAL_EDIT");
      await deleteProjectEntry(proj.id, "src/removed.js");

      const pngFile = { id: "assets/logo.png", path: "assets/logo.png", isBinary: true, content: "", base64: null, contentLoaded: false, blobSha: "SHA_PNG" };
      const rawFile = { id: "bin/rawdata", path: "bin/rawdata", isBinary: false, content: "", base64: null, contentLoaded: false, blobSha: "SHA_RAW" };
      const txtFile = { id: "src/util.js", path: "src/util.js", isBinary: false, content: "", base64: null, contentLoaded: false, blobSha: "SHA_TXT" };
      const editedFile = { id: "src/edited.js", path: "src/edited.js", isBinary: false, content: "", base64: null, contentLoaded: false, blobSha: "SHA_ED" };
      const removedFile = { id: "src/removed.js", path: "src/removed.js", isBinary: false, content: "", base64: null, contentLoaded: false, blobSha: "SHA_DEL" };

      // 1. Binario lazy con extensión conocida (simula blobPayload completo de fetchSingleRepoBlob)
      const r1 = await cacheAndSyncGithubFile({
        projectId: proj.id,
        fileObj: pngFile,
        remotePayload: { isBinary: true, base64: "iVBORw0=", content: "" },
        blobSha: "SHA_PNG"
      });
      assert.equal(r1.deleted, false);
      assert.equal(pngFile.isBinary, true);
      assert.equal(pngFile.base64, "iVBORw0=");
      assert.equal(pngFile.baseBase64, "iVBORw0=");
      assert.equal(pngFile.contentLoaded, true);

      // 2. Binario lazy sin extensión inicialmente isBinary=false (detectado dinámicamente en batch/blob)
      const r2 = await cacheAndSyncGithubFile({
        projectId: proj.id,
        fileObj: rawFile,
        remotePayload: { path: "bin/rawdata", isBinary: true, base64: "AAECAw==", content: "", blobSha: "SHA_RAW" },
        blobSha: "SHA_RAW"
      });
      assert.equal(r2.deleted, false);
      assert.equal(rawFile.isBinary, true);
      assert.equal(rawFile.base64, "AAECAw==");
      assert.equal(rawFile.baseBase64, "AAECAw==");
      assert.equal(rawFile.contentLoaded, true);

      // 3. Texto lazy
      const r3 = await cacheAndSyncGithubFile({
        projectId: proj.id,
        fileObj: txtFile,
        remotePayload: { isBinary: false, base64: null, content: "export const u = 1;" },
        blobSha: "SHA_TXT"
      });
      assert.equal(r3.deleted, false);
      assert.equal(txtFile.isBinary, false);
      assert.equal(txtFile.content, "export const u = 1;");
      assert.equal(txtFile.baseContent, "export const u = 1;");
      assert.equal(txtFile.base64, null);
      assert.equal(txtFile.contentLoaded, true);

      // 4. Edición local previa no es pisada y fileObj se reconcilia con saved
      const r4 = await cacheAndSyncGithubFile({
        projectId: proj.id,
        fileObj: editedFile,
        remotePayload: { isBinary: false, base64: null, content: "REMOTE_OLD" },
        blobSha: "SHA_ED"
      });
      assert.equal(r4.deleted, false);
      assert.equal(editedFile.content, "LOCAL_EDIT");
      assert.equal(editedFile.contentLoaded, true);

      // 5. Tombstone deleted=true no resucita ni en IndexedDB ni en memoria
      const r5 = await cacheAndSyncGithubFile({
        projectId: proj.id,
        fileObj: removedFile,
        remotePayload: { isBinary: false, base64: null, content: "SHOULD_STAY_DELETED" },
        blobSha: "SHA_DEL"
      });
      assert.equal(r5.deleted, true);
      assert.equal(removedFile.deleted, true);
      assert.equal(await getEntryRecord(proj.id, "src/removed.js"), null);

      const rawEntries = await getAllRawProjectEntries(proj.id);
      const byPath = new Map(rawEntries.map((e) => [e.path, e]));
      assert.equal(byPath.get("assets/logo.png")?.base64, "iVBORw0=");
      assert.equal(byPath.get("assets/logo.png")?.baseBase64, "iVBORw0=");
      assert.equal(byPath.get("bin/rawdata")?.isBinary, true);
      assert.equal(byPath.get("bin/rawdata")?.base64, "AAECAw==");
      assert.equal(byPath.get("bin/rawdata")?.baseBase64, "AAECAw==");
      assert.equal(byPath.get("src/util.js")?.content, "export const u = 1;");
      assert.equal(byPath.get("src/edited.js")?.content, "LOCAL_EDIT");
      assert.equal(byPath.get("src/removed.js")?.deleted, true);

      const pending = await getPendingGithubChanges(proj.id);
      const pendingByPath = new Map(pending.map((c) => [c.path, c]));
      assert.equal(pendingByPath.has("assets/logo.png"), false);
      assert.equal(pendingByPath.has("bin/rawdata"), false);
      assert.equal(pendingByPath.has("src/util.js"), false);
      assert.equal(pendingByPath.get("src/edited.js")?.status, "modified");
      assert.equal(pendingByPath.get("src/removed.js")?.status, "deleted");

      // Reconciliación directa cuando saved es null
      const fallbackFile = { path: "extra.png", isBinary: false, content: "old", base64: null, contentLoaded: false };
      applyCachedBlobRecordToFile(fallbackFile, null, { isBinary: true, base64: "AQID", content: "" });
      assert.equal(fallbackFile.isBinary, true);
      assert.equal(fallbackFile.base64, "AQID");
      assert.equal(fallbackFile.content, "");
      assert.equal(fallbackFile.contentLoaded, true);
    } finally {
      await deleteProject(proj.id).catch(() => {});
    }
  });
});

describe("Ronda 2 — Parte 2: AI y Preview", () => {
  test("chatController: sin duplicar último turno, streamProviderId en fly, fences dinámicos, rutas con '-' y ARIA toggleKeyVisBtn", async () => {
    assert.equal(detectFilePathFromCodeSegment("ts path=src/my-app/user-card.ts", "export const x = 1;"), "src/my-app/user-card.ts");
    const segs = parseMarkdownSegments("````md\n```js\ncode\n```\n````");
    assert.equal(segs.length, 1);
    assert.equal(segs[0].type, "code");
    assert.ok(segs[0].code.includes("```js"));

    saveProviderId("gemini");
    saveApiKey("gemini", GEMINI_TOK);

    makeDomEl("button", "btn-ai-settings");
    makeDomEl("button", "btn-ai-clear-chat");
    makeDomEl("div", "chat-settings-drawer", { hidden: true });
    makeDomEl("span", "chat-current-model-label");
    makeDomEl("button", "chat-key-status-btn");
    const providerSelect = makeDomEl("select", "ai-provider-select");
    makeDomEl("select", "ai-model-select");
    makeDomEl("input", "ai-custom-model-input");
    makeDomEl("button", "ai-fetch-models-btn");
    makeDomEl("input", "ai-api-key-input");
    const toggleKeyVisBtn = makeDomEl("button", "ai-toggle-key-vis");
    makeDomEl("button", "ai-clear-key-btn");
    makeDomEl("div", "ai-provider-help");
    makeDomEl("button", "ai-mode-local");
    makeDomEl("button", "ai-mode-session");
    makeDomEl("button", "ai-export-keys-btn");
    makeDomEl("button", "ai-import-keys-btn");
    makeDomEl("div", "ai-import-keys-slot");
    makeDomEl("div", "chat-extra-tabs");
    makeDomEl("div", "chat-stream");
    makeDomEl("div", "chat-scroll-body");
    const composerForm = makeDomEl("form", "chat-composer-form");
    const promptInput = makeDomEl("textarea", "chat-prompt-input");
    makeDomEl("button", "chat-submit-btn");
    makeDomEl("span", "chat-token-counter");
    makeDomEl("button", "btn-chat-regenerate");

    let capturedBody = null;
    let releaseStream;
    let resolveFetchDone;
    const fetchDone = new Promise((r) => { resolveFetchDone = r; });
    globalThis.fetch = async (_url, init = {}) => {
      capturedBody = JSON.parse(init.body);
      await new Promise((r) => { releaseStream = r; });
      setTimeout(resolveFetchDone, 20);
      return new Response(JSON.stringify({ error: { message: "API key invalid" } }), { status: 401 });
    };

    const ctrl = initChatController({
      getContextSnapshot: () => ({
        projectName: "demo",
        activeFile: {
          id: "README.md",
          name: "README.md",
          path: "README.md",
          lang: "markdown",
          content: "```js\nalert(1)\n```",
          cursorLine: 1
        },
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

    assert.equal(toggleKeyVisBtn.getAttribute("aria-pressed"), "false");
    assert.equal(toggleKeyVisBtn.getAttribute("aria-label"), "Mostrar clave");
    toggleKeyVisBtn.click();
    assert.equal(toggleKeyVisBtn.getAttribute("aria-pressed"), "true");
    assert.equal(toggleKeyVisBtn.getAttribute("aria-label"), "Ocultar clave");

    promptInput.value = "Hola turno 1";
    const submitEv = new Event("submit", { cancelable: true });
    submitEv.preventDefault = () => {};
    composerForm.dispatchEvent(submitEv);
    await new Promise((r) => setTimeout(r, 20));

    // Cambiar de proveedor mientras el stream está en vuelo
    providerSelect.value = "groq";
    providerSelect.dispatchEvent(new Event("change"));
    releaseStream?.();
    await Promise.race([
      fetchDone,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout esperando fetchDone en chatController")), 1000))
    ]);
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(capturedBody);
    const userContents = capturedBody.contents.map((c) => c.parts[0].text);
    assert.deepEqual(userContents, ["Hola turno 1"], "No debe duplicar el último turno de usuario");
    assert.ok(
      capturedBody.systemInstruction.parts[0].text.includes("````"),
      "Debe usar delimitador dinámico de backticks cuando el archivo contiene ```"
    );
    assert.equal(checkAuthLockout("ai:gemini").failedAttempts, 1);
    assert.equal(checkAuthLockout("ai:groq").failedAttempts, 0, "401 tardío debe imputarse a streamProviderId");
    ctrl.clearConversation?.();
  });

  test("providers.js: AbortSignal vivo en consumeSseStream, SSE multi-línea data: y fallback ante HTTP 500", async () => {
    // 1. SSE multi-línea data: combinado por línea en blanco
    const chunks = [];
    globalThis.fetch = async () =>
      makeFakeSseResponse([
        'data: {"candidates":[{"content":{"parts":\n',
        'data: [{"text":"Hola\\nSSE"}]}}]}\n\n'
      ]);

    await streamAiCompletion({
      providerId: "gemini",
      model: "gemini-2.5-flash",
      apiKey: GEMINI_TOK,
      systemPrompt: "sys",
      history: [{ role: "user", content: "hi" }],
      onChunk: (c) => chunks.push(c)
    });
    assert.equal(chunks.join(""), "Hola\nSSE");

    // 2. AbortSignal vivo durante lectura del stream
    const ac = new AbortController();
    globalThis.fetch = async (url) => {
      if (!String(url).includes(":streamGenerateContent")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      const stream = new ReadableStream({
        pull() {
          return new Promise(() => {});
        }
      });
      return new Response(stream, { status: 200 });
    };
    const p = streamAiCompletion({
      providerId: "gemini",
      model: "gemini-2.5-flash",
      apiKey: GEMINI_TOK,
      systemPrompt: "sys",
      history: [{ role: "user", content: "hi" }],
      signal: ac.signal,
      onChunk: () => {}
    });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(() => p, (err) => err?.name === "AbortError");

    // 3. HTTP 500 dispara fallback al siguiente modelo en Groq/OpenAI-compatible
    let calls = 0;
    const out = [];
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "Internal Server Error" } }), { status: 500 });
      }
      return makeFakeSseResponse(['data: {"choices":[{"delta":{"content":"Recuperado"}}]}\n\ndata: [DONE]\n\n']);
    };

    await streamAiCompletion({
      providerId: "groq",
      model: "llama-3.3-70b-versatile",
      apiKey: "gsk_Round2ValidGroqKey1234567890abcdef",
      systemPrompt: "sys",
      history: [{ role: "user", content: "hi" }],
      onChunk: (c) => out.push(c)
    });
    assert.ok(calls >= 2);
    assert.equal(out.join(""), "Recuperado");
  });

  test("tsTranspiler: return !x, Array<Array<number>>, public readonly en constructor y ASI interface/declare", () => {
    const src = [
      "const flag = true",
      "function inv(x: boolean): boolean {",
      "  return !x",
      "}",
      "const matrix: Array<Array<number>> = [[1, 2]]",
      "class User {",
      "  constructor(public readonly id: number) {}",
      "}",
      "const a = 1",
      "interface Foo { x: number }",
      "export declare const BAR: string",
      "const b = 2"
    ].join("\n");

    const { code: js } = transpileTypeScriptAndJsx(src, { jsx: false });
    assert.ok(js.includes("return !x"), "No debe corromper return !x");
    assert.equal(js.includes("export declare"), false);
    assert.equal(/\bexport\s*;?\s*$/m.test(js), false, "No debe dejar export huérfano tras declare");
    assert.equal(js.includes("readonly"), false, "constructor(public readonly id) no debe dejar readonly");
    assert.doesNotThrow(() => acorn.parse(js, { ecmaVersion: "latest", sourceType: "module" }));

    const mod = {};
    vm.runInNewContext(
      `${js.replace(/^export\s+/gm, "")}; this.res = { inv: inv(false), matrix, u: new User(7).id, a, b };`,
      mod
    );
    assert.equal(mod.res.inv, true);
    assert.deepEqual(JSON.parse(JSON.stringify(mod.res.matrix)), [[1, 2]]);
    assert.equal(mod.res.u, 7);
    assert.equal(mod.res.a, 1);
    assert.equal(mod.res.b, 2);
  });

  test("moduleBundler: import.meta, ./sub/../../x, ciclos con live bindings y exclusión contentLoaded=false", () => {
    const map = buildExactModuleMap([
      { path: "src/main.js", content: "" },
      { path: "secret.js", content: "export const s = 1;" },
      { path: "src/lazy.js", content: "", contentLoaded: false }
    ]);
    assert.equal(resolveLocalModuleEntry("./sub/../../secret.js", "src/main.js", map, { allowParentTraversal: false }), null);
    assert.equal(resolveLocalModuleEntry("./lazy.js", "src/main.js", map), null);

    const bundle = buildVirtualModuleBundle({
      entryPath: "main.js",
      entryCode: `
        import { getB, incA } from "./a.js";
        import { bVal } from "./b.js";
        const metaUrl = import.meta.url;
        incA();
        globalThis.__mbResult = { bVal, afterInc: getB(), metaUrl };
      `,
      exactMap: buildExactModuleMap([
        {
          path: "a.js",
          content: `
            import { bVal } from "./b.js";
            export let count = 1;
            export function incA() { count += 1; }
            export function getB() { return bVal + count; }
          `
        },
        {
          path: "b.js",
          content: `
            import { count } from "./a.js";
            export const bVal = 10;
            export function readA() { return count; }
          `
        }
      ])
    });

    const { scriptCode } = formatVirtualModuleExecution(bundle);
    const ctx = { console };
    ctx.globalThis = ctx;
    ctx.window = ctx;
    ctx.self = ctx;
    vm.runInNewContext(scriptCode, ctx);
    assert.equal(ctx.__mbResult.bVal, 10);
    assert.equal(ctx.__mbResult.afterInc, 12);
    assert.equal(typeof ctx.__mbResult.metaUrl, "string");
  });

  test("htmlBundler: @supports ((...)), </script > case-insensitive y url(...) relativo", () => {
    const html = `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="./styles/main.css">
      <style>.bg { background: url("./img/dot.png"); }</style>
    </head><body><script src="./app.js"></script></body></html>`;

    const files = [
      { path: "index.html", content: html },
      { path: "styles/main.css", content: `@import url("./part.css") supports((display: grid) and (gap: 1rem));` },
      { path: "styles/part.css", content: `.box { display: grid; background: url("../img/dot.png"); }` },
      { path: "img/dot.png", content: "", isBinary: true, base64: "AQID" },
      { path: "app.js", content: `const s = "</script > </STYLE >";` }
    ];

    const bundled = bundleHtmlWithFolderAssets("index.html", html, buildWorkspaceAssetMap(files));
    assert.ok(bundled.includes("@supports ((display: grid) and (gap: 1rem))"));
    assert.ok(bundled.includes("data:image/png;base64,AQID"));
    assert.equal(/<\/script\s*>\s*<\/STYLE/i.test(bundled), false, "Debe escapar </script > y </style > dentro de JS");
  });

  test("loopGuard: protege shadowing, sobrevive a try-catch con estado sticky y clearInterval no borra su timer", () => {
    const inst = instrumentLoops("const __studioLoopGuard = () => {}; while (true) { break; }", acorn);
    assert.ok(inst.code.includes("globalThis.__studioLoopGuard("));

    let fakeNow = 0;
    const cleared = [];
    const timerIds = [101];
    const sandbox = {
      window: null,
      globalThis: null,
      Date: { now: () => fakeNow },
      Error,
      console: { error() {} },
      setInterval: () => timerIds[0],
      clearInterval: (id) => cleared.push(id),
      clearTimeout: (id) => cleared.push(id)
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInNewContext(buildLoopGuardRuntime(100), sandbox);
    sandbox.clearInterval(101);
    assert.deepEqual(cleared, []);

    fakeNow = 250;
    assert.throws(() => {
      vm.runInNewContext("try { __studioLoopGuard(1); } catch (_) {} __studioLoopGuard(2);", sandbox);
    }, (err) => err?.isLoopGuardError === true);
  });

  test("pythonRunner, sqlRunner y cRunner: contratos de ejecución, límites y diagnósticos", () => {
    const pyHtml = buildStandalonePythonPreview({ path: "main.py", shortName: "main.py", content: "print(1)" });
    assert.ok(pyHtml.includes("_studio_repl_ns"));
    assert.ok(pyHtml.includes("sys.settrace"));
    assert.ok(pyHtml.includes("canStop: false"));

    assert.equal(hasLimitClause("SELECT * FROM (SELECT * FROM t LIMIT 5)"), false);
    assert.equal(hasLimitClause("SELECT * FROM t LIMIT (50)"), true);
    assert.equal(hasLimitClause("SELECT * FROM t LIMIT -1"), true);

    const csv = convertResultsToCsv([{ columns: ["f"], values: [["=CMD()"], ["+SUM(1)"], ["-1+1"], ["-42"]] }]);
    assert.ok(csv.includes('"\'=CMD()"'));
    assert.ok(csv.includes('"\'+SUM(1)"'));
    assert.ok(csv.includes('"\'-1+1"'));
    assert.equal(csv.includes("'-42"), false);

    const sqlHtml = buildSqlRunnerPreview({ path: "q.sql", shortName: "q.sql", content: "SELECT 1;" });
    assert.ok(sqlHtml.includes("EXPORT_MAX_ROWS = 10000"));
    assert.ok(sqlHtml.includes("getExportDataset"));

    const cpp = "std::scanf(\"%d\", &x);";
    assert.equal(injectInteractiveInputGuard(cpp, "main.cpp", false), cpp);

    const diags = parseGccErrors(
      "src/app.ts(12,5): error TS2322: Type 'string' is not assignable\nProgram.cs(8,3): error CS0103: Name does not exist"
    );
    assert.equal(diags.length, 2);
    assert.equal(diags[0].line, 12);
    assert.ok(diags[0].message.includes("TS2322"));
    assert.equal(diags[1].line, 8);
    assert.ok(diags[1].message.includes("CS0103"));
  });
});

describe("Ronda 2 — Parte 3: Editor, UI, CSS, A11y y PWA", () => {
  test("splitEditorController + editorManager: aislamiento de destroy() y exclusión binaria", async () => {
    const ruler = makeDomEl("div", "editor-error-ruler");
    const acBar = makeDomEl("div", "editor-autocomplete-bar");
    const acTrack = makeDomEl("div", "editor-autocomplete-track");
    acBar.appendChild(acTrack);

    const mainMount = makeDomEl("div", "editor-mount");
    const splitMount = makeDomEl("div", "split-mount", { hidden: true });
    const splitBody = makeDomEl("div", "split-body");
    const splitTitle = makeDomEl("span", "split-title");
    const splitSelect = makeDomEl("select", "split-select");
    const stageEl = makeDomEl("div", "editor-stage");
    const dividerEl = makeDomEl("div", "split-divider", { hidden: true });

    const files = [
      { id: "a.js", path: "a.js", shortName: "a.js", language: "javascript", content: "const a = 1;" },
      { id: "logo.png", path: "logo.png", shortName: "logo.png", isBinary: true, base64: "AQID", content: "" }
    ];

    const mainEd = await createEditorManager({ mountEl: mainMount });
    mainEd.openFile(files[0]);
    mainEd.addErrorMarker(1, "SyntaxError");
    assert.equal(ruler.children.length, 1);

    const splitCtrl = createSplitEditorController({
      editorStageEl: stageEl,
      editorMountEl: mainMount,
      splitMountEl: splitMount,
      splitDividerEl: dividerEl,
      splitBodyEl: splitBody,
      splitTitleTextEl: splitTitle,
      splitFileSelectEl: splitSelect,
      getActiveProject: () => ({ id: "p1" }),
      getActiveFileId: () => "a.js",
      getFilesOnly: () => files,
      getOpenTabIds: () => ["a.js", "logo.png"],
      isFileDirtyForProject: () => false,
      renderTabs: () => {},
      scheduleAutosave: () => {}
    });

    await splitCtrl.toggle(true);
    assert.equal(splitSelect.children.length, 1);
    assert.equal(splitSelect.children[0].value, "a.js");

    await splitCtrl.openFile(files[1]);
    assert.equal(splitSelect.value, "a.js", "Al intentar abrir binario debe restaurar el select al archivo previo");

    await splitCtrl.toggle(false);
    assert.equal(ruler.children.length, 1, "destroy() del split no debe vaciar #editor-error-ruler");
    assert.equal(acBar.parentElement, document.body, "destroy() del split no debe remover #editor-autocomplete-bar");

    mainEd.destroy();
  });

  test("icons.js, codeFormatter, smartReplace, globalSearchModal y livePreviewModal", async () => {
    const svg = icon("alertTriangle");
    assert.ok(svg.startsWith("<svg ") && svg.includes('aria-hidden="true"'));
    const box = makeDomEl("div");
    const holder = makeDomEl("span");
    holder.setAttribute("data-icon", "alertTriangle");
    box.appendChild(holder);
    hydrateIcons(box);
    assert.ok(holder.innerHTML.includes("<svg "));

    const { formatted: formattedTpl } = formatCode(
      "const t = `linea1\n\nlinea3`;\nfunction f(){return /abc/g.test(t);}",
      "javascript"
    );
    assert.ok(formattedTpl.includes("linea1\n\nlinea3"));
    assert.ok(formattedTpl.includes("return /abc/g.test(t)"));

    const longDoc = [
      "function big() {",
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "  const d = 4;",
      "  const e = 5;",
      "  const f = 6;",
      "  const g = 7;",
      "  const h = 8;",
      "  const i = 9;",
      "  const j = 10;",
      "  return a + j;",
      "}",
      "const untouched = true;"
    ].join("\n");
    const rep = computeSmartReplacement(longDoc, "function big() {\n  return 42;\n}");
    assert.ok(rep.text.includes("return 42;"));
    assert.ok(rep.text.includes("const untouched = true;"));

    const shortRep = computeSmartReplacement("const a = 1;\nconst b = 2;", "const b = 99;");
    assert.equal(shortRep.text, "const a = 1;\nconst b = 99;");

    // globalSearchModal: registra blockGlobalShortcuts: true e hidrata iconos
    const gsDialog = makeDomEl("dialog", "global-search-dialog");
    const gsOpen = makeDomEl("button", "btn-global-search");
    makeDomEl("button", "btn-close-global-search");
    const gsInput = makeDomEl("input", "global-search-input");
    makeDomEl("div", "global-search-stats");
    const gsResults = makeDomEl("div", "global-search-results");
    makeDomEl("button", "btn-search-case");
    makeDomEl("button", "btn-search-word");
    makeDomEl("button", "btn-search-regex");

    const picked = [];
    initGlobalSearchModal({
      getFiles: () => [{ path: "src/app.js", content: "const needle = 1;" }],
      onSelectMatch: (m) => picked.push(m)
    });

    gsOpen.click();
    assert.equal(keyboardRouter.shouldBlockGlobalShortcuts(), true);
    gsInput.value = "needle";
    gsInput.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 180));
    assert.equal(gsResults.querySelectorAll(".search-match-row").length, 1);
    gsInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    assert.equal(picked.length, 1);
    assert.equal(picked[0].path, "src/app.js");
    assert.equal(gsDialog.open, false);

    // livePreviewModal: carga dependencias con contentLoaded === false
    makeDomEl("button", "btn-live-preview");
    makeDomEl("dialog", "preview-dialog");
    makeDomEl("h2", "preview-dialog-title");
    makeDomEl("span", "preview-file-badge");
    makeDomEl("button", "btn-preview-js-mode");
    makeDomEl("button", "btn-close-preview");
    makeDomEl("button", "btn-preview-reload");
    makeDomEl("button", "btn-preview-console");
    makeDomEl("button", "btn-preview-clear-console");
    makeDomEl("div", "preview-unavailable-state", { hidden: true });
    makeDomEl("div", "preview-unavailable-title");
    makeDomEl("div", "preview-unavailable-desc");
    makeDomEl("div", "preview-console-panel");
    makeDomEl("div", "preview-console-title");
    makeDomEl("div", "preview-console-list");
    makeDomEl("form", "preview-repl-form");
    makeDomEl("input", "preview-repl-input");
    makeDomEl("div", "preview-iframe-wrapper");
    const iframeEl = makeDomEl("iframe", "preview-iframe");
    makeDomEl("div", "preview-c-runner");
    makeDomEl("select", "preview-page-select");
    makeDomEl("button", "btn-preview-back");
    makeDomEl("button", "btn-preview-forward");

    const lazyFiles = [
      { path: "main.js", content: 'import { x } from "./dep.js"; console.log(x);', contentLoaded: true },
      { path: "dep.js", content: "", contentLoaded: false }
    ];
    const loadedPaths = [];
    initLivePreviewModal({
      getWorkspaceSnapshot: () => ({ projectId: "lp1", activeFileId: "main.js", files: lazyFiles }),
      onBeforePreview: async () => {},
      onErrorMarker: () => {},
      onClearErrorMarkers: () => {},
      onGoToLine: () => {},
      ensureFilesLoaded: async (arr) => {
        for (const f of arr) {
          loadedPaths.push(f.path);
          f.content = "export const x = 7;";
          f.contentLoaded = true;
        }
      }
    });

    document.getElementById("btn-live-preview").click();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(loadedPaths, ["dep.js"]);
    assert.ok(String(iframeEl.srcdoc || "").includes("dep.js"));
    assert.ok(String(iframeEl.srcdoc || "").includes("const x = 7"));
  });

  test("CSS: cascada @media (pointer: coarse), cero variables indefinidas y contraste WCAG AA OKLCH en 4 temas", () => {
    const tokensCss = fs.readFileSync(path.join(ROOT_DIR, "css/tokens.css"), "utf8");
    const definedVars = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));

    const cssFiles = ["base.css", "layout.css", "editor.css", "chat.css", "workspace.css", "app.css"];
    for (const file of cssFiles) {
      const content = fs.readFileSync(path.join(ROOT_DIR, "css", file), "utf8");
      const localVars = new Set([...content.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
      const refs = [...content.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]);
      for (const ref of refs) {
        if (ref === "--progress-val") continue;
        assert.ok(definedVars.has(ref) || localVars.has(ref), `Variable CSS indefinida ${ref} en css/${file}`);
      }
    }

    for (const file of ["editor.css", "chat.css", "workspace.css", "app.css"]) {
      const content = fs.readFileSync(path.join(ROOT_DIR, "css", file), "utf8");
      const lastPointerCoarse = content.lastIndexOf("@media (pointer: coarse)");
      assert.ok(lastPointerCoarse > content.length * 0.5, `@media (pointer: coarse) debe estar al final en css/${file}`);
      assert.ok(content.slice(lastPointerCoarse).includes("--text-touch-input"));
    }

    const extractBlock = (selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const m = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(tokensCss);
      assert.ok(m, `Debe existir bloque ${selector}`);
      const vars = {};
      for (const line of m[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
        vars[line[1]] = line[2].trim();
      }
      return vars;
    };

    const rootVars = extractBlock(":root");
    const themes = {
      default: rootVars,
      dracula: { ...rootVars, ...extractBlock('[data-theme="dracula"]') },
      nord: { ...rootVars, ...extractBlock('[data-theme="nord"]') },
      monokai: { ...rootVars, ...extractBlock('[data-theme="monokai"]') }
    };

    for (const [name, vars] of Object.entries(themes)) {
      const bg = oklchToLinearSrgb(parseOklch(vars["--color-paper"]));
      const bg2 = oklchToLinearSrgb(parseOklch(vars["--color-paper-2"]));
      const edBg = oklchToLinearSrgb(parseOklch(vars["--color-editor-bg"]));

      for (const tok of ["--color-ink", "--color-ink-2", "--color-muted", "--color-accent-text"]) {
        const fg = oklchToLinearSrgb(parseOklch(vars[tok]));
        assert.ok(contrastRatio(fg, bg) >= 4.5, `${name} ${tok} vs --color-paper < 4.5:1`);
        assert.ok(contrastRatio(fg, bg2) >= 4.5, `${name} ${tok} vs --color-paper-2 < 4.5:1`);
      }

      for (const tok of ["--syn-comment", "--color-gutter-ink"]) {
        const fg = oklchToLinearSrgb(parseOklch(vars[tok]));
        assert.ok(contrastRatio(fg, edBg) >= 4.5, `${name} ${tok} vs --color-editor-bg < 4.5:1`);
      }

      const accentBg = oklchToLinearSrgb(parseOklch(vars["--color-accent"]));
      const accentInk = oklchToLinearSrgb(parseOklch(vars["--color-accent-ink"]));
      assert.ok(contrastRatio(accentInk, accentBg) >= 4.5, `${name} --color-accent-ink vs --color-accent < 4.5:1`);

      const ruleStrong = compositeOver(
        { ...oklchToLinearSrgb(parseOklch(vars["--color-rule-strong"])), a: parseOklch(vars["--color-rule-strong"]).a },
        bg
      );
      assert.ok(contrastRatio(ruleStrong, bg) >= 3.0, `${name} --color-rule-strong UI contrast < 3.0:1`);
    }
  });

  test("index.html y sw.js cumplen atributos ARIA, crossorigin y reglas PWA críticas", () => {
    const html = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
    assert.ok(/fonts\.googleapis\.com[^>]*crossorigin="anonymous"/i.test(html));
    assert.ok(/id="editor-split-divider"[^>]*role="separator"[^>]*aria-orientation="vertical"[^>]*tabindex="0"[^>]*aria-label=/i.test(html));
    assert.ok(/class="[^"]*preview-device-btn[^"]*"[^>]*role="radio"[^>]*aria-checked="/i.test(html));
    assert.ok(/role="tabpanel"[^>]*aria-labelledby="settings-tab-appearance"/i.test(html));

    const sw = fs.readFileSync(path.join(ROOT_DIR, "sw.js"), "utf8");
    assert.ok(sw.includes('SHELL_CACHE = "studio-ide-shell-v30"'));
    assert.ok(sw.includes('RUNTIME_CACHE = "studio-ide-runtime-v2"'));
    assert.ok(sw.includes('response.type !== "opaque"'));
    assert.ok(sw.includes("ignoreSearch: true"));
    assert.ok(sw.includes("fetchWithTimeout"));
    assert.ok(sw.includes("event.waitUntil("));
  });
});
