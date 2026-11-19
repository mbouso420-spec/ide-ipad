import { icon } from "../ui/icons.js";
import { escapeHtml } from "../utils/dom.js";
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
  getProviderModels,
  getSavedModel,
  getSavedProviderId,
  importKeysBundle,
  isAbortError,
  saveApiKey,
  saveModel,
  saveProviderId,
  setKeyStorageMode,
  streamAiCompletion,
  syncCredentialsBackup,
  validateApiKey
} from "./providers.js";
import {
  AuthLockoutError,
  checkAuthLockout,
  computeTokenFingerprint,
  formatRemainingCooldown,
  formatSafeErrorMessage,
  maskCredentialPreview,
  redactSensitiveTokens,
  validateCredentialFormat
} from "../security/credentialGuard.js";
import { broadcastWorkspaceChange } from "../storage/workspaceDb.js";
import { MAX_STORED_CHAT_TURNS } from "../storage/db/dbCore.js";
import {
  cleanHistoryForAi,
  truncateCodeContent,
  detectFilePathFromCodeSegment,
  parseMarkdownSegments,
  parseMarkdownSegmentsIncremental,
  formatProseHtml,
  estimateTokens,
  formatInlineMarkdown,
  copyToClipboardSafe
} from "./markdownRenderer.js";
import { MAX_AI_ATTACHMENTS, createMentionPopover } from "./mentionPopover.js";

export {
  cleanHistoryForAi,
  truncateCodeContent,
  detectFilePathFromCodeSegment,
  parseMarkdownSegments,
  formatProseHtml,
  estimateTokens,
  formatInlineMarkdown,
  MAX_AI_ATTACHMENTS
};

/**
 * Controlador del Asistente IA estilo Antigravity (depurado 100% para APIs gratuitas):
 * - Google Gemini Gratis, Groq Gratis, OpenRouter (:free) y Mistral/Codestral Gratis
 * - Contexto multi-archivo mediante pestañas abiertas y menciones `@archivo` (hasta 8 adjuntos)
 */
