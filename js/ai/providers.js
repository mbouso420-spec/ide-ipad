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
  validateCredentialFormat
} from "../security/credentialGuard.js";
import { saveCredentialsBackup } from "../storage/workspaceDb.js";

function aiScope(providerId) {
  return `ai:${providerId || "unknown"}`;
}

const STORAGE_MODE_KEY = "ide.ai.storageMode";
const ACTIVE_PROVIDER_KEY = "ide.ai.provider";
const CUSTOM_MODEL_PREFIX = "ide.ai.model.";
const KEY_PREFIX = "ide.ai.key.";
const GH_TOKEN_STORAGE_KEY = "ide.github.pat";
const GH_REPOS_CACHE_KEY = "ide.github.reposCache";
const GH_USER_CACHE_KEY = "ide.github.userLogin";

const liveSyncedByProvider = new Map();
const liveModelsByProvider = new Map();

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

function getStorageArea(kind) {
  if (typeof window !== "undefined") {
    try {
      if (window[kind]) return window[kind];
    } catch {
      return null;
    }
  }
  try {
    return kind === "sessionStorage"
      ? typeof sessionStorage !== "undefined"
        ? sessionStorage
        : null
      : typeof localStorage !== "undefined"
        ? localStorage
        : null;
  } catch {
    return null;
  }
}

export function getProviderModels(providerId) {
  return liveModelsByProvider.get(providerId) || AI_PROVIDERS[providerId]?.models || [];
}

export const PROVIDER_SHORT_NAMES = {
  gemini: "Google Gemini",
  groq: "Groq",
  openrouter: "OpenRouter",
  mistral: "Mistral"
};

function providerLabel(providerId) {
  return PROVIDER_SHORT_NAMES[providerId] || "el proveedor de IA";
}

/**
 * Catálogo depurado con los 4 proveedores 100% GRATUITOS (sin tarjeta) y con soporte CORS directo en navegador
 * que siguen activos a fines de 2026:
 * - Google Gemini (Gratis): familia 3.x Flash / Flash-Lite + Gemma.
 * - Groq (Gratis): incluye los modelos oficiales abiertos de OpenAI (GPT-OSS 120B y 20B), Llama 4, Qwen 3 y Kimi.
 * - OpenRouter (Gratis): router inteligente openrouter/free + todos los modelos :free vigentes del día.
 * - Mistral / Codestral (Gratis): plan Experiment gratuito con Codestral y Devstral para código.
 *
 * Nota: GitHub Models (models.github.ai) fue dado de baja definitivamente por GitHub el 30 de julio de 2026,
 * por lo que se retiró de la lista de IA (tu token de GitHub sigue funcionando en el botón Repositorio para clonar y hacer commits).
 */
export const AI_PROVIDERS = {
  gemini: {
    id: "gemini",
    name: "Google Gemini (Gratis)",
    protocol: "gemini",
    supportsLiveModels: true,
    keyPlaceholder: "AIzaSy…",
    helpText: "Sincroniza automáticamente los modelos Flash gratuitos activos en tu cuenta y reintenta si hay alta demanda.",
    contextWindow: 1000000,
    freeQuota: "15 req/min · 1M TPM (Google AI Studio)",
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Recomendado, cuota gratuita)", contextWindow: 1000000 },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite (Rápido, menor latencia)", contextWindow: 1000000 },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (Estable, alta velocidad)", contextWindow: 1000000 }
    ]
  },
  groq: {
    id: "groq",
    name: "Groq (Llama 3.3, GPT de OpenAI y modelos abiertos)",
    protocol: "openai",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    supportsLiveModels: true,
    keyPlaceholder: "gsk_…",
    helpText: "100% gratis sin tarjeta en console.groq.com/keys. Incluye Llama 3.3 70B y responde al instante.",
    contextWindow: 128000,
    freeQuota: "30 req/min · 6.000 TPM (70B) / 30.000 TPM (8B)",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile (Potente y gratuito)", contextWindow: 128000 },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant (Ultrarrápido)", contextWindow: 128000 },
      { id: "openai/gpt-oss-120b", label: "OpenAI GPT-OSS 120B (Gratis y ultrarrápido)", contextWindow: 128000 },
      { id: "openai/gpt-oss-20b", label: "OpenAI GPT-OSS 20B (Instantáneo, cuota amplia)", contextWindow: 128000 }
    ]
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter (Modelos :free Gratis)",
    protocol: "openai",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    supportsLiveModels: true,
    keyPlaceholder: "sk-or-v1-…",
    helpText: "Gratis sin tarjeta en openrouter.ai/keys. El modo Auto-Router elige siempre un modelo :free activo.",
    contextWindow: 16000,
    freeQuota: "20 req/min · Modelos :free rotativos sin tarjeta",
    models: [
      { id: "openrouter/free", label: "Auto-Router Gratis (Elige un modelo :free activo)", contextWindow: 16000 },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "NVIDIA Nemotron 3 Ultra (:free)", contextWindow: 32000 },
      { id: "google/gemma-4-31b-it:free", label: "Google Gemma 4 31B (:free)", contextWindow: 8192 },
      { id: "cohere/north-mini-code:free", label: "Cohere North Mini Code (:free)", contextWindow: 16000 }
    ]
  },
  mistral: {
    id: "mistral",
    name: "Mistral / Codestral (Plan Gratis)",
    protocol: "openai",
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    supportsLiveModels: true,
    keyPlaceholder: "Clave de console.mistral.ai…",
    helpText: "Gratis activando el plan Experiment (sin tarjeta) en console.mistral.ai.",
    contextWindow: 32000,
    freeQuota: "1 req/seg · Plan Experiment gratis",
    models: [
      { id: "codestral-latest", label: "Codestral (Especialista en código)", contextWindow: 32000 },
      { id: "devstral-small-latest", label: "Devstral Small (Agente de programación)", contextWindow: 32000 },
      { id: "mistral-small-latest", label: "Mistral Small (Rápido y general)", contextWindow: 32000 }
    ]
  }
};

