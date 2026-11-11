import { keyboardRouter } from "./keyboardRouter.js";
import { getStorageQuotaEstimate, formatStorageBytes } from "../storage/storageQuota.js";
import { saveCredentialsBackup } from "../storage/workspaceDb.js";
import {
  encryptKeysPayload,
  decryptKeysPayload,
  isEncryptedKeyVault
} from "../security/keyVaultCrypto.js";
import {
  AI_PROVIDERS,
  getKeyStorageMode,
  setKeyStorageMode,
  exportKeysBundle,
  importKeysBundle,
  hasStoredCredentials,
  getApiKey,
  getSavedModel,
  getSavedProviderId,
  getModelContextWindow,
  getAiTemperature,
  setAiTemperature,
  setAiContextBudget,
  getAiThinkingSpeed,
  setAiThinkingSpeed
} from "../ai/providers.js";

const THEME_STORAGE_KEY = "studio_theme";

export const KEYBOARD_SHORTCUTS = [
  { combo: "Cmd/Ctrl + P", desc: "Apertura rápida de archivo y salto directo a línea (ej. app.js:145)", category: "Navegación" },
  { combo: "Cmd/Ctrl + Shift + F", desc: "Búsqueda global de texto y expresiones regulares en todo el proyecto", category: "Búsqueda" },
  { combo: "Cmd/Ctrl + S", desc: "Forzar guardado inmediato en almacenamiento local IndexedDB", category: "Archivo" },
  { combo: "Shift + Alt + F", desc: "Formatear e indentar el archivo activo (100% offline)", category: "Editor" },
  { combo: "Cmd/Ctrl + W / Alt + W", desc: "Cerrar pestaña activa (Alt+W prioritario en iPad Safari PWA)", category: "Editor" },
  { combo: "Cmd/Ctrl + B", desc: "Alternar visibilidad del panel lateral del Explorador", category: "Paneles" },
  { combo: "Cmd/Ctrl + J", desc: "Alternar visibilidad del panel lateral del Asistente IA", category: "Paneles" },
  { combo: "Cmd/Ctrl + ,", desc: "Abrir ventana de Configuración y Atajos de Teclado", category: "General" },
  { combo: "Escape", desc: "Cerrar diálogo activo o cancelar acción", category: "General" },
  { combo: "Enter", desc: "Confirmar acción en modales y ejecutar búsquedas", category: "General" }
];

/**
 * Inicializa el modal de Configuración y Preferencias del IDE.
 *
 * @param {{
 *   editor: {
 *     getFontSize: () => number,
 *     stepFontSize: (delta: number) => number,
 *     isWordWrapEnabled: () => boolean,
 *     toggleWordWrap: () => boolean,
 *     isMinimapVisible: () => boolean,
 *     toggleMinimap: () => boolean
 *   },
 *   onThemeChange?: (newTheme: string) => void,
 *   getContextSnapshot?: () => { activeFile?: { content?: string }, otherOpenFiles?: Array<{ content?: string }> },
 *   onSelectProvider?: (providerId: string) => void
 * }} config
 */