export function initChatController({
  getContextSnapshot,
  onResolveFileContent,
  onInsertAtCursor,
  onReplaceSelection,
  onApplyWholeFile,
  onApplyToFile,
  onApplyMultiFile,
  onConversationChange,
  onKeysImported,
  initialPanelVisible
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
  let attachmentLimitNotice = "";
  let attachmentNoticeTimer = 0;

  const activeStreams = new Map();
  let conversationKey = null;

  const keyChecks = new Map();
  let keyCheckTimer = 0;
  let keyCheckController = null;
  let liveModelsController = null;
  let destroyed = false;
  const chatPanelEl = document.getElementById("panel-assistant") || null;
  let panelVisible = (() => {
    if (typeof initialPanelVisible === "boolean") return initialPanelVisible;
    if (chatPanelEl && chatPanelEl.hidden) return false;
    const bodyDataset = document.body?.dataset;
    if (bodyDataset) {
      if (bodyDataset.zenMode === "true") return false;
      if (bodyDataset.rightOpen === "false") return false;
    }
    return true;
  })();
  let deferredKeyValidation = false;
  let autoScrollPinned = true;
  let lastHasSelection = null;
  const listenerAbort = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = listenerAbort ? { signal: listenerAbort.signal } : undefined;
  const passiveListenOpts = listenerAbort ? { signal: listenerAbort.signal, passive: true } : { passive: true };
  const streamDomState = new WeakMap();

  scrollBody?.addEventListener?.(
    "scroll",
    () => {
      if (!scrollBody) return;
      const gap = (scrollBody.scrollHeight || 0) - (scrollBody.scrollTop || 0) - (scrollBody.clientHeight || 0);
      autoScrollPinned = gap <= 48;
    },
    passiveListenOpts
  );

  function clearImportKeysSlot() {
    if (!importKeysSlot) return;
    importKeysSlot.querySelectorAll?.("input")?.forEach((inp) => {
      inp.value = "";
    });
    importKeysSlot.hidden = true;
    importKeysSlot.innerHTML = "";
  }

  /** @type {Set<string>} */
  const attachedTabIds = new Set();
  /** @type {Set<string>} */
  const mentionedFileIds = new Set();

  /** @type {Array<{ role: "user" | "assistant", content: string }>} */
  let conversation = [];

  function getTotalAttachedCount() {
    const unique = new Set([...attachedTabIds, ...mentionedFileIds]);
    return unique.size;
  }

  function showAttachmentNotice(message = `Máximo ${MAX_AI_ATTACHMENTS} archivos adjuntos`) {
    attachmentLimitNotice = message;
    renderExtraTabChips();
    window.clearTimeout(attachmentNoticeTimer);
    attachmentNoticeTimer = window.setTimeout(() => {
      attachmentNoticeTimer = 0;
      attachmentLimitNotice = "";
      if (!destroyed) renderExtraTabChips();
    }, 2600);
  }

  function tryAttachFileId(fileId, targetSet) {
    const hasAlready = attachedTabIds.has(fileId) || mentionedFileIds.has(fileId);
    if (!hasAlready && getTotalAttachedCount() >= MAX_AI_ATTACHMENTS) {
      showAttachmentNotice();
      return false;
    }
    targetSet.add(fileId);
    return true;
  }

  function syncKeyVisibilityButton(visible) {
    if (!toggleKeyVisBtn) return;
    toggleKeyVisBtn.innerHTML = icon(visible ? "eyeOff" : "eye");
    toggleKeyVisBtn.setAttribute("aria-pressed", String(Boolean(visible)));
    toggleKeyVisBtn.setAttribute("aria-label", visible ? "Ocultar clave" : "Mostrar clave");
  }

  function syncApiKeyMaskPlaceholder(providerId) {
    keyVisible = false;
    syncKeyVisibilityButton(false);
    if (!apiKeyInput) return;
    const provider = AI_PROVIDERS[providerId] ?? AI_PROVIDERS.gemini;
    const savedKey = getApiKey(provider.id);
    apiKeyInput.value = "";
    apiKeyInput.type = "password";
    apiKeyInput.placeholder = savedKey
      ? `Guardada (${maskCredentialPreview(savedKey)}) — pegá otra para cambiar`
      : provider.keyPlaceholder;
  }

  populateProviderOptions();
  syncSettingsForm();
  renderConversation();
  if (panelVisible) {
    scheduleKeyValidation(activeProviderId, 0, false);
  } else {
    deferredKeyValidation = true;
  }

  const mentionPopover = createMentionPopover({
    promptInput,
    composerForm,
    getProjectFiles: () => getContextSnapshot()?.projectFiles || [],
    getActiveFileId: () => getContextSnapshot()?.activeFile?.id || null,
    async onSelectFile(file) {
      if (!file || !file.id) return;
      if (tryAttachFileId(file.id, mentionedFileIds)) {
        if (file.contentLoaded === false && typeof onResolveFileContent === "function") {
          try {
            const resolved = await onResolveFileContent(file.id);
            const latest = getContextSnapshot()?.projectFiles?.find((f) => f.id === file.id);
            if (!resolved || latest?.contentLoaded === false) {
              mentionedFileIds.delete(file.id);
              showAttachmentNotice(`No se pudo cargar ${file.path || file.id} desde GitHub.`);
            }
          } catch {
            mentionedFileIds.delete(file.id);
            showAttachmentNotice(`No se pudo cargar ${file.path || file.id} desde GitHub.`);
          }
        }
        if (!destroyed) {
          renderExtraTabChips();
          updateTokenEstimate();
        }
      }
    },
    listenOpts
  });

  function scheduleKeyValidation(providerId, delayMs, announce) {
    window.clearTimeout(keyCheckTimer);
    keyCheckTimer = 0;
    keyCheckController?.abort();
    keyCheckController = null;
    if (destroyed) return;

    const lockState = checkAuthLockout(`ai:${providerId}`);
    const key = getApiKey(providerId);
    const keyFp = key ? computeTokenFingerprint(`ai:${providerId}`, key) : "";
    if (lockState.locked) {
      keyChecks.set(providerId, {
        fingerprint: keyFp,
        status: "locked",
        message: `Bloqueo temporal activo (${formatRemainingCooldown(lockState.remainingMs)}) por intentos fallidos.`
      });
      updateModelStrip();
      return;
    }

    if (!key) {
      keyChecks.delete(providerId);
      updateModelStrip();
      if (providerId === "openrouter" && panelVisible) {
        void syncLiveModelsSilently(providerId);
      }
      return;
    }

    const fmt = validateCredentialFormat(providerId, key);
    if (!fmt.valid) {
      keyChecks.set(providerId, { fingerprint: keyFp, status: "invalid", message: fmt.reason });
      updateModelStrip();
      if (providerId === activeProviderId && providerHelpEl && announce) {
        providerHelpEl.textContent = fmt.reason;
      }
      return;
    }

    const previous = keyChecks.get(providerId);
    if (!announce && previous && previous.fingerprint === keyFp && previous.status !== "checking") {
      updateModelStrip();
      return;
    }

    keyChecks.set(providerId, { fingerprint: keyFp, status: "checking", message: "" });
    updateModelStrip();

    keyCheckTimer = window.setTimeout(async () => {
      keyCheckTimer = 0;
      if (destroyed) return;
      const controller = new AbortController();
      keyCheckController = controller;
      let result;
      try {
        result = await validateApiKey(providerId, key, controller.signal);
      } catch {
        return;
      }
      if (keyCheckController === controller) {
        keyCheckController = null;
      }
      if (destroyed || getApiKey(providerId) !== key) {
        return;
      }
      keyChecks.set(providerId, { fingerprint: keyFp, ...result });
      updateModelStrip();
      if (result.status === "valid") {
        if (providerId === activeProviderId && document.activeElement !== apiKeyInput) {
          syncApiKeyMaskPlaceholder(providerId);
        }
        void syncLiveModelsSilently(providerId);
      }
      if (providerId === activeProviderId && providerHelpEl && (announce || result.status !== "valid")) {
        providerHelpEl.textContent = redactSensitiveTokens(result.message, [key]);
      }
    }, delayMs);
  }

  async function syncLiveModelsSilently(providerId) {
    if (destroyed) return;
    const provider = AI_PROVIDERS[providerId];
    if (!provider || !provider.supportsLiveModels) {
      return;
    }
    const key = getApiKey(providerId);
    if (!key && providerId !== "openrouter") {
      return;
    }
    liveModelsController?.abort();
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    liveModelsController = ctrl;
    try {
      const liveModels = await fetchLiveFreeModels(providerId, key, ctrl?.signal);
      if (destroyed) return;
      if (liveModels.length > 0 && activeProviderId === providerId) {
        const stillValid = liveModels.some((m) => m.id === activeModelId);
        if (!stillValid) {
          activeModelId = liveModels[0].id;
          saveModel(providerId, activeModelId);
        }
        syncSettingsForm();
      }
    } catch {
      // Silencioso en segundo plano
    } finally {
      if (liveModelsController === ctrl) {
        liveModelsController = null;
      }
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
    if (!settingsOpen) {
      syncApiKeyMaskPlaceholder(activeProviderId);
      clearImportKeysSlot();
    }
  }

  settingsBtn?.addEventListener("click", () => toggleSettings(), listenOpts);
  keyStatusBtn?.addEventListener("click", () => toggleSettings(), listenOpts);

  function cancelStreamRaf(stream) {
    if (!stream) return;
    if (stream.rafId && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(stream.rafId);
    }
    stream.rafId = 0;
    stream.rafPending = false;
  }

  clearChatBtn?.addEventListener("click", () => {
    const running = activeStreams.get(conversationKey);
    if (running) {
      running.discarded = true;
      cancelStreamRaf(running);
      activeStreams.delete(conversationKey);
      running.controller.abort();
    }
    currentStreamStatus = "";
    conversation = [];
    renderConversation();
    setStreamingUiState(false);
    updateTokenEstimate();
    onConversationChange?.([], conversationKey);
  }, listenOpts);

  providerSelect?.addEventListener("change", () => {
    liveModelsController?.abort();
    liveModelsController = null;
    activeProviderId = providerSelect.value;
    saveProviderId(activeProviderId);
    activeModelId = getSavedModel(activeProviderId);
    syncSettingsForm();
    scheduleKeyValidation(activeProviderId, 0, false);
  }, listenOpts);

  modelSelect?.addEventListener("change", () => {
    activeModelId = modelSelect.value;
    if (customModelInput) {
      customModelInput.value = activeModelId;
    }
    saveModel(activeProviderId, activeModelId);
    updateModelStrip();
  }, listenOpts);

  customModelInput?.addEventListener("input", () => {
    const val = customModelInput.value.trim();
    if (val) {
      activeModelId = val;
      saveModel(activeProviderId, activeModelId);
      if (modelSelect) {
        const hasOpt = Array.from(modelSelect.options || []).some((o) => o.value === val);
        if (!hasOpt) {
          const customOpt = document.createElement("option");
          customOpt.value = val;
          customOpt.textContent = `${val} (Personalizado)`;
          modelSelect.appendChild(customOpt);
        }
        modelSelect.value = val;
      }
      updateModelStrip();
    }
  }, listenOpts);

  apiKeyInput?.addEventListener("input", () => {
    const rawVal = apiKeyInput.value;
    if (!rawVal.trim()) {
      return;
    }
    saveApiKey(activeProviderId, rawVal);
    syncCredentialsBackup();
    scheduleKeyValidation(activeProviderId, 700, true);
  }, listenOpts);

  apiKeyInput?.addEventListener("blur", (event) => {
    if (event?.relatedTarget === toggleKeyVisBtn) {
      return;
    }
    keyVisible = false;
    apiKeyInput.type = "password";
    syncKeyVisibilityButton(false);
    if (getApiKey(activeProviderId)) {
      syncApiKeyMaskPlaceholder(activeProviderId);
    }
  }, listenOpts);

  toggleKeyVisBtn?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
  }, listenOpts);

  toggleKeyVisBtn?.addEventListener("click", () => {
    keyVisible = !keyVisible;
    if (apiKeyInput) {
      apiKeyInput.type = keyVisible ? "text" : "password";
    }
    syncKeyVisibilityButton(keyVisible);
  }, listenOpts);

  clearKeyBtn?.addEventListener("click", () => {
    clearApiKey(activeProviderId);
    syncCredentialsBackup();
    syncApiKeyMaskPlaceholder(activeProviderId);
    scheduleKeyValidation(activeProviderId, 0, false);
  }, listenOpts);

  modeLocalBtn?.addEventListener("click", () => {
    setKeyStorageMode("local");
    syncStorageModeButtons();
    syncCredentialsBackup();
    broadcastWorkspaceChange({ type: "KEY_STORAGE_MODE_CHANGED", mode: "local" });
  }, listenOpts);

  modeSessionBtn?.addEventListener("click", () => {
    setKeyStorageMode("session");
    syncStorageModeButtons();
    syncCredentialsBackup();
    broadcastWorkspaceChange({ type: "KEY_STORAGE_MODE_CHANGED", mode: "session" });
  }, listenOpts);

  exportKeysBtn?.addEventListener("click", async () => {
    const bundle = exportKeysBundle();
    const ok = await copyToClipboardSafe(bundle);
    if (providerHelpEl) {
      providerHelpEl.textContent = ok
        ? "Pack de claves copiado al portapapeles. Podés mandártelo al iPad y tocar Importar pack."
        : "No se pudo acceder al portapapeles automáticamente.";
    }
  }, listenOpts);

  importKeysBtn?.addEventListener("click", () => {
    if (!importKeysSlot) return;
    if (!importKeysSlot.hidden) {
      clearImportKeysSlot();
      return;
    }
    importKeysSlot.hidden = false;
    importKeysSlot.innerHTML = "";

    const form = document.createElement("form");
    form.className = "inline-edit-form";

    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    input.spellcheck = false;
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
      input.value = "";
      clearImportKeysSlot();
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
  }, listenOpts);

  fetchModelsBtn?.addEventListener("click", async () => {
    const provider = AI_PROVIDERS[activeProviderId];
    if (!provider) return;
    const targetProviderId = provider.id;
    const targetKey = getApiKey(targetProviderId);

    fetchModelsBtn.disabled = true;
    liveModelsController?.abort();
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    liveModelsController = ctrl;
    try {
      const liveModels = await fetchLiveFreeModels(targetProviderId, targetKey, ctrl?.signal);
      if (destroyed || activeProviderId !== targetProviderId) return;
      if (liveModels.length > 0) {
        activeModelId = liveModels[0].id;
        saveModel(targetProviderId, activeModelId);
        syncSettingsForm();
        if (providerHelpEl) {
          providerHelpEl.textContent = `Lista actualizada (${liveModels.length} modelos gratuitos disponibles).`;
        }
      }
    } catch (error) {
      if (!destroyed && !isAbortError(error) && providerHelpEl && activeProviderId === targetProviderId) {
        providerHelpEl.textContent = formatSafeErrorMessage(error, [targetKey], "Error al actualizar modelos.");
      }
    } finally {
      if (liveModelsController === ctrl) {
        liveModelsController = null;
      }
      fetchModelsBtn.disabled = false;
    }
  }, listenOpts);

  function collectAttachedFiles(snapshot) {
    const seen = new Set();
    const result = [];
    const activeId = snapshot?.activeFile?.id || null;

    const addFile = (f, source) => {
      if (!f || !f.id || f.id === activeId || seen.has(f.id)) return;
      if (f.isBinary || f.contentLoaded === false) return;
      seen.add(f.id);
      result.push({ file: f, source });
    };

    for (const f of snapshot?.otherOpenFiles || []) {
      if (attachedTabIds.has(f.id)) {
        addFile(f, "tab");
      }
    }
    const allProjectFiles = snapshot?.projectFiles || snapshot?.otherOpenFiles || [];
    for (const f of allProjectFiles) {
      if (mentionedFileIds.has(f.id)) {
        addFile(f, "mention");
      }
    }
    return result.slice(0, MAX_AI_ATTACHMENTS);
  }

  function updateTokenEstimate(providedSnapshot = null) {
    if (!tokenCounterEl) return;
    const promptLen = promptInput ? promptInput.value.length : 0;
    const snapshot = providedSnapshot || (getContextSnapshot ? getContextSnapshot() : null);
    let contextLen = 0;
    if (snapshot?.activeFile) {
      if (snapshot.selection && snapshot.selection.text) {
        contextLen += snapshot.selection.text.length;
      } else {
        contextLen += (snapshot.activeFile.content || "").length;
      }
    }
    for (const item of collectAttachedFiles(snapshot)) {
      contextLen += Math.min(6000, (item.file.content || "").length);
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

  promptInput?.addEventListener("input", updateTokenEstimate, listenOpts);

  const toggleToolsBtn = document.getElementById("btn-toggle-composer-tools");
  const toolsDrawer = document.getElementById("chat-tools-drawer");

  toggleToolsBtn?.addEventListener("click", () => {
    if (!toolsDrawer) return;
    const willShow = toolsDrawer.hidden;
    toolsDrawer.hidden = !willShow;
    toggleToolsBtn.setAttribute("aria-expanded", String(willShow));
    toggleToolsBtn.classList.toggle("is-active", willShow);
  }, listenOpts);

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
    }, listenOpts);
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
      }
    }, listenOpts);
  });

  function preflightAuthCheck() {
    const lockState = checkAuthLockout(`ai:${activeProviderId}`);
    if (lockState.locked) {
      appendErrorBanner(
        `Bloqueo temporal activo para ${AI_PROVIDERS[activeProviderId].name} por múltiples intentos fallidos. Esperá ${formatRemainingCooldown(lockState.remainingMs)}.`
      );
      return null;
    }

    const apiKey = getApiKey(activeProviderId);
    if (!apiKey) {
      toggleSettings(true);
      apiKeyInput?.focus();
      appendErrorBanner(
        `Falta la API Key gratuita para ${AI_PROVIDERS[activeProviderId].name}. Pegala arriba (queda guardada en este navegador).`
      );
      return null;
    }

    const fmt = validateCredentialFormat(activeProviderId, apiKey);
    if (!fmt.valid) {
      toggleSettings(true);
      apiKeyInput?.focus();
      appendErrorBanner(fmt.reason);
      return null;
    }

    return apiKey;
  }

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

    const apiKey = preflightAuthCheck();
    if (!apiKey) return;

    const userText = conversation[lastUserIdx].content;
    conversation.splice(lastUserIdx);
    await sendPrompt(userText, apiKey);
  }, listenOpts);

  promptInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !mentionPopover.isOpen()) {
      event.preventDefault();
      composerForm?.requestSubmit();
    }
  }, listenOpts);

  composerForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    mentionPopover.close();

    const running = activeStreams.get(conversationKey);
    if (running) {
      cancelStreamRaf(running);
      running.controller.abort();
      return;
    }

    const userText = (promptInput?.value || "").trim();
    if (!userText) {
      return;
    }

    const apiKey = preflightAuthCheck();
    if (!apiKey) {
      return;
    }

    if (promptInput) {
      promptInput.value = "";
    }
    autoScrollPinned = true;

    await sendPrompt(userText, apiKey);
  }, listenOpts);

  async function resolveExplicitMentionsInPrompt(userText, snapshot, signal = null) {
    const mentionedRefs = userText.match(/@([^\s@"'`]+)/g);
    if (!mentionedRefs || mentionedRefs.length === 0) return [];
    const allProjectFiles = snapshot?.projectFiles || snapshot?.otherOpenFiles || [];
    const byPath = new Map(allProjectFiles.map((f) => [f.path.toLowerCase(), f]));
    const failedPaths = [];

    for (const ref of mentionedRefs) {
      if (signal?.aborted || destroyed) break;
      const targetPath = ref.slice(1).trim().toLowerCase();
      const matched = byPath.get(targetPath);
      if (!matched || matched.isBinary) continue;
      if (!tryAttachFileId(matched.id, mentionedFileIds)) continue;
      if (matched.contentLoaded === false) {
        let ok = false;
        if (typeof onResolveFileContent === "function") {
          try {
            const resolved = await onResolveFileContent(matched.id);
            const fresh = getContextSnapshot()?.projectFiles?.find((f) => f.id === matched.id);
            ok = Boolean(resolved) && fresh?.contentLoaded !== false;
          } catch {
            ok = false;
          }
        }
        if (!ok) {
          mentionedFileIds.delete(matched.id);
          failedPaths.push(matched.path || matched.id);
        }
      }
    }
    if (failedPaths.length > 0 && !destroyed) {
      showAttachmentNotice(`No se pudo cargar ${failedPaths[0]} desde GitHub.`);
      updateTokenEstimate();
    }
    return failedPaths;
  }

  function appendConversationTurnToDom(userText, assistantIndex) {
    if (!streamContainer) return false;
    if (streamContainer.children.length === 0 || streamContainer.querySelector?.(".chat-empty-welcome")) {
      return false;
    }
    const capsule = document.createElement("div");
    capsule.className = "chat-user-capsule";
    capsule.textContent = userText;
    const aiNode = document.createElement("div");
    aiNode.className = "chat-ai-response";
    aiNode.dataset.assistantIndex = String(assistantIndex);
    populateAssistantNode(aiNode, "", true);
    streamContainer.append(capsule, aiNode);
    syncRegenerateButton();
    updateTokenEstimate();
    return true;
  }

  async function sendPrompt(userText, apiKey) {
    if (destroyed) return;
    const key = conversationKey;
    const convo = conversation;
    if (activeStreams.has(key)) return;
    const streamProviderId = activeProviderId;
    const streamModelId = activeModelId;
    convo.push({ role: "user", content: userText });
    const assistantEntry = { role: "assistant", content: "" };
    convo.push(assistantEntry);

    const stream = {
      controller: new AbortController(),
      convo,
      discarded: false,
      rafId: 0,
      rafPending: false,
      flushNow: null
    };
    activeStreams.set(key, stream);
    const isVisible = () => !destroyed && conversationKey === key && conversation === convo;

    autoScrollPinned = true;
    if (!appendConversationTurnToDom(userText, convo.length - 1)) {
      renderConversation();
    }
    scrollToBottom(true);

    currentStreamStatus = "";
    setStreamingUiState(true);

    let streamSettled = false;
    const cancelQueuedRender = () => {
      streamSettled = true;
      cancelStreamRaf(stream);
    };
    const scheduleRender = () => {
      if (destroyed || streamSettled || stream.rafPending || !isVisible()) return;
      if (typeof document !== "undefined" && document.hidden) return;
      stream.rafPending = true;
      const rafId = window.requestAnimationFrame(() => {
        stream.rafId = 0;
        stream.rafPending = false;
        if (destroyed || streamSettled || !isVisible()) return;
        updateLastAssistantMessage(assistantEntry.content, true);
        scrollToBottom();
      });
      if (stream.rafPending) {
        stream.rafId = rafId;
      }
    };
    stream.flushNow = () => {
      if (destroyed || streamSettled || !isVisible()) return;
      scheduleRender();
    };

    try {
      let snapshot = getContextSnapshot();
      await resolveExplicitMentionsInPrompt(userText, snapshot, stream.controller.signal);
      if (stream.controller.signal.aborted || stream.discarded || destroyed) {
        const abortErr = new Error("AbortError");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      if (isVisible()) {
        snapshot = getContextSnapshot();
      }
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

      const messagesForAi = cleanHistoryForAi(convo.slice(0, -2));
      messagesForAi.push({ role: "user", content: promptToSend });

      await streamAiCompletion({
        providerId: streamProviderId,
        model: streamModelId,
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
          if (streamSettled || !isVisible()) return;
          const safeNotice = redactSensitiveTokens(noticeText, [apiKey]);
          currentStreamStatus = safeNotice;
          if (providerHelpEl && activeProviderId === streamProviderId) {
            providerHelpEl.textContent = safeNotice;
          }
          scheduleRender();
        },
        onChunk(delta) {
          if (streamSettled) return;
          if (isVisible()) {
            currentStreamStatus = "";
          }
          assistantEntry.content += delta;
          scheduleRender();
        }
      });

      cancelQueuedRender();
      if (isVisible()) {
        updateLastAssistantMessage(assistantEntry.content || "Sin contenido devuelto por el modelo.", false);
      }
    } catch (error) {
      cancelQueuedRender();
      if (isAbortError(error)) {
        if (!stream.discarded) {
          assistantEntry.content += "\n\n*(Generación detenida)*";
          if (isVisible()) {
            updateLastAssistantMessage(assistantEntry.content, false);
          }
        }
      } else {
        const rawMessage =
          error instanceof Error ? error.message : "Error de red al conectar con el proveedor gratuito.";
        const message = redactSensitiveTokens(rawMessage, [apiKey]);
        if (error instanceof AuthLockoutError || error?.httpStatus === 401 || error?.httpStatus === 403) {
          const lockNow = checkAuthLockout(`ai:${streamProviderId}`);
          keyChecks.set(streamProviderId, {
            fingerprint: computeTokenFingerprint(`ai:${streamProviderId}`, apiKey),
            status: lockNow.locked ? "locked" : "invalid",
            message
          });
          if (isVisible()) {
            updateModelStrip();
          }
        }
        if (assistantEntry.content.trim()) {
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
      let pruned = false;
      if (!stream.discarded && convo.length > MAX_STORED_CHAT_TURNS) {
        convo.splice(0, convo.length - MAX_STORED_CHAT_TURNS);
        pruned = true;
      }
      if (isVisible()) {
        currentStreamStatus = "";
        setStreamingUiState(false);
        if (pruned) {
          renderConversation();
        } else {
          updateTokenEstimate();
        }
        scrollToBottom();
      }
      if (!stream.discarded && !destroyed) {
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
      const models = getProviderModels(provider.id);
      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      }
      const existsInPreset = models.some((m) => m.id === activeModelId);
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
      syncApiKeyMaskPlaceholder(provider.id);
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
    const lock = checkAuthLockout(`ai:${provider.id}`);

    if (currentModelLabel) {
      const displayName = PROVIDER_SHORT_NAMES[provider.id] || provider.name;
      currentModelLabel.textContent = `${displayName}: ${activeModelId}`;
    }

    if (keyStatusBtn) {
      const check = keyChecks.get(provider.id);
      const keyFp = key ? computeTokenFingerprint(`ai:${provider.id}`, key) : "";
      const current = check && check.fingerprint === keyFp ? check : null;
      let label = "Falta clave";
      let state = "missing";
      if (lock.locked) {
        label = `Bloqueada (${formatRemainingCooldown(lock.remainingMs)})`;
        state = "invalid";
      } else if (key) {
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
      keyStatusBtn.title = redactSensitiveTokens(current?.message || "Abrir configuración de API Key", [key]);
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

  function renderExtraTabChips(providedSnapshot = null) {
    if (!extraTabsBar) return;
    const snapshot = providedSnapshot || getContextSnapshot();
    const otherOpenFiles = snapshot?.otherOpenFiles || [];
    const allProjectFiles = snapshot?.projectFiles || otherOpenFiles;

    const validOpenIds = new Set(otherOpenFiles.map((f) => f.id));
    for (const id of [...attachedTabIds]) {
      if (!validOpenIds.has(id)) {
        attachedTabIds.delete(id);
      }
    }
    const projectMap = new Map(
      allProjectFiles
        .filter((f) => f && !f.isBinary && f.contentLoaded !== false)
        .map((f) => [f.id, f])
    );
    const activeId = snapshot?.activeFile?.id || null;
    for (const id of [...mentionedFileIds]) {
      if (!projectMap.has(id) || id === activeId) {
        mentionedFileIds.delete(id);
      }
    }

    const extraMentioned = [...mentionedFileIds]
      .filter((id) => !validOpenIds.has(id))
      .map((id) => projectMap.get(id))
      .filter(Boolean);

    if (otherOpenFiles.length === 0 && extraMentioned.length === 0 && !attachmentLimitNotice) {
      extraTabsBar.hidden = true;
      return;
    }

    extraTabsBar.hidden = false;
    const totalCount = getTotalAttachedCount();
    const countLabel = totalCount > 0 ? ` (${totalCount}/${MAX_AI_ATTACHMENTS})` : "";
    extraTabsBar.innerHTML = `<span class="chat-extra-label">Adjuntar${countLabel}:</span>`;

    for (const file of otherOpenFiles) {
      const attached = attachedTabIds.has(file.id) || mentionedFileIds.has(file.id);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "context-chip";
      chip.setAttribute("aria-pressed", String(attached));
      chip.innerHTML = `${icon(attached ? "check" : "plus")}<span>${escapeHtml(file.shortName || file.name)}</span>`;
      chip.addEventListener("click", () => {
        if (attached) {
          attachedTabIds.delete(file.id);
          mentionedFileIds.delete(file.id);
        } else {
          tryAttachFileId(file.id, attachedTabIds);
        }
        renderExtraTabChips();
        updateTokenEstimate();
      });
      extraTabsBar.appendChild(chip);
    }

    for (const file of extraMentioned) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "context-chip is-mention";
      chip.setAttribute("aria-pressed", "true");
      chip.title = `Quitar @${file.path}`;
      chip.innerHTML = `${icon("check")}<span>@${escapeHtml(file.shortName || file.path)}</span>`;
      chip.addEventListener("click", () => {
        mentionedFileIds.delete(file.id);
        renderExtraTabChips();
        updateTokenEstimate();
      });
      extraTabsBar.appendChild(chip);
    }

    if (attachmentLimitNotice) {
      const warn = document.createElement("span");
      warn.className = "chat-extra-limit-warn";
      warn.textContent = attachmentLimitNotice;
      extraTabsBar.appendChild(warn);
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
        <p>Configurado exclusivamente con proveedores y modelos gratuitos. Leo automáticamente el archivo abierto y podés sumar hasta ${MAX_AI_ATTACHMENTS} archivos con <code>@archivo</code>.</p>
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
    if (lastNode && (typeof HTMLElement === "undefined" || lastNode instanceof HTMLElement)) {
      populateAssistantNode(lastNode, markdownText, isStreaming);
    }
  }

  function buildMultiFilePlanElement(multiFiles) {
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
    btnApplyAll.innerHTML = `${icon("gitCompare")}<span>Revisar y aplicar cambios</span>`;
    btnApplyAll.addEventListener("click", async () => {
      btnApplyAll.disabled = true;
      btnApplyAll.innerHTML = `${icon("refreshCw")}<span>Revisando lote…</span>`;
      if (typeof onApplyMultiFile === "function") {
        try {
          const applied = await onApplyMultiFile(multiFiles.map((m) => ({ path: m.filePath, code: m.code, lang: m.lang })));
          if (applied === false) {
            btnApplyAll.disabled = false;
            btnApplyAll.innerHTML = `${icon("x")}<span>Sin cambios aplicados</span>`;
            window.setTimeout(() => {
              if (!btnApplyAll.isConnected) return;
              btnApplyAll.innerHTML = `${icon("gitCompare")}<span>Revisar y aplicar cambios</span>`;
            }, 1500);
          } else {
            const countLabel = typeof applied === "number" ? applied : multiFiles.length;
            btnApplyAll.innerHTML = `${icon("check")}<span>¡${countLabel} archivo(s) aplicados!</span>`;
            window.setTimeout(() => {
              if (!btnApplyAll.isConnected) return;
              btnApplyAll.disabled = false;
              btnApplyAll.innerHTML = `${icon("gitCompare")}<span>Revisar y aplicar cambios</span>`;
            }, 2500);
          }
        } catch {
          btnApplyAll.disabled = false;
          btnApplyAll.innerHTML = `${icon("x")}<span>Error al aplicar</span>`;
          window.setTimeout(() => {
            if (!btnApplyAll.isConnected) return;
            btnApplyAll.innerHTML = `${icon("gitCompare")}<span>Revisar y aplicar cambios</span>`;
          }, 1500);
        }
      } else {
        btnApplyAll.disabled = false;
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
    return planEl;
  }

  function appendSegmentNodes(targetParent, seg, contextHint, insertBeforeNode = null) {
    if (seg.type === "prose") {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = formatProseHtml(seg.content);
      while (wrapper.firstChild) {
        targetParent.insertBefore(wrapper.firstChild, insertBeforeNode);
      }
      return;
    }
    const block = buildCodeBlockElement(seg.lang, seg.code, seg.filePath, contextHint);
    targetParent.insertBefore(block, insertBeforeNode);
  }

  function appendClosedSegmentsRange(container, state, segments, targetCount) {
    for (let i = 0; i < targetCount; i += 1) {
      const seg = segments[i];
      if (seg.type === "prose") {
        state.lastProseContent += (state.lastProseContent ? "\n" : "") + (seg.content || "");
        appendSegmentNodes(container, seg, null, state.tailHost);
      } else {
        const contextHint = {
          precedingProse: state.lastProseContent,
          previousCodeBlock: state.previousCodeBlock
        };
        appendSegmentNodes(container, seg, contextHint, state.tailHost);
        state.previousCodeBlock = seg.code || "";
        state.lastProseContent = "";
        if (seg.filePath) {
          state.closedFileSegments.push(seg);
        }
      }
      state.closedCount += 1;
    }
  }

  function populateAssistantNode(container, markdownText, isStreaming) {
    let state = streamDomState.get(container);
    const hasValidState =
      Boolean(state) &&
      state.tailHost.parentNode === container &&
      markdownText.length >= state.closedOffset &&
      (state.closedOffset === 0 ||
        markdownText.slice(Math.max(0, state.closedOffset - 32), state.closedOffset) === state.closedAnchor);

    if (!hasValidState) {
      streamDomState.delete(container);
      state = null;
    }

    if (isStreaming) {
      const parsed = parseMarkdownSegmentsIncremental(
        markdownText,
        state ? state.closedOffset : 0,
        state ? state.lastProseContent : ""
      );
      const tailSegs = parsed.segments;
      const tailOffsets = parsed.segmentOffsets;

      if ((!state || state.closedCount === 0) && tailSegs.length === 0) {
        streamDomState.delete(container);
        container.innerHTML = "";
        const waiting = document.createElement("p");
        waiting.className = "chat-streaming-note";
        waiting.textContent = currentStreamStatus || "Generando respuesta…";
        container.appendChild(waiting);
        return;
      }

      if (!state) {
        container.innerHTML = "";
        const tailHost = document.createElement("div");
        tailHost.className = "chat-streaming-tail";
        const indicator = document.createElement("span");
        indicator.className = "chat-streaming-note";
        indicator.textContent = "Escribiendo…";
        container.append(tailHost, indicator);
        state = {
          closedCount: 0,
          closedOffset: 0,
          closedAnchor: "",
          closedFileSegments: [],
          lastProseContent: "",
          previousCodeBlock: "",
          tailHost,
          indicator,
          lastTailKey: "",
          lastCodeText: ""
        };
        streamDomState.set(container, state);
      }

      const localClosedCount = Math.max(0, tailSegs.length - 1);
      if (localClosedCount > 0) {
        appendClosedSegmentsRange(container, state, tailSegs, localClosedCount);
        if (tailOffsets.length > localClosedCount) {
          state.closedOffset = tailOffsets[localClosedCount];
          state.closedAnchor = markdownText.slice(Math.max(0, state.closedOffset - 32), state.closedOffset);
        }
        state.lastTailKey = "";
        state.lastCodeText = "";
      }

      const activeSeg = tailSegs[tailSegs.length - 1];
      if (activeSeg) {
        if (activeSeg.type === "code") {
          const tailKey = `code:${state.closedCount}:${activeSeg.lang || ""}:${activeSeg.filePath || ""}`;
          const existingCodeEl =
            state.lastTailKey === tailKey ? state.tailHost.querySelector(".chat-code-pre code") : null;
          if (existingCodeEl) {
            if (
              state.lastCodeText &&
              activeSeg.code.startsWith(state.lastCodeText) &&
              existingCodeEl.firstChild &&
              typeof existingCodeEl.firstChild.appendData === "function"
            ) {
              const delta = activeSeg.code.slice(state.lastCodeText.length);
              if (delta) {
                existingCodeEl.firstChild.appendData(delta);
              }
            } else {
              existingCodeEl.textContent = activeSeg.code;
            }
            state.lastCodeText = activeSeg.code;
          } else {
            state.tailHost.innerHTML = "";
            const contextHint = {
              precedingProse: state.lastProseContent,
              previousCodeBlock: state.previousCodeBlock
            };
            appendSegmentNodes(state.tailHost, activeSeg, contextHint, null);
            state.lastTailKey = tailKey;
            state.lastCodeText = activeSeg.code;
          }
        } else {
          // Promocionar párrafos de prosa ya completados (delimitados por \n\n) para evitar re-parseo O(N²) en respuestas largas
          const rawTail = markdownText.slice(state.closedOffset);
          const paraSplitIdx = tailSegs.length === 1 ? rawTail.lastIndexOf("\n\n") : -1;
          if (paraSplitIdx > 0) {
            const stableText = rawTail.slice(0, paraSplitIdx).trim();
            if (stableText) {
              appendClosedSegmentsRange(container, state, [{ type: "prose", content: stableText }], 1);
            }
            state.closedOffset += paraSplitIdx + 2;
            state.closedAnchor = markdownText.slice(Math.max(0, state.closedOffset - 32), state.closedOffset);
            const remProse = rawTail.slice(paraSplitIdx + 2).trim();
            state.tailHost.innerHTML = "";
            state.lastTailKey = `prose:${state.closedCount}`;
            state.lastCodeText = "";
            if (remProse) {
              appendSegmentNodes(state.tailHost, { type: "prose", content: remProse }, null, null);
            }
          } else {
            state.tailHost.innerHTML = "";
            state.lastTailKey = `prose:${state.closedCount}`;
            state.lastCodeText = "";
            appendSegmentNodes(state.tailHost, activeSeg, null, null);
          }
        }
      }
      return;
    }

    if (state) {
      const parsed = parseMarkdownSegmentsIncremental(
        markdownText,
        state.closedOffset,
        state.lastProseContent
      );
      appendClosedSegmentsRange(container, state, parsed.segments, parsed.segments.length);
      state.tailHost.remove();
      state.indicator.remove();
      streamDomState.delete(container);

      if (state.closedFileSegments.length >= 2) {
        container.insertBefore(buildMultiFilePlanElement(state.closedFileSegments), container.firstChild);
      }
      return;
    }

    const segments = parseMarkdownSegments(markdownText);
    streamDomState.delete(container);
    container.innerHTML = "";

    const multiFiles = segments.filter((s) => s.type === "code" && s.filePath);
    if (multiFiles.length >= 2) {
      container.appendChild(buildMultiFilePlanElement(multiFiles));
    }

    let lastProseContent = "";
    let previousCodeBlock = "";
    for (const seg of segments) {
      if (seg.type === "prose") {
        lastProseContent += (lastProseContent ? "\n" : "") + (seg.content || "");
        appendSegmentNodes(container, seg, null, null);
      } else {
        const contextHint = {
          precedingProse: lastProseContent,
          previousCodeBlock
        };
        appendSegmentNodes(container, seg, contextHint, null);
        previousCodeBlock = seg.code || "";
        lastProseContent = "";
      }
    }
  }

  function buildCodeBlockElement(lang, code, filePath = null, contextHint = null) {
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

    const pre = document.createElement("pre");
    pre.className = "chat-code-pre code-font";
    const codeEl = document.createElement("code");
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    const getLiveCode = () => codeEl.textContent || "";

    const actions = document.createElement("div");
    actions.className = "chat-code-actions-wrap";

    const btnInsert = createCodeActionButton("arrowDownLeft", "En cursor", "Insertar en la posición del cursor", async () => {
      btnInsert.disabled = true;
      let inserted = false;
      try {
        inserted = (await onInsertAtCursor(getLiveCode(), lang)) !== false;
      } catch {
        inserted = false;
      } finally {
        btnInsert.disabled = false;
      }
      btnInsert.innerHTML = inserted
        ? `${icon("check")}<span>Insertado</span>`
        : `${icon("x")}<span>Sin archivo abierto</span>`;
      window.setTimeout(() => {
        if (!btnInsert.isConnected) return;
        btnInsert.innerHTML = `${icon("arrowDownLeft")}<span>En cursor</span>`;
      }, inserted ? 1300 : 2200);
    });

    const hasSelNow = Boolean(getContextSnapshot().selection?.lineCount > 0);
    const btnReplace = createCodeActionButton(
      "replace",
      "Reemplazar código",
      hasSelNow
        ? "Reemplazar las líneas seleccionadas"
        : "Reemplazar línea o bloque correspondiente en el editor",
      async () => {
        if (typeof onReplaceSelection !== "function") return;
        btnReplace.disabled = true;
        let applied = false;
        try {
          applied = (await onReplaceSelection(getLiveCode(), contextHint)) !== false;
        } catch {
          applied = false;
        } finally {
          btnReplace.disabled = false;
        }
        btnReplace.innerHTML = applied
          ? `${icon("check")}<span>Reemplazado</span>`
          : `${icon("x")}<span>No aplicado</span>`;
        window.setTimeout(() => {
          if (!btnReplace.isConnected) return;
          btnReplace.innerHTML = `${icon("replace")}<span>Reemplazar código</span>`;
        }, applied ? 1300 : 2000);
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
          const applied = await onApplyToFile(filePath, getLiveCode(), lang);
          btnApplyAction.innerHTML =
            applied === false
              ? `${icon("x")}<span>Cancelado</span>`
              : `${icon("check")}<span>Guardado</span>`;
        } catch {
          btnApplyAction.innerHTML = `${icon("x")}<span>Error</span>`;
        }
        window.setTimeout(() => {
          if (!btnApplyAction.isConnected) return;
          btnApplyAction.disabled = false;
          btnApplyAction.innerHTML = `${icon("fileCheck")}<span>Aplicar a ${escapeHtml(baseName)}</span>`;
        }, 1500);
      });
    } else {
      btnApplyAction = createCodeActionButton("fileCheck", "Aplicar cambios", "Revisar diferencias y aplicar al archivo (reversible con Deshacer)", () => {
        onApplyWholeFile(getLiveCode(), lang, contextHint);
      });
    }

    const btnCopy = createCodeActionButton("copy", "Copiar", "Copiar bloque al portapapeles", async () => {
      const copied = await copyToClipboardSafe(getLiveCode());
      btnCopy.innerHTML = copied
        ? `${icon("check")}<span>Copiado</span>`
        : `${icon("x")}<span>Sin acceso</span>`;
      window.setTimeout(() => {
        if (!btnCopy.isConnected) return;
        btnCopy.innerHTML = `${icon("copy")}<span>Copiar</span>`;
      }, 1400);
    });

    actions.append(btnInsert, btnReplace, btnApplyAction, btnCopy);
    header.append(infoWrap, actions);

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
    scrollToBottom(true);
  }

  function scrollToBottom(force = false) {
    if (scrollBody && (force || autoScrollPinned)) {
      scrollBody.scrollTop = scrollBody.scrollHeight;
    }
  }

  function getSafeBacktickFence(content) {
    const matches = String(content || "").match(/`+/g);
    let maxRun = 2;
    if (matches) {
      for (const run of matches) {
        if (run.length > maxRun) {
          maxRun = run.length;
        }
      }
    }
    return "`".repeat(maxRun + 1);
  }

  function sanitizePromptLabel(value) {
    return String(value || "").replace(/[\r\n`]+/g, " ").trim();
  }

  function buildSystemPrompt(snapshot) {
    const budget = getAiContextBudget();
    const parts = [
      "Sos el asistente de programación integrado en Studio IDE (estilo Antigravity).",
      "Respondé en español claro, directo y técnico. Cuando propongas código, encerralo siempre en bloques Markdown con su lenguaje (por ejemplo ```python, ```cpp, ```rust, ```go, ```html, ```css, ```js, ```sql, ```markdown) para que el usuario pueda inyectarlo directamente en el editor con un toque desde su iPad. Al proponer cambios multi-archivo o crear nuevos archivos, identificá cada bloque indicando la ruta (por ejemplo ```css:styles.css o ```html:index.html o con un comentario inicial // file: src/app.js) para que Studio IDE pueda aplicarlos en lote automáticamente."
    ];

    if (snapshot.activeFile) {
      const safeActiveContent = truncateCodeContent(snapshot.activeFile.content, budget);
      const cursorLine = snapshot.selection?.cursorLine || 1;
      const activeFence = getSafeBacktickFence(safeActiveContent);
      const activeLang = sanitizePromptLabel(snapshot.activeFile.lang);
      const activeName = sanitizePromptLabel(snapshot.activeFile.name);
      parts.push(
        `\n--- ARCHIVO ACTIVO EN EL EDITOR: ${activeName} (${activeLang}, cursor en línea ${cursorLine}) ---\n${activeFence}${activeLang}\n${safeActiveContent}\n${activeFence}`
      );
    }

    if (snapshot.selection && snapshot.selection.text) {
      const safeSelection = truncateCodeContent(snapshot.selection.text, 10000);
      const selFence = getSafeBacktickFence(safeSelection);
      parts.push(
        `\n--- FRAGMENTO SELECCIONADO POR EL USUARIO (${snapshot.selection.lineCount} líneas) ---\n${selFence}\n${safeSelection}\n${selFence}`
      );
    }

    for (const { file: extra, source } of collectAttachedFiles(snapshot)) {
      const safeExtraContent = truncateCodeContent(extra.content, 6000);
      const extraFence = getSafeBacktickFence(safeExtraContent);
      const extraLang = sanitizePromptLabel(extra.lang);
      const extraName = sanitizePromptLabel(extra.path || extra.name);
      const label = source === "mention" ? "ARCHIVO MENCIONADO (@archivo)" : "PESTAÑA ADJUNTA DE REFERENCIA";
      parts.push(
        `\n--- ${label}: ${extraName} (${extraLang}) ---\n${extraFence}${extraLang}\n${safeExtraContent}\n${extraFence}`
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

  function syncReplaceButtonsState(providedSnapshot = null) {
    if (!streamContainer) return;
    const snapshot = providedSnapshot || getContextSnapshot();
    const hasSel = Boolean(snapshot?.selection?.lineCount > 0);
    if (lastHasSelection === hasSel) return;
    lastHasSelection = hasSel;
    const buttons = streamContainer.querySelectorAll('button[data-action="replace-selection"]');
    for (const btn of buttons) {
      if (btn instanceof HTMLButtonElement) {
        btn.disabled = false;
        btn.title = hasSel
          ? "Reemplazar las líneas seleccionadas"
          : "Reemplazar línea o bloque correspondiente en el editor";
      }
    }
  }

  function abortProjectStream(projectId) {
    const running = activeStreams.get(projectId);
    if (!running) return;
    running.discarded = true;
    cancelStreamRaf(running);
    activeStreams.delete(projectId);
    running.controller.abort();
    if (conversationKey === projectId && !destroyed) {
      currentStreamStatus = "";
      setStreamingUiState(false);
    }
  }

  function setPanelVisible(visible) {
    const next = Boolean(visible);
    if (panelVisible === next) return;
    panelVisible = next;
    if (!panelVisible) {
      mentionPopover.close();
      syncApiKeyMaskPlaceholder(activeProviderId);
      clearImportKeysSlot();
      window.clearTimeout(keyCheckTimer);
      keyCheckTimer = 0;
      keyCheckController?.abort();
      keyCheckController = null;
      return;
    }
    if (destroyed) return;
    const snapshot = getContextSnapshot ? getContextSnapshot() : null;
    renderExtraTabChips(snapshot);
    updateTokenEstimate(snapshot);
    updateModelStrip();
    if (deferredKeyValidation) {
      deferredKeyValidation = false;
      scheduleKeyValidation(activeProviderId, 0, false);
    }
    activeStreams.get(conversationKey)?.flushNow?.();
  }

  document?.addEventListener?.(
    "visibilitychange",
    () => {
      if (destroyed) return;
      if (document.hidden) {
        syncApiKeyMaskPlaceholder(activeProviderId);
        clearImportKeysSlot();
        window.clearTimeout(keyCheckTimer);
        keyCheckTimer = 0;
        for (const stream of activeStreams.values()) {
          cancelStreamRaf(stream);
        }
      } else {
        activeStreams.get(conversationKey)?.flushNow?.();
      }
    },
    listenOpts
  );

  window?.addEventListener?.(
    "pagehide",
    () => {
      if (destroyed) return;
      syncApiKeyMaskPlaceholder(activeProviderId);
      clearImportKeysSlot();
      window.clearTimeout(keyCheckTimer);
      keyCheckTimer = 0;
      keyCheckController?.abort();
      keyCheckController = null;
      liveModelsController?.abort();
      liveModelsController = null;
      for (const stream of activeStreams.values()) {
        cancelStreamRaf(stream);
        stream.controller.abort();
      }
    },
    listenOpts
  );

  window?.addEventListener?.(
    "studio-credentials-updated",
    () => {
      if (destroyed) return;
      keyChecks.clear();
      syncSettingsForm();
      if (panelVisible) {
        scheduleKeyValidation(activeProviderId, 0, false);
      } else {
        deferredKeyValidation = true;
      }
      updateTokenEstimate();
    },
    listenOpts
  );

  return {
    notifyWorkspaceChanged() {
      if (destroyed) return;
      const snapshot = getContextSnapshot ? getContextSnapshot() : null;
      renderExtraTabChips(snapshot);
      syncReplaceButtonsState(snapshot);
      updateTokenEstimate(snapshot);
    },
    notifySelectionChanged() {
      if (destroyed) return;
      const snapshot = getContextSnapshot ? getContextSnapshot() : null;
      syncReplaceButtonsState(snapshot);
      updateTokenEstimate(snapshot);
    },
    setPanelVisible,
    abortProjectStream,
    setConversation(nextHistory, key = null) {
      if (destroyed) return;
      conversationKey = key;
      mentionedFileIds.clear();
      mentionPopover.close();
      lastHasSelection = null;
      autoScrollPinned = true;
      const live = activeStreams.get(key);
      if (live && !live.discarded) {
        conversation = live.convo;
        renderConversation();
        setStreamingUiState(true);
        scrollToBottom(true);
        return;
      }
      setStreamingUiState(false);
      const filteredHistory = Array.isArray(nextHistory)
        ? nextHistory
            .filter(
              (item) =>
                item &&
                (item.role === "user" || item.role === "assistant") &&
                typeof item.content === "string"
            )
            .slice(-MAX_STORED_CHAT_TURNS)
            .map((item) => ({ role: item.role, content: item.content }))
        : [];
      conversation = filteredHistory;
      renderConversation();
      scrollToBottom(true);
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
    },
    destroy() {
      destroyed = true;
      if (attachmentNoticeTimer) {
        window.clearTimeout(attachmentNoticeTimer);
        attachmentNoticeTimer = 0;
      }
      if (keyCheckTimer) {
        window.clearTimeout(keyCheckTimer);
        keyCheckTimer = 0;
      }
      keyCheckController?.abort();
      keyCheckController = null;
      liveModelsController?.abort();
      liveModelsController = null;
      for (const stream of activeStreams.values()) {
        stream.discarded = true;
        cancelStreamRaf(stream);
        stream.controller.abort();
      }
      activeStreams.clear();
      keyChecks.clear();
      if (apiKeyInput) {
        apiKeyInput.value = "";
        apiKeyInput.type = "password";
      }
      clearImportKeysSlot();
      mentionPopover.destroy();
      listenerAbort?.abort();
    }
  };
}
