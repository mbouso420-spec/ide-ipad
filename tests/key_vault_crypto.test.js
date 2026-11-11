import "./setup.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  VAULT_FORMAT,
  VAULT_VERSION,
  DEFAULT_PBKDF2_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  isEncryptedKeyVault,
  encryptKeysPayload,
  decryptKeysPayload
} from "../js/security/keyVaultCrypto.js";
import {
  exportKeysBundle,
  importKeysBundle,
  saveApiKey,
  getApiKey,
  clearApiKey,
  saveProviderId
} from "../js/ai/providers.js";
import { initSettingsModal } from "../js/ui/settingsModal.js";
import { keyboardRouter } from "../js/ui/keyboardRouter.js";

describe("Bóveda Cifrada de Credenciales (AES-GCM 256 + PBKDF2-SHA256)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    keyboardRouter.modalStack = [];
    document.body.children = [];
  });

  test("Cifrado y descifrado completo preserva todas las API keys y token GitHub", async () => {
    saveApiKey("gemini", "AIzaSyTestVaultGeminiKey1234567890");
    saveApiKey("groq", "gsk_testVaultGroqKey1234567890abcdef");
    saveProviderId("groq");
    localStorage.setItem("ide.github.pat", "github_pat_vaultTestToken1234567890");

    const plainBundle = exportKeysBundle();
    const vaultJson = await encryptKeysPayload(plainBundle, "ClaveMaestraSegura!2026", {
      iterations: 20_000
    });

    assert.equal(isEncryptedKeyVault(vaultJson), true);
    assert.equal(isEncryptedKeyVault(plainBundle), false);
    assert.ok(!vaultJson.includes("AIzaSyTestVaultGeminiKey"));
    assert.ok(!vaultJson.includes("gsk_testVaultGroqKey"));
    assert.ok(!vaultJson.includes("github_pat_vaultTestToken"));

    const parsed = JSON.parse(vaultJson);
    assert.equal(parsed.format, VAULT_FORMAT);
    assert.equal(parsed.version, VAULT_VERSION);
    assert.equal(parsed.kdf, "PBKDF2-SHA256");
    assert.equal(parsed.cipher, "AES-GCM-256");

    // Vaciar almacenamiento y restaurar desde la bóveda descifrada
    localStorage.clear();
    sessionStorage.clear();
    assert.equal(getApiKey("gemini"), "");

    const decryptedJson = await decryptKeysPayload(vaultJson, "ClaveMaestraSegura!2026");
    const restoredCount = importKeysBundle(decryptedJson);

    assert.equal(restoredCount, 3);
    assert.equal(getApiKey("gemini"), "AIzaSyTestVaultGeminiKey1234567890");
    assert.equal(getApiKey("groq"), "gsk_testVaultGroqKey1234567890abcdef");
    assert.equal(localStorage.getItem("ide.github.pat"), "github_pat_vaultTestToken1234567890");
  });

  test("Salt e IV aleatorios generan cifrados distintos para el mismo payload", async () => {
    const sample = JSON.stringify({ gemini: "AIzaSySameSecret12345678901234567" });
    const encA = JSON.parse(await encryptKeysPayload(sample, "mi-pass-123", { iterations: 15_000 }));
    const encB = JSON.parse(await encryptKeysPayload(sample, "mi-pass-123", { iterations: 15_000 }));

    assert.notEqual(encA.salt, encB.salt);
    assert.notEqual(encA.iv, encB.iv);
    assert.notEqual(encA.ciphertext, encB.ciphertext);
  });

  test("Rechaza contraseña incorrecta o ciphertext alterado", async () => {
    const sample = JSON.stringify({ gemini: "AIzaSyProtectedKey12345678901234" });
    const vaultJson = await encryptKeysPayload(sample, "pass-correcta", { iterations: 15_000 });

    await assert.rejects(
      () => decryptKeysPayload(vaultJson, "pass-incorrecta"),
      /Contraseña incorrecta/i
    );

    const parsed = JSON.parse(vaultJson);
    const tamperedBytes = Buffer.from(parsed.ciphertext, "base64");
    tamperedBytes[0] ^= 0xff;
    parsed.ciphertext = tamperedBytes.toString("base64");

    await assert.rejects(
      () => decryptKeysPayload(JSON.stringify(parsed), "pass-correcta"),
      /Contraseña incorrecta|dañado/i
    );
  });

  test("Valida contraseña mínima, iteraciones seguras y formatos inválidos", async () => {
    assert.equal(DEFAULT_PBKDF2_ITERATIONS, 210_000);
    assert.equal(MIN_PASSPHRASE_LENGTH, 6);

    await assert.rejects(
      () => encryptKeysPayload("{}", "12345"),
      /al menos 6 caracteres/i
    );
    await assert.rejects(
      () => encryptKeysPayload("", "clavevalida"),
      /No hay credenciales/i
    );
    await assert.rejects(
      () => decryptKeysPayload(JSON.stringify({ format: "otro", version: 1 }), "clavevalida"),
      /formato de bóveda/i
    );
    await assert.rejects(
      () =>
        decryptKeysPayload(
          JSON.stringify({
            format: VAULT_FORMAT,
            version: VAULT_VERSION,
            iterations: 50,
            salt: "AAAA",
            iv: "AAAA",
            ciphertext: "AAAA"
          }),
          "clavevalida"
        ),
      /fuera de rango seguro/i
    );
  });

  test("Integración DOM en SettingsModal: exporta e importa bóveda cifrada limpiando la contraseña", async () => {
    const dialog = document.createElement("dialog");
    dialog.id = "settings-dialog";
    dialog.open = false;
    dialog.showModal = function () { this.open = true; };
    dialog.close = function () { this.open = false; };

    const passphraseInput = document.createElement("input");
    passphraseInput.id = "vault-passphrase-input";
    const btnExport = document.createElement("button");
    btnExport.id = "btn-export-keys-encrypted";
    const btnImport = document.createElement("button");
    btnImport.id = "btn-import-keys-encrypted";
    const fileInput = document.createElement("input");
    fileInput.id = "vault-import-file";
    const vaultStatus = document.createElement("p");
    vaultStatus.id = "vault-transfer-status";
    vaultStatus.hidden = true;

    dialog.append(passphraseInput, btnExport, btnImport, fileInput, vaultStatus);
    document.body.appendChild(dialog);

    saveApiKey("mistral", "mistral_secret_test_1234567890abcdef");

    let capturedBlob = null;
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    const origCreateElement = document.createElement;
    URL.createObjectURL = (blob) => {
      capturedBlob = blob;
      return "blob:test-vault";
    };
    URL.revokeObjectURL = () => {};
    document.createElement = (tag) => {
      const el = origCreateElement(tag);
      if (tag === "a") {
        el.click = () => {};
      }
      return el;
    };

    try {
      initSettingsModal({ editor: null });

      passphraseInput.value = "MiClaveFuerte99";
      btnExport.click();
      // Esperar promesa PBKDF2/AES-GCM dentro del listener
      await new Promise((r) => setTimeout(r, 250));

      assert.ok(capturedBlob, "Debe haber generado el Blob cifrado");
      const exportedVaultText = await capturedBlob.text();
      assert.equal(isEncryptedKeyVault(exportedVaultText), true);
      assert.equal(passphraseInput.value, "", "Debe limpiar la contraseña tras exportar");
      assert.match(vaultStatus.textContent, /descargada correctamente/i);

      // Limpiar claves e importar desde fileInput
      clearApiKey("mistral");
      assert.equal(getApiKey("mistral"), "");

      passphraseInput.value = "MiClaveFuerte99";
      fileInput.files = [
        {
          name: "studio-ide-claves.vault.json",
          text: async () => exportedVaultText
        }
      ];
      fileInput.dispatchEvent(new Event("change"));
      await new Promise((r) => setTimeout(r, 250));

      assert.equal(getApiKey("mistral"), "mistral_secret_test_1234567890abcdef");
      assert.equal(passphraseInput.value, "", "Debe limpiar la contraseña tras importar");
      assert.match(vaultStatus.textContent, /restauraron 1 credencial/i);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
      document.createElement = origCreateElement;
    }
  });
});