/**
 * Devuelve la capacidad máxima de tokens de contexto del modelo activo o del proveedor.
 * @param {string} providerId
 * @param {string} [modelId]
 * @returns {number}
 */
export function getModelContextWindow(providerId, modelId) {
  const provider = AI_PROVIDERS[providerId];
  if (!provider) return 16000;
  if (modelId) {
    const models = getProviderModels(providerId);
    const found = models.find((m) => m.id === modelId) || provider.models?.find((m) => m.id === modelId);
    if (found?.contextWindow) return found.contextWindow;
  }
  return provider.contextWindow || 16000;
}

export function isFreeActiveGoogleModelId(id) {
  const lower = String(id || "").toLowerCase();
  if (!lower.startsWith("gemini-") && !lower.startsWith("gemma-")) {
    return false;
  }
  const retiredOrPaidOrSpecial = [
    "1.0",
    "1.5",
    "argon",
    "-pro",
    "ultra",
    "tts",
    "audio",
    "transcribe",
    "-live",
    "image",
    "imagen",
    "veo",
    "embedding",
    "aqa",
    "robotics",
    "computer-use",
    "thinking-exp"
  ];
  for (const token of retiredOrPaidOrSpecial) {
    if (lower.includes(token)) {
      return false;
    }
  }
  return lower.includes("flash") || lower.startsWith("gemma-");
}

function isActiveGroqChatModelId(id) {
  const lower = String(id || "").toLowerCase();
  const excluded = [
    "whisper",
    "tts",
    "orpheus",
    "guard",
    "safeguard",
    "embedding"
  ];
  return !excluded.some((token) => lower.includes(token));
}

export function getKeyStorageMode() {
  try {
    const local = getStorageArea("localStorage");
    const mode = local?.getItem(STORAGE_MODE_KEY);
    return mode === "session" ? "session" : "local";
  } catch {
    return "session";
  }
}

export function setKeyStorageMode(nextMode) {
  const prevMode = getKeyStorageMode();
  if (prevMode === nextMode && nextMode !== "session") {
    return;
  }

  try {
    const local = getStorageArea("localStorage");
    const session = getStorageArea("sessionStorage");
    local?.setItem(STORAGE_MODE_KEY, nextMode);
    const fromStore = prevMode === "session" ? session : local;
    const toStore = nextMode === "session" ? session : local;

    for (const id of Object.keys(AI_PROVIDERS)) {
      const k = `${KEY_PREFIX}${id}`;
      const val = fromStore?.getItem(k);
      if (val) {
        toStore?.setItem(k, val);
      }
      if (fromStore !== toStore) {
        fromStore?.removeItem(k);
      }
      if (nextMode === "session") {
        local?.removeItem(k);
      }
    }
    for (const extraKey of [GH_TOKEN_STORAGE_KEY, GH_REPOS_CACHE_KEY, GH_USER_CACHE_KEY]) {
      const val = fromStore?.getItem(extraKey);
      if (val) {
        toStore?.setItem(extraKey, val);
      }
      if (fromStore !== toStore) {
        fromStore?.removeItem(extraKey);
      }
      if (nextMode === "session") {
        local?.removeItem(extraKey);
      }
    }
    if (nextMode === "session") {
      void saveCredentialsBackup("");
    }
  } catch {
    // Entorno restringido
  }
}

export function getApiKey(providerId) {
  if (!Object.hasOwn(AI_PROVIDERS, providerId)) {
    return "";
  }
  const k = `${KEY_PREFIX}${providerId}`;
  try {
    return getStorageArea("sessionStorage")?.getItem(k) || getStorageArea("localStorage")?.getItem(k) || "";
  } catch {
    return "";
  }
}

export function saveApiKey(providerId, apiKey) {
  if (!Object.hasOwn(AI_PROVIDERS, providerId)) {
    return;
  }
  const k = `${KEY_PREFIX}${providerId}`;
  const raw = String(apiKey || "");
  if (CONTROL_CHARS_RE.test(raw)) {
    return;
  }
  const trimmed = raw.trim();
  liveSyncedByProvider.delete(providerId);
  if (providerId !== "openrouter") {
    liveModelsByProvider.delete(providerId);
  }
  try {
    const local = getStorageArea("localStorage");
    const session = getStorageArea("sessionStorage");
    local?.removeItem(k);
    session?.removeItem(k);
    if (!trimmed) {
      return;
    }
    const target = getKeyStorageMode() === "session" ? session : local;
    target?.setItem(k, trimmed);
  } catch {
    // Entorno restringido
  }
}

export function clearApiKey(providerId) {
  saveApiKey(providerId, "");
}

