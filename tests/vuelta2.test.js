import "./setup.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { resetAuthSecurityState } = await import("../js/security/credentialGuard.js");
const backup = await import("../js/storage/emergencyBackup.js");
const db = await import("../js/storage/workspaceDb.js");
const { decodeImportedFile } = await import("../js/storage/fileImport.js");

describe("[BUG-26] Importación: solo texto editable", () => {
  const enc = (s) => new TextEncoder().encode(s);
  test("texto UTF-8 (ñ, emoji, CRLF, vacío) se acepta intacto; BOM se quita", () => {
    assert.deepEqual(decodeImportedFile(enc("hola ñ 😀\r\n"), "a.py"), { ok: true, text: "hola ñ 😀\r\n" });
    assert.deepEqual(decodeImportedFile(new Uint8Array(), "vacio.txt"), { ok: true, text: "" });
    assert.deepEqual(decodeImportedFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), "bom.txt"), { ok: true, text: "A" });
  });
  test("binarios por extensión (mayúsculas incluidas) se rechazan", () => {
    for (const name of ["foto.PNG", "doc.pdf", "a.zip", "x.docx", "lib.wasm"]) {
      assert.equal(decodeImportedFile(enc("cualquier cosa"), name).ok, false, name);
    }
  });
  test("firma PNG con extensión engañosa (.txt) se rechaza por byte NUL", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    assert.equal(decodeImportedFile(png, "no-es-texto.txt").ok, false);
  });
  test("Latin-1 / bytes inválidos en UTF-8 se rechazan en vez de guardarse corruptos", () => {
    const r = decodeImportedFile(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "latin1.txt");
    assert.deepEqual(r, { ok: false, reason: "no es texto UTF-8" });
  });
  test("archivo sin extensión con texto (Makefile) se acepta", () => {
    assert.equal(decodeImportedFile(enc("all:\n\tcc main.c\n"), "Makefile").ok, true);
  });
});

const { isNetworkFailure, toFriendlyNetworkError } = await import("../js/net/networkErrors.js");
const gh = await import("../js/github/githubService.js");
const ai = await import("../js/ai/providers.js");

describe("Errores de red en español", () => {
  test("clasifica mensajes de Chrome, Safari y Firefox; respeta AbortError y errores HTTP", () => {
    assert.equal(isNetworkFailure(new TypeError("Failed to fetch")), true);
    assert.equal(isNetworkFailure(new TypeError("Load failed")), true);
    assert.equal(isNetworkFailure(new TypeError("NetworkError when attempting to fetch resource.")), true);
    assert.equal(isNetworkFailure(new DOMException("Aborted", "AbortError")), false);
    assert.equal(isNetworkFailure(new Error("GitHub API: Bad credentials")), false);
    assert.equal(isNetworkFailure(Object.assign(new Error("network error"), { httpStatus: 503 })), false);
    assert.equal(isNetworkFailure(new TypeError("x is not a function")), false);
    assert.equal(isNetworkFailure(null), false);
  });
  test("mensaje distingue 'sin internet' (navigator.onLine=false)", () => {
    const prev = navigator.onLine;
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    assert.match(toFriendlyNetworkError(new TypeError("Failed to fetch"), "GitHub").message, /Estás sin conexión a internet/);
    Object.defineProperty(navigator, "onLine", { value: prev, configurable: true });
    assert.match(toFriendlyNetworkError(new TypeError("Failed to fetch"), "GitHub").message, /^Sin conexión con GitHub\./);
  });
  test("GitHub: red caída al abrir un repo devuelve mensaje en español", async () => {
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(gh.fetchRepoTreeIndex({ token: "", owner: "o", repo: "r", branch: "main" }), /^Error: Sin conexión con GitHub/);
  });
  test("GitHub: 401 se explica en español y conserva status 401 (requisito actualizado en Vuelta #3)", async () => {
    resetAuthSecurityState();
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    await assert.rejects(gh.fetchGithubUser("ghp_InvalidServerRejected1234567890"), (e) => /GitHub rechazó el token/.test(e.message) && e.status === 401);
  });
  test("IA: red caída no reintenta otros modelos y avisa en español", async () => {
    resetAuthSecurityState();
    let calls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) throw new TypeError("Load failed");
      calls += 1;
      throw new TypeError("Load failed");
    };
    await assert.rejects(
      ai.streamAiCompletion({ providerId: "groq", model: "llama-3.1-8b-instant", apiKey: "gsk_ValidFormatGroqKey1234567890abcd", systemPrompt: "s", history: [{ role: "user", content: "x" }], onChunk() {} }),
      /Sin conexión con Groq/
    );
    assert.equal(calls, 1);
  });
  test("IA: 'Actualizar modelos' sin red avisa en español", async () => {
    resetAuthSecurityState();
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(ai.fetchLiveFreeModels("mistral", "mistralValidFormatKey1234567890abcd"), /Sin conexión con Mistral/);
  });
});

