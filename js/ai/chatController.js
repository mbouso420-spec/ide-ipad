import { icon } from "../ui/icons.js";
import {
  AI_PROVIDERS,
  PROVIDER_SHORT_NAMES,
  clearApiKey,
  exportKeysBundle,
  fetchLiveFreeModels,
  getAiContextBudget,
  getModelContextWindow,
  getAiThinkingSpeed,
  setAiThinkingSpeed,
  getApiKey,
  getKeyStorageMode,
  getSavedModel,
  getSavedProviderId,
  hasStoredCredentials,
  importKeysBundle,
  saveApiKey,
  saveModel,
  saveProviderId,
  setKeyStorageMode,
  streamAiCompletion,
  validateApiKey
} from "./providers.js";
import { saveCredentialsBackup } from "../storage/workspaceDb.js";

/**
 * Controlador del Asistente IA estilo Antigravity (depurado 100% para APIs gratuitas):
 * - Google Gemini Gratis (con respaldo automático si un modelo Flash está con alta demanda)
 * - Groq Gratis, GitHub Models Gratis, OpenRouter (:free) y Mistral/Codestral Gratis
 */
export function initChatController({
  getContextSnapshot,
  onInsertAtCursor,
  onReplaceSelection,
  onApplyWholeFile,
  onApplyToFile,
  onApplyMultiFile,
  onConversationChange,
  onKeysImported
}) {
  const settingsBtn = document.getElementById("btn-ai-settings");
  const clearChatBtn = document.getElementById("btn-ai-clear-chat");
  const settingsDrawer = document.getElementById("chat-settings-drawer");
  const currentModelLabel = document.getElementById("chat-current-model-label");
  const keyStatusBtn = document.getElementById("chat-key-status-btn");

  const providerSelect = document.getElementById("ai-provider-select");
  const modelSelect = document.getElementById("ai-model-select");
  const customModelInput = document.getElementById("ai-custom-model-input");
  const fetchModelsBtn = document.getElementById("ai-fetch-models-btn");
  const apiKeyInput = document.getElementById("ai-api-key-input");
  const toggleKeyVisBtn = document.getElementById("ai-toggle-key-vis");
  const clearKeyBtn = document.getElementById("ai-clear-key-btn");
  const providerHelpEl = document.getElementById("ai-provider-help");
  const modeLocalBtn = document.getElementById("ai-mode-local");
  const modeSessionBtn = document.getElementById("ai-mode-session");
  const exportKeysBtn = document.getElementById("ai-export-keys-btn");
  const importKeysBtn = document.getElementById("ai-import-keys-btn");
  const importKeysSlot = document.getElementById("ai-import-keys-slot");

  const extraTabsBar = document.getElementById("chat-extra-tabs");
  const streamContainer = document.getElementById("chat-stream");
  const scrollBody = document.getElementById("chat-scroll-body");
  const composerForm = document.getElementById("chat-composer-form");
  const promptInput = document.getElementById("chat-prompt-input");
  const submitBtn = document.getElementById("chat-submit-btn");
  const tokenCounterEl = document.getElementById("chat-token-counter");
  const regenerateBtn = document.getElementById("btn-chat-regenerate");

  let activeProviderId = getSavedProviderId();
  let activeModelId = getSavedModel(activeProviderId);
  let settingsOpen = false;
  let keyVisible = false;
  let currentStreamStatus = "";

  /**
   * Respuestas en curso por conversación (clave = id del proyecto). Una respuesta sigue en segundo plano
   * si el usuario cambia de proyecto y se guarda en el proyecto donde se hizo la pregunta.
   * @type {Map<string | null, { controller: AbortController, convo: Array<{ role: string, content: string }>, discarded: boolean }>}
   */
  const activeStreams = new Map();
  /** @type {string | null} */
  let conversationKey = null;

  /**
   * Resultado de la verificación de la clave por proveedor (solo en memoria; se re-verifica al abrir la app).
   * @type {Map<string, { key: string, status: "checking" | "valid" | "invalid" | "offline" | "unknown", message: string }>}
   */
  const keyChecks = new Map();
  let keyCheckTimer = 0;
  /** @type {AbortController | null} */
  let keyCheckController = null;

  /** @type {Set<string>} */
  const attachedTabIds = new Set();

  /** @type {Array<{ role: "user" | "assistant", content: string }>} */
  let conversation = [];

  populateProviderOptions();
  syncSettingsForm();
  renderConversation();
  // La lista de modelos se pide recién cuando la clave resulta válida: con una clave inválida
  // se hace una sola consulta (la verificación) en lugar de dos.
  scheduleKeyValidation(activeProviderId, 0, false);

  /**
   * Verifica la clave del proveedor con una consulta liviana y actualiza el indicador.
   * @param {string} providerId
   * @param {number} delayMs espera para no consultar en cada tecla
   * @param {boolean} announce si mostrar el resultado en el texto de ayuda (cuando el usuario la acaba de pegar)
   */
  function scheduleKeyValidation(providerId, delayMs, announce) {
    window.clearTimeout(keyCheckTimer);
    keyCheckController?.abort();
    keyCheckController = null;

    const key = getApiKey(providerId);
    if (!key) {
      keyChecks.delete(providerId);
      updateModelStrip();
      if (providerId === "openrouter") {
        // El catálogo de OpenRouter es público: se puede listar sin clave.
        void syncLiveModelsSilently(providerId);
      }
      return;
    }
    const previous = keyChecks.get(providerId);
    if (!announce && previous && previous.key === key && previous.status !== "checking") {
      updateModelStrip();
      return;
    }

    keyChecks.set(providerId, { key, status: "checking", message: "" });
    updateModelStrip();

    keyCheckTimer = window.setTimeout(async () => {
      const controller = new AbortController();
      keyCheckController = controller;
      let result;
      try {
        result = await validateApiKey(providerId, key, controller.signal);
      } catch {
        return; // Cancelada porque el usuario siguió escribiendo o cambió de proveedor
      }
      if (keyCheckController === controller) {
        keyCheckController = null;
      }
      if (getApiKey(providerId) !== key) {
        return; // La clave cambió mientras se verificaba: este resultado ya no aplica
      }
      keyChecks.set(providerId, { key, ...result });
      updateModelStrip();
      if (result.status === "valid") {
        void syncLiveModelsSilently(providerId);
      }
      if (providerId === activeProviderId && providerHelpEl && (announce || result.status !== "valid")) {
        providerHelpEl.textContent = result.message;
      }
    }, delayMs);
  }

  async function syncLiveModelsSilently(providerId) {
    const provider = AI_PROVIDERS[providerId];
    if (!provider || !provider.supportsLiveModels) {
      return;
    }
    const key = getApiKey(providerId);
    if (!key && providerId !== "openrouter") {
      return;
    }
    try {
      const liveModels = await fetchLiveFreeModels(providerId, key);
      if (liveModels.length > 0) {
        provider.models = liveModels;
        if (activeProviderId === providerId) {
          const stillValid = liveModels.some((m) => m.id === activeModelId);
          if (!stillValid) {
            activeModelId = liveModels[0].id;
            saveModel(providerId, activeModelId);
          }
          syncSettingsForm();
        }
      }
    } catch {
      // Silencioso en segundo plano
    }
  }

  function toggleSettings(forceState) {
    settingsOpen = typeof forceState === "boolean" ? forceState : !settingsOpen;
    if (settingsDrawer) {
      settingsDrawer.hidden = !settingsOpen;
    }
    if (settingsBtn) {
      settingsBtn.setAttribute("aria-expanded", String(settingsOpen));
    }
  }

  settingsBtn?.addEventListener("click", () => toggleSettings());
  keyStatusBtn?.addEventListener("click", () => toggleSettings());

  clearChatBtn?.addEventListener("click", () => {
    const running = activeStreams.get(conversationKey);
    if (running) {
      // Se descarta: al cortarse no debe volver a guardar la conversación que el usuario acaba de limpiar.
      running.discarded = true;
      running.controller.abort();
    }
    conversation = [];
    renderConversation();
    setStreamingUiState(false);
    onConversationChange?.([], conversationKey);
  });

  providerSelect?.addEventListener("change", () => {
    activeProviderId = providerSelect.value;
    saveProviderId(activeProviderId);
    activeModelId = getSavedModel(activeProviderId);
    syncSettingsForm();
    scheduleKeyValidation(activeProviderId, 0, false);
  });

  modelSelect?.addEventListener("change", () => {
    activeModelId = modelSelect.value;
    if (customModelInput) {
      customModelInput.value = activeModelId;
    }
    saveModel(activeProviderId, activeModelId);
    updateModelStrip();
  });

  customModelInput?.addEventListener("input", () => {
    const val = customModelInput.value.trim();
    if (val) {
      activeModelId = val;
      saveModel(activeProviderId, activeModelId);
      updateModelStrip();
    }
  });

  function syncCredentialsBackup() {
    try {
      if (getKeyStorageMode() === "session" || !hasStoredCredentials()) {
        void saveCredentialsBackup("");
      } else {
        void saveCredentialsBackup(exportKeysBundle());
      }
    } catch {
      // Ignorar si falla el guardado asíncrono
    }
  }

  apiKeyInput?.addEventListener("input", () => {
    saveApiKey(activeProviderId, apiKeyInput.value);
    syncCredentialsBackup();
    scheduleKeyValidation(activeProviderId, 700, true);
  });

  toggleKeyVisBtn?.addEventListener("click", () => {
    keyVisible = !keyVisible;
    if (apiKeyInput) {
      apiKeyInput.type = keyVisible ? "text" : "password";
    }
    toggleKeyVisBtn.innerHTML = icon(keyVisible ? "eyeOff" : "eye");
  });

  clearKeyBtn?.addEventListener("click", () => {
    clearApiKey(activeProviderId);
    syncCredentialsBackup();
    if (apiKeyInput) {
      apiKeyInput.value = "";
    }
    scheduleKeyValidation(activeProviderId, 0, false);
  });

  modeLocalBtn?.addEventListener("click", () => {
    setKeyStorageMode("local");
    syncStorageModeButtons();
    syncCredentialsBackup();
  });

  modeSessionBtn?.addEventListener("click", () => {
    setKeyStorageMode("session");
    syncStorageModeButtons();
    try {
      void saveCredentialsBackup("");
    } catch {}
  });

  exportKeysBtn?.addEventListener("click", async () => {
    const bundle = exportKeysBundle();
    const ok = await copyToClipboardSafe(bundle);
    if (providerHelpEl) {
      providerHelpEl.textContent = ok
        ? "Pack de claves copiado al portapapeles. Podés mandártelo al iPad y tocar Importar pack."
        : "No se pudo acceder al portapapeles automáticamente.";
    }
  });

  importKeysBtn?.addEventListener("click", () => {
    if (!importKeysSlot) return;
    if (!importKeysSlot.hidden) {
      importKeysSlot.hidden = true;
      importKeysSlot.innerHTML = "";
      return;
    }
    importKeysSlot.hidden = false;
    importKeysSlot.innerHTML = "";

    const form = document.createElement("form");
    form.className = "inline-edit-form";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-edit-input";
    input.placeholder = '{"gemini":"AIza…","groq":"gsk_…"}';
    input.setAttribute("aria-label", "Pegar paquete de claves exportado");

    const okBtn = document.createElement("button");
    okBtn.type = "submit";
    okBtn.className = "tree-icon-btn";
    okBtn.setAttribute("aria-label", "Importar claves");
    okBtn.innerHTML = icon("check");

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "tree-icon-btn";
    closeBtn.setAttribute("aria-label", "Cancelar");
    closeBtn.innerHTML = icon("x");

    const close = () => {
      importKeysSlot.hidden = true;
      importKeysSlot.innerHTML = "";
    };

    closeBtn.addEventListener("click", close);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        const count = importKeysBundle(input.value.trim());
        syncCredentialsBackup();
        close();
        syncSettingsForm();
        scheduleKeyValidation(activeProviderId, 0, true);
        onKeysImported?.();
        if (providerHelpEl) {
          providerHelpEl.textContent = `Se importaron ${count} clave(s) en este dispositivo.`;
        }
      } catch {
        if (providerHelpEl) {
          providerHelpEl.textContent = "El texto pegado no corresponde a un pack válido.";
        }
      }
    });

    form.append(input, okBtn, closeBtn);
    importKeysSlot.appendChild(form);
    input.focus();
  });

  fetchModelsBtn?.addEventListener("click", async () => {
    const provider = AI_PROVIDERS[activeProviderId];
    if (!provider) return;

    fetchModelsBtn.disabled = true;
    try {
      const liveModels = await fetchLiveFreeModels(provider.id, getApiKey(provider.id));
      if (liveModels.length > 0) {
        provider.models = liveModels;
        activeModelId = liveModels[0].id;
        saveModel(provider.id, activeModelId);
        syncSettingsForm();
        if (providerHelpEl) {
          providerHelpEl.textContent = `Lista actualizada (${liveModels.length} modelos gratuitos disponibles).`;
        }
      }
    } catch (error) {
      if (providerHelpEl) {
        providerHelpEl.textContent = error instanceof Error ? error.message : "Error al actualizar modelos.";
      }
    } finally {
      fetchModelsBtn.disabled = false;
    }
  });

  function updateTokenEstimate() {
    if (!tokenCounterEl) return;
    const promptLen = promptInput ? promptInput.value.length : 0;
    const snapshot = getContextSnapshot ? getContextSnapshot() : null;
    let contextLen = 0;
    if (snapshot?.activeFile) {
      if (snapshot.selection && snapshot.selection.text) {
        contextLen += snapshot.selection.text.length;
      } else {
        contextLen += (snapshot.activeFile.content || "").length;
      }
    }
    if (snapshot?.otherOpenFiles) {
      for (const f of snapshot.otherOpenFiles) {
        if (attachedTabIds.has(f.id)) {
          contextLen += (f.content || "").length;
        }
      }
    }
    const totalChars = promptLen + contextLen;
    const usedTokens = estimateTokens(totalChars);

    const activeKey = getApiKey(activeProviderId);
    const hasKey = Boolean(activeKey && activeKey.trim());
    const modelContext = getModelContextWindow(activeProviderId, activeModelId);

    if (!hasKey) {
      tokenCounterEl.textContent = `~${usedTokens.toLocaleString()} tokens (Sin clave de API)`;
    } else {
      tokenCounterEl.textContent = `~${usedTokens.toLocaleString()} / ${modelContext.toLocaleString()} tokens`;
    }
  }

  function syncRegenerateButton() {
    if (!regenerateBtn) return;
    const hasAssistantResponse = conversation.some((m) => m.role === "assistant");
    const isStreaming = activeStreams.has(conversationKey);
    regenerateBtn.hidden = !hasAssistantResponse || isStreaming;
  }

  promptInput?.addEventListener("input", updateTokenEstimate);

  const toggleToolsBtn = document.getElementById("btn-toggle-composer-tools");
  const toolsDrawer = document.getElementById("chat-tools-drawer");

  toggleToolsBtn?.addEventListener("click", () => {
    if (!toolsDrawer) return;
    const willShow = toolsDrawer.hidden;
    toolsDrawer.hidden = !willShow;
    toggleToolsBtn.setAttribute("aria-expanded", String(willShow));
    toggleToolsBtn.classList.toggle("is-active", willShow);
  });

  const actionChips = composerForm?.querySelectorAll(".chat-action-chip");
  actionChips?.forEach((btn) => {
    btn.addEventListener("click", () => {
      const cmd = btn.dataset?.command || btn.getAttribute("data-command");
      if (!promptInput) return;
      if (cmd === "/fix") {
        promptInput.value = "/fix Analizá y corregí los errores en el código activo.";
      } else if (cmd === "/explain") {
        promptInput.value = "/explain Explicá cómo funciona este código y su lógica paso a paso.";
      } else if (cmd === "/test") {
        promptInput.value = "/test Generá una suite de pruebas unitarias exhaustiva para este código.";
      } else if (cmd) {
        promptInput.value = `${cmd} `;
      }
      promptInput.focus();
      updateTokenEstimate();
    });
  });

  const thinkingButtons = composerForm?.querySelectorAll(".chat-thinking-btn");
  function syncThinkingSpeedUi(speed = getAiThinkingSpeed()) {
    thinkingButtons?.forEach((btn) => {
      const active = btn.dataset?.speed === speed || btn.getAttribute("data-speed") === speed;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", String(active));
    });
  }
  syncThinkingSpeedUi();

  thinkingButtons?.forEach((btn) => {
    btn.addEventListener("click", () => {
      const chosen = btn.dataset?.speed || btn.getAttribute("data-speed");
      if (chosen === "baja" || chosen === "media" || chosen === "alta") {
        setAiThinkingSpeed(chosen);
        syncThinkingSpeedUi(chosen);
        const settingSpeed = document.getElementById("setting-ai-thinking-speed");
        if (settingSpeed) {
          settingSpeed.value = chosen;
        }
      }
    });
  });

  regenerateBtn?.addEventListener("click", async () => {
    const running = activeStreams.get(conversationKey);
    if (running) return;

    let lastUserIdx = -1;
    for (let i = conversation.length - 1; i >= 0; i -= 1) {
      if (conversation[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return;

    const userText = conversation[lastUserIdx].content;
    const apiKey = getApiKey(activeProviderId);
    if (!apiKey) {
      toggleSettings(true);
      apiKeyInput?.focus();
      return;
    }

    conversation.splice(lastUserIdx);
    await sendPrompt(userText, apiKey);
  });

  promptInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composerForm?.requestSubmit();
    }
  });

  composerForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const running = activeStreams.get(conversationKey);
    if (running) {
      running.controller.abort();
      return;
    }

    const userText = (promptInput?.value || "").trim();
    if (!userText) {
      return;
    }

    const apiKey = getApiKey(activeProviderId);
    if (!apiKey) {
      toggleSettings(true);
      apiKeyInput?.focus();
      appendErrorBanner(
        `Falta la API Key gratuita para ${AI_PROVIDERS[activeProviderId].name}. Pegala arriba (queda guardada en este navegador).`
      );
      return;
    }

    if (promptInput) {
      promptInput.value = "";
    }

    await sendPrompt(userText, apiKey);
  });

  async function sendPrompt(userText, apiKey) {
    const snapshot = getContextSnapshot();
    const systemPrompt = buildSystemPrompt(snapshot);

    let promptToSend = userText;
    if (userText.startsWith("/fix")) {
      const rest = userText.slice(4).trim();
      promptToSend = `[COMANDO RÁPIDO /fix]: Revisá el código del archivo activo, detectá errores de sintaxis, compilación o ejecución, y devolvé la versión corregida con explicación concisa.${rest ? ` Detalle adicional: ${rest}` : ""}`;
    } else if (userText.startsWith("/explain")) {
      const rest = userText.slice(8).trim();
      promptToSend = `[COMANDO RÁPIDO /explain]: Explicá de manera didáctica y detallada el funcionamiento de este código, su estructura y sus puntos clave.${rest ? ` Consulta: ${rest}` : ""}`;
    } else if (userText.startsWith("/test")) {
      const rest = userText.slice(5).trim();
      promptToSend = `[COMANDO RÁPIDO /test]: Diseñá una suite completa de pruebas unitarias con casos normales, límites y de error para este código.${rest ? ` Requisitos: ${rest}` : ""}`;
    }

    // La respuesta queda atada a ESTA conversación aunque el usuario cambie de proyecto mientras llega.
    const key = conversationKey;
    const convo = conversation;
    convo.push({ role: "user", content: userText });
    const assistantEntry = { role: "assistant", content: "" };
    convo.push(assistantEntry);

    const stream = { controller: new AbortController(), convo, discarded: false };
    activeStreams.set(key, stream);
    const isVisible = () => conversationKey === key && conversation === convo;

    renderConversation();
    scrollToBottom();

    currentStreamStatus = "";
    setStreamingUiState(true);

    let rafPending = false;
    const scheduleRender = () => {
      if (rafPending || !isVisible()) return;
      rafPending = true;
      window.requestAnimationFrame(() => {
        rafPending = false;
        if (!isVisible()) return;
        updateLastAssistantMessage(assistantEntry.content, true);
        scrollToBottom();
      });
    };

    const messagesForAi = cleanHistoryForAi(convo.slice(0, -1));
    messagesForAi.push({ role: "user", content: promptToSend });

    try {
      await streamAiCompletion({
        providerId: activeProviderId,
        model: activeModelId,
        apiKey,
        systemPrompt,
        history: messagesForAi,
        signal: stream.controller.signal,
        onModelsSynced(syncedProviderId, liveModels) {
          if (activeProviderId === syncedProviderId && Array.isArray(liveModels) && liveModels.length > 0) {
            const stillValid = liveModels.some((m) => m.id === activeModelId);
            if (!stillValid) {
              activeModelId = liveModels[0].id;
              saveModel(syncedProviderId, activeModelId);
            }
            syncSettingsForm();
          }
        },
        onFallbackNotice(noticeText) {
          if (!isVisible()) return;
          currentStreamStatus = noticeText;
          if (providerHelpEl) {
            providerHelpEl.textContent = noticeText;
          }
          scheduleRender();
        },
        onChunk(delta) {
          if (isVisible()) {
            currentStreamStatus = "";
          }
          assistantEntry.content += delta;
          scheduleRender();
        }
      });

      if (isVisible()) {
        updateLastAssistantMessage(assistantEntry.content || "Sin contenido devuelto por el modelo.", false);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (!stream.discarded) {
          assistantEntry.content += "\n\n*(Generación detenida)*";
          if (isVisible()) {
            updateLastAssistantMessage(assistantEntry.content, false);
          }
        }
      } else {
        const message =
          error instanceof Error ? error.message : "Error de red al conectar con el proveedor gratuito.";
        if (assistantEntry.content.trim()) {
          // Se conserva lo que ya llegó: perderlo sería peor que mostrarlo incompleto.
          assistantEntry.content += `\n\n*(Respuesta interrumpida: ${message})*`;
          if (isVisible()) {
            updateLastAssistantMessage(assistantEntry.content, false);
          }
        } else {
          const idx = convo.indexOf(assistantEntry);
          if (idx !== -1) {
            convo.splice(idx, 1);
          }
          if (isVisible()) {
            renderConversation();
            appendErrorBanner(message);
          }
        }
      }
    } finally {
      if (activeStreams.get(key) === stream) {
        activeStreams.delete(key);
      }
      if (isVisible()) {
        currentStreamStatus = "";
        setStreamingUiState(false);
        scrollToBottom();
      }
      if (!stream.discarded) {
        onConversationChange?.(
          convo.map((m) => ({ role: m.role, content: m.content })),
          key
        );
      }
    }
  }

  function populateProviderOptions() {
    if (!providerSelect) return;
    providerSelect.innerHTML = "";
    for (const provider of Object.values(AI_PROVIDERS)) {
      const opt = document.createElement("option");
      opt.value = provider.id;
      opt.textContent = provider.name;
      providerSelect.appendChild(opt);
    }
    providerSelect.value = activeProviderId;
  }

  function syncSettingsForm() {
    const provider = AI_PROVIDERS[activeProviderId] ?? AI_PROVIDERS.gemini;

    if (providerSelect) {
      providerSelect.value = provider.id;
    }

    if (modelSelect) {
      modelSelect.innerHTML = "";
      for (const m of provider.models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      }
      const existsInPreset = provider.models.some((m) => m.id === activeModelId);
      if (!existsInPreset && activeModelId) {
        const customOpt = document.createElement("option");
        customOpt.value = activeModelId;
        customOpt.textContent = `${activeModelId} (Personalizado)`;
        modelSelect.appendChild(customOpt);
      }
      modelSelect.value = activeModelId;
    }

    if (customModelInput) {
      customModelInput.value = activeModelId;
    }

    if (fetchModelsBtn) {
      fetchModelsBtn.hidden = !provider.supportsLiveModels;
    }

    if (apiKeyInput) {
      apiKeyInput.placeholder = provider.keyPlaceholder;
      apiKeyInput.value = getApiKey(provider.id);
    }

    if (providerHelpEl) {
      providerHelpEl.textContent = provider.helpText;
    }

    syncStorageModeButtons();
    updateModelStrip();
  }

  function syncStorageModeButtons() {
    const mode = getKeyStorageMode();
    modeLocalBtn?.setAttribute("aria-pressed", String(mode === "local"));
    modeSessionBtn?.setAttribute("aria-pressed", String(mode === "session"));
  }

  function updateModelStrip() {
    const provider = AI_PROVIDERS[activeProviderId] ?? AI_PROVIDERS.gemini;
    const key = getApiKey(provider.id);

    if (currentModelLabel) {
      const displayName = PROVIDER_SHORT_NAMES[provider.id] || provider.name;
      currentModelLabel.textContent = `${displayName}: ${activeModelId}`;
    }

    if (keyStatusBtn) {
      const check = keyChecks.get(provider.id);
      const current = check && check.key === key ? check : null;
      let label = "Falta clave";
      let state = "missing";
      if (key) {
        if (!current) {
          label = "Clave sin verificar";
          state = "unverified";
        } else if (current.status === "checking") {
          label = "Verificando…";
          state = "checking";
        } else if (current.status === "valid") {
          label = "Clave válida";
          state = "valid";
        } else if (current.status === "invalid") {
          label = "Clave inválida";
          state = "invalid";
        } else {
          label = "Clave sin verificar";
          state = "unverified";
        }
      }
      keyStatusBtn.classList.toggle("has-key", state === "valid");
      keyStatusBtn.classList.toggle("is-invalid", state === "invalid");
      keyStatusBtn.classList.toggle("is-unverified", state === "unverified" || state === "checking");
      keyStatusBtn.dataset.keyState = state;
      keyStatusBtn.title = current?.message || "Abrir configuración de API Key";
      keyStatusBtn.innerHTML = `${icon("key")}<span>${label}</span>`;
    }
  }

  function setStreamingUiState(streaming) {
    if (submitBtn) {
      if (streaming) {
        submitBtn.setAttribute("aria-label", "Detener respuesta");
        submitBtn.title = "Detener respuesta";
        submitBtn.innerHTML = icon("square");
      } else {
        submitBtn.setAttribute("aria-label", "Enviar consulta");
        submitBtn.title = "Enviar consulta";
        submitBtn.innerHTML = icon("send");
      }
    }
    syncRegenerateButton();
    updateTokenEstimate();
  }

  function renderExtraTabChips() {
    if (!extraTabsBar) return;
    const { otherOpenFiles } = getContextSnapshot();

    const validIds = new Set(otherOpenFiles.map((f) => f.id));
    for (const id of [...attachedTabIds]) {
      if (!validIds.has(id)) {
        attachedTabIds.delete(id);
      }
    }

    if (otherOpenFiles.length === 0) {
      extraTabsBar.hidden = true;
      return;
    }

    extraTabsBar.hidden = false;
    extraTabsBar.innerHTML = `<span class="chat-extra-label">Sumar pestaña:</span>`;

    for (const file of otherOpenFiles) {
      const attached = attachedTabIds.has(file.id);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "context-chip";
      chip.setAttribute("aria-pressed", String(attached));
      chip.innerHTML = `${icon(attached ? "check" : "plus")}<span>${escapeHtml(file.shortName || file.name)}</span>`;
      chip.addEventListener("click", () => {
        if (attachedTabIds.has(file.id)) {
          attachedTabIds.delete(file.id);
        } else {
          attachedTabIds.add(file.id);
        }
        renderExtraTabChips();
      });
      extraTabsBar.appendChild(chip);
    }
  }

  function renderConversation() {
    if (!streamContainer) return;
    streamContainer.innerHTML = "";

    if (conversation.length === 0) {
      const welcome = document.createElement("div");
      welcome.className = "chat-empty-welcome";
      welcome.innerHTML = `
        <div class="chat-empty-title">Asistente contextual listo</div>
        <p>Configurado exclusivamente con proveedores y modelos gratuitos. Leo automáticamente el archivo abierto en el centro y las líneas que selecciones.</p>
        <div class="chat-quick-prompts">
          <button type="button" class="btn btn-sm" data-quick-prompt="Revisá este archivo y sugerí mejoras concretas.">Revisar archivo</button>
          <button type="button" class="btn btn-sm" data-quick-prompt="Explicame paso a paso cómo funciona este código.">Explicar código</button>
        </div>
      `;
      welcome.querySelectorAll("[data-quick-prompt]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const text = btn.getAttribute("data-quick-prompt") || "";
          if (promptInput) {
            promptInput.value = text;
            composerForm?.requestSubmit();
          }
        });
      });
      streamContainer.appendChild(welcome);
      return;
    }

    conversation.forEach((msg, index) => {
      if (msg.role === "user") {
        const capsule = document.createElement("div");
        capsule.className = "chat-user-capsule";
        capsule.textContent = msg.content;
        streamContainer.appendChild(capsule);
      } else {
        const aiNode = document.createElement("div");
        aiNode.className = "chat-ai-response";
        aiNode.dataset.assistantIndex = String(index);
        const isLiveTail = index === conversation.length - 1 && activeStreams.has(conversationKey);
        populateAssistantNode(aiNode, msg.content, isLiveTail);
        streamContainer.appendChild(aiNode);
      }
    });

    syncRegenerateButton();
    updateTokenEstimate();
  }

  function updateLastAssistantMessage(markdownText, isStreaming) {
    if (!streamContainer) return;
    const nodes = streamContainer.querySelectorAll(".chat-ai-response");
    const lastNode = nodes[nodes.length - 1];
    if (lastNode instanceof HTMLElement) {
      populateAssistantNode(lastNode, markdownText, isStreaming);
    }
  }

  function populateAssistantNode(container, markdownText, isStreaming) {
    const segments = parseMarkdownSegments(markdownText);
    container.innerHTML = "";

    if (segments.length === 0 && isStreaming) {
      const waiting = document.createElement("p");
      waiting.className = "chat-streaming-note";
      waiting.textContent = currentStreamStatus || "Generando respuesta…";
      container.appendChild(waiting);
      return;
    }

    const multiFiles = segments.filter((s) => s.type === "code" && s.filePath);
    if (multiFiles.length >= 2 && !isStreaming) {
      const planEl = document.createElement("div");
      planEl.className = "chat-multi-file-plan";

      const planHeader = document.createElement("div");
      planHeader.className = "chat-multi-file-plan-header";

      const planBadge = document.createElement("span");
      planBadge.className = "chat-multi-file-plan-badge";
      planBadge.innerHTML = `${icon("sparkles")}<span>Plan multi-archivo detectado (${multiFiles.length} archivos)</span>`;

      const btnApplyAll = document.createElement("button");
      btnApplyAll.type = "button";
      btnApplyAll.className = "btn btn-primary btn-sm chat-multi-apply-all-btn";
      btnApplyAll.innerHTML = `${icon("zap")}<span>Aplicar todos los cambios</span>`;
      btnApplyAll.addEventListener("click", async () => {
        btnApplyAll.disabled = true;
        btnApplyAll.innerHTML = `${icon("refreshCw")}<span>Aplicando lote…</span>`;
        if (typeof onApplyMultiFile === "function") {
          try {
            await onApplyMultiFile(multiFiles.map((m) => ({ path: m.filePath, code: m.code, lang: m.lang })));
            btnApplyAll.innerHTML = `${icon("check")}<span>¡${multiFiles.length} archivos aplicados!</span>`;
          } catch {
            btnApplyAll.innerHTML = `${icon("x")}<span>Error al aplicar</span>`;
          }
        }
      });

      planHeader.append(planBadge, btnApplyAll);

      const chipsTrack = document.createElement("div");
      chipsTrack.className = "chat-multi-file-chips";
      for (const mf of multiFiles) {
        const chip = document.createElement("span");
        chip.className = "chat-multi-file-chip";
        chip.innerHTML = `${icon("fileCode")}<span>${escapeHtml(mf.filePath)}</span>`;
        chipsTrack.appendChild(chip);
      }

      planEl.append(planHeader, chipsTrack);
      container.appendChild(planEl);
    }

    for (const seg of segments) {
      if (seg.type === "prose") {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = formatProseHtml(seg.content);
        while (wrapper.firstChild) {
          container.appendChild(wrapper.firstChild);
        }
      } else {
        container.appendChild(buildCodeBlockElement(seg.lang, seg.code, seg.filePath));
      }
    }

    if (isStreaming) {
      const indicator = document.createElement("span");
      indicator.className = "chat-streaming-note";
      indicator.textContent = "Escribiendo…";
      container.appendChild(indicator);
    }
  }

  function buildCodeBlockElement(lang, code, filePath = null) {
    const block = document.createElement("div");
    block.className = "chat-code-block";

    const header = document.createElement("div");
    header.className = "chat-code-header-wrap";

    const infoWrap = document.createElement("div");
    infoWrap.style.display = "flex";
    infoWrap.style.alignItems = "center";
    infoWrap.style.gap = "var(--space-2xs)";

    const langSpan = document.createElement("span");
    langSpan.className = "code-font";
    langSpan.textContent = lang || "código";
    infoWrap.appendChild(langSpan);

    if (filePath) {
      const pathBadge = document.createElement("span");
      pathBadge.className = "chat-code-filepath";
      pathBadge.innerHTML = `${icon("fileCode")}<span>${escapeHtml(filePath)}</span>`;
      infoWrap.appendChild(pathBadge);
    }

    const actions = document.createElement("div");
    actions.className = "chat-code-actions-wrap";

    const btnInsert = createCodeActionButton("arrowDownLeft", "En cursor", "Insertar en la posición del cursor", async () => {
      let inserted = false;
      try {
        inserted = (await onInsertAtCursor(code, lang)) !== false;
      } catch {
        inserted = false;
      }
      btnInsert.innerHTML = inserted
        ? `${icon("check")}<span>Insertado</span>`
        : `${icon("x")}<span>Sin archivo abierto</span>`;
      window.setTimeout(() => {
        btnInsert.innerHTML = `${icon("arrowDownLeft")}<span>En cursor</span>`;
      }, inserted ? 1300 : 2200);
    });

    const hasSelNow = Boolean(getContextSnapshot().selection?.lineCount > 0);
    const btnReplace = createCodeActionButton(
      "replace",
      "Reemplazar código",
      hasSelNow
        ? "Reemplazar las líneas seleccionadas"
        : "Reemplazar todo el archivo (sin selección activa)",
      async () => {
        const applied = await onReplaceSelection(code);
        if (applied !== false) {
          btnReplace.innerHTML = `${icon("check")}<span>Reemplazado</span>`;
          window.setTimeout(() => {
            btnReplace.innerHTML = `${icon("replace")}<span>Reemplazar código</span>`;
          }, 1300);
        }
      }
    );
    btnReplace.dataset.action = "replace-selection";
    btnReplace.disabled = false;

    let btnApplyAction;
    if (filePath && typeof onApplyToFile === "function") {
      const baseName = filePath.split("/").pop();
      btnApplyAction = createCodeActionButton("fileCheck", `Aplicar a ${baseName}`, `Aplicar o crear archivo ${filePath}`, async () => {
        btnApplyAction.disabled = true;
        try {
          await onApplyToFile(filePath, code, lang);
          btnApplyAction.innerHTML = `${icon("check")}<span>Guardado</span>`;
        } catch {
          btnApplyAction.innerHTML = `${icon("x")}<span>Error</span>`;
        }
        window.setTimeout(() => {
          btnApplyAction.disabled = false;
          btnApplyAction.innerHTML = `${icon("fileCheck")}<span>Aplicar a ${escapeHtml(baseName)}</span>`;
        }, 1500);
      });
    } else {
      btnApplyAction = createCodeActionButton("fileCheck", "Aplicar cambios", "Reemplazar contenido completo del archivo (reversible con Deshacer)", () => {
        onApplyWholeFile(code, lang);
      });
    }

    const btnCopy = createCodeActionButton("copy", "Copiar", "Copiar bloque al portapapeles", async () => {
      const copied = await copyToClipboardSafe(code);
      btnCopy.innerHTML = copied
        ? `${icon("check")}<span>Copiado</span>`
        : `${icon("x")}<span>Sin acceso</span>`;
      window.setTimeout(() => {
        btnCopy.innerHTML = `${icon("copy")}<span>Copiar</span>`;
      }, 1400);
    });

    actions.append(btnInsert, btnReplace, btnApplyAction, btnCopy);
    header.append(infoWrap, actions);

    const pre = document.createElement("pre");
    pre.className = "chat-code-pre code-font";
    const codeEl = document.createElement("code");
    codeEl.textContent = code;
    pre.appendChild(codeEl);

    block.append(header, pre);
    return block;
  }

  function createCodeActionButton(iconName, label, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-ghost btn-sm";
    btn.title = title;
    btn.innerHTML = `${icon(iconName)}<span>${escapeHtml(label)}</span>`;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function appendErrorBanner(message) {
    if (!streamContainer) return;
    const banner = document.createElement("div");
    banner.className = "chat-error-banner";
    banner.setAttribute("role", "alert");
    banner.textContent = message;
    streamContainer.appendChild(banner);
    scrollToBottom();
  }

  function scrollToBottom() {
    if (scrollBody) {
      scrollBody.scrollTop = scrollBody.scrollHeight;
    }
  }

  function buildSystemPrompt(snapshot) {
    const budget = getAiContextBudget();
    const parts = [
      "Sos el asistente de programación integrado en Studio IDE (estilo Antigravity).",
      "Respondé en español claro, directo y técnico. Cuando propongas código, encerralo siempre en bloques Markdown con su lenguaje (por ejemplo ```python, ```cpp, ```rust, ```go, ```html, ```css, ```js, ```sql, ```markdown) para que el usuario pueda inyectarlo directamente en el editor con un toque desde su iPad. Al proponer cambios multi-archivo o crear nuevos archivos, identificá cada bloque indicando la ruta (por ejemplo ```css:styles.css o ```html:index.html o con un comentario inicial // file: src/app.js) para que Studio IDE pueda aplicarlos en lote automáticamente."
    ];

    if (snapshot.activeFile) {
      const safeActiveContent = truncateCodeContent(snapshot.activeFile.content, budget);
      parts.push(
        `\n--- ARCHIVO ACTIVO EN EL EDITOR: ${snapshot.activeFile.name} (${snapshot.activeFile.lang}) ---\n\`\`\`${snapshot.activeFile.lang}\n${safeActiveContent}\n\`\`\``
      );
    }

    if (snapshot.selection && snapshot.selection.text) {
      const safeSelection = truncateCodeContent(snapshot.selection.text, 10000);
      parts.push(
        `\n--- FRAGMENTO SELECCIONADO POR EL USUARIO (${snapshot.selection.lineCount} líneas) ---\n\`\`\`\n${safeSelection}\n\`\`\``
      );
    }

    const attachedFiles = snapshot.otherOpenFiles.filter((f) => attachedTabIds.has(f.id));
    for (const extra of attachedFiles) {
      const safeExtraContent = truncateCodeContent(extra.content, 6000);
      parts.push(
        `\n--- PESTAÑA ADJUNTA DE REFERENCIA: ${extra.name} (${extra.lang}) ---\n\`\`\`${extra.lang}\n${safeExtraContent}\n\`\`\``
      );
    }

    const thinkingSpeed = getAiThinkingSpeed();
    if (thinkingSpeed === "baja") {
      parts.push("\n--- PREFERENCIA DE PENSAMIENTO: RÁPIDO ---\nRespondé de forma directa, concisa y rápida, enfocándote en entregar el código necesario sin explicaciones teóricas extensas.");
    } else if (thinkingSpeed === "alta") {
      parts.push("\n--- PREFERENCIA DE PENSAMIENTO: PROFUNDO ---\nAnalizá exhaustivamente todos los casos límite, arquitectura, seguridad y rendimiento antes de proponer la solución óptima.");
    }

    return parts.join("\n");
  }

  function syncReplaceButtonsState() {
    if (!streamContainer) return;
    const hasSel = Boolean(getContextSnapshot().selection?.lineCount > 0);
    const buttons = streamContainer.querySelectorAll('button[data-action="replace-selection"]');
    for (const btn of buttons) {
      if (btn instanceof HTMLButtonElement) {
        btn.disabled = false;
        btn.title = hasSel
          ? "Reemplazar las líneas seleccionadas"
          : "Reemplazar todo el archivo (sin selección activa)";
      }
    }
  }

  return {
    notifyWorkspaceChanged() {
      renderExtraTabChips();
      syncReplaceButtonsState();
      updateTokenEstimate();
    },
    notifySelectionChanged() {
      syncReplaceButtonsState();
      updateTokenEstimate();
    },
    setConversation(nextHistory, key = null) {
      conversationKey = key;
      const live = activeStreams.get(key);
      if (live && !live.discarded) {
        // Volvemos a un proyecto cuya respuesta sigue llegando: mostrar la conversación en vivo.
        conversation = live.convo;
        renderConversation();
        setStreamingUiState(true);
        scrollToBottom();
        return;
      }
      setStreamingUiState(false);
      conversation = Array.isArray(nextHistory)
        ? nextHistory
            .filter(
              (item) =>
                item &&
                (item.role === "user" || item.role === "assistant") &&
                typeof item.content === "string"
            )
            .map((item) => ({ role: item.role, content: item.content }))
        : [];
      renderConversation();
      scrollToBottom();
    },
    switchProvider(providerId) {
      if (AI_PROVIDERS[providerId]) {
        activeProviderId = providerId;
        saveProviderId(activeProviderId);
        activeModelId = getSavedModel(activeProviderId);
        if (providerSelect) providerSelect.value = activeProviderId;
        syncSettingsForm();
        toggleSettings(true);
        if (!getApiKey(activeProviderId) && apiKeyInput) {
          apiKeyInput.focus();
        }
      }
    },
    syncThinkingSpeed(speed) {
      syncThinkingSpeedUi(speed);
    }
  };
}

