import { getKeyStorageMode } from "../ai/providers.js";
import { toFriendlyNetworkError } from "../net/networkErrors.js";
import {
  AuthLockoutError,
  assertNotLockedOut,
  checkAuthLockout,
  CredentialFormatError,
  formatRemainingCooldown,
  isTokenRejectedInSession,
  markTokenRejectedInSession,
  recordAuthFailure,
  recordAuthSuccess,
  redactSensitiveTokens,
  sanitizeErrorCause,
  validateCredentialFormat
} from "../security/credentialGuard.js";
import { isBinaryFile, MAX_IMPORT_FILE_BYTES } from "../storage/fileImport.js";
import { base64ToBytes, hasNullBytes, slugifyName, utf8ToBase64 } from "../utils/encoding.js";

const GH_TOKEN_KEY = "ide.github.pat";
const GH_SCOPE = "github";
const GH_REPOS_CACHE_KEY = "ide.github.reposCache";
const GH_USER_CACHE_KEY = "ide.github.userLogin";

const MAX_TEXT_FILE_BYTES = 350000;
const GITHUB_REQUEST_TIMEOUT_MS = 25000;
const GIST_PRETTY_JSON_THRESHOLD_CHARS = 512 * 1024;
const MAX_GIST_PAYLOAD_BYTES = 9 * 1024 * 1024;
const VALID_REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_GIST_FILENAMES = new Set(["__proto__", "constructor", "prototype", "studio_project.json"]);

/**
 * Valida estrictamente un segmento de propietario o repositorio en GitHub (sin traversal ni separadores).
 * @param {string} segment
 * @returns {boolean}
 */
export function isValidGithubRepoSegment(segment) {
  return (
    typeof segment === "string" &&
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    VALID_REPO_SEGMENT_RE.test(segment)
  );
}

