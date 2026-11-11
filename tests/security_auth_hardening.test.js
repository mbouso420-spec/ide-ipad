import "./setup.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  LOCKOUT_THRESHOLD,
  LOCKOUT_DURATIONS_MS,
  AuthLockoutError,
  CredentialFormatError,
  checkAuthLockout,
  recordAuthFailure,
  recordAuthSuccess,
  validateCredentialFormat,
  computeTokenFingerprint,
  isTokenRejectedInSession,
  redactSensitiveTokens,
  maskCredentialPreview,
  resetAuthSecurityState
} from "../js/security/credentialGuard.js";

import * as gh from "../js/github/githubService.js";
import * as ai from "../js/ai/providers.js";
import { writeEmergencyBackup } from "../js/storage/emergencyBackup.js";
import { buildZipArchive } from "../js/storage/zipExporter.js";

describe("Seguridad AppSec: Fuerza Bruta, Rate Limiting, Pre-Vuelo e Higiene de Credenciales", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetAuthSecurityState();
  });

  describe("1. Ataque de diccionario / fuerza bruta y Lockout Progresivo (30s -> 2m -> 5m)", () => {
    test("GitHub: 20 tokens falsos seguidos bloquean tras 4 fallos y detienen llamadas fetch()", async () => {
      let fetchCalls = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      };

      try {
        const results = [];
        for (let i = 1; i <= 20; i++) {
          const fakePat = `ghp_BruteForceAttempt_${String(i).padStart(2, "0")}_AbCdEf123456`;
          const res = await gh.verifyGithubToken(fakePat);
          results.push(res);
        }

        // Exactamente LOCKOUT_THRESHOLD (4) intentos debieron llegar a la red; los otros 16 frenados localmente
        assert.equal(fetchCalls, LOCKOUT_THRESHOLD, `Solo deben ejecutarse ${LOCKOUT_THRESHOLD} fetch(); los restantes se bloquean localmente`);
        assert.equal(results[0].status, "invalid");
        assert.equal(results[1].status, "invalid");
        assert.equal(results[2].status, "invalid");
        assert.equal(results[3].status, "locked", "El 4to intento fallido debe activar bloqueo temporal");
        assert.ok(results[3].remainingMs >= 29_000 && results[3].remainingMs <= 30_000);

        for (let i = 4; i < 20; i++) {
          assert.equal(results[i].status, "locked", `Intento #${i + 1} debe quedar bloqueado sin tocar la red`);
        }

        // Llamadas programáticas directas también deben ser rechazadas con AuthLockoutError antes de fetch()
        await assert.rejects(
          () => gh.fetchGithubUser("ghp_AnotherTokenAttempt9876543210abc"),
          (err) => err instanceof AuthLockoutError && err.code === "ERR_AUTH_LOCKOUT" && err.status === 429
        );
        assert.equal(fetchCalls, LOCKOUT_THRESHOLD);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("Proveedores de IA (Groq/Gemini): 20 claves falsas en verify/stream bloquean al umbral sin tocar red", async () => {
      let fetchCalls = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 });
      };

      try {
        for (let i = 1; i <= 20; i++) {
          const fakeGroq = `gsk_BruteForceGroqKey_${String(i).padStart(2, "0")}_XyZ9876543`;
          const res = await ai.validateApiKey("groq", fakeGroq);
          if (i < LOCKOUT_THRESHOLD) {
            assert.equal(res.status, "invalid");
          } else {
            assert.equal(res.status, "locked");
          }
        }

        assert.equal(fetchCalls, LOCKOUT_THRESHOLD);

        // El streaming también queda bloqueado inmediatamente con AuthLockoutError
        await assert.rejects(
          () =>
            ai.streamAiCompletion({
              providerId: "groq",
              model: "llama-3.3-70b-versatile",
              apiKey: "gsk_AttemptDuringLockout1234567890abcd",
              systemPrompt: "sys",
              history: [{ role: "user", content: "hola" }],
              onChunk() {}
            }),
          (err) => err instanceof AuthLockoutError && err.code === "ERR_AUTH_LOCKOUT"
        );
        assert.equal(fetchCalls, LOCKOUT_THRESHOLD);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("Escalado exponencial progresivo (30s -> 2m -> 5m) y reinicio tras éxito HTTP 200", () => {
      const scope = "github";
      const t0 = 1_700_000_000_000;

      // Fallos 1, 2, 3: aún sin bloqueo
      for (let i = 1; i < LOCKOUT_THRESHOLD; i++) {
        const f = recordAuthFailure(scope, t0 + i * 100);
        assert.equal(f.locked, false);
        assert.equal(f.failedAttempts, i);
      }

      // Fallo 4: bloqueo Nivel 1 -> 30 segundos (30,000 ms)
      const lvl1 = recordAuthFailure(scope, t0 + 1000);
      assert.equal(lvl1.locked, true);
      assert.equal(lvl1.cooldownMs, LOCKOUT_DURATIONS_MS[0]); // 30s
      assert.equal(lvl1.cooldownMs, 30_000);

      // Simulamos que vencen los 30s (+31s), falla de nuevo (Fallo 5) -> 2 minutos (120,000 ms)
      const lvl2 = recordAuthFailure(scope, t0 + 32_000);
      assert.equal(lvl2.locked, true);
      assert.equal(lvl2.cooldownMs, LOCKOUT_DURATIONS_MS[1]); // 2m
      assert.equal(lvl2.cooldownMs, 120_000);

      // Vencen los 2m (+121s), falla de nuevo (Fallo 6) -> 5 minutos (300,000 ms)
      const lvl3 = recordAuthFailure(scope, t0 + 32_000 + 121_000);
      assert.equal(lvl3.locked, true);
      assert.equal(lvl3.cooldownMs, LOCKOUT_DURATIONS_MS[2]); // 5m
      assert.equal(lvl3.cooldownMs, 300_000);

      // Si luego expira y hay un login exitoso -> se limpia a 0
      recordAuthSuccess(scope);
      const afterSuccess = checkAuthLockout(scope, t0 + 500_000);
      assert.equal(afterSuccess.locked, false);
      assert.equal(afterSuccess.failedAttempts, 0);
    });
  });

  describe("2. Persistencia de Bloqueo ante Recarga de Página (F5)", () => {
    test("el bloqueo persiste en localStorage y sobrevive a reinicios simulados de módulo", async () => {
      const scope = "ai:gemini";
      const t0 = Date.now();

      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        recordAuthFailure(scope, t0);
      }

      // Verificamos que la clave quedó persistida en localStorage SIN almacenar ningún secreto
      const persistedRaw = localStorage.getItem(`ide.security.lockout.${scope}`);
      assert.ok(persistedRaw, "Debe persistirse el bloqueo en localStorage");
      const parsed = JSON.parse(persistedRaw);
      assert.equal(parsed.failedAttempts, LOCKOUT_THRESHOLD);
      assert.ok(parsed.lockoutUntil > t0);

      // Simulamos recarga fresca del módulo vía import con cache-busting query string (?reload=1)
      const freshGuard = await import(`../js/security/credentialGuard.js?reload=${Date.now()}`);
      const reloadedLock = freshGuard.checkAuthLockout(scope, t0 + 5000);
      assert.equal(reloadedLock.locked, true, "Tras recargar módulo, la ventana de bloqueo debe seguir vigente");
      assert.ok(reloadedLock.remainingMs > 20_000);

      // Tras vencer los 30s, el bloqueo desaparece
      const expiredLock = freshGuard.checkAuthLockout(scope, t0 + 35_000);
      assert.equal(expiredLock.locked, false);
    });
  });

  describe("3. Validación de Formato Pre-Vuelo y Lista Negra de Huellas en Sesión", () => {
    test("rechaza entradas vacías, cortas, baja entropía, prefijos inválidos e inyección CRLF con 0 fetch()", async () => {
      let fetchCalls = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      };

      try {
        const badTokens = [
          "",
          "   ",
          "short",
          "ghp_12345", // muy corto
          "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa", // baja entropía
          "badprefix_1234567890abcdef123456", // prefijo inválido
          "ghp_ValidPrefix1234567890\r\nX-Evil: 1", // inyección CRLF
          "ghp_ValidPrefix 1234567890abcd" // espacios internos
        ];

        for (const t of badTokens) {
          const r = await gh.verifyGithubToken(t);
          assert.equal(r.status, "invalid", `Token malicioso aceptado erróneamente: ${JSON.stringify(t)}`);
        }

        const badGeminiKeys = [
          "",
          "AIzaShort",
          "AIzaaaaaaaaaaaaaaaaaaaaaaaaa",
          "sk-wrong-prefix-1234567890abcdef",
          "AIzaSyValidPrefix123456\nInjected"
        ];
        for (const k of badGeminiKeys) {
          const r = await ai.validateApiKey("gemini", k);
          assert.equal(r.status, "invalid", `API key Gemini maliciosa aceptada: ${JSON.stringify(k)}`);
        }

        // Ninguna de estas pruebas inválidas debió tocar la red
        assert.equal(fetchCalls, 0);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("huella rechazada (401) bloquea reintento inmediato del mismo token sin almacenar texto plano", async () => {
      let fetchCalls = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      };

      const secretPat = "ghp_MySuperSecretRejectedPat9876543210";
      try {
        // 1er intento: llega al servidor -> 401 -> se marca su huella en memoria
        const r1 = await gh.verifyGithubToken(secretPat);
        assert.equal(r1.status, "invalid");
        assert.equal(fetchCalls, 1);
        assert.equal(isTokenRejectedInSession("github", secretPat), true);

        // Verificamos que computeTokenFingerprint no conserva substrings del secreto
        const fp = computeTokenFingerprint("github", secretPat);
        assert.ok(!fp.includes("MySuperSecret"));
        assert.ok(!fp.includes("9876543210"));

        // 2do intento con el MISMO token: bloqueado localmente sin fetch()
        const r2 = await gh.verifyGithubToken(secretPat);
        assert.equal(r2.status, "invalid");
        assert.equal(r2.rejectedInSession, true);
        assert.equal(fetchCalls, 1, "No debe volver a consultar la red para la misma huella ya rechazada");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("4. Higiene de Credenciales en DOM, Errores, Consola y Cero Filtración en Exportaciones", () => {
    test("HTML inputs de credenciales exigen type=password, autocomplete=off, spellcheck=false", async () => {
      const html = await fs.readFile(new URL("../index.html", import.meta.url), "utf-8");

      const aiIdx = html.indexOf('id="ai-api-key-input"');
      const aiBlock = html.slice(html.lastIndexOf("<input", aiIdx), html.indexOf(">", aiIdx) + 1);
      assert.ok(aiBlock.includes('type="password"'), "ai-api-key-input debe ser password");
      assert.ok(aiBlock.includes('autocomplete="off"'), "ai-api-key-input debe tener autocomplete=off");
      assert.ok(aiBlock.includes('spellcheck="false"'), "ai-api-key-input debe tener spellcheck=false");

      const ghIdx = html.indexOf('id="gh-token-input"');
      const ghBlock = html.slice(html.lastIndexOf("<input", ghIdx), html.indexOf(">", ghIdx) + 1);
      assert.ok(ghBlock.includes('type="password"'), "gh-token-input debe ser password");
      assert.ok(ghBlock.includes('autocomplete="off"'), "gh-token-input debe tener autocomplete=off");
      assert.ok(ghBlock.includes('spellcheck="false"'), "gh-token-input debe tener spellcheck=false");
    });

    test("redactSensitiveTokens y respuestas de error jamás filtran secretos reales ni headers", async () => {
      const ghSecret = "ghp_SecretLeakCheck1234567890abcdefghij";
      const aiSecret = "AIzaSySecretGeminiKey9876543210abcdefghi";
      const groqSecret = "gsk_SecretGroqKey1234567890abcdefghijklm";

      const dirtyLog =
        `Failed GET https://example.com?key=${aiSecret} Authorization: Bearer ${ghSecret} body=${groqSecret}`;
      const clean = redactSensitiveTokens(dirtyLog, [ghSecret, aiSecret, groqSecret]);

      assert.ok(!clean.includes(ghSecret), "No debe contener secreto de GitHub");
      assert.ok(!clean.includes(aiSecret), "No debe contener secreto de Gemini");
      assert.ok(!clean.includes(groqSecret), "No debe contener secreto de Groq");
      assert.ok(clean.includes("[REDACTED"));

      // Simular que un servidor de IA hace eco de la API Key en su mensaje de error 401
      const origFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({ error: { message: `Incorrect API key provided: ${groqSecret}` } }),
          { status: 401 }
        );
      try {
        await assert.rejects(
          () =>
            ai.streamAiCompletion({
              providerId: "groq",
              model: "llama-3.3-70b-versatile",
              apiKey: groqSecret,
              systemPrompt: "sys",
              history: [{ role: "user", content: "hi" }],
              onChunk() {}
            }),
          (err) => {
            assert.ok(!err.message.includes(groqSecret), "El mensaje de error propagado jamás debe contener la API Key");
            assert.ok(err.message.includes("[REDACTED"));
            return true;
          }
        );
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test("Exportaciones ZIP, Gists y Respaldo de Emergencia jamás incluyen tokens guardados en storage", async () => {
      const ghSecret = "ghp_RealStoredSecretPat9988776655443322";
      const geminiSecret = "AIzaSyRealStoredSecretGemini112233445566";
      gh.saveGithubToken(ghSecret);
      ai.saveApiKey("gemini", geminiSecret);

      // 1. Emergency Backup
      writeEmergencyBackup(
        [{ projectId: "p_sec", filePath: "main.c", content: "int main() { return 0; }" }],
        localStorage,
        "p_sec",
        "tab_sec"
      );
      const emergencyDump = localStorage.getItem("studio_ide_emergency_backup_p_sec_tab_sec") || "";
      assert.ok(!emergencyDump.includes(ghSecret), "EmergencyBackup nunca debe contener PAT de GitHub");
      assert.ok(!emergencyDump.includes(geminiSecret), "EmergencyBackup nunca debe contener API Key de IA");

      // 2. ZIP Exporter
      const zipBytes = buildZipArchive([
        { path: "main.c", content: "int main() { return 0; }" },
        { path: "README.md", content: "# Proyecto seguro" }
      ]);
      const zipStr = new TextDecoder("latin1").decode(zipBytes);
      assert.ok(!zipStr.includes(ghSecret), "Archivo ZIP nunca debe contener PAT guardado");
      assert.ok(!zipStr.includes(geminiSecret), "Archivo ZIP nunca debe contener API Key guardada");

      // 3. Gist Payload
      const origFetch = globalThis.fetch;
      let sentBody = "";
      globalThis.fetch = async (_url, init) => {
        sentBody = String(init.body || "");
        return new Response(
          JSON.stringify({ id: "gist_safe", html_url: "https://gist.github.com/gist_safe" }),
          { status: 201 }
        );
      };
      try {
        await gh.saveProjectToGist(ghSecret, {
          projectName: "proyecto-limpio",
          entries: [{ path: "main.c", content: "int main(){return 0;}", isFolder: false }]
        });
        assert.ok(!sentBody.includes(ghSecret), "El cuerpo JSON del Gist nunca debe contener el token");
        assert.ok(!sentBody.includes(geminiSecret), "El cuerpo JSON del Gist nunca debe filtrar claves de IA");
      } finally {
        globalThis.fetch = origFetch;
      }

      // Verificación de máscara
      const masked = maskCredentialPreview(ghSecret);
      assert.equal(masked, "ghp_••••3322");
      assert.ok(!masked.includes("RealStoredSecret"));
    });
  });
});