export function exportKeysBundle() {
  const bundle = {};
  for (const id of Object.keys(AI_PROVIDERS)) {
    const val = getApiKey(id);
    if (val) {
      bundle[id] = val;
    }
  }
  try {
    const ghToken =
      getStorageArea("sessionStorage")?.getItem(GH_TOKEN_STORAGE_KEY) ||
      getStorageArea("localStorage")?.getItem(GH_TOKEN_STORAGE_KEY) ||
      "";
    if (ghToken) {
      bundle.githubPat = ghToken;
    }
    const currentProvider = getSavedProviderId();
    if (currentProvider) {
      bundle.activeProvider = currentProvider;
    }
  } catch {
    // Ignorar
  }
  return JSON.stringify(bundle);
}

function isValidImportedSecretString(raw) {
  if (typeof raw !== "string" || CONTROL_CHARS_RE.test(raw)) {
    return false;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 512 && !/\s/.test(trimmed);
}

export function importKeysBundle(rawJson) {
  const parsed = JSON.parse(rawJson);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Formato de claves inválido.");
  }
  let count = 0;
  for (const id of Object.keys(AI_PROVIDERS)) {
    if (Object.hasOwn(parsed, id) && isValidImportedSecretString(parsed[id])) {
      saveApiKey(id, parsed[id].trim());
      count += 1;
    }
  }
  const ghVal = parsed.githubPat || parsed.github || parsed.ghToken || parsed.token;
  if (isValidImportedSecretString(ghVal)) {
    try {
      const cleanPat = ghVal.trim();
      const local = getStorageArea("localStorage");
      const session = getStorageArea("sessionStorage");
      local?.removeItem(GH_TOKEN_STORAGE_KEY);
      session?.removeItem(GH_TOKEN_STORAGE_KEY);
      const target = getKeyStorageMode() === "session" ? session : local;
      target?.setItem(GH_TOKEN_STORAGE_KEY, cleanPat);
      count += 1;
    } catch {
      // Ignorar
    }
  }
  if (typeof parsed.activeProvider === "string" && Object.hasOwn(AI_PROVIDERS, parsed.activeProvider)) {
    saveProviderId(parsed.activeProvider);
  }
  return count;
}

export function hasStoredCredentials() {
  try {
    for (const id of Object.keys(AI_PROVIDERS)) {
      if (getApiKey(id)) return true;
    }
    const ghToken =
      getStorageArea("sessionStorage")?.getItem(GH_TOKEN_STORAGE_KEY) ||
      getStorageArea("localStorage")?.getItem(GH_TOKEN_STORAGE_KEY) ||
      "";
    return Boolean(ghToken && ghToken.trim());
  } catch {
    return false;
  }
}

export function getSavedProviderId() {
  try {
    const local = getStorageArea("localStorage");
    const saved = local?.getItem(ACTIVE_PROVIDER_KEY);
    if (saved && Object.hasOwn(AI_PROVIDERS, saved)) {
      return saved;
    }
    if (saved && !Object.hasOwn(AI_PROVIDERS, saved)) {
      local?.setItem(ACTIVE_PROVIDER_KEY, "gemini");
    }
    return "gemini";
  } catch {
    return "gemini";
  }
}

export function saveProviderId(providerId) {
  if (!Object.hasOwn(AI_PROVIDERS, providerId)) return;
  try {
    getStorageArea("localStorage")?.setItem(ACTIVE_PROVIDER_KEY, providerId);
  } catch {
    // Ignorar
  }
}

export function getSavedModel(providerId) {
  const provider = Object.hasOwn(AI_PROVIDERS, providerId) ? AI_PROVIDERS[providerId] : AI_PROVIDERS.gemini;
  const fallbackModel = getProviderModels(provider.id)[0]?.id || provider.models[0].id;
  try {
    const local = getStorageArea("localStorage");
    const saved = local?.getItem(`${CUSTOM_MODEL_PREFIX}${provider.id}`);
    if (saved) {
      if (provider.id === "gemini" && !isFreeActiveGoogleModelId(saved)) {
        local?.setItem(`${CUSTOM_MODEL_PREFIX}${provider.id}`, fallbackModel);
        return fallbackModel;
      }
      if (provider.id === "groq" && !isActiveGroqChatModelId(saved)) {
        local?.setItem(`${CUSTOM_MODEL_PREFIX}${provider.id}`, fallbackModel);
        return fallbackModel;
      }
      return saved;
    }
    return fallbackModel;
  } catch {
    return fallbackModel;
  }
}

export function saveModel(providerId, modelId) {
  if (!Object.hasOwn(AI_PROVIDERS, providerId)) return;
  try {
    getStorageArea("localStorage")?.setItem(`${CUSTOM_MODEL_PREFIX}${providerId}`, String(modelId || "").trim());
  } catch {
    // Ignorar
  }
}

/**
 * Consulta en vivo los modelos gratuitos vigentes directamente desde el servidor del proveedor.
 */
const KEY_CHECK_ENDPOINTS = {
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", header: "x-goog-api-key" },
  groq: { url: "https://api.groq.com/openai/v1/models", header: "bearer" },
  mistral: { url: "https://api.mistral.ai/v1/models", header: "bearer" },
  // La lista de modelos de OpenRouter es pública: /key es la consulta que sí exige una clave válida.
  openrouter: { url: "https://openrouter.ai/api/v1/key", header: "bearer" }
};

/**
 * Comprueba una API Key con UNA consulta liviana al proveedor oficial (no consume cuota de generación).
 * Respuestas verificadas contra las APIs reales: Gemini responde 400 "API key not valid";
 * Groq, Mistral y OpenRouter responden 401 ante una clave inválida.
 * @returns {Promise<{ status: "valid" | "invalid" | "offline" | "unknown", message: string }>}
 */