/**
 * Analiza `"owner/repo"` exigiendo exactamente dos segmentos válidos de GitHub.
 * @param {string} fullName
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseRepoFullName(fullName) {
  const parts = String(fullName || "").trim().split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!isValidGithubRepoSegment(owner) || !isValidGithubRepoSegment(repo)) {
    return null;
  }
  return { owner, repo };
}

function validateGithubRouteParam(key, rawValue) {
  const val = String(rawValue ?? "");
  if (!val || /[\x00-\x1f\x7f?#\\]/.test(val)) {
    throw new Error(`Parámetro de ruta GitHub inválido (${key}).`);
  }
  if (key === "owner" || key === "repo") {
    if (!isValidGithubRepoSegment(val)) {
      throw new Error(`Identificador GitHub inválido para "${key}".`);
    }
    return val;
  }
  if (key === "branch" || key === "ref" || key === "path") {
    const segments = val.split("/");
    if (segments.some((seg) => seg === "." || seg === "..")) {
      throw new Error(`Segmento relativo no permitido en "${key}".`);
    }
    return segments.map(encodeURIComponent).join("/");
  }
  if (val.includes("/") || val === "." || val === "..") {
    throw new Error(`Parámetro GitHub inválido para "${key}".`);
  }
  return encodeURIComponent(val);
}

function createRequestTimeoutSignal(externalSignal = null, timeoutMs = GITHUB_REQUEST_TIMEOUT_MS) {
  let timerId = null;
  let controller = null;
  let onExternalAbort = null;

  let timeoutSignal;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    timeoutSignal = AbortSignal.timeout(timeoutMs);
  } else {
    controller = new AbortController();
    timerId = setTimeout(() => controller.abort(new Error("Tiempo de espera agotado.")), timeoutMs);
    if (typeof timerId?.unref === "function") {
      timerId.unref();
    }
    timeoutSignal = controller.signal;
  }

  let signal = timeoutSignal;
  if (externalSignal) {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
      signal = AbortSignal.any([externalSignal, timeoutSignal]);
    } else {
      const combined = new AbortController();
      const forwardAbort = (source) => {
        if (!combined.signal.aborted) {
          combined.abort(source?.reason);
        }
      };
      if (externalSignal.aborted) {
        forwardAbort(externalSignal);
      } else {
        onExternalAbort = () => forwardAbort(externalSignal);
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        timeoutSignal.addEventListener("abort", () => forwardAbort(timeoutSignal), { once: true });
      }
      signal = combined.signal;
    }
  }

  return {
    signal,
    dispose() {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (externalSignal && onExternalAbort) {
        externalSignal.removeEventListener("abort", onExternalAbort);
        onExternalAbort = null;
      }
    }
  };
}

function isRemoteRepoEmpty(err, { allowNotFound = false } = {}) {
  const status = Number(err?.status) || 0;
  const msg = String(err?.message || "").toLowerCase();
  if (status === 409 || msg.includes("empty")) return true;
  if (allowNotFound && (status === 404 || msg.includes("not found"))) return true;
  return false;
}

export function getGithubToken() {
  try {
    return window.sessionStorage.getItem(GH_TOKEN_KEY) || window.localStorage.getItem(GH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function saveGithubToken(token) {
  const raw = String(token || "");
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    return;
  }
  const trimmed = raw.trim();
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
async function createGithubClient(token, { requireToken = true } = {}) {
  const isAnonymousPublic = !requireToken && (token === "" || token === undefined || token === null);
  let cleanToken = "";

  if (!isAnonymousPublic) {
    // 1. Verificar bloqueo progresivo por fuerza bruta antes de instanciar cliente o abrir red
    assertNotLockedOut(GH_SCOPE);

    // 2. Validación de formato pre-vuelo (descarta entradas vacías, cortas, prefijos inválidos o caracteres de control)
    const fmt = validateCredentialFormat("github", token);
    if (!fmt.valid) {
      throw new CredentialFormatError(fmt.reason, fmt.code);
    }
    cleanToken = fmt.clean;

    // 3. Bloqueo de sesión por huella ya rechazada previamente con 401
    if (isTokenRejectedInSession(GH_SCOPE, cleanToken)) {
      const rejectedErr = new Error(
        "GitHub rechazó este token previamente en esta sesión. Ingresá un nuevo Personal Access Token."
      );
      rejectedErr.status = 401;
      rejectedErr.rejectedInSession = true;
      throw rejectedErr;
    }
  }

  const raw = await createRawGithubClient(cleanToken);
  return {
    async request(route, params = {}) {
      if (cleanToken) {
        assertNotLockedOut(GH_SCOPE);
        if (isTokenRejectedInSession(GH_SCOPE, cleanToken)) {
          const rejectedErr = new Error(
            "GitHub rechazó este token previamente en esta sesión. Ingresá un nuevo Personal Access Token."
          );
          rejectedErr.status = 401;
          rejectedErr.rejectedInSession = true;
          throw rejectedErr;
        }
      }

      try {
        const data = await raw.request(route, params);
        if (cleanToken) {
          recordAuthSuccess(GH_SCOPE);
        }
        return data;
      } catch (error) {
        const status = Number(error?.status) || 0;
        const rawMsg = String(error?.message || "");
        const lowerMsg = rawMsg.toLowerCase();

        if (status === 401 && cleanToken) {
          markTokenRejectedInSession(GH_SCOPE, cleanToken);
          const failure = recordAuthFailure(GH_SCOPE);
          const lockSuffix = failure.locked
            ? ` Bloqueo temporal activado (${formatRemainingCooldown(failure.remainingMs)}) tras múltiples intentos fallidos.`
            : "";
          const authError = new Error(
            `GitHub rechazó el token (inválido, vencido o revocado). Conectá uno nuevo desde el botón Repositorio.${lockSuffix}`
          );
          authError.status = 401;
          authError.credentialRejected = true;
          authError.lockout = failure.locked ? failure : null;
          authError.cause = sanitizeErrorCause(error, [cleanToken]);
          throw authError;
        }

        if (status === 403 && cleanToken && isGithubCredentialRejection403(lowerMsg)) {
          markTokenRejectedInSession(GH_SCOPE, cleanToken);
          const failure = recordAuthFailure(GH_SCOPE);
          if (failure.locked) {
            throw new AuthLockoutError(GH_SCOPE, failure.remainingMs, failure.failedAttempts);
          }
          const rejectedErr = toFriendlyNetworkError(error, "GitHub");
          rejectedErr.status = 403;
          rejectedErr.credentialRejected = true;
          rejectedErr.cause = sanitizeErrorCause(error, [cleanToken]);
          if (rejectedErr.message) {
            rejectedErr.message = redactSensitiveTokens(rejectedErr.message, [cleanToken]);
          }
          throw rejectedErr;
        }

        const safeErr = toFriendlyNetworkError(error, "GitHub");
        if (safeErr instanceof Error) {
          safeErr.cause = sanitizeErrorCause(safeErr.cause ?? error, [cleanToken]);
          if (safeErr.message) {
            safeErr.message = redactSensitiveTokens(safeErr.message, [cleanToken]);
          }
        }
        throw safeErr;
      }
    }
  };
}

function isGithubRateLimitMessage(lowerMsg) {
  return (
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("secondary rate") ||
    lowerMsg.includes("abuse detection") ||
    lowerMsg.includes("too many requests")
  );
}

function isGithubCredentialRejection403(lowerMsg) {
  if (!lowerMsg || isGithubRateLimitMessage(lowerMsg)) return false;
  if (
    lowerMsg.includes("resource not accessible") ||
    lowerMsg.includes("protected branch") ||
    lowerMsg.includes("branch protection") ||
    lowerMsg.includes("repository rule") ||
    lowerMsg.includes("scope") ||
    lowerMsg.includes("permission") ||
    lowerMsg.includes("permiso") ||
    lowerMsg.includes("no tiene permiso")
  ) {
    return false;
  }
  return (
    lowerMsg.includes("bad credentials") ||
    lowerMsg.includes("invalid credentials") ||
    lowerMsg.includes("token expired") ||
    lowerMsg.includes("expired token") ||
    lowerMsg.includes("token revoked") ||
    lowerMsg.includes("revoked") ||
    lowerMsg.includes("requires authentication") ||
    lowerMsg.includes("organization sso") ||
    lowerMsg.includes("saml")
  );
}

async function createRawGithubClient(token) {
  try {
    const mod = await import("@octokit/core");
    if (mod && typeof mod.Octokit === "function") {
      const octokit = new mod.Octokit({ auth: token || undefined });
      return {
        async request(route, params = {}) {
          const [, rawPath = ""] = route.split(" ");
          rawPath.replace(/\{([^}]+)\}/g, (_, key) => validateGithubRouteParam(key, params?.[key]));
          const timeout = createRequestTimeoutSignal(params?.signal || null);
          try {
            const res = await octokit.request(route, {
              ...params,
              request: { ...(params?.request || {}), signal: timeout.signal }
            });
            return res.data;
          } finally {
            timeout.dispose();
          }
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
      const externalSignal = bodyPayload.signal || null;
      delete bodyPayload.signal;

      path = path.replace(/\{([^}]+)\}/g, (_, key) => {
        const val = bodyPayload[key];
        delete bodyPayload[key];
        return validateGithubRouteParam(key, val);
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

      const timeout = createRequestTimeoutSignal(externalSignal);
      init.signal = timeout.signal;
      let res;
      try {
        res = await fetch(url, init);
      } finally {
        timeout.dispose();
      }
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const errJson = await res.json();
          if (errJson?.message) detail = errJson.message;
        } catch {
          // Ignorar
        }
        if (detail.includes("Resource not accessible by personal access token") && rawPath.startsWith("/gists")) {
          detail =
            "Resource not accessible by personal access token: Tu token de GitHub no tiene permiso para Gists. Activá 'Account permissions -> Gists (Read and write)' en GitHub o usá un Token Classic con la casilla 'gist'.";
        }
        const safeDetail = redactSensitiveTokens(detail, [token]);
        const err = new Error(`GitHub API: ${safeDetail}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }
  };
}

/**
 * Comprueba un token con GET /user (GitHub responde 401 "Bad credentials" si es inválido, vencido o revocado).
 * Aplica bloqueo progresivo ante fuerza bruta, validación de formato pre-vuelo y rechazo por huella en sesión.
 * @returns {Promise<{ status: "valid", login: string } | { status: "invalid" | "offline" | "unknown" | "locked", message: string, remainingMs?: number }>}
 */
