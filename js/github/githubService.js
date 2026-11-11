import { getKeyStorageMode } from "../ai/providers.js";
import { toFriendlyNetworkError } from "../net/networkErrors.js";
import { BINARY_EXTENSIONS } from "../storage/fileImport.js";

const GH_TOKEN_KEY = "ide.github.pat";
const GH_REPOS_CACHE_KEY = "ide.github.reposCache";
const GH_USER_CACHE_KEY = "ide.github.userLogin";

const MAX_TEXT_FILE_BYTES = 350000;

export function getGithubToken() {
  try {
    return window.sessionStorage.getItem(GH_TOKEN_KEY) || window.localStorage.getItem(GH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function saveGithubToken(token) {
  const trimmed = token.trim();
  try {
    window.localStorage.removeItem(GH_TOKEN_KEY);
    window.sessionStorage.removeItem(GH_TOKEN_KEY);
    if (!trimmed) {
      window.localStorage.removeItem(GH_REPOS_CACHE_KEY);
      window.sessionStorage.removeItem(GH_REPOS_CACHE_KEY);
      window.localStorage.removeItem(GH_USER_CACHE_KEY);
      window.sessionStorage.removeItem(GH_USER_CACHE_KEY);
      return;
    }
    const store = getKeyStorageMode() === "session" ? window.sessionStorage : window.localStorage;
    store.setItem(GH_TOKEN_KEY, trimmed);
  } catch {
    // Entorno restringido
  }
}

export function clearGithubToken() {
  saveGithubToken("");
}

export function getCachedGithubUserLogin() {
  try {
    return (
      window.sessionStorage.getItem(GH_USER_CACHE_KEY) ||
      window.localStorage.getItem(GH_USER_CACHE_KEY) ||
      ""
    );
  } catch {
    return "";
  }
}

export function saveCachedGithubUserLogin(login) {
  const clean = String(login || "").trim();
  try {
    window.localStorage.removeItem(GH_USER_CACHE_KEY);
    window.sessionStorage.removeItem(GH_USER_CACHE_KEY);
    if (!clean) return;
    const store = getKeyStorageMode() === "session" ? window.sessionStorage : window.localStorage;
    store.setItem(GH_USER_CACHE_KEY, clean);
  } catch {
    // Ignorar cuota de almacenamiento
  }
}

export function getCachedUserRepositories() {
  try {
    const raw =
      window.sessionStorage.getItem(GH_REPOS_CACHE_KEY) ||
      window.localStorage.getItem(GH_REPOS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCachedUserRepositories(repos) {
  try {
    const slim = repos.map((r) => ({
      full_name: r.full_name,
      default_branch: r.default_branch || "main",
      private: Boolean(r.private)
    }));
    const store = getKeyStorageMode() === "session" ? window.sessionStorage : window.localStorage;
    store.setItem(GH_REPOS_CACHE_KEY, JSON.stringify(slim));
  } catch {
    // Ignorar cuota de almacenamiento
  }
}

/**
 * Crea un cliente ligero sobre Octokit (@octokit/core vía ESM) con respaldo directo a GitHub REST API v3.
 * @param {string} token
 */
async function createGithubClient(token) {
  const raw = await createRawGithubClient(token);
  return {
    async request(route, params = {}) {
      try {
        return await raw.request(route, params);
      } catch (error) {
        if (error?.status === 401) {
          const authError = new Error(
            "GitHub rechazó el token (inválido, vencido o revocado). Conectá uno nuevo desde el botón Repositorio."
          );
          authError.status = 401;
          authError.cause = error;
          throw authError;
        }
        throw toFriendlyNetworkError(error, "GitHub");
      }
    }
  };
}

async function createRawGithubClient(token) {
  try {
    const mod = await import("@octokit/core");
    if (mod && typeof mod.Octokit === "function") {
      const octokit = new mod.Octokit({ auth: token || undefined });
      return {
        async request(route, params = {}) {
          const res = await octokit.request(route, params);
          return res.data;
        }
      };
    }
  } catch {
    // Si falla la carga desde CDN, usar cliente REST directo compatible con las mismas rutas
  }

  return {
    async request(route, params = {}) {
      const [method, rawPath] = route.split(" ");
      let path = rawPath;
      const bodyPayload = { ...params };

      path = path.replace(/\{([^}]+)\}/g, (_, key) => {
        const val = String(bodyPayload[key] ?? "");
        delete bodyPayload[key];
        if (key === "ref" || key === "branch") {
          return val.split("/").map(encodeURIComponent).join("/");
        }
        return encodeURIComponent(val);
      });

      let url = `https://api.github.com${path}`;
      const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const init = { method, headers };
      if (method === "GET") {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(bodyPayload)) {
          if (v !== undefined && v !== null) {
            qs.set(k, String(v));
          }
        }
        const queryStr = qs.toString();
        if (queryStr) {
          url += `?${queryStr}`;
        }
      } else {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(bodyPayload);
      }

      const res = await fetch(url, init);
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const errJson = await res.json();
          if (errJson?.message) detail = errJson.message;
        } catch {
          // Ignorar
        }
        if (detail.includes("Resource not accessible by personal access token")) {
          detail = "Tu token de GitHub no tiene permiso para este recurso. Para Gists, activá 'Account permissions -> Gists (Read and write)' en GitHub o usá un Token Classic con la casilla 'gist'.";
        }
        const err = new Error(`GitHub API: ${detail}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }
  };
}

/**
 * Comprueba un token con GET /user (GitHub responde 401 "Bad credentials" si es inválido, vencido o revocado).
 * @returns {Promise<{ status: "valid", login: string } | { status: "invalid" | "offline" | "unknown", message: string }>}
 */
export async function verifyGithubToken(token) {
  const clean = String(token || "").trim();
  if (!clean) {
    return { status: "invalid", message: "Pegá un Personal Access Token (PAT) de GitHub." };
  }
  try {
    const user = await fetchGithubUser(clean);
    return { status: "valid", login: String(user?.login || "") };
  } catch (error) {
    if (error?.isNetworkFailure) {
      return { status: "offline", message: "Sin conexión: no se pudo verificar el token con GitHub." };
    }
    if (error?.status === 401) {
      return {
        status: "invalid",
        message: "Token inválido o vencido. Revisá que lo hayas copiado completo o generá uno nuevo en GitHub."
      };
    }
    return {
      status: "unknown",
      message: `No se pudo verificar el token ahora (${error instanceof Error ? error.message : "error desconocido"}).`
    };
  }
}

export async function fetchGithubUser(token) {
  const client = await createGithubClient(token);
  const user = await client.request("GET /user");
  if (user?.login) {
    saveCachedGithubUserLogin(user.login);
  }
  return user;
}

export async function fetchUserRepositories(token) {
  const client = await createGithubClient(token);
  const allRepos = [];
  const perPage = 100;
  for (let page = 1; page <= 3; page += 1) {
    const batch = await client.request("GET /user/repos", {
      sort: "updated",
      per_page: perPage,
      page,
      affiliation: "owner,collaborator,organization_member"
    });
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }
    allRepos.push(...batch);
    if (batch.length < perPage) {
      break;
    }
  }
  if (allRepos.length > 0) {
    saveCachedUserRepositories(allRepos);
  }
  return allRepos;
}

export async function fetchRepositoryBranches(token, owner, repo) {
  return fetchRepoBranches(token, owner, repo);
}

/**
 * Obtiene la lista de ramas de un repositorio de GitHub (GET /repos/{owner}/{repo}/branches).
 * Admite tanto llamada posicional (token, owner, repo) como objeto { token, owner, repo }.
 */
export async function fetchRepoBranches(paramsOrToken, maybeOwner, maybeRepo) {
  let token, owner, repo;
  if (paramsOrToken && typeof paramsOrToken === "object") {
    token = paramsOrToken.token;
    owner = paramsOrToken.owner;
    repo = paramsOrToken.repo;
  } else {
    token = paramsOrToken;
    owner = maybeOwner;
    repo = maybeRepo;
  }
  const client = await createGithubClient(token);
  return client.request("GET /repos/{owner}/{repo}/branches", {
    owner,
    repo,
    per_page: 100
  });
}

/**
 * Crea una nueva rama en GitHub a partir de un commit SHA de origen (POST /repos/{owner}/{repo}/git/refs).
 * @param {{ token: string, owner: string, repo: string, branchName: string, fromSha: string }} params
 * @returns {Promise<{ ref: string, commitSha: string }>}
 */
export async function createRepoBranch({ token, owner, repo, branchName, fromSha }) {
  const cleanBranch = String(branchName || "").replace(/^refs\/heads\//, "").trim();
  if (!cleanBranch) {
    throw new Error("El nombre de la rama no puede estar vacío.");
  }
  const client = await createGithubClient(token);
  const res = await client.request("POST /repos/{owner}/{repo}/git/refs", {
    owner,
    repo,
    ref: `refs/heads/${cleanBranch}`,
    sha: fromSha
  });
  return {
    ref: res?.ref || `refs/heads/${cleanBranch}`,
    commitSha: res?.object?.sha || fromSha
  };
}

/**
 * Obtiene únicamente el índice liviano de carpetas y archivos del repositorio (sin descargar contenidos),
 * permitiendo mostrar cualquier repositorio en el Explorador en ~250ms bajo demanda.
 */
export async function fetchRepoTreeIndex({ token, owner, repo, branch }) {
  const client = await createGithubClient(token);

  let branchInfo = null;
  try {
    branchInfo = await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
      owner,
      repo,
      branch
    });
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    const st = err?.status;
    if (st === 404 || st === 409 || msg.includes("not found") || msg.includes("empty")) {
      // Verificar si el repositorio existe pero aún no tiene commits (vacío)
      const repoInfo = await client.request("GET /repos/{owner}/{repo}", { owner, repo });
      if (repoInfo) {
        return {
          commitSha: null,
          isEmptyRepo: true,
          branch: repoInfo.default_branch || branch || "main",
          entries: []
        };
      }
    }
    throw err;
  }

  const commitSha = branchInfo?.commit?.sha;
  const treeSha = branchInfo?.commit?.commit?.tree?.sha || commitSha;
  if (!commitSha || !treeSha) {
    return { commitSha: null, isEmptyRepo: true, branch, entries: [] };
  }

  let treeData;
  try {
    treeData = await client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: treeSha,
      recursive: "1"
    });
  } catch (err) {
    if (err?.status === 409 || String(err?.message || "").toLowerCase().includes("empty")) {
      return { commitSha: null, isEmptyRepo: true, branch, entries: [] };
    }
    throw err;
  }

  const rawTree = Array.isArray(treeData?.tree) ? treeData.tree : [];
  const entries = rawTree
    .filter((node) => {
      if (node.type !== "blob" || !node.path || !node.sha) return false;
      // Los enlaces simbólicos (120000) no son archivos de texto editables: editarlos los convertiría en archivos comunes.
      if (node.mode === "120000") return false;
      if (typeof node.size === "number" && node.size > MAX_TEXT_FILE_BYTES) return false;
      if (node.path.startsWith("node_modules/") || node.path.startsWith(".git/")) return false;
      const ext = node.path.includes(".") ? node.path.split(".").pop().toLowerCase() : "";
      return !BINARY_EXTENSIONS.has(ext);
    })
    .map((node) => ({
      path: node.path,
      blobSha: node.sha,
      size: node.size || 0,
      mode: node.mode === "100755" ? "100755" : "100644"
    }));

  const isTruncated = Boolean(treeData?.truncated);

  return {
    commitSha,
    isEmptyRepo: false,
    isTruncated,
    branch,
    entries
  };
}

/**
 * Descarga el contenido de un único archivo puntual desde GitHub bajo demanda (~120ms).
 */
export async function fetchSingleRepoBlob({ token, owner, repo, blobSha }) {
  const client = await createGithubClient(token);
  const blob = await client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
    owner,
    repo,
    file_sha: blobSha
  });
  return blob.encoding === "base64" ? decodeBase64Utf8(blob.content || "") : String(blob.content || "");
}

/**
 * Descarga en lote una lista de archivos pendientes para dejar el repositorio disponible sin internet.
 */
export async function downloadBatchBlobs({ token, owner, repo, items, onProgress }) {
  const client = await createGithubClient(token);
  const results = [];
  let completed = 0;
  const total = items.length;
  onProgress?.(0, total);

  const CONCURRENCY = 6;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        const blob = await client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner,
          repo,
          file_sha: item.blobSha
        });
        completed += 1;
        onProgress?.(completed, total);
        const content =
          blob.encoding === "base64" ? decodeBase64Utf8(blob.content || "") : String(blob.content || "");
        return {
          path: item.path,
          blobSha: item.blobSha,
          mode: item.mode || null,
          content
        };
      })
    );
    results.push(...batchResults);
  }
  return results;
}

/**
 * Descarga completa de un repositorio y rama hacia memoria para hidratar IndexedDB (modo offline completo).
 */
export async function downloadRepoFiles({ token, owner, repo, branch, onProgress }) {
  const index = await fetchRepoTreeIndex({ token, owner, repo, branch });
  if (index.isEmptyRepo || index.entries.length === 0) {
    onProgress?.(0, 0);
    return {
      commitSha: index.commitSha,
      isTruncated: Boolean(index.isTruncated),
      files: []
    };
  }

  const files = await downloadBatchBlobs({
    token,
    owner,
    repo,
    items: index.entries,
    onProgress
  });

  return {
    commitSha: index.commitSha,
    isTruncated: Boolean(index.isTruncated),
    files
  };
}

/**
 * Error lanzado cuando la rama remota avanzó desde la última descarga/sincronización local.
 */
export class RemoteAheadError extends Error {
  constructor(remoteSha, expectedSha) {
    super("El repositorio en GitHub tiene commits nuevos que todavía no descargaste.");
    this.name = "RemoteAheadError";
    this.remoteSha = remoteSha;
    this.expectedSha = expectedSha;
  }
}

/**
 * Lista los archivos que cambiaron en GitHub entre dos commits (compare API).
 * @returns {Promise<Array<{ path: string, status: string, blobSha: string | null }>>}
 */
export async function compareRemoteCommits({ token, owner, repo, base, head }) {
  const client = await createGithubClient(token);
  const data = await client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner,
    repo,
    basehead: `${base}...${head}`
  });
  const files = Array.isArray(data?.files) ? data.files : [];
  return files.map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename || null,
    status: f.status,
    blobSha: f.status === "removed" ? null : f.sha || null
  }));
}

/**
 * Crea un único Commit + Push atómico en GitHub (soporta incluso repositorios recién creados sin commits previos).
 * Si se indica expectedBaseSha y la rama remota avanzó, lanza RemoteAheadError salvo que force sea true.
 */
export async function pushAtomicCommit({
  token,
  owner,
  repo,
  branch,
  message,
  changes,
  expectedBaseSha = null,
  force = false
}) {
  if (!changes.length) {
    throw new Error("No hay archivos modificados para enviar en el commit.");
  }

  const client = await createGithubClient(token);
  const cleanMsg = message.trim() || "Actualización desde Studio IDE";

  let latestCommitSha = null;
  let baseTreeSha = null;
  let remainingChanges = [...changes];

  try {
    const branchData = await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
      owner,
      repo,
      branch
    });
    latestCommitSha = branchData?.commit?.sha || null;
    baseTreeSha = branchData?.commit?.commit?.tree?.sha || null;
  } catch (err) {
    const st = err?.status;
    const msg = String(err?.message || "").toLowerCase();
    if (st === 404 || st === 409 || msg.includes("not found") || msg.includes("empty")) {
      if (expectedBaseSha && !force) {
        throw new Error(
          `La rama ${branch} ya no existe en GitHub o fue reiniciada. Tocá Actualizar remoto antes de subir.`
        );
      }
      // Repositorio vacío: inicializar rama con el primer archivo nuevo vía Contents API
      const firstAddedIdx = remainingChanges.findIndex((c) => c.status !== "deleted");
      if (firstAddedIdx === -1) {
        throw new Error("El repositorio remoto está vacío; creá al menos un archivo para inicializarlo.");
      }
      const firstFile = remainingChanges[firstAddedIdx];
      const isBin = firstFile.isBinary || firstFile.encoding === "base64" || Boolean(firstFile.base64);
      const contentPayload = isBin
        ? (firstFile.base64 || firstFile.content)
        : encodeUtf8Base64(firstFile.content);
      const initRes = await client.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path: firstFile.path,
        message: cleanMsg,
        content: contentPayload,
        branch
      });
      latestCommitSha = initRes?.commit?.sha || null;
      baseTreeSha = initRes?.commit?.tree?.sha || null;
      remainingChanges.splice(firstAddedIdx, 1);

      if (remainingChanges.length === 0 && latestCommitSha) {
        return { commitSha: latestCommitSha };
      }

      if (!latestCommitSha || !baseTreeSha) {
        const branchDataAfter = await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
          owner,
          repo,
          branch
        });
        latestCommitSha = branchDataAfter?.commit?.sha || null;
        baseTreeSha = branchDataAfter?.commit?.commit?.tree?.sha || null;
      }
    } else {
      throw err;
    }
  }

  if (!latestCommitSha || !baseTreeSha) {
    throw new Error("No se pudo leer el último commit de la rama remota.");
  }

  if (!force && expectedBaseSha && latestCommitSha !== expectedBaseSha) {
    throw new RemoteAheadError(latestCommitSha, expectedBaseSha);
  }

  const BLOB_UPLOAD_CONCURRENCY = 4;
  const treeItems = new Array(remainingChanges.length);
  let nextIdx = 0;

  async function uploadWorker() {
    while (nextIdx < remainingChanges.length) {
      const idx = nextIdx++;
      const change = remainingChanges[idx];
      if (change.status === "deleted") {
        treeItems[idx] = {
          path: change.path,
          mode: "100644",
          type: "blob",
          sha: null
        };
        continue;
      }
      const mode = change.mode === "100755" ? "100755" : "100644";
      if (change.isBinary || change.encoding === "base64" || (change.base64 && typeof change.base64 === "string")) {
        const b64 = change.base64 || (typeof change.content === "string" ? change.content : "");
        const createdBlob = await client.request("POST /repos/{owner}/{repo}/git/blobs", {
          owner,
          repo,
          content: b64,
          encoding: "base64"
        });
        const blobSha = createdBlob?.sha || createdBlob?.data?.sha || null;
        treeItems[idx] = {
          path: change.path,
          mode,
          type: "blob",
          sha: blobSha
        };
      } else {
        treeItems[idx] = {
          path: change.path,
          // Conserva el bit de ejecución (100755) de scripts existentes; el resto se publica como archivo normal.
          mode,
          type: "blob",
          content: typeof change.content === "string" ? change.content : ""
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(BLOB_UPLOAD_CONCURRENCY, remainingChanges.length) }, () => uploadWorker())
  );

  const createdTree = await client.request("POST /repos/{owner}/{repo}/git/trees", {
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeItems
  });

  const createdCommit = await client.request("POST /repos/{owner}/{repo}/git/commits", {
    owner,
    repo,
    message: cleanMsg,
    tree: createdTree.sha,
    parents: [latestCommitSha]
  });

  await client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: createdCommit.sha
  });

  return {
    commitSha: createdCommit.sha
  };
}

function decodeBase64Utf8(base64) {
  const clean = base64.replace(/\s+/g, "");
  const atobFn = typeof atob === "function" ? atob : (globalThis.atob || (typeof window !== "undefined" ? window.atob : null));
  const binary = atobFn(clean);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  let binary = "";
  const chunkSize = 8192;
  const len = bytes.length;
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  const btoaFn = typeof btoa === "function" ? btoa : (globalThis.btoa || (typeof window !== "undefined" ? window.btoa : null));
  return btoaFn(binary);
}

/**
 * Guarda o actualiza una copia de respaldo completa de un proyecto local en un Gist privado de GitHub.
 * @param {string} token
 * @param {{ projectName: string, entries: Array<any>, existingGistId?: string|null }} options
 */
export async function saveProjectToGist(token, { projectName, entries, existingGistId = null }) {
  if (!token) throw new Error("Conectá tu token de GitHub para respaldar en Gists.");
  const client = await createGithubClient(token);
  const cleanName = String(projectName || "proyecto").trim();

  const manifest = {
    schema: "studio_ide_gist_backup_v1",
    projectName: cleanName,
    backedUpAt: Date.now(),
    entries: (entries || [])
      .filter((e) => !e.isFolder && !e.deleted)
      .map((e) => ({
        path: e.path,
        content: typeof e.content === "string" ? e.content : "",
        isBinary: Boolean(e.isBinary),
        base64: e.base64 || null,
        mode: e.mode || null
      }))
  };

  const filesPayload = {
    "studio_project.json": {
      content: JSON.stringify(manifest, null, 2)
    }
  };

  // Agregar hasta 10 archivos principales con nombres planos para previsualización directa en gist.github.com
  manifest.entries.slice(0, 10).forEach((entry) => {
    const flatName = entry.path.replace(/[/\\:]/g, "__");
    if (flatName && flatName !== "studio_project.json") {
      filesPayload[flatName] = { content: entry.content || "// vacío" };
    }
  });

  const description = `[Studio IDE Backup] ${cleanName}`;

  if (existingGistId) {
    try {
      const res = await client.request("PATCH /gists/{gist_id}", {
        gist_id: existingGistId,
        description,
        files: filesPayload
      });
      return {
        id: res.id,
        url: res.html_url || `https://gist.github.com/${res.id}`,
        updatedAt: res.updated_at || new Date().toISOString()
      };
    } catch (err) {
      if (err?.status !== 404) {
        throw err;
      }
      // Si el Gist previo fue borrado en GitHub, se crea uno nuevo abajo
    }
  }

  const res = await client.request("POST /gists", {
    description,
    public: false,
    files: filesPayload
  });

  return {
    id: res.id,
    url: res.html_url || `https://gist.github.com/${res.id}`,
    updatedAt: res.updated_at || new Date().toISOString()
  };
}

/**
 * Obtiene la lista de proyectos respaldados en Gists privados de GitHub del usuario.
 * @param {string} token
 */
export async function fetchUserGistBackups(token) {
  if (!token) return [];
  const client = await createGithubClient(token);
  const list = await client.request("GET /gists", { per_page: 50 });
  if (!Array.isArray(list)) return [];

  return list
    .filter((g) => {
      const desc = String(g.description || "");
      return desc.startsWith("[Studio IDE Backup]") || Boolean(g.files && g.files["studio_project.json"]);
    })
    .map((g) => {
      const rawName = String(g.description || "").replace(/^\[Studio IDE Backup\]\s*/i, "").trim();
      const name = rawName || g.id.slice(0, 8);
      return {
        id: g.id,
        name,
        description: g.description,
        updatedAt: g.updated_at,
        url: g.html_url
      };
    });
}

/**
 * Descarga y extrae los archivos de un Gist de respaldo de Studio IDE.
 * @param {string} token
 * @param {string} gistId
 */
export async function fetchGistBackupContent(token, gistId) {
  if (!token) throw new Error("Conectá tu token de GitHub.");
  const client = await createGithubClient(token);
  const gist = await client.request("GET /gists/{gist_id}", { gist_id: gistId });
  const manifestFile = gist.files && gist.files["studio_project.json"];

  if (manifestFile) {
    let manifestRawContent = manifestFile.content || "";
    if ((manifestFile.truncated || !manifestRawContent) && manifestFile.raw_url) {
      try {
        const rawUrl = String(manifestFile.raw_url);
        if (/^https:\/\/(gist\.githubusercontent\.com|api\.github\.com)\//i.test(rawUrl)) {
          const rawRes = await fetch(rawUrl);
          if (rawRes.ok) {
            manifestRawContent = await rawRes.text();
          }
        }
      } catch (_) {
        // Fallback a contenido parcial o archivos planos
      }
    }

    if (manifestRawContent) {
      try {
        const parsed = JSON.parse(manifestRawContent);
        return {
          projectName: parsed.projectName || gist.description || "proyecto-restaurado",
          entries: Array.isArray(parsed.entries) ? parsed.entries : []
        };
      } catch {
        // Fallback a archivos planos
      }
    }
  }

  const entries = [];
  for (const [filename, fileObj] of Object.entries(gist.files || {})) {
    if (filename === "studio_project.json") continue;
    const realPath = filename.replace(/__/g, "/");
    entries.push({
      path: realPath,
      content: fileObj.content || "",
      isFolder: false
    });
  }

  return {
    projectName: gist.description ? gist.description.replace(/^\[Studio IDE Backup\]\s*/i, "") : "proyecto-restaurado",
    entries
  };
}

/**
 * Publica un proyecto local como un repositorio privado o público nuevo en GitHub.
 * @param {string} token
 * @param {{ repoName: string, isPrivate?: boolean, entries?: Array<any> }} options
 */
export async function publishProjectAsNewRepository(token, { repoName, isPrivate = true, entries = [] }) {
  if (!token) throw new Error("Conectá tu token de GitHub.");
  const client = await createGithubClient(token);
  const cleanName = String(repoName || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (!cleanName) throw new Error("Nombre de repositorio inválido.");

  const createdRepo = await client.request("POST /user/repos", {
    name: cleanName,
    description: "Proyecto creado y sincronizado desde Studio IDE para iPad",
    private: Boolean(isPrivate),
    auto_init: false
  });

  const owner = createdRepo.owner?.login;
  const repo = createdRepo.name;
  const branch = createdRepo.default_branch || "main";

  const fileEntries = entries.filter((e) => !e.isFolder && !e.deleted && e.path);
  if (fileEntries.length > 0) {
    await pushAtomicCommit({
      token,
      owner,
      repo,
      branch,
      message: "Initial commit from Studio IDE",
      changes: fileEntries.map((f) => ({
        path: f.path,
        content: typeof f.content === "string" ? f.content : "",
        isBinary: Boolean(f.isBinary),
        base64: f.base64 || null,
        mode: f.mode || null,
        status: "added"
      }))
    });
  }

  return {
    owner,
    repo,
    branch,
    fullName: createdRepo.full_name,
    url: createdRepo.html_url
  };
}

/**
 * Crea un blob Git en el repositorio remoto usando GitHub REST API.
 * @param {{ token: string, owner: string, repo: string, content: string, encoding?: "utf-8" | "base64" }} options
 */
export async function createGitBlob({ token, owner, repo, content, encoding = "utf-8" }) {
  const client = await createGithubClient(token);
  const res = await client.request("POST /repos/{owner}/{repo}/git/blobs", {
    owner,
    repo,
    content,
    encoding
  });
  return res?.sha || res?.data?.sha || "";
}
