import "./setup.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const gh = await import("../js/github/githubService.js");
const { resetAuthSecurityState } = await import("../js/security/credentialGuard.js");
const GH_TOK = "ghp_ValidTestToken1234567890abcdef";
const GH_TOK_BAD = "ghp_InvalidBadToken1234567890abcd";

/** Servidor GitHub falso: registra llamadas y responde según rutas. */
function installFakeGithub(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || "GET"} ${u.pathname}`;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ key, url: String(url), body, headers: init.headers || {} });
    const handler = routes[key];
    if (!handler) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    const [status, json] = handler(body, u);
    return new Response(JSON.stringify(json), { status });
  };
  return calls;
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

describe("Cliente REST GitHub (fallback sin Octokit)", () => {
  beforeEach(() => resetAuthSecurityState());
  test("fetchRepoTreeIndex filtra binarios, >350KB, node_modules, .git y nodos no-blob", async () => {
    installFakeGithub({
      "GET /repos/o/r/branches/main": () => [200, { commit: { sha: "C1", commit: { tree: { sha: "T1" } } } }],
      "GET /repos/o/r/git/trees/T1": () => [200, {
        tree: [
          { type: "blob", path: "a.js", sha: "s1", size: 10 },
          { type: "blob", path: "img.PNG", sha: "s2", size: 10 },
          { type: "blob", path: "big.txt", sha: "s3", size: 400000 },
          { type: "blob", path: "node_modules/x.js", sha: "s4", size: 1 },
          { type: "tree", path: "src", sha: "s5" },
          { type: "commit", path: "submod", sha: "s6" },
          { type: "blob", path: "src/ñ.py", sha: "s7", size: 5 }
        ]
      }]
    });
    const idx = await gh.fetchRepoTreeIndex({ token: GH_TOK, owner: "o", repo: "r", branch: "main" });
    assert.equal(idx.commitSha, "C1");
    assert.equal(idx.isTruncated, false);
    assert.deepEqual(idx.entries.map((e) => e.path), ["a.js", "src/ñ.py"]);
  });

  test("fetchRepoTreeIndex detecta y propaga indicador isTruncated de la API de GitHub", async () => {
    installFakeGithub({
      "GET /repos/o/r/branches/main": () => [200, { commit: { sha: "C1", commit: { tree: { sha: "T1" } } } }],
      "GET /repos/o/r/git/trees/T1": () => [200, {
        truncated: true,
        tree: [
          { type: "blob", path: "file.js", sha: "s1", size: 10 }
        ]
      }]
    });
    const idx = await gh.fetchRepoTreeIndex({ token: GH_TOK, owner: "o", repo: "r", branch: "main" });
    assert.equal(idx.isTruncated, true);
    assert.equal(idx.entries.length, 1);
  });

  test("rama con '/' se codifica por segmentos (feature/x)", async () => {
    const calls = installFakeGithub({
      "GET /repos/o/r/branches/feature/x": () => [200, { commit: { sha: "C", commit: { tree: { sha: "T" } } } }],
      "GET /repos/o/r/git/trees/T": () => [200, { tree: [] }]
    });
    const idx = await gh.fetchRepoTreeIndex({ token: GH_TOK, owner: "o", repo: "r", branch: "feature/x" });
    assert.equal(idx.isEmptyRepo, false);
    assert.ok(calls[0].url.endsWith("/branches/feature/x"));
  });

  test("repositorio vacío se detecta (409) y devuelve rama por defecto", async () => {
    installFakeGithub({
      "GET /repos/o/r/branches/main": () => [409, { message: "Git Repository is empty." }],
      "GET /repos/o/r": () => [200, { default_branch: "trunk" }]
    });
    const idx = await gh.fetchRepoTreeIndex({ token: GH_TOK, owner: "o", repo: "r", branch: "main" });
    assert.equal(idx.isEmptyRepo, true);
    assert.equal(idx.branch, "trunk");
  });

  test("error 401 se propaga en español conservando status 401 (requisito actualizado en Vuelta #3)", async () => {
    installFakeGithub({ "GET /repos/o/r/branches/main": () => [401, { message: "Bad credentials" }] });
    await assert.rejects(
      gh.fetchRepoTreeIndex({ token: GH_TOK_BAD, owner: "o", repo: "r", branch: "main" }),
      (e) => /GitHub rechazó el token/.test(e.message) && e.status === 401
    );
  });

  test("otros errores de la API (404) conservan el mensaje original de GitHub", async () => {
    installFakeGithub({ "GET /repos/o/r/branches/main": () => [404, { message: "Branch not found" }], "GET /repos/o/r": () => [404, { message: "Not Found" }] });
    await assert.rejects(gh.fetchRepoTreeIndex({ token: GH_TOK_BAD, owner: "o", repo: "r", branch: "main" }), /Not Found/);
  });

  test("fetchSingleRepoBlob decodifica base64 UTF-8 con saltos de línea (ñ, emoji, CJK)", async () => {
    const text = "hola ñandú 😀 文件\nlínea 2\n";
    const encoded = b64(text).replace(/(.{10})/g, "$1\n");
    installFakeGithub({ "GET /repos/o/r/git/blobs/abc": () => [200, { encoding: "base64", content: encoded }] });
    assert.equal(await gh.fetchSingleRepoBlob({ token: GH_TOK, owner: "o", repo: "r", blobSha: "abc" }), text);
  });

  test("downloadBatchBlobs descarga N>concurrencia y reporta progreso monotónico hasta total", async () => {
    installFakeGithub({});
    globalThis.fetch = async (url) => {
      const sha = String(url).split("/").pop();
      return new Response(JSON.stringify({ encoding: "base64", content: b64(`c-${sha}`) }), { status: 200 });
    };
    const items = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}`, blobSha: `s${i}` }));
    const progress = [];
    const res = await gh.downloadBatchBlobs({ token: GH_TOK, owner: "o", repo: "r", items, onProgress: (d, t) => progress.push([d, t]) });
    assert.equal(res.length, 15);
    assert.equal(res[7].content, "c-s7");
    assert.deepEqual(progress.at(-1), [15, 15]);
    for (let i = 1; i < progress.length; i += 1) assert.ok(progress[i][0] >= progress[i - 1][0]);
  });
});