/**
 * Limpia anotaciones de interrupción o errores de transporte del historial antes de enviarlo a la API de IA.
 * @param {Array<{ role: string, content: string }>} rawConvo
 * @returns {Array<{ role: string, content: string }>}
 */
export function cleanHistoryForAi(rawConvo) {
  if (!Array.isArray(rawConvo)) return [];
  return rawConvo
    .map((m) => {
      let content = String(m?.content || "");
      content = content
        .replace(/\n\n\*\((?:Generación detenida|Respuesta interrumpida:[^)]*)\)\*/g, "")
        .trim();
      return { role: m.role, content };
    })
    .filter((m) => Boolean(m.content));
}

/**
 * Trunca contenido de código extenso de forma equilibrada (conservando cabecera y pie)
 * para no desbordar el presupuesto de tokens de modelos gratuitos (TPM).
 * @param {string} content
 * @param {number} [maxChars]
 * @returns {string}
 */
export function truncateCodeContent(content, maxChars = 16000) {
  if (typeof content !== "string" || content.length <= maxChars) {
    return typeof content === "string" ? content : "";
  }
  const headTarget = Math.floor(maxChars * 0.6);
  const tailTarget = maxChars - headTarget;

  const headEnd = content.lastIndexOf("\n", headTarget);
  const headSlice = headEnd > 0 ? content.slice(0, headEnd) : content.slice(0, headTarget);

  const tailStartOffset = content.length - tailTarget;
  const tailStart = content.indexOf("\n", tailStartOffset);
  const tailSlice = tailStart > 0 ? content.slice(tailStart + 1) : content.slice(tailStartOffset);

  const middleText = content.slice(headSlice.length, content.length - tailSlice.length);
  const omittedLines = Math.max(1, middleText.split("\n").length);

  return `${headSlice}\n\n// ... [${omittedLines} líneas omitidas por límite de contexto de la API gratuita] ...\n\n${tailSlice}`;
}