export async function validateApiKey(providerId, apiKey, signal) {
  const scope = aiScope(providerId);
  const check = KEY_CHECK_ENDPOINTS[providerId];
  const label = providerLabel(providerId);

  const lockState = checkAuthLockout(scope);
  if (lockState.locked) {
    return {
      status: "locked",
      remainingMs: lockState.remainingMs,
      message: new AuthLockoutError(scope, lockState.remainingMs, lockState.failedAttempts).message
    };
  }

  const fmt = validateCredentialFormat(providerId, apiKey);
  if (!fmt.valid) {
    return { status: "invalid", formatInvalid: true, message: fmt.reason };
  }
  const cleanKey = fmt.clean;

  if (isTokenRejectedInSession(scope, cleanKey)) {
    return {
      status: "invalid",
      rejectedInSession: true,
      message: `Esta clave de ${label} ya fue rechazada en esta sesión. Probá con otra clave.`
    };
  }

  if (!check) {
    return { status: "unknown", message: `No hay verificación disponible para ${label}.` };
  }

  const headers =
    check.header === "bearer" ? { Authorization: `Bearer ${cleanKey}` } : { [check.header]: cleanKey };

  let res;
  try {
    res = await fetch(check.url, { headers, signal });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const friendly = toFriendlyNetworkError(error, label);
    if (friendly?.isNetworkFailure) {
      return { status: "offline", message: `Sin conexión: no se pudo verificar la clave de ${label}.` };
    }
    return { status: "unknown", message: `No se pudo verificar la clave de ${label} ahora.` };
  }

  if (res.ok || res.status === 429) {
    // 429 = la clave fue reconocida pero llegó al límite momentáneo de consultas.
    recordAuthSuccess(scope);
    return { status: "valid", message: `Clave de ${label} verificada.` };
  }

  let detail = "";
  try {
    const data = await res.json();
    detail = String(data?.error?.message || data?.detail || data?.message || "");
  } catch {
    // Sin cuerpo JSON
  }

  const keyRejected =
    res.status === 401 ||
    res.status === 403 ||
    (res.status === 400 && /api key|api_key|apikey/i.test(detail));
  if (keyRejected) {
    markTokenRejectedInSession(scope, cleanKey);
    const failure = recordAuthFailure(scope);
    if (failure.locked) {
      return {
        status: "locked",
        remainingMs: failure.remainingMs,
        message: `${label} rechazó la clave. Bloqueo temporal activado (${formatRemainingCooldown(failure.remainingMs)}) tras múltiples intentos fallidos.`
      };
    }
    return {
      status: "invalid",
      message: `${label} rechazó la clave. Revisá que la hayas copiado completa o generá una nueva.`
    };
  }
  return { status: "unknown", message: `No se pudo verificar la clave de ${label} (respuesta ${res.status}).` };
}

export function isAbortError(error) {
  return Boolean(error && typeof error === "object" && error.name === "AbortError");
}

export async function fetchLiveFreeModels(providerId, apiKey, signal, options = {}) {
  try {
    return await fetchLiveFreeModelsRaw(providerId, apiKey, signal, options);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const friendly = toFriendlyNetworkError(error, providerLabel(providerId));
    if (friendly instanceof Error && friendly.message) {
      friendly.message = redactSensitiveTokens(friendly.message, [apiKey]);
    }
    throw friendly;
  }
}

