import "./setup.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const ai = await import("../js/ai/providers.js");
const gh = await import("../js/github/githubService.js");
const { resetAuthSecurityState } = await import("../js/security/credentialGuard.js");

const TEST_KEYS_INVALID = {
  gemini: "AIzaSyInvalidTestKey1234567890abcd",
  groq: "gsk_InvalidTestKey1234567890abcdef",
  mistral: "mistralInvalidTestKey1234567890ab",
  openrouter: "sk-or-v1-InvalidTestKey1234567890ab"
};
const TEST_KEYS_VALID = {
  gemini: "AIzaSyValidTestKey1234567890abcdef",
  groq: "gsk_ValidTestKey1234567890abcdef12",
  mistral: "mistralValidTestKey1234567890abcd",
  openrouter: "sk-or-v1-ValidTestKey1234567890abcd"
};
const GH_TOK_INVALID = "ghp_InvalidTestToken1234567890abcd";
const GH_TOK_VALID = "ghp_ValidTestToken1234567890abcdef";
const GH_TOK_RATE = "ghp_RateLimitToken1234567890abcdef";

/** Respuestas reales capturadas el 2026-11-04 con claves falsas (curl contra cada API). */
const REAL_INVALID = {
  gemini: [400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }],
  groq: [401, { error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } }],
  mistral: [401, { detail: "Invalid API Key" }],
  openrouter: [401, { error: { message: "User not found.", code: 401 } }]
};

function fakeFetch(status, body, seen = []) {
  return async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers || {} });
    return new Response(JSON.stringify(body), { status });
  };
}

describe("Validación de claves de IA", () => {
  beforeEach(() => resetAuthSecurityState());

  for (const [provider, [status, body]] of Object.entries(REAL_INVALID)) {
    test(`${provider}: respuesta real de clave inválida (${status}) -> "invalid" con mensaje en español`, async () => {
      globalThis.fetch = fakeFetch(status, body);
      const r = await ai.validateApiKey(provider, TEST_KEYS_INVALID[provider]);
      assert.equal(r.status, "invalid");
      assert.match(r.message, /rechazó la clave/);
    });
    test(`${provider}: 200 -> "valid"`, async () => {
      globalThis.fetch = fakeFetch(200, { data: [] });
      assert.equal((await ai.validateApiKey(provider, TEST_KEYS_VALID[provider])).status, "valid");
    });
  }

  test("cada proveedor consulta su endpoint correcto y la clave nunca va en la URL", async () => {
    const expected = {
      gemini: ["generativelanguage.googleapis.com/v1beta/models", "x-goog-api-key"],
      groq: ["api.groq.com/openai/v1/models", "Authorization"],
      mistral: ["api.mistral.ai/v1/models", "Authorization"],
      openrouter: ["openrouter.ai/api/v1/key", "Authorization"]
    };
    for (const [provider, [urlPart, header]] of Object.entries(expected)) {
      const seen = [];
      const testKey = TEST_KEYS_VALID[provider];
      globalThis.fetch = fakeFetch(200, {}, seen);
      await ai.validateApiKey(provider, testKey);
      assert.ok(seen[0].url.includes(urlPart), `${provider}: ${seen[0].url}`);
      assert.ok(!seen[0].url.includes(testKey), `${provider}: clave en URL`);
      assert.ok(String(seen[0].headers[header]).includes(testKey), `${provider}: cabecera ${header}`);
    }
  });

  test("429 cuenta como clave válida (reconocida pero con límite momentáneo)", async () => {
    globalThis.fetch = fakeFetch(429, { error: { message: "rate limit" } });
    assert.equal((await ai.validateApiKey("groq", TEST_KEYS_VALID.groq)).status, "valid");
  });

  test("sin internet -> 'offline' (nunca se marca inválida por falta de red)", async () => {
    globalThis.fetch = async () => { throw new TypeError("Load failed"); };
    const r = await ai.validateApiKey("gemini", TEST_KEYS_VALID.gemini);
    assert.equal(r.status, "offline");
    assert.match(r.message, /Sin conexión/);
  });

  test("error del servidor (500) o 400 que no habla de la clave -> 'unknown', no 'invalid'", async () => {
    globalThis.fetch = fakeFetch(500, { error: { message: "internal" } });
    assert.equal((await ai.validateApiKey("mistral", TEST_KEYS_VALID.mistral)).status, "unknown");
    globalThis.fetch = fakeFetch(400, { error: { message: "pageSize must be positive" } });
    assert.equal((await ai.validateApiKey("gemini", TEST_KEYS_VALID.gemini)).status, "unknown");
  });

  test("clave vacía o con solo espacios -> 'invalid' sin consultar la red", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
    assert.equal((await ai.validateApiKey("groq", "   ")).status, "invalid");
    assert.equal(calls, 0);
  });

  test("cancelación (AbortError) se propaga para descartar resultados viejos", async () => {
    globalThis.fetch = async () => { throw new DOMException("Aborted", "AbortError"); };
    await assert.rejects(ai.validateApiKey("groq", TEST_KEYS_VALID.groq), (e) => e.name === "AbortError");
  });
});

describe("Verificación del token de GitHub", () => {
  beforeEach(() => resetAuthSecurityState());

  test("respuesta real de token falso (401 Bad credentials) -> 'invalid' en español", async () => {
    globalThis.fetch = fakeFetch(401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" });
    const r = await gh.verifyGithubToken(GH_TOK_INVALID);
    assert.equal(r.status, "invalid");
    assert.match(r.message, /Token inválido o vencido/);
  });
  test("token válido -> 'valid' con el usuario", async () => {
    globalThis.fetch = fakeFetch(200, { login: "mbouso420-spec" });
    assert.deepEqual(await gh.verifyGithubToken(GH_TOK_VALID), { status: "valid", login: "mbouso420-spec" });
  });
  test("sin internet -> 'offline'", async () => {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    assert.equal((await gh.verifyGithubToken(GH_TOK_VALID)).status, "offline");
  });
  test("límite de GitHub (403) -> 'unknown', no 'invalid'", async () => {
    globalThis.fetch = fakeFetch(403, { message: "API rate limit exceeded" });
    assert.equal((await gh.verifyGithubToken(GH_TOK_RATE)).status, "unknown");
  });
  test("token vacío -> 'invalid' sin consultar la red", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
    assert.equal((await gh.verifyGithubToken("  ")).status, "invalid");
    assert.equal(calls, 0);
  });
});