export async function verifyGithubToken(token) {
  const lockState = checkAuthLockout(GH_SCOPE);
  if (lockState.locked) {
    return {
      status: "locked",
      remainingMs: lockState.remainingMs,
      message: new AuthLockoutError(GH_SCOPE, lockState.remainingMs, lockState.failedAttempts).message
    };
  }

  const fmt = validateCredentialFormat("github", token);
  if (!fmt.valid) {
    return { status: "invalid", formatInvalid: true, message: fmt.reason };
  }

  if (isTokenRejectedInSession(GH_SCOPE, fmt.clean)) {
    return {
      status: "invalid",
      rejectedInSession: true,
      message: "Este token ya fue rechazado por GitHub en esta sesión. Ingresá un nuevo Personal Access Token."
    };
  }

  try {
    const user = await fetchGithubUser(fmt.clean);
    return { status: "valid", login: String(user?.login || "") };
  } catch (error) {
    if (error instanceof AuthLockoutError || error?.code === "ERR_AUTH_LOCKOUT") {
      return {
        status: "locked",
        remainingMs: error.remainingMs || 0,
        message: error.message
      };
    }
    if (error?.isNetworkFailure) {
      return { status: "offline", message: "Sin conexión: no se pudo verificar el token con GitHub." };
    }
    if (error?.status === 401 || error?.credentialRejected) {
      const postFailureLock = checkAuthLockout(GH_SCOPE);
      if (postFailureLock.locked) {
        return {
          status: "locked",
          remainingMs: postFailureLock.remainingMs,
          message: `Token inválido o vencido. Bloqueo temporal activado (${formatRemainingCooldown(postFailureLock.remainingMs)}) tras múltiples intentos fallidos.`
        };
      }
      return {
        status: "invalid",
        message: "Token inválido o vencido. Revisá que lo hayas copiado completo o generá uno nuevo en GitHub."
      };
    }
    const safeMsg = redactSensitiveTokens(
      error instanceof Error ? error.message : "error desconocido",
      [fmt.clean]
    );
    return {
      status: "unknown",
      message: `No se pudo verificar el token ahora (${safeMsg}).`
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
  const client = await createGithubClient(token, { requireToken: false });
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
  const client = await createGithubClient(token, { requireToken: false });

  let branchInfo = null;
  try {
    branchInfo = await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
      owner,
      repo,
      branch
    });
  } catch (err) {
    if (isRemoteRepoEmpty(err, { allowNotFound: true })) {
      // Verificar si el repositorio existe pero aún no tiene commits (vacío)
      const repoInfo = await client.request("GET /repos/{owner}/{repo}", { owner, repo });
      if (!repoInfo) {
        throw err;
      }
      const defaultBranch = repoInfo.default_branch || branch || "main";
      if (isRemoteRepoEmpty(err)) {
        return {
          commitSha: null,
          isEmptyRepo: true,
          branch: defaultBranch,
          entries: []
        };
      }

      // Ante 404 en /branches/{branch}, validar que realmente sea un repo vacío y no una rama inexistente.
      let repoHasCommits = typeof repoInfo.size === "number" && repoInfo.size > 0;
      if (!repoHasCommits && branch && defaultBranch && branch !== defaultBranch) {
        try {
          const defBranchInfo = await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
            owner,
            repo,
            branch: defaultBranch
          });
          if (defBranchInfo?.commit?.sha) {
            repoHasCommits = true;
          }
        } catch (defErr) {
          if (isRemoteRepoEmpty(defErr)) {
            return {
              commitSha: null,
              isEmptyRepo: true,
              branch: defaultBranch,
              entries: []
            };
          }
        }
      }

      if (!repoHasCommits) {
        try {
          const branchList = await client.request("GET /repos/{owner}/{repo}/branches", {
            owner,
            repo,
            per_page: 1
          });
          if (Array.isArray(branchList)) {
            if (branchList.length > 0) {
              repoHasCommits = true;
            } else {
              return {
                commitSha: null,
                isEmptyRepo: true,
                branch: defaultBranch,
                entries: []
              };
            }
          }
        } catch (listErr) {
          if (isRemoteRepoEmpty(listErr)) {
            return {
              commitSha: null,
              isEmptyRepo: true,
              branch: defaultBranch,
              entries: []
            };
          }
          if (repoInfo.size === 0 && (!branch || branch === defaultBranch)) {
            return {
              commitSha: null,
              isEmptyRepo: true,
              branch: defaultBranch,
              entries: []
            };
          }
        }
      }

      if (!repoHasCommits && repoInfo.size === 0 && (!branch || branch === defaultBranch)) {
        return {
          commitSha: null,
          isEmptyRepo: true,
          branch: defaultBranch,
          entries: []
        };
      }
      throw err;
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
    if (isRemoteRepoEmpty(err)) {
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
      if (node.path.startsWith("node_modules/") || node.path.startsWith(".git/")) return false;
      const isBin = isBinaryFile(node.path);
      const maxSize = isBin ? MAX_IMPORT_FILE_BYTES : MAX_TEXT_FILE_BYTES;
      if (typeof node.size === "number" && node.size > maxSize) return false;
      return true;
    })
    .map((node) => ({
      path: node.path,
      blobSha: node.sha,
      size: node.size || 0,
      mode: node.mode === "100755" ? "100755" : "100644",
      isBinary: isBinaryFile(node.path)
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
 * Devuelve string UTF-8 para archivos de texto, o `{ isBinary: true, base64, content: "" }` para binarios.
 */
export async function fetchSingleRepoBlob({ token, owner, repo, blobSha, path = "", isBinary = false }) {
  const client = await createGithubClient(token, { requireToken: false });
  const blob = await client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
    owner,
    repo,
    file_sha: blobSha
  });
  const parsed = parseGithubBlobPayload(blob, { path, isBinary });
  if (parsed.isBinary) {
    return {
      isBinary: true,
      base64: parsed.base64,
      content: ""
    };
  }
  return parsed.content;
}

/**
 * Descarga en lote una lista de archivos pendientes para dejar el repositorio disponible sin internet.
 */
export async function downloadBatchBlobs({ token, owner, repo, items, onProgress }) {
  const client = await createGithubClient(token, { requireToken: false });
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
        const parsed = parseGithubBlobPayload(blob, { path: item.path, isBinary: item.isBinary });
        return {
          path: item.path,
          blobSha: item.blobSha,
          mode: item.mode || null,
          isBinary: parsed.isBinary,
          base64: parsed.base64,
          content: parsed.content
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
  let initializedFilePath = null;
  let initializedCommitSha = null;

  try {
    const branchData = await client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
      owner,
      repo,
      branch
    });
    latestCommitSha = branchData?.commit?.sha || null;
    baseTreeSha = branchData?.commit?.commit?.tree?.sha || null;
  } catch (err) {
    if (isRemoteRepoEmpty(err, { allowNotFound: true })) {
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
        : utf8ToBase64(firstFile.content);
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
      initializedFilePath = firstFile.path;
      initializedCommitSha = latestCommitSha;
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
        latestCommitSha = branchDataAfter?.commit?.sha || latestCommitSha;
        baseTreeSha = branchDataAfter?.commit?.commit?.tree?.sha || null;
        if (latestCommitSha) {
          initializedCommitSha = latestCommitSha;
        }
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

  try {
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
          const blobSha = createdBlob?.sha || createdBlob?.data?.sha || "";
          if (typeof blobSha !== "string" || !blobSha.trim()) {
            throw new Error(`GitHub no devolvió un SHA de blob válido para "${change.path}".`);
          }
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
    if (!createdTree?.sha) {
      throw new Error("GitHub no devolvió un SHA de árbol válido al crear el commit.");
    }

    const createdCommit = await client.request("POST /repos/{owner}/{repo}/git/commits", {
      owner,
      repo,
      message: cleanMsg,
      tree: createdTree.sha,
      parents: [latestCommitSha]
    });
    if (!createdCommit?.sha) {
      throw new Error("GitHub no devolvió un SHA de commit válido.");
    }

    await client.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: createdCommit.sha
    });

    return {
      commitSha: createdCommit.sha
    };
  } catch (phase2Err) {
    // Si falló la fase 2 después de inicializar un repo vacío en fase 1, propagar qué archivo ya se publicó
    // para evitar reintentar el push completo sobre un estado divergente.
    if (initializedCommitSha && initializedFilePath && phase2Err && typeof phase2Err === "object") {
      phase2Err.partialCommitSha = initializedCommitSha;
      phase2Err.initializedFilePath = initializedFilePath;
      const baseMsg = phase2Err.message || "Error al completar el commit atómico.";
      phase2Err.message = `El repositorio se inicializó con "${initializedFilePath}" (${initializedCommitSha.slice(0, 7)}), pero falló el resto de archivos: ${baseMsg}`;
    }
    throw phase2Err;
  }
}