describe("pushAtomicCommit", () => {
  let routes;
  beforeEach(() => {
    routes = {
      "GET /repos/o/r/branches/main": () => [200, { commit: { sha: "BASE", commit: { tree: { sha: "TREE0" } } } }],
      "POST /repos/o/r/git/trees": () => [201, { sha: "TREE1" }],
      "POST /repos/o/r/git/commits": () => [201, { sha: "NEWC" }],
      "PATCH /repos/o/r/git/refs/heads/main": () => [200, { object: { sha: "NEWC" } }]
    };
  });

  test("commit atómico: árbol con alta, modificación y borrado (sha:null)", async () => {
    const calls = installFakeGithub(routes);
    const res = await gh.pushAtomicCommit({
      token: GH_TOK, owner: "o", repo: "r", branch: "main", message: "  msg  ",
      expectedBaseSha: "BASE",
      changes: [
        { path: "a.txt", status: "added", content: "A" },
        { path: "b.txt", status: "modified", content: "B2" },
        { path: "c.txt", status: "deleted", content: "" }
      ]
    });
    assert.equal(res.commitSha, "NEWC");
    const tree = calls.find((c) => c.key === "POST /repos/o/r/git/trees").body;
    assert.equal(tree.base_tree, "TREE0");
    assert.deepEqual(tree.tree.map((t) => [t.path, t.sha === null ? "DEL" : t.content]), [["a.txt", "A"], ["b.txt", "B2"], ["c.txt", "DEL"]]);
    const commit = calls.find((c) => c.key === "POST /repos/o/r/git/commits").body;
    assert.equal(commit.message, "msg");
    assert.deepEqual(commit.parents, ["BASE"]);
    assert.equal(calls.at(-1).body.sha, "NEWC");
  });

  test("rama remota avanzada -> RemoteAheadError y no se escribe nada", async () => {
    const calls = installFakeGithub(routes);
    await assert.rejects(
      gh.pushAtomicCommit({ token: GH_TOK, owner: "o", repo: "r", branch: "main", message: "m", expectedBaseSha: "VIEJO", changes: [{ path: "a", status: "modified", content: "x" }] }),
      (e) => e instanceof gh.RemoteAheadError && e.remoteSha === "BASE" && e.expectedSha === "VIEJO"
    );
    assert.ok(!calls.some((c) => c.key.startsWith("POST") || c.key.startsWith("PATCH")));
  });

  test("force=true ignora la divergencia", async () => {
    installFakeGithub(routes);
    const r = await gh.pushAtomicCommit({ token: GH_TOK, owner: "o", repo: "r", branch: "main", message: "m", expectedBaseSha: "VIEJO", force: true, changes: [{ path: "a", status: "modified", content: "x" }] });
    assert.equal(r.commitSha, "NEWC");
  });

  test("sin cambios -> error claro", async () => {
    await assert.rejects(gh.pushAtomicCommit({ token: GH_TOK, owner: "o", repo: "r", branch: "main", message: "m", changes: [] }), /No hay archivos/);
  });

  test("repositorio vacío: primer archivo vía Contents API (UTF-8) y resto en árbol", async () => {
    let branchCalls = 0;
    routes["GET /repos/o/r/branches/main"] = () => {
      branchCalls += 1;
      return branchCalls === 1 ? [404, { message: "Branch not found" }] : [200, { commit: { sha: "INIT", commit: { tree: { sha: "T0" } } } }];
    };
    routes["PUT /repos/o/r/contents/src%2Fa.py"] = () => [201, { commit: { sha: "INIT" } }];
    routes["PUT /repos/o/r/contents/src/a.py"] = () => [201, { commit: { sha: "INIT" } }];
    const calls = installFakeGithub(routes);
    const r = await gh.pushAtomicCommit({
      token: GH_TOK, owner: "o", repo: "r", branch: "main", message: "init",
      changes: [{ path: "src/a.py", status: "added", content: "print('ñ')" }, { path: "b.md", status: "added", content: "# B" }]
    });
    assert.equal(r.commitSha, "NEWC");
    const put = calls.find((c) => c.key.startsWith("PUT"));
    assert.equal(Buffer.from(put.body.content, "base64").toString("utf8"), "print('ñ')");
    const tree = calls.find((c) => c.key === "POST /repos/o/r/git/trees").body;
    assert.deepEqual(tree.tree.map((t) => t.path), ["b.md"]);
  });

  test("[BUG-20] modo de archivo ejecutable (100755) se preserva al modificar", async () => {
    const calls = installFakeGithub(routes);
    await gh.pushAtomicCommit({
      token: GH_TOK, owner: "o", repo: "r", branch: "main", message: "m", expectedBaseSha: "BASE",
      changes: [{ path: "run.sh", status: "modified", content: "#!/bin/sh\necho 2\n", mode: "100755" }]
    });
    const tree = calls.find((c) => c.key === "POST /repos/o/r/git/trees").body;
    assert.equal(tree.tree[0].mode, "100755");
  });

  test("[BUG-20] fetchRepoTreeIndex conserva el modo y excluye symlinks (120000)", async () => {
    installFakeGithub({
      "GET /repos/o/r/branches/main": () => [200, { commit: { sha: "C1", commit: { tree: { sha: "T1" } } } }],
      "GET /repos/o/r/git/trees/T1": () => [200, {
        tree: [
          { type: "blob", path: "run.sh", sha: "s1", size: 10, mode: "100755" },
          { type: "blob", path: "link", sha: "s2", size: 5, mode: "120000" },
          { type: "blob", path: "a.txt", sha: "s3", size: 5, mode: "100644" }
        ]
      }]
    });
    const idx = await gh.fetchRepoTreeIndex({ token: GH_TOK, owner: "o", repo: "r", branch: "main" });
    assert.deepEqual(idx.entries.map((e) => `${e.path}:${e.mode}`), ["run.sh:100755", "a.txt:100644"]);
  });
});