export function detectFilePathFromCodeSegment(rawHeader, code, precedingProse = "") {
  if (rawHeader) {
    if (rawHeader.includes(":")) {
      const parts = rawHeader.split(":");
      if (parts[1] && parts[1].trim()) {
        const candidate = parts[1].trim().split(/\s+/)[0];
        if (candidate.includes(".")) return candidate;
      }
    }
    const fileParamMatch = rawHeader.match(/(?:file|filepath|path)=["']?([^"'\s]+)["']?/i);
    if (fileParamMatch) return fileParamMatch[1];
    const headerParts = rawHeader.split(/\s+/);
    if (headerParts.length > 1 && headerParts[1].includes(".")) {
      return headerParts[1];
    }
  }

  const firstLine = (code || "").trim().split(/\r?\n/)[0] || "";
  const commentMatch = firstLine.match(/^(?:\/\/|#|\/\*|<!--)\s*(?:file(?:path)?|archivo):\s*([^\s*>-]+)/i);
  if (commentMatch) {
    return commentMatch[1];
  }

  if (precedingProse) {
    const lines = precedingProse.trim().split(/\r?\n/);
    const lastProseLine = lines[lines.length - 1] || "";
    const proseMatch = lastProseLine.match(/(?:archivo|file|filepath):\s*[`*_]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`*_]?/i);
    if (proseMatch) {
      return proseMatch[1];
    }
  }

  return null;
}

export function parseMarkdownSegments(raw) {
  const segments = [];
  const fenceRegex = /```([^\r\n]*)\r?\n?([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let match;

  while ((match = fenceRegex.exec(raw)) !== null) {
    let lastProseContent = "";
    if (match.index > lastIndex) {
      const prose = raw.slice(lastIndex, match.index).trim();
      if (prose) {
        lastProseContent = prose;
        segments.push({ type: "prose", content: prose });
      }
    } else if (segments.length > 0 && segments[segments.length - 1].type === "prose") {
      lastProseContent = segments[segments.length - 1].content;
    }

    const rawHeader = (match[1] || "").trim();
    let lang = (rawHeader.split(/\s+/)[0] || "").toLowerCase();
    if (lang.includes(":")) {
      lang = lang.split(":")[0];
    }
    const code = (match[2] || "").replace(/\n$/, "");
    const filePath = detectFilePathFromCodeSegment(rawHeader, code, lastProseContent);

    const segment = {
      type: "code",
      lang,
      code
    };
    if (filePath) {
      segment.filePath = filePath;
    }
    segments.push(segment);
    lastIndex = fenceRegex.lastIndex;
    if (!raw.slice(match.index).includes("```", 3)) {
      break;
    }
  }

  if (lastIndex < raw.length) {
    const tail = raw.slice(lastIndex).trim();
    if (tail) {
      segments.push({ type: "prose", content: tail });
    }
  }

  return segments;
}