async function fetchLiveFreeModelsRaw(providerId, apiKey, signal, { trackAuthFailure = true } = {}) {
  const scope = aiScope(providerId);
  if (providerId !== "openrouter") {
    assertNotLockedOut(scope);
    const fmt = validateCredentialFormat(providerId, apiKey);
    if (!fmt.valid) {
      throw new CredentialFormatError(fmt.reason, fmt.code);
    }
    if (isTokenRejectedInSession(scope, fmt.clean)) {
      const err = new Error(`Esta clave de ${providerLabel(providerId)} ya fue rechazada en esta sesión.`);
      err.httpStatus = 401;
      throw err;
    }
    apiKey = fmt.clean;
  }

  if (providerId === "gemini") {
    if (!apiKey) {
      throw new Error("Pegá primero tu API Key de Google AI Studio.");
    }
    // La clave viaja en cabecera (no en la URL) para que no quede en historiales, logs ni cachés intermedias.
    const url = "https://generativelanguage.googleapis.com/v1beta/models";
    const res = await fetch(url, { signal, headers: { "x-goog-api-key": apiKey } });
    if (!res.ok) {
      if (trackAuthFailure && (res.status === 401 || res.status === 403)) {
        markTokenRejectedInSession(scope, apiKey);
        recordAuthFailure(scope);
      }
      throw new Error(`Error al consultar Gemini (${res.status}).`);
    }
    recordAuthSuccess(scope);
    const data = await res.json();
    const list = Array.isArray(data.models) ? data.models : [];
    const filtered = list
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => {
        const id = String(m.name || "").replace(/^models\//, "");
        return {
          id,
          label: m.displayName ? `${m.displayName} (${id})` : id
        };
      })
      .filter((m) => isFreeActiveGoogleModelId(m.id));

    filtered.sort((a, b) => scoreGoogleModel(a.id) - scoreGoogleModel(b.id));

    if (filtered.length > 0) {
      liveModelsByProvider.set("gemini", filtered);
      liveSyncedByProvider.set("gemini", apiKey);
    }
    return filtered;
  }

  if (providerId === "groq") {
    if (!apiKey) {
      throw new Error("Pegá primero tu API Key gratuita de Groq.");
    }
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal
    });
    if (!res.ok) {
      if (trackAuthFailure && (res.status === 401 || res.status === 403)) {
        markTokenRejectedInSession(scope, apiKey);
        recordAuthFailure(scope);
      }
      throw new Error(`Error al consultar Groq (${res.status}).`);
    }
    recordAuthSuccess(scope);
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : [];
    const filtered = list
      .filter((m) => m?.active !== false && isActiveGroqChatModelId(m.id))
      .map((m) => ({
        id: m.id,
        label: formatGroqLabel(m.id)
      }));

    filtered.sort((a, b) => scoreGroqModel(a.id) - scoreGroqModel(b.id));

    if (filtered.length > 0) {
      liveModelsByProvider.set("groq", filtered);
      liveSyncedByProvider.set("groq", apiKey);
    }
    return filtered;
  }

  if (providerId === "openrouter") {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal });
    if (!res.ok) {
      throw new Error(`Error al consultar OpenRouter (${res.status}).`);
    }
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : [];
    const freeItems = list
      .filter((m) => String(m.id || "").endsWith(":free"))
      .map((m) => ({
        id: m.id,
        label: m.name ? `${m.name}` : m.id
      }));

    const combined = [
      { id: "openrouter/free", label: "Auto-Router Gratis (Elige un modelo :free activo)" },
      ...freeItems.filter((m) => m.id !== "openrouter/free")
    ];

    liveModelsByProvider.set("openrouter", combined);
    liveSyncedByProvider.set("openrouter", "public");
    return combined;
  }

  if (providerId === "mistral") {
    if (!apiKey) {
      throw new Error("Pegá primero tu clave gratuita de Mistral.");
    }
    const res = await fetch("https://api.mistral.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal
    });
    if (!res.ok) {
      if (trackAuthFailure && (res.status === 401 || res.status === 403)) {
        markTokenRejectedInSession(scope, apiKey);
        recordAuthFailure(scope);
      }
      throw new Error(`Error al consultar Mistral (${res.status}).`);
    }
    recordAuthSuccess(scope);
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : [];
    const filtered = list
      .filter((m) => {
        const id = String(m.id || "").toLowerCase();
        return !id.includes("embed") && !id.includes("moderation") && !id.includes("ocr") && !id.includes("voxtral");
      })
      .map((m) => ({ id: m.id, label: m.id }));

    if (filtered.length > 0) {
      const preferred = ["codestral-latest", "devstral-small-latest", "mistral-small-latest"];
      filtered.sort((a, b) => {
        const ia = preferred.indexOf(a.id);
        const ib = preferred.indexOf(b.id);
        if (ia !== -1 || ib !== -1) {
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        }
        return a.id.localeCompare(b.id);
      });
      liveModelsByProvider.set("mistral", filtered);
      liveSyncedByProvider.set("mistral", apiKey);
    }
    return filtered;
  }

  return getProviderModels(providerId);
}

function formatGroqLabel(id) {
  if (id === "openai/gpt-oss-120b") return "OpenAI GPT-OSS 120B (Gratis y ultrarrápido)";
  if (id === "openai/gpt-oss-20b") return "OpenAI GPT-OSS 20B (Instantáneo)";
  return id;
}

function scoreGroqModel(id) {
  const lower = id.toLowerCase();
  if (lower === "openai/gpt-oss-120b") return 1;
  if (lower === "openai/gpt-oss-20b") return 2;
  if (lower.includes("gpt-oss")) return 3;
  if (lower.includes("qwen") || lower.includes("kimi") || lower.includes("llama-4") || lower.includes("deepseek")) return 4;
  return 5;
}

function scoreGoogleModel(id) {
  if (id.includes("flash-lite")) return 1;
  if (id.startsWith("gemini-2.5-flash")) return 2;
  if (id.startsWith("gemini-3")) return 3;
  if (id.startsWith("gemini-")) return 4;
  if (id.startsWith("gemma-") && id.includes("-it")) return 5;
  return 6;
}

export async function streamAiCompletion({
  providerId,
  model,
  apiKey,
  systemPrompt,
  history,
  onChunk,
  onFallbackNotice,
  onModelsSynced,
  signal
}) {
  const provider = AI_PROVIDERS[providerId] ?? AI_PROVIDERS.gemini;
  const scope = aiScope(provider.id);

  // 1. Verificar bloqueo progresivo por fuerza bruta antes de cualquier llamada de red
  assertNotLockedOut(scope);

  // 2. Validar formato pre-vuelo de la API Key
  const fmt = validateCredentialFormat(provider.id, apiKey);
  if (!fmt.valid) {
    throw new CredentialFormatError(fmt.reason, fmt.code);
  }
  const cleanKey = fmt.clean;

  // 3. Impedir reenvío de clave ya rechazada (401/403) en la sesión actual
  if (isTokenRejectedInSession(scope, cleanKey)) {
    const err = new Error(
      `${providerLabel(provider.id)} rechazó esta clave previamente en esta sesión. Ingresá una nueva API Key.`
    );
    err.httpStatus = 401;
    err.rejectedInSession = true;
    throw err;
  }

  if (provider.protocol === "gemini") {
    return streamGeminiWithFallback({
      model,
      apiKey: cleanKey,
      systemPrompt,
      history,
      onChunk,
      onFallbackNotice,
      onModelsSynced,
      signal
    });
  }

  return streamOpenAiWithFallback({
    provider,
    model,
    apiKey: cleanKey,
    systemPrompt,
    history,
    onChunk,
    onFallbackNotice,
    onModelsSynced,
    signal
  });
}