function parseGithubBlobPayload(blob, { path = "", isBinary = false } = {}) {
  const markedBinary = Boolean(isBinary) || (Boolean(path) && isBinaryFile(path));

  if (blob?.encoding !== "base64") {
    const raw = String(blob?.content || "");
    if (markedBinary) {
      return {
        isBinary: true,
        base64: utf8ToBase64(raw),
        content: ""
      };
    }
    return {
      isBinary: false,
      base64: null,
      content: raw
    };
  }

  const cleanBase64 = String(blob.content || "").replace(/\s+/g, "");
  // Modo estricto: propaga error explícito ante Base64 corrupto en lugar de degradar a "".
  const bytes = base64ToBytes(cleanBase64, { strict: true });
  if (markedBinary || hasNullBytes(bytes)) {
    return {
      isBinary: true,
      base64: cleanBase64,
      content: ""
    };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      isBinary: false,
      base64: null,
      content: text
    };
  } catch {
    return {
      isBinary: true,
      base64: cleanBase64,
      content: ""
    };
  }
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

  let manifestJson = JSON.stringify(manifest, null, 2);
  if (manifestJson.length > GIST_PRETTY_JSON_THRESHOLD_CHARS) {
    manifestJson = JSON.stringify(manifest);
  }

  const filesPayload = Object.create(null);
  filesPayload["studio_project.json"] = {
    content: manifestJson
  };

  // Agregar hasta 10 archivos de texto principales con nombres planos para previsualización en gist.github.com.
  manifest.entries
    .filter((entry) => !entry.isBinary)
    .slice(0, 10)
    .forEach((entry) => {
      const flatName = String(entry.path || "").replace(/[/\\:]/g, "__");
      if (flatName && !RESERVED_GIST_FILENAMES.has(flatName)) {
        filesPayload[flatName] = { content: entry.content || "// vacío" };
      }
    });

  const description = `[Studio IDE Backup] ${cleanName}`;
  const serializedSize = new TextEncoder().encode(JSON.stringify({ description, files: filesPayload })).length;
  if (serializedSize > MAX_GIST_PAYLOAD_BYTES) {
    throw new Error("El respaldo supera el límite máximo permitido (9 MB) para subir a GitHub Gist.");
  }

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
          const timeout = createRequestTimeoutSignal();
          try {
            const rawRes = await fetch(rawUrl, { signal: timeout.signal });
            if (rawRes.ok) {
              manifestRawContent = await rawRes.text();
            }
          } finally {
            timeout.dispose();
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
  const cleanName = slugifyName(repoName, { allowDots: true, collapse: false, fallback: "" });
  if (!cleanName || !isValidGithubRepoSegment(cleanName)) throw new Error("Nombre de repositorio inválido.");

  const createdRepo = await client.request("POST /user/repos", {
    name: cleanName,
    description: "Proyecto creado y sincronizado desde Studio IDE para iPad",
    private: Boolean(isPrivate),
    auto_init: false
  });

  const owner = createdRepo.owner?.login;
  const repo = createdRepo.name;
  const branch = createdRepo.default_branch || "main";

  let commitSha = null;
  const fileEntries = entries.filter((e) => !e.isFolder && !e.deleted && e.path);
  if (fileEntries.length > 0) {
    const pushRes = await pushAtomicCommit({
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
    commitSha = pushRes?.commitSha || null;
  }

  return {
    owner,
    repo,
    branch,
    commitSha,
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