describe("[BUG-28] Respaldo de emergencia ante cierre/recarga abrupta", () => {
  beforeEach(() => localStorage.clear());

  test("escribir -> leer conserva Unicode y contenido vacío; lista vacía borra la clave", () => {
    assert.equal(backup.writeEmergencyBackup([
      { projectId: "p", filePath: "a.py", content: "ñ 😀\r\n" },
      { projectId: "p", filePath: "b.txt", content: "" },
      { projectId: 1, filePath: "x", content: "inválido" }
    ]), true);
    assert.deepEqual(backup.readEmergencyBackup(), [
      { projectId: "p", filePath: "a.py", content: "ñ 😀\r\n" },
      { projectId: "p", filePath: "b.txt", content: "" }
    ]);
    backup.writeEmergencyBackup([]);
    assert.equal(localStorage.getItem(backup.EMERGENCY_BACKUP_KEY), null);
  });

  test("respaldo corrupto o ausente no rompe el arranque", async () => {
    localStorage.setItem(backup.EMERGENCY_BACKUP_KEY, "{roto");
    assert.deepEqual(backup.readEmergencyBackup(), []);
    assert.equal(await backup.restoreEmergencyBackup(db), 0);
    assert.equal(localStorage.getItem(backup.EMERGENCY_BACKUP_KEY), null);
  });

  test("cuota llena: devuelve false sin lanzar", () => {
    const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem() {} };
    assert.equal(backup.writeEmergencyBackup([{ projectId: "p", filePath: "a", content: "x" }], full), false);
  });

  test("al abrir la app vuelca lo pendiente a IndexedDB, no recrea archivos borrados y limpia el respaldo", async () => {
    const pid = `bk-${Date.now()}`;
    await db.upsertEntry(pid, "src/main.py", { content: "viejo" });
    backup.writeEmergencyBackup([
      { projectId: pid, filePath: "src/main.py", content: "lo último que escribí" },
      { projectId: pid, filePath: "borrado.py", content: "no debe resucitar" }
    ]);
    const n = await backup.restoreEmergencyBackup(db);
    assert.equal(n, 1);
    const files = await db.getProjectEntries(pid);
    assert.equal(files.find((f) => f.path === "src/main.py").content, "lo último que escribí");
    assert.ok(!files.some((f) => f.path === "borrado.py"));
    assert.equal(localStorage.getItem(backup.EMERGENCY_BACKUP_KEY), null);
  });
});

describe("PWA: caché offline completa", () => {
  test("todo módulo de js/ figura en APP_SHELL_URLS de sw.js (si falta, la app no abre sin conexión)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "..");
    const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    const modules = walk(path.join(root, "js")).filter((f) => f.endsWith(".js")).map((f) => `./${path.relative(root, f).split(path.sep).join("/")}`);
    const missing = modules.filter((m) => !sw.includes(`"${m}"`));
    assert.ok(modules.length >= 17);
    assert.deepEqual(missing, []);
  });
});