async function streamGeminiWithFallback({
  model,
  apiKey,
  systemPrompt,
  history,
  onChunk,
  onFallbackNotice,
  onModelsSynced,
  signal
}) {
  let cleanRequested = model.replace(/^models\//, "");

  if (liveSyncedByProvider.get("gemini") !== apiKey) {
    try {
      const live = await fetchLiveFreeModels("gemini", apiKey, signal, { trackAuthFailure: false });
      if (live.length > 0) {
        onModelsSynced?.("gemini", live);
      }
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        throw isAbortError(err) ? err : new DOMException("Aborted", "AbortError");
      }
      // Seguimos con los modelos 3.x precargados; el endpoint de generación validará la clave
    }
  }

  const activeIds = getProviderModels("gemini").map((m) => m.id);
  if (
    !isFreeActiveGoogleModelId(cleanRequested) ||
    (liveSyncedByProvider.get("gemini") === apiKey && activeIds.length > 0 && !activeIds.includes(cleanRequested))
  ) {
    cleanRequested = activeIds[0] || AI_PROVIDERS.gemini.models[0].id;
  }

  const candidates = [cleanRequested, ...activeIds].filter(
    (m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx
  );

  let lastError = null;
  let emittedAnyChunk = false;
  const trackedOnChunk = (text) => {
    emittedAnyChunk = true;
    onChunk(text);
  };

  for (let i = 0; i < candidates.length; i += 1) {
    const candidateModel = candidates[i];
    const maxAttempts = i === 0 ? 3 : 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        if (i > 0 && attempt === 1) {
          onFallbackNotice?.(
            `Usando modelo alternativo activo (${candidateModel}) para responder sin espera.`
          );
        } else if (attempt > 1) {
          const waitMs = attempt === 2 ? 1300 : 2600;
          onFallbackNotice?.(
            `Alta demanda momentánea en ${candidateModel}; reintentando automáticamente (${attempt}/${maxAttempts})…`
          );
          await waitAbortable(waitMs, signal);
        }

        await runSingleGeminiStream({
          cleanModel: candidateModel,
          apiKey,
          systemPrompt,
          history,
          onChunk: trackedOnChunk,
          signal
        });
        return;
      } catch (rawError) {
        if (isAbortError(rawError)) {
          throw rawError;
        }
        const error = toFriendlyNetworkError(rawError, providerLabel("gemini"));
        if (emittedAnyChunk || error?.isNetworkFailure) {
          // Ya se mostró parte de la respuesta (reintentar duplicaría texto) o no hay red (reintentar no sirve).
          throw error;
        }
        lastError = error;
        const status = error?.httpStatus || 0;
        const msg = String(error?.message || "").toLowerCase();

        const isNotFound =
          status === 404 || msg.includes("no longer available") || msg.includes("not found");
        const isOverloaded =
          status === 503 ||
          status === 429 ||
          msg.includes("overloaded") ||
          msg.includes("high demand") ||
          msg.includes("unavailable") ||
          msg.includes("resource_exhausted");

        if (isNotFound) {
          break;
        }
        if (!isOverloaded) {
          throw error;
        }
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
}

async function streamOpenAiWithFallback({
  provider,
  model,
  apiKey,
  systemPrompt,
  history,
  onChunk,
  onFallbackNotice,
  onModelsSynced,
  signal
}) {
  const syncToken = provider.id === "openrouter" ? "public" : apiKey;
  if (provider.supportsLiveModels && liveSyncedByProvider.get(provider.id) !== syncToken) {
    try {
      const live = await fetchLiveFreeModels(provider.id, apiKey, signal, { trackAuthFailure: false });
      if (live.length > 0) {
        onModelsSynced?.(provider.id, live);
      }
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        throw isAbortError(err) ? err : new DOMException("Aborted", "AbortError");
      }
      // Continuar con lista base
    }
  }

  const activeIds = getProviderModels(provider.id).map((m) => m.id);
  let startModel = model;
  if (
    liveSyncedByProvider.get(provider.id) === syncToken &&
    activeIds.length > 0 &&
    !activeIds.includes(startModel)
  ) {
    startModel = activeIds[0];
  }

  const fallbackPool =
    provider.id === "openrouter"
      ? [startModel, "openrouter/free", ...activeIds.slice(0, 3)]
      : [startModel, ...activeIds.slice(0, 3)];

  const candidates = fallbackPool.filter((m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx);
  let lastError = null;
  let emittedAnyChunk = false;
  const trackedOnChunk = (text) => {
    emittedAnyChunk = true;
    onChunk(text);
  };

  for (let i = 0; i < candidates.length; i += 1) {
    const candidateModel = candidates[i];
    try {
      if (i > 0) {
        onFallbackNotice?.(`Cambiando automáticamente a ${candidateModel}…`);
      }
      await runSingleOpenAiStream({
        providerId: provider.id,
        endpoint: provider.endpoint,
        model: candidateModel,
        apiKey,
        systemPrompt,
        history,
        onChunk: trackedOnChunk,
        signal
      });
      return;
    } catch (rawError) {
      if (isAbortError(rawError)) {
        throw rawError;
      }
      const error = toFriendlyNetworkError(rawError, providerLabel(provider.id));
      if (emittedAnyChunk || error?.isNetworkFailure) {
        // Ya se mostró parte de la respuesta (reintentar duplicaría texto) o no hay red (reintentar no sirve).
        throw error;
      }
      lastError = error;
      const status = error?.httpStatus || 0;
      const msg = String(error?.message || "").toLowerCase();
      const canFallback =
        status === 404 ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        msg.includes("model_not_found") ||
        msg.includes("decommissioned") ||
        msg.includes("not found") ||
        msg.includes("rate limit");

      if (!canFallback) {
        throw error;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
}

function waitAbortable(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  const timerApi = typeof window !== "undefined" ? window : globalThis;
  return new Promise((resolve, reject) => {
    let onAbort = null;
    const timer = timerApi.setTimeout(() => {
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        timerApi.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function createFetchConnectSignal(parentSignal, timeoutMs = 45000) {
  const timerApi = typeof window !== "undefined" ? window : globalThis;
  const controller = new AbortController();
  let onParentAbort = null;
  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason || new DOMException("Aborted", "AbortError"));
    return { signal: controller.signal, clearTimer: () => {}, cleanup: () => {} };
  }
  if (parentSignal) {
    onParentAbort = () => {
      controller.abort(parentSignal.reason || new DOMException("Aborted", "AbortError"));
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  let timer = timerApi.setTimeout(() => {
    controller.abort(new DOMException("Tiempo de espera agotado al conectar con el servidor de IA.", "TimeoutError"));
  }, timeoutMs);
  const clearTimer = () => {
    if (timer) {
      timerApi.clearTimeout(timer);
      timer = 0;
    }
  };
  return {
    signal: controller.signal,
    clearTimer,
    cleanup: () => {
      clearTimer();
      if (onParentAbort) {
        parentSignal?.removeEventListener("abort", onParentAbort);
        onParentAbort = null;
      }
    }
  };
}

async function runSingleGeminiStream({ cleanModel, apiKey, systemPrompt, history, onChunk, signal }) {
  const isGemma = cleanModel.toLowerCase().startsWith("gemma-");
  const supportsThinking = /^gemini-(2\.5|3)/i.test(cleanModel) && !isGemma;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:streamGenerateContent?alt=sse`;

  const contents = history.map((msg, idx) => {
    const text =
      isGemma && idx === 0 && msg.role === "user"
        ? `${systemPrompt}\n\nConsulta del usuario:\n${msg.content}`
        : msg.content;
    return {
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text }]
    };
  });

  const generationConfig = { temperature: getAiTemperature() };
  if (supportsThinking) {
    generationConfig.thinkingConfig = { thinkingBudget: getThinkingBudget() };
  }

  const bodyPayload = {
    contents,
    generationConfig
  };
  if (!isGemma) {
    bodyPayload.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const connect = createFetchConnectSignal(signal);
  try {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(bodyPayload),
        signal: connect.signal
      });
    } finally {
      connect.clearTimer();
    }

    if (!res.ok) {
      const errMsg = await extractApiError(res, `Gemini (${cleanModel})`, apiKey);
      const keyInvalid =
        res.status === 401 ||
        res.status === 403 ||
        (res.status === 400 && /api key|api_key|apikey/i.test(errMsg));
      if (keyInvalid) {
        const scope = aiScope("gemini");
        markTokenRejectedInSession(scope, apiKey);
        recordAuthFailure(scope);
      }
      const err = new Error(errMsg);
      err.httpStatus = res.status;
      throw err;
    }

    recordAuthSuccess(aiScope("gemini"));

    await consumeSseStream(
      res.body,
      (jsonStr) => {
        const payload = JSON.parse(jsonStr);
        const parts = payload?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part?.thought) {
              continue;
            }
            if (typeof part.text === "string" && part.text.length > 0) {
              onChunk(part.text);
            }
          }
        }
      },
      connect.signal
    );
  } finally {
    connect.cleanup();
  }
}

async function runSingleOpenAiStream({ providerId, endpoint, model, apiKey, systemPrompt, history, onChunk, signal }) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  if (providerId === "openrouter") {
    const origin =
      typeof window !== "undefined" ? window.location?.origin || "https://github.io" : "https://github.io";
    headers["HTTP-Referer"] = origin;
    headers["X-Title"] = "Studio IDE";
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((msg) => ({ role: msg.role, content: msg.content }))
  ];

  const connect = createFetchConnectSignal(signal);
  try {
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          temperature: getAiTemperature()
        }),
        signal: connect.signal
      });
    } finally {
      connect.clearTimer();
    }

    if (!res.ok) {
      const errMsg = await extractApiError(res, `${AI_PROVIDERS[providerId]?.name || providerId} (${model})`, apiKey);
      if (res.status === 401 || res.status === 403) {
        const scope = aiScope(providerId);
        markTokenRejectedInSession(scope, apiKey);
        recordAuthFailure(scope);
      }
      const err = new Error(errMsg);
      err.httpStatus = res.status;
      throw err;
    }

    recordAuthSuccess(aiScope(providerId));

    await consumeSseStream(
      res.body,
      (jsonStr) => {
        const payload = JSON.parse(jsonStr);
        const delta = payload?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          onChunk(delta);
        }
      },
      connect.signal
    );
  } finally {
    connect.cleanup();
  }
}

function readChunkWithAbortAndTimeout(reader, signal, chunkTimeoutMs) {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
    return Promise.reject(reason);
  }
  const timerApi = typeof window !== "undefined" ? window : globalThis;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timerId = 0;
    let onAbort = null;
    const cleanup = () => {
      if (timerId) {
        timerApi.clearTimeout(timerId);
        timerId = 0;
      }
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    if (signal) {
      onAbort = () => {
        const reason = signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
        fail(reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (chunkTimeoutMs > 0 && Number.isFinite(chunkTimeoutMs)) {
      timerId = timerApi.setTimeout(() => {
        fail(new DOMException("Tiempo de espera agotado esperando datos del flujo de IA.", "TimeoutError"));
      }, chunkTimeoutMs);
    }
    Promise.resolve(reader.read()).then(
      (chunk) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(chunk);
      },
      (err) => {
        fail(err);
      }
    );
  });
}

async function consumeSseStream(body, onDataPacket, signal = null, chunkTimeoutMs = 45000) {
  if (!body) {
    throw new Error("El navegador no recibió un flujo de datos válido.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const eventDataLines = [];

  const flushEvent = () => {
    if (eventDataLines.length === 0) {
      return;
    }
    const payload = eventDataLines.join("\n").trim();
    eventDataLines.length = 0;
    if (!payload || payload === "[DONE]") {
      return;
    }
    try {
      onDataPacket(payload);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return;
      }
      throw err;
    }
  };

  const processLine = (rawLine) => {
    if (rawLine === "") {
      flushEvent();
      return;
    }
    if (rawLine.startsWith(":")) {
      return;
    }
    if (rawLine === "data") {
      eventDataLines.push("");
      return;
    }
    if (rawLine.startsWith("data:")) {
      let val = rawLine.slice(5);
      if (val.startsWith(" ")) {
        val = val.slice(1);
      }
      eventDataLines.push(val);
    }
  };

  const drainLines = (isFinal) => {
    let pos = 0;
    while (pos < buffer.length) {
      const nlIdx = buffer.indexOf("\n", pos);
      const crIdx = buffer.indexOf("\r", pos);
      let brIdx = -1;
      let brLen = 0;
      if (crIdx !== -1 && (nlIdx === -1 || crIdx < nlIdx)) {
        if (crIdx + 1 < buffer.length) {
          brIdx = crIdx;
          brLen = buffer.charCodeAt(crIdx + 1) === 10 ? 2 : 1;
        } else if (isFinal) {
          brIdx = crIdx;
          brLen = 1;
        } else {
          break;
        }
      } else if (nlIdx !== -1) {
        brIdx = nlIdx;
        brLen = 1;
      } else {
        break;
      }
      processLine(buffer.slice(pos, brIdx));
      pos = brIdx + brLen;
    }
    if (pos > 0) {
      buffer = buffer.slice(pos);
    }
  };

  try {
    while (true) {
      const { value, done } = await readChunkWithAbortAndTimeout(reader, signal, chunkTimeoutMs);
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      drainLines(false);
    }

    drainLines(true);
    if (buffer.length > 0) {
      processLine(buffer);
    }
    flushEvent();
  } catch (err) {
    try {
      await reader.cancel?.();
    } catch {
      // Ignorar errores secundarios al cancelar el lector
    }
    throw err;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // El lector ya fue liberado
    }
  }
}

export const AI_TEMP_STORAGE_KEY = "studio_ai_temp";
export const AI_BUDGET_STORAGE_KEY = "studio_ai_budget";
export const AI_THINKING_SPEED_STORAGE_KEY = "studio_ai_thinking_speed";

export function getAiThinkingSpeed() {
  try {
    const val = getStorageArea("localStorage")?.getItem(AI_THINKING_SPEED_STORAGE_KEY);
    if (val === "baja" || val === "media" || val === "alta") return val;
  } catch (_) {}
  return "media";
}

export function setAiThinkingSpeed(speed) {
  try {
    getStorageArea("localStorage")?.setItem(AI_THINKING_SPEED_STORAGE_KEY, String(speed));
  } catch (_) {}
}

export function getThinkingBudget(speed = getAiThinkingSpeed()) {
  switch (speed) {
    case "baja":
      return 1024;
    case "alta":
      return 16384;
    case "media":
    default:
      return 4096;
  }
}

export function getAiTemperature() {
  try {
    const val = parseFloat(getStorageArea("localStorage")?.getItem(AI_TEMP_STORAGE_KEY));
    if (!isNaN(val) && val >= 0 && val <= 2) return val;
  } catch (_) {}
  return 0.25;
}

export function setAiTemperature(temp) {
  try {
    getStorageArea("localStorage")?.setItem(AI_TEMP_STORAGE_KEY, String(temp));
  } catch (_) {}
}

export function getAiContextBudget() {
  try {
    const val = getStorageArea("localStorage")?.getItem(AI_BUDGET_STORAGE_KEY);
    if (val === "compact") return 8000;
    if (val === "large") return 40000;
  } catch (_) {}
  return 16000;
}

export function setAiContextBudget(mode) {
  try {
    getStorageArea("localStorage")?.setItem(AI_BUDGET_STORAGE_KEY, String(mode));
  } catch (_) {}
}

async function extractApiError(res, label, secret = "") {
  try {
    const data = await res.json();
    const detail = data?.error?.message || data?.message || JSON.stringify(data);
    return redactSensitiveTokens(`${label} (${res.status}): ${detail}`, [secret]);
  } catch {
    return `${label}: error HTTP ${res.status}. Verificá tu clave gratuita o probá otro modelo de la lista.`;
  }
}
