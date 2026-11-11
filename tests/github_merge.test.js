import "./setup.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  classifyRemotePullChanges,
  buildRemotePullPlan
} from "../js/github/githubMerge.js";
import {
  hydrateGithubProject,
  hydrateLazyGithubProject,
  updateFileContent,
  upsertEntry,
  deleteProjectEntry,
  getPendingGithubChanges,
  getProjectEntries,
  getProject,
  applyRemotePullPlan,
  saveProjectState
} from "../js/storage/workspaceDb.js";

describe("Pull Inteligente y Resolución de Conflictos GitHub (3-way merge)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  test("classifyRemotePullChanges separa actualizaciones seguras, renombres y conflictos superpuestos", () => {
    const result = classifyRemotePullChanges({
      localEntries: [
        { path: "src/shared.js", contentLoaded: true },
        { path: "src/localOnly.js", contentLoaded: true },
        { path: "src/remoteOnly.js", contentLoaded: true },
        { path: "legacy/old.js", contentLoaded: true },
        { path: "docs/deleteMe.md", contentLoaded: true },
        { path: "bothDeleted.txt", contentLoaded: true }
      ],
      localPendingChanges: [
        { path: "src/shared.js", status: "modified", content: "local", baseContent: "base" },
        { path: "src/localOnly.js", status: "modified", content: "local2", baseContent: "base2" },
        { path: "newLocal.js", status: "added", content: "nuevo" },
        { path: "bothDeleted.txt", status: "deleted", content: "" }
      ],
      remoteDiffFiles: [
        { path: "src/remoteOnly.js", status: "modified", blobSha: "sha-rem-1" },
        { path: "src/shared.js", status: "modified", blobSha: "sha-rem-shared" },
        { path: "docs/newRemote.md", status: "added", blobSha: "sha-rem-doc" },
        { path: "docs/deleteMe.md", status: "removed", blobSha: null },
        { path: "legacy/new.js", previousPath: "legacy/old.js", status: "renamed", blobSha: "sha-ren" },
        { path: "bothDeleted.txt", status: "removed", blobSha: null }
      ]
    });

    assert.deepEqual(
      result.safeUpdates.map((u) => u.path),
      ["docs/newRemote.md", "legacy/new.js", "src/remoteOnly.js"]
    );
    assert.deepEqual(
      result.safeDeletions.map((d) => d.path),
      ["bothDeleted.txt", "docs/deleteMe.md", "legacy/old.js"]
    );
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].path, "src/shared.js");
    assert.equal(result.conflicts[0].localStatus, "modified");
    assert.equal(result.conflicts[0].remoteStatus, "modified");
    assert.equal(result.conflicts[0].resolution, "keep-local");
  });

  test("Integración IndexedDB completa: integra remotos seguros y resuelve conflictos (keep-local vs take-remote)", async () => {
    const project = await hydrateGithubProject({
      owner: "octocat",
      repo: "demo-merge",
      branch: "main",
      commitSha: "commit-base-1",
      files: [
        { path: "src/shared-keep.js", content: "base keep", blobSha: "s1" },
        { path: "src/shared-take.js", content: "base take", blobSha: "s2" },
        { path: "src/remote-only.js", content: "v1 remote", blobSha: "s3" },
        { path: "src/local-deleted-rem-mod.js", content: "base del", blobSha: "s4" },
        { path: "src/removed-remote.js", content: "adios", blobSha: "s5" },
        { path: "src/resurrect.js", content: "base res", blobSha: "s6" }
      ]
    });

    // Abrir pestañas para probar limpieza automática de pestañas eliminadas
    project.openTabIds = ["src/shared-keep.js", "src/removed-remote.js"];
    project.activeFileId = "src/removed-remote.js";
    await saveProjectState(project);

    // Ediciones locales
    await updateFileContent(project.id, "src/shared-keep.js", "local keep v2");
    await updateFileContent(project.id, "src/shared-take.js", "local take descartable");
    await deleteProjectEntry(project.id, "src/local-deleted-rem-mod.js", false);
    await updateFileContent(project.id, "src/resurrect.js", "local modified while remote deleted");
    await upsertEntry(project.id, "local-brand-new.js", { isFolder: false, content: "hola" });

    const remoteDiffFiles = [
      { path: "src/shared-keep.js", status: "modified", blobSha: "blob-keep-rem" },
      { path: "src/shared-take.js", status: "modified", blobSha: "blob-take-rem" },
      { path: "src/remote-only.js", status: "modified", blobSha: "blob-only-rem" },
      { path: "src/local-deleted-rem-mod.js", status: "modified", blobSha: "blob-res-rem" },
      { path: "src/removed-remote.js", status: "removed", blobSha: null },
      { path: "src/resurrect.js", status: "removed", blobSha: null },
      { path: "nested/dir/added.js", status: "added", blobSha: "blob-nested-add" }
    ];

    const localEntries = await getProjectEntries(project.id);
    const localPendingChanges = await getPendingGithubChanges(project.id);
    const classification = classifyRemotePullChanges({
      localEntries,
      localPendingChanges,
      remoteDiffFiles
    });

    assert.equal(classification.conflicts.length, 4);

    // Usuario elige "take-remote" para shared-take.js y conserva local en los demás
    const takeTarget = classification.conflicts.find((c) => c.path === "src/shared-take.js");
    takeTarget.resolution = "take-remote";

    const remoteBlobs = {
      "blob-keep-rem": "remote keep v2",
      "blob-take-rem": "remote take ganador",
      "blob-only-rem": "v2 remote",
      "blob-res-rem": "remote modified",
      "blob-nested-add": "export const ok = true;"
    };

    const plan = await buildRemotePullPlan({
      project,
      localEntries,
      classification,
      newCommitSha: "commit-remote-2",
      fetchBlob: async (sha) => remoteBlobs[sha]
    });

    const summary = await applyRemotePullPlan(project.id, plan);
    assert.equal(summary.project.github.commitSha, "commit-remote-2");
    assert.deepEqual(summary.project.openTabIds, ["src/shared-keep.js"]);
    assert.equal(summary.project.activeFileId, "src/shared-keep.js");

    const entriesAfter = await getProjectEntries(project.id);
    const byPath = new Map(entriesAfter.map((e) => [e.path, e]));

    assert.equal(byPath.get("src/remote-only.js")?.content, "v2 remote");
    assert.equal(byPath.get("src/shared-take.js")?.content, "remote take ganador");
    assert.equal(byPath.get("src/shared-keep.js")?.content, "local keep v2");
    assert.equal(byPath.get("src/shared-keep.js")?.baseContent, "remote keep v2");
    assert.equal(byPath.get("nested/dir/added.js")?.content, "export const ok = true;");
    assert.equal(byPath.has("src/removed-remote.js"), false);
    assert.equal(byPath.has("local-brand-new.js"), true);

    // Verificar pendientes exactos listos para el próximo Commit y Push
    const pendingAfter = await getPendingGithubChanges(project.id);
    const pendingMap = new Map(pendingAfter.map((c) => [c.path, c]));
    assert.equal(pendingMap.has("src/remote-only.js"), false);
    assert.equal(pendingMap.has("src/shared-take.js"), false);
    assert.equal(pendingMap.get("src/shared-keep.js")?.status, "modified");
    assert.equal(pendingMap.get("src/resurrect.js")?.status, "added");
    assert.equal(pendingMap.get("src/local-deleted-rem-mod.js")?.status, "deleted");
    assert.equal(pendingMap.get("local-brand-new.js")?.status, "added");
  });

  test("Proyecto lazy: archivos remotos no abiertos se actualizan sin descargar blobs innecesarios", async () => {
    const project = await hydrateLazyGithubProject({
      owner: "octocat",
      repo: "lazy-merge",
      branch: "main",
      commitSha: "commit-lazy-1",
      entries: [
        { path: "src/open.js", blobSha: "sha-open-1", mode: "100644" },
        { path: "src/unopened.js", blobSha: "sha-unopened-1", mode: "100644" }
      ]
    });

    // Solo open.js tiene contenido cargado, pero sin modificaciones locales
    await upsertEntry(project.id, "src/open.js", {
      isFolder: false,
      content: "v1 open",
      baseContent: "v1 open",
      fromGithub: true,
      blobSha: "sha-open-1",
      contentLoaded: true
    });

    const classification = classifyRemotePullChanges({
      localEntries: await getProjectEntries(project.id),
      localPendingChanges: [],
      remoteDiffFiles: [
        { path: "src/open.js", status: "modified", blobSha: "sha-open-2" },
        { path: "src/unopened.js", status: "modified", blobSha: "sha-unopened-2" },
        { path: "src/new-lazy.js", status: "added", blobSha: "sha-new-lazy" }
      ]
    });

    const fetchedShas = [];
    const plan = await buildRemotePullPlan({
      project,
      localEntries: await getProjectEntries(project.id),
      classification,
      newCommitSha: "commit-lazy-2",
      fetchBlob: async (sha) => {
        fetchedShas.push(sha);
        return `content:${sha}`;
      }
    });

    assert.deepEqual(fetchedShas, ["sha-open-2"]);
    await applyRemotePullPlan(project.id, plan);

    const updatedEntries = await getProjectEntries(project.id);
    const byPath = new Map(updatedEntries.map((e) => [e.path, e]));
    assert.equal(byPath.get("src/open.js")?.content, "content:sha-open-2");
    assert.equal(byPath.get("src/open.js")?.contentLoaded, true);
    assert.equal(byPath.get("src/unopened.js")?.contentLoaded, false);
    assert.equal(byPath.get("src/unopened.js")?.blobSha, "sha-unopened-2");
    assert.equal(byPath.get("src/new-lazy.js")?.contentLoaded, false);
    assert.equal((await getProject(project.id))?.github?.commitSha, "commit-lazy-2");
  });
});