export function initSettingsModal({ editor, onThemeChange, onHardwareKeyboardChange, getContextSnapshot, onSelectProvider }) {
  const dialog = document.getElementById("settings-dialog");
  const openBtn = document.getElementById("btn-open-settings");
  const closeBtn = document.getElementById("btn-close-settings");

  const selectTheme = document.getElementById("select-theme");
  const chkWordWrap = document.getElementById("setting-word-wrap");
  const chkMinimap = document.getElementById("setting-minimap");
  const chkHardwareKeyboard = document.getElementById("setting-hardware-keyboard");
  const selectKeyStorage = document.getElementById("setting-key-storage");
  const selectAutosave = document.getElementById("setting-autosave-delay");
  const selectAiTemp = document.getElementById("setting-ai-temperature");
  const selectAiBudget = document.getElementById("setting-ai-budget");
  const selectAiThinkingSpeed = document.getElementById("setting-ai-thinking-speed");
  const modelsListEl = document.getElementById("settings-active-models-list");
  const quotaTextEl = document.getElementById("setting-quota-text");
  const vaultPassphraseInput = document.getElementById("vault-passphrase-input");
  const btnExportVault = document.getElementById("btn-export-keys-encrypted");
  const btnImportVault = document.getElementById("btn-import-keys-encrypted");
  const vaultFileInput = document.getElementById("vault-import-file");
  const vaultStatusEl = document.getElementById("vault-transfer-status");
  const shortcutsFilter = document.getElementById("setting-shortcuts-filter");
  const shortcutsListEl = document.getElementById("setting-shortcuts-list");

  const tabButtons = dialog?.querySelectorAll(".settings-tab-btn");
  const tabPanels = dialog?.querySelectorAll(".settings-tab-panel");

  function open() {
    if (!dialog) return;
    syncControlsWithState();
    refreshStorageInfo();
    renderShortcutsList("");
    if (vaultPassphraseInput) vaultPassphraseInput.value = "";
    setVaultStatus("", "neutral");
    if (!dialog.open) {
      dialog.showModal();
    }
    keyboardRouter.pushModal({
      id: "settings-dialog",
      onEscape: () => close()
    });
  }

  function close() {
    if (vaultPassphraseInput) vaultPassphraseInput.value = "";
    keyboardRouter.popModal("settings-dialog");
    if (dialog?.open) {
      dialog.close();
    }
  }

  function refreshTokensMeter() {
    const pctEl = document.getElementById("models-tokens-pct");
    const fillEl = document.getElementById("models-meter-fill");
    const detailEl = document.getElementById("models-tokens-detail");
    const remainingEl = document.getElementById("models-tokens-remaining");
    const trackEl = dialog?.querySelector(".models-meter-track");

    let contextChars = 0;
    try {
      const snapshot = getContextSnapshot ? getContextSnapshot() : null;
      if (snapshot?.activeFile?.content) {
        contextChars += snapshot.activeFile.content.length;
      }
      if (snapshot?.otherOpenFiles) {
        for (const f of snapshot.otherOpenFiles) {
          contextChars += (f.content || "").length;
        }
      }
    } catch (_) {}

    const usedTokens = Math.ceil(contextChars / 4);
    const activeProviderId = getSavedProviderId();
    let effectiveProviderId = activeProviderId;
    let activeKey = getApiKey(activeProviderId);

    const allProviders = Object.keys(AI_PROVIDERS);
    const connectedProviders = allProviders.filter((pid) => Boolean(getApiKey(pid)?.trim()));

    if (!activeKey && connectedProviders.length > 0) {
      effectiveProviderId = connectedProviders[0];
      activeKey = getApiKey(effectiveProviderId);
    }

    const hasKey = Boolean(activeKey && activeKey.trim());
    const activeModelId = getSavedModel(effectiveProviderId);
    const provider = AI_PROVIDERS[effectiveProviderId] || AI_PROVIDERS.gemini;
    const maxModelTokens = getModelContextWindow(effectiveProviderId, activeModelId);

    if (!hasKey) {
      if (pctEl) {
        pctEl.textContent = "Sin API key configurada";
        pctEl.className = "models-tokens-badge badge-neutral";
      }
      if (fillEl) {
        fillEl.style.setProperty("--progress-val", "0");
        fillEl.dataset.state = "inactive";
      }
      if (trackEl) {
        trackEl.setAttribute("aria-valuenow", "0");
      }
      if (detailEl) {
        detailEl.textContent = `~${usedTokens.toLocaleString()} tokens en contexto actual (esperando API key)`;
      }
      if (remainingEl) {
        remainingEl.textContent = "Elegí y configurá una API key de algún proveedor para activar el Asistente";
      }
    } else {
      const remainingTokens = Math.max(0, maxModelTokens - usedTokens);
      const availablePct = maxModelTokens > 0
        ? Math.max(0, Math.min(100, Math.round((remainingTokens / maxModelTokens) * 100)))
        : 100;

      if (pctEl) {
        pctEl.textContent = `${availablePct}% disponible (${connectedProviders.length}/4 conectados · ${provider.name.split(" ")[0]})`;
        pctEl.className = "models-tokens-badge";
      }
      if (fillEl) {
        fillEl.style.setProperty("--progress-val", String(availablePct));
        fillEl.dataset.state = availablePct > 40 ? "good" : availablePct > 15 ? "warning" : "low";
      }
      if (trackEl) {
        trackEl.setAttribute("aria-valuenow", String(availablePct));
      }
      if (detailEl) {
        detailEl.textContent = `~${usedTokens.toLocaleString()} / ${maxModelTokens.toLocaleString()} tokens en uso`;
      }
      if (remainingEl) {
        remainingEl.textContent = `${remainingTokens.toLocaleString()} tokens libres en ${provider.name.split(" ")[0]}`;
      }
    }

    renderActiveModelsList(usedTokens);
  }

  function renderActiveModelsList(usedTokens = 0) {
    if (!modelsListEl) return;
    const activeProviderId = getSavedProviderId();
    const providers = Object.values(AI_PROVIDERS || {});

    modelsListEl.innerHTML = providers
      .map((p) => {
        const key = getApiKey(p.id);
        const hasKey = Boolean(key && key.trim());
        const isCurrentActive = p.id === activeProviderId;
        const savedModel = getSavedModel(p.id) || p.models?.[0]?.id || "Predeterminado";
        const maxTokens = getModelContextWindow(p.id, savedModel);

        let progressPct = 0;
        let meterState = "inactive";
        let detailText = "";
        let remainingText = "";

        if (hasKey) {
          const remaining = Math.max(0, maxTokens - usedTokens);
          progressPct = maxTokens > 0
            ? Math.max(0, Math.min(100, Math.round((remaining / maxTokens) * 100)))
            : 100;
          meterState = progressPct > 40 ? "good" : progressPct > 15 ? "warning" : "low";
          detailText = `~${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${progressPct}% libre)`;
          remainingText = `${remaining.toLocaleString()} tokens libres`;
        } else {
          progressPct = 0;
          meterState = "inactive";
          detailText = `Capacidad: ${maxTokens.toLocaleString()} tokens`;
          remainingText = "Sin API key";
        }

        return `
        <div class="models-provider-item ${isCurrentActive ? "is-active-provider" : ""}" role="listitem">
          <div class="models-provider-top">
            <div class="models-provider-header">
              <span class="models-provider-name">${escapeHtml(p.name)}</span>
              ${isCurrentActive ? '<span class="models-active-pill">En uso en chat</span>' : ""}
              <span class="models-status-badge ${hasKey ? "badge-connected" : "badge-disconnected"}">
                ${hasKey ? "Conectado" : "Sin API key"}
              </span>
            </div>
            <button
              type="button"
              class="btn ${isCurrentActive ? "btn-secondary" : "btn-ghost"} btn-sm btn-provider-action"
              data-provider-id="${escapeHtml(p.id)}"
              title="${hasKey ? (isCurrentActive ? "Proveedor actualmente seleccionado en el chat" : "Activar este proveedor en el chat") : "Configurar API key"}"
            >
              ${hasKey ? (isCurrentActive ? "Activo ✓" : "Usar en chat") : "Configurar"}
            </button>
          </div>

          <div class="models-provider-meta">
            <span class="models-provider-model code-font">${escapeHtml(savedModel)}</span>
            <span class="models-provider-hint">${escapeHtml(p.freeQuota || p.helpText || "")}</span>
          </div>

          <div class="models-provider-meter">
            <div class="models-meter-track" role="progressbar" aria-valuenow="${progressPct}" aria-valuemin="0" aria-valuemax="100">
              <div class="models-meter-fill" style="--progress-val: ${progressPct};" data-state="${meterState}"></div>
            </div>
            <div class="models-provider-meter-legend">
              <span class="code-font">${detailText}</span>
              <span class="code-font">${remainingText}</span>
            </div>
          </div>
        </div>
      `;
      })
      .join("");

    const buttons = modelsListEl.querySelectorAll(".btn-provider-action");
    if (buttons && buttons.length > 0) {
      buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const pid = btn.dataset?.providerId || btn.getAttribute?.("data-provider-id");
          if (pid) {
            close();
            onSelectProvider?.(pid);
          }
        });
      });
    } else {
      for (const p of providers) {
        const btn = document.createElement("button");
        btn.setAttribute("data-provider-id", p.id);
        btn.addEventListener("click", () => {
          close();
          onSelectProvider?.(p.id);
        });
        modelsListEl.appendChild(btn);
      }
    }
  }

  function syncControlsWithState() {
    if (selectTheme) {
      try {
        const saved = localStorage.getItem(THEME_STORAGE_KEY) || "default";
        selectTheme.value = saved;
      } catch (_) {
        selectTheme.value = "default";
      }
    }

    if (chkWordWrap && editor) {
      chkWordWrap.checked = Boolean(editor.isWordWrapEnabled?.());
    }

    if (chkMinimap && editor) {
      chkMinimap.checked = Boolean(editor.isMinimapVisible?.());
    }

    if (chkHardwareKeyboard && editor) {
      chkHardwareKeyboard.checked = editor.isHardwareKeyboardMode ? Boolean(editor.isHardwareKeyboardMode()) : true;
    }

    if (selectKeyStorage) {
      selectKeyStorage.value = getKeyStorageMode();
    }

    if (selectAutosave) {
      try {
        const stored = localStorage.getItem("studio_autosave_delay") || "240";
        selectAutosave.value = stored;
      } catch (_) {
        selectAutosave.value = "240";
      }
    }

    if (selectAiTemp) {
      selectAiTemp.value = String(getAiTemperature());
    }

    if (selectAiBudget) {
      try {
        const stored = localStorage.getItem("studio_ai_budget") || "standard";
        selectAiBudget.value = stored;
      } catch (_) {
        selectAiBudget.value = "standard";
      }
    }

    if (selectAiThinkingSpeed) {
      selectAiThinkingSpeed.value = getAiThinkingSpeed();
    }

    refreshTokensMeter();
    renderActiveModelsList();
  }

  async function refreshStorageInfo() {
    if (!quotaTextEl) return;
    try {
      const estimate = await getStorageQuotaEstimate();
      const quota = estimate?.quotaBytes ?? estimate?.quota ?? 0;
      const usage = estimate?.usageBytes ?? estimate?.usage ?? 0;
      if (estimate && quota > 0) {
        quotaTextEl.textContent = `${formatStorageBytes(usage)} usados de ${formatStorageBytes(quota)} disponibles`;
      } else {
        quotaTextEl.textContent = "Almacenamiento persistente activo en IndexedDB";
      }
    } catch (_) {
      quotaTextEl.textContent = "IndexedDB activo";
    }
  }

  function renderShortcutsList(query = "") {
    if (!shortcutsListEl) return;
    const clean = String(query || "").trim().toLowerCase();

    const filtered = KEYBOARD_SHORTCUTS.filter(
      (s) => s.combo.toLowerCase().includes(clean) || s.desc.toLowerCase().includes(clean) || s.category.toLowerCase().includes(clean)
    );

    if (filtered.length === 0) {
      shortcutsListEl.innerHTML = '<div class="settings-empty-note">No se encontraron atajos de teclado coincidentes.</div>';
      return;
    }

    shortcutsListEl.innerHTML = filtered
      .map(
        (item) => `
        <div class="settings-shortcut-row">
          <div class="settings-shortcut-info">
            <span class="settings-shortcut-category">${escapeHtml(item.category)}</span>
            <span class="settings-shortcut-desc">${escapeHtml(item.desc)}</span>
          </div>
          <kbd class="settings-shortcut-kbd">${escapeHtml(item.combo)}</kbd>
        </div>
      `
      )
      .join("");
  }

  // Switch tabs
  tabButtons?.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetTab = btn.dataset.tab;
      tabButtons.forEach((b) => {
        const active = b === btn;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-selected", String(active));
      });
      tabPanels?.forEach((panel) => {
        panel.hidden = panel.dataset.tab !== targetTab;
      });
    });
  });

  // Control Events
  openBtn?.addEventListener("click", () => open());
  closeBtn?.addEventListener("click", () => close());

  dialog?.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });

  selectTheme?.addEventListener("change", (e) => {
    const chosen = (e?.target ? e.target.value : selectTheme?.value) || "default";
    if (chosen === "default") {
      delete document.documentElement.dataset.theme;
      try {
        localStorage.removeItem(THEME_STORAGE_KEY);
      } catch (_) {}
    } else {
      document.documentElement.dataset.theme = chosen;
      try {
        localStorage.setItem(THEME_STORAGE_KEY, chosen);
      } catch (_) {}
    }
    onThemeChange?.(chosen);
  });

  chkWordWrap?.addEventListener("change", () => {
    if (editor) {
      const enabled = editor.toggleWordWrap();
      chkWordWrap.checked = enabled;
      const btnWrap = document.getElementById("btn-editor-wrap");
      if (btnWrap) btnWrap.setAttribute("aria-pressed", String(enabled));
    }
  });

  chkMinimap?.addEventListener("change", () => {
    if (editor) {
      const enabled = editor.toggleMinimap();
      chkMinimap.checked = enabled;
      const btnMinimap = document.getElementById("btn-editor-minimap");
      if (btnMinimap) btnMinimap.setAttribute("aria-pressed", String(enabled));
    }
  });

  chkHardwareKeyboard?.addEventListener("change", () => {
    if (editor && typeof editor.setHardwareKeyboardMode === "function") {
      const enabled = editor.setHardwareKeyboardMode(Boolean(chkHardwareKeyboard.checked));
      chkHardwareKeyboard.checked = enabled;
      onHardwareKeyboardChange?.(enabled);
    }
  });

  selectKeyStorage?.addEventListener("change", (e) => {
    const mode = e.target.value;
    if (mode === "session" || mode === "local") {
      setKeyStorageMode(mode);
      try {
        if (mode === "session" || !hasStoredCredentials()) {
          void saveCredentialsBackup("");
        } else {
          void saveCredentialsBackup(exportKeysBundle());
        }
      } catch (_) {}
    }
  });

  selectAutosave?.addEventListener("change", (e) => {
    const val = (e?.target ? e.target.value : selectAutosave?.value) || "240";
    try {
      localStorage.setItem("studio_autosave_delay", val);
    } catch (_) {}
  });

  selectAiTemp?.addEventListener("change", (e) => {
    const val = parseFloat((e?.target ? e.target.value : selectAiTemp?.value) || "0.7");
    setAiTemperature(val);
  });

  selectAiBudget?.addEventListener("change", (e) => {
    const val = (e?.target ? e.target.value : selectAiBudget?.value) || "standard";
    setAiContextBudget(val);
    refreshTokensMeter();
  });

  selectAiThinkingSpeed?.addEventListener("change", (e) => {
    const val = (e?.target ? e.target.value : selectAiThinkingSpeed?.value) || "media";
    if (val === "baja" || val === "media" || val === "alta") {
      setAiThinkingSpeed(val);
      const chatBtns = document.querySelectorAll(".chat-thinking-btn");
      chatBtns?.forEach((btn) => {
        const active = (btn.dataset?.speed || btn.getAttribute?.("data-speed")) === val;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-checked", String(active));
      });
    }
  });

  function setVaultStatus(message, type = "neutral") {
    if (!vaultStatusEl) return;
    vaultStatusEl.hidden = !message;
    vaultStatusEl.textContent = message || "";
    vaultStatusEl.className =
      type === "error"
        ? "gh-status-msg is-error"
        : type === "ok"
          ? "gh-status-msg is-ok"
          : "gh-status-msg";
  }

  function triggerVaultDownload(encryptedJson) {
    const blob = new Blob([encryptedJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "studio-ide-claves.vault.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function readSelectedFileText(file) {
    if (file && typeof file.text === "function") {
      return file.text();
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("No se pudo leer el archivo seleccionado."));
      reader.readAsText(file);
    });
  }

  btnExportVault?.addEventListener("click", async () => {
    if (!hasStoredCredentials()) {
      setVaultStatus("No hay API keys ni token de GitHub guardados para exportar.", "error");
      return;
    }
    const passphrase = vaultPassphraseInput?.value || "";
    if (btnExportVault) btnExportVault.disabled = true;
    setVaultStatus("Cifrando credenciales con AES-GCM 256…", "neutral");
    try {
      const bundleJson = exportKeysBundle();
      const encryptedJson = await encryptKeysPayload(bundleJson, passphrase);
      triggerVaultDownload(encryptedJson);
      if (vaultPassphraseInput) vaultPassphraseInput.value = "";
      setVaultStatus("Bóveda cifrada descargada correctamente (studio-ide-claves.vault.json).", "ok");
    } catch (err) {
      setVaultStatus(err instanceof Error ? err.message : "No se pudo cifrar la bóveda.", "error");
    } finally {
      if (btnExportVault) btnExportVault.disabled = false;
    }
  });

  async function importVaultText(rawText, passphrase) {
    let payloadJson = rawText;
    if (isEncryptedKeyVault(rawText)) {
      payloadJson = await decryptKeysPayload(rawText, passphrase);
    } else {
      throw new Error("Solo se admite importar archivos cifrados de bóveda Studio IDE (.vault.json).");
    }
    const count = importKeysBundle(payloadJson);
    if (getKeyStorageMode() === "local" && hasStoredCredentials()) {
      void saveCredentialsBackup(exportKeysBundle());
    }
    refreshTokensMeter();
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("studio-credentials-updated"));
    }
    if (vaultPassphraseInput) vaultPassphraseInput.value = "";
    setVaultStatus(
      count > 0
        ? `Se restauraron ${count} credencial(es) desde la bóveda cifrada.`
        : "Bóveda descifrada sin credenciales activas.",
      count > 0 ? "ok" : "neutral"
    );
  }

  btnImportVault?.addEventListener("click", () => {
    const passphrase = vaultPassphraseInput?.value || "";
    if (!passphrase || passphrase.length < 6) {
      setVaultStatus("Ingresá la contraseña maestra (mínimo 6 caracteres) antes de elegir el archivo cifrado.", "error");
      vaultPassphraseInput?.focus();
      return;
    }
    if (vaultFileInput) {
      vaultFileInput.value = "";
      vaultFileInput.click();
    }
  });

  vaultFileInput?.addEventListener("change", async () => {
    const file = vaultFileInput.files?.[0];
    if (!file) return;
    const passphrase = vaultPassphraseInput?.value || "";
    if (btnImportVault) btnImportVault.disabled = true;
    setVaultStatus("Descifrando bóveda de credenciales…", "neutral");
    try {
      const rawText = await readSelectedFileText(file);
      await importVaultText(rawText, passphrase);
    } catch (err) {
      setVaultStatus(err instanceof Error ? err.message : "No se pudo importar la bóveda.", "error");
    } finally {
      vaultFileInput.value = "";
      if (btnImportVault) btnImportVault.disabled = false;
    }
  });

  shortcutsFilter?.addEventListener("input", (e) => {
    renderShortcutsList((e?.target ? e.target.value : shortcutsFilter?.value) || "");
  });

  return {
    open,
    close,
    syncControls: syncControlsWithState
  };
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