export function formatProseHtml(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let paragraphLines = [];
  let listType = null;
  let listItems = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      out.push(`<p>${paragraphLines.map(formatInlineMarkdown).join("<br>")}</p>`);
      paragraphLines = [];
    }
  };

  const flushList = () => {
    if (listType && listItems.length > 0) {
      out.push(`<${listType}>${listItems.join("")}</${listType}>`);
      listType = null;
      listItems = [];
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const hrMatch = trimmed.match(/^(-{3,}|\*{3,}|_{3,})$/);
    if (hrMatch) {
      flushParagraph();
      flushList();
      out.push('<hr class="chat-md-hr">');
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      out.push(`<h3 class="chat-md-heading">${formatInlineMarkdown(headingMatch[2])}</h3>`);
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      out.push(`<blockquote class="chat-md-quote">${formatInlineMarkdown(quoteMatch[1])}</blockquote>`);
      continue;
    }

    const ulMatch = rawLine.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) {
      flushParagraph();
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listItems.push(`<li>${formatInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = rawLine.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      flushParagraph();
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listItems.push(`<li>${formatInlineMarkdown(olMatch[1])}</li>`);
      continue;
    }

    flushList();
    paragraphLines.push(rawLine);
  }

  flushParagraph();
  flushList();
  return out.join("");
}

/**
 * Estima la cantidad de tokens según la cantidad de caracteres (regla estándar de ~4 caracteres por token).
 * @param {number} charCount
 * @returns {number}
 */
export function estimateTokens(charCount) {
  const count = Math.max(0, Number(charCount) || 0);
  return Math.ceil(count / 4);
}

export function formatInlineMarkdown(str) {
  const codeTokens = [];
  const withPlaceholders = String(str).replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code class="chat-inline-code">${escapeHtml(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  let safe = escapeHtml(withPlaceholders);
  safe = safe.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="chat-link">$1</a>'
  );
  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  safe = safe.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeTokens[Number(idx)] || "");
  return safe;
}

async function copyToClipboardSafe(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Respaldo con textarea temporal
    }
  }
  try {
    const temp = document.createElement("textarea");
    temp.value = text;
    temp.setAttribute("readonly", "");
    temp.style.position = "fixed";
    temp.style.opacity = "0";
    temp.style.pointerEvents = "none";
    document.body.appendChild(temp);
    temp.select();
    const ok = document.execCommand("copy");
    temp.remove();
    return Boolean(ok);
  } catch {
    return false;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