describe("Token de GitHub en almacenamiento", () => {
  test("guardar respeta el modo de almacenamiento y limpiar borra token y caché de repos", () => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("ide.ai.storageMode", "session");
    gh.saveGithubToken("  ghp_abc  ");
    assert.equal(sessionStorage.getItem("ide.github.pat"), "ghp_abc");
    assert.equal(localStorage.getItem("ide.github.pat"), null);
    sessionStorage.setItem("ide.github.reposCache", "[]");
    gh.clearGithubToken();
    assert.equal(gh.getGithubToken(), "");
    assert.equal(sessionStorage.getItem("ide.github.reposCache"), null);
    localStorage.clear();
  });
  test("caché de repos corrupta no rompe", () => {
    localStorage.setItem("ide.github.reposCache", "{no json");
    assert.deepEqual(gh.getCachedUserRepositories(), []);
    localStorage.clear();
  });
});


describe("Respaldo en la Nube con GitHub (Gists y Repositorios)", () => {
  beforeEach(() => resetAuthSecurityState());
  test("saveProjectToGist crea un Gist secreto con studio_project.json", async () => {
    const calls = installFakeGithub({
      "POST /gists": () => [201, {
        id: "gist123",
        html_url: "https://gist.github.com/gist123",
        updated_at: "2026-11-04T23:00:00Z"
      }]
    });

    const entries = [
      { path: "src/main.cpp", content: "int main() {}", isFolder: false },
      { path: "README.md", content: "# Demo", isFolder: false }
    ];

    const res = await gh.saveProjectToGist(GH_TOK, {
      projectName: "mi-proyecto-local",
      entries
    });

    assert.equal(res.id, "gist123");
    assert.equal(res.url, "https://gist.github.com/gist123");
    const call = calls.find((c) => c.key === "POST /gists");
    assert.ok(call);
    assert.equal(call.body.public, false, "El Gist debe ser secreto/privado");
    assert.ok(call.body.files["studio_project.json"], "Debe contener el archivo de proyecto");
    const manifest = JSON.parse(call.body.files["studio_project.json"].content);
    assert.equal(manifest.projectName, "mi-proyecto-local");
    assert.equal(manifest.entries.length, 2);
  });

  test("saveProjectToGist con existingGistId actualiza via PATCH", async () => {
    const calls = installFakeGithub({
      "PATCH /gists/gist123": () => [200, {
        id: "gist123",
        html_url: "https://gist.github.com/gist123",
        updated_at: "2026-11-04T23:30:00Z"
      }]
    });

    const res = await gh.saveProjectToGist(GH_TOK, {
      projectName: "mi-proyecto-local",
      entries: [{ path: "a.js", content: "console.log(1)", isFolder: false }],
      existingGistId: "gist123"
    });

    assert.equal(res.id, "gist123");
    const patchCall = calls.find((c) => c.key === "PATCH /gists/gist123");
    assert.ok(patchCall, "Debe invocar PATCH sobre el gist existente");
  });

  test("fetchUserGistBackups lista y filtra gists de Studio IDE", async () => {
    installFakeGithub({
      "GET /gists": () => [200, [
        { id: "g1", description: "[Studio IDE Backup] Calculadora C++", updated_at: "2026-11-04T12:00:00Z", html_url: "https://gist.github.com/g1", files: { "studio_project.json": {} } },
        { id: "g2", description: "Snippet suelto de python", updated_at: "2026-11-04T10:00:00Z", html_url: "https://gist.github.com/g2", files: { "test.py": {} } },
        { id: "g3", description: "[Studio IDE Backup] Web App", updated_at: "2026-11-04T14:00:00Z", html_url: "https://gist.github.com/g3", files: { "studio_project.json": {} } }
      ]]
    });

    const list = await gh.fetchUserGistBackups(GH_TOK);
    assert.equal(list.length, 2, "Debe filtrar solo los 2 gists de Studio IDE");
    assert.equal(list[0].name, "Calculadora C++");
    assert.equal(list[1].name, "Web App");
  });

  test("fetchGistBackupContent extrae las entradas del manifest", async () => {
    const manifestJson = JSON.stringify({
      schema: "studio_ide_gist_backup_v1",
      projectName: "App Restaurada",
      entries: [
        { path: "main.py", content: "print(42)" },
        { path: "utils/helper.py", content: "def foo() {}" }
      ]
    });

    installFakeGithub({
      "GET /gists/g1": () => [200, {
        id: "g1",
        description: "[Studio IDE Backup] App Restaurada",
        files: {
          "studio_project.json": { content: manifestJson }
        }
      }]
    });

    const data = await gh.fetchGistBackupContent(GH_TOK, "g1");
    assert.equal(data.projectName, "App Restaurada");
    assert.equal(data.entries.length, 2);
    assert.equal(data.entries[0].path, "main.py");
  });

  test("createProjectFromGistBackup y convertLocalProjectToGithub en IndexedDB", async () => {
    const { createProjectFromGistBackup, convertLocalProjectToGithub, getProject, getProjectEntries } = await import("../js/storage/workspaceDb.js");

    const created = await createProjectFromGistBackup({
      projectName: "Proyecto Gist Demo",
      entries: [
        { path: "src/index.js", content: "console.log('hola');" },
        { path: "README.md", content: "# Leeme" }
      ]
    });

    assert.ok(created.id);
    assert.equal(created.name, "Proyecto Gist Demo");
    assert.equal(created.kind, "local");

    const entries = await getProjectEntries(created.id);
    assert.equal(entries.filter((e) => !e.isFolder).length, 2);

    // Convertir a GitHub
    const converted = await convertLocalProjectToGithub(created.id, {
      owner: "mi-usuario",
      repo: "mi-repo",
      branch: "main"
    });

    assert.equal(converted.kind, "github");
    assert.equal(converted.github.owner, "mi-usuario");
    assert.equal(converted.github.repo, "mi-repo");

    const stored = await getProject(created.id);
    assert.equal(stored.kind, "github");
  });

  test("publishProjectAsNewRepository crea repositorio privado si isPrivate es true", async () => {
    const calls = installFakeGithub({
      "POST /user/repos": (body) => [201, {
        name: body.name,
        full_name: `mi-usuario/${body.name}`,
        owner: { login: "mi-usuario" },
        default_branch: "main",
        html_url: `https://github.com/mi-usuario/${body.name}`
      }]
    });

    const res = await gh.publishProjectAsNewRepository(GH_TOK, {
      repoName: "Proyecto Secreto",
      isPrivate: true,
      entries: []
    });

    assert.equal(res.owner, "mi-usuario");
    assert.equal(res.repo, "proyecto-secreto");
    assert.equal(res.fullName, "mi-usuario/proyecto-secreto");
    const postCall = calls.find((c) => c.key === "POST /user/repos");
    assert.ok(postCall);
    assert.equal(postCall.body.name, "proyecto-secreto");
    assert.equal(postCall.body.private, true, "Debe ser privado en GitHub");
  });

  test("publishProjectAsNewRepository crea repositorio público si isPrivate es false", async () => {
    const calls = installFakeGithub({
      "POST /user/repos": (body) => [201, {
        name: body.name,
        full_name: `mi-usuario/${body.name}`,
        owner: { login: "mi-usuario" },
        default_branch: "main",
        html_url: `https://github.com/mi-usuario/${body.name}`
      }]
    });

    const res = await gh.publishProjectAsNewRepository(GH_TOK, {
      repoName: "Proyecto Open Source",
      isPrivate: false,
      entries: []
    });

    assert.equal(res.owner, "mi-usuario");
    assert.equal(res.repo, "proyecto-open-source");
    assert.equal(res.fullName, "mi-usuario/proyecto-open-source");
    const postCall = calls.find((c) => c.key === "POST /user/repos");
    assert.ok(postCall);
    assert.equal(postCall.body.name, "proyecto-open-source");
    assert.equal(postCall.body.private, false, "Debe ser público en GitHub");
  });
});
