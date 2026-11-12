import { icon } from "../ui/icons.js";
import {
  clearGithubToken,
  compareRemoteCommits,
  createRepoBranch,
  downloadRepoFiles,
  fetchGithubUser,
  fetchRepoTreeIndex,
  fetchRepositoryBranches,
  fetchSingleRepoBlob,
  fetchUserRepositories,
  getCachedGithubUserLogin,
  getCachedUserRepositories,
  getGithubToken,
  parseRepoFullName,
  pushAtomicCommit,
  RemoteAheadError,
  saveGithubToken,
  verifyGithubToken
} from "./githubService.js";
import {
  applyRemotePullPlan,
  countPendingGithubChanges,
  getPendingGithubChanges,
  getProjectEntries,
  hydrateGithubProject,
  hydrateLazyGithubProject,
  makeGithubProjectId,
  markProjectSynced,
  migrateGithubProjectBranch,
  saveCredentialsBackup
} from "../storage/workspaceDb.js";
import { classifyRemotePullChanges, buildRemotePullPlan } from "./githubMerge.js";
import { initGithubLocalBackupPanel, setGithubStatus as setStatus } from "./githubLocalBackupPanel.js";
import { exportKeysBundle, getKeyStorageMode, hasStoredCredentials } from "../ai/providers.js";
import {
  checkAuthLockout,
  formatRemainingCooldown,
  formatSafeErrorMessage,
  maskCredentialPreview,
  redactSensitiveTokens
} from "../security/credentialGuard.js";

/**
 * Controlador del flujo de conexión con GitHub (PAT local + Octokit),
 * apertura instantánea bajo demanda sin descargar todo, copia offline opcional para iPad,
 * previsualización de Diff por archivo y Commit + Push atómico.
 */
export function initGithubController({
  getActiveProject,
  onFlushPendingSaves,
  onProjectClonedOrSynced,
  onReposListChanged,
  onOpenDiff
}) {
  const openDialogBtn = document.getElementById("btn-open-github");
  const topbarRepoLabel = document.getElementById("topbar-repo-label");
  const dialog = document.getElementById("github-dialog");
  const closeDialogBtn = document.getElementById("btn-close-github");

  const tokenInput = document.getElementById("gh-token-input");
  const connectBtn = document.getElementById("btn-gh-connect");
  const clearTokenBtn = document.getElementById("btn-gh-clear-token");
  const userStatusEl = document.getElementById("gh-user-status");
  const authMsgEl = document.getElementById("gh-auth-msg");

  const repoSelect = document.getElementById("gh-repo-select");
  const manualRepoInput = document.getElementById("gh-manual-repo");
  const branchSelect = document.getElementById("gh-branch-select");
  const openLiveBtn = document.getElementById("btn-gh-open-live");
  const cloneBtn = document.getElementById("btn-gh-clone");
  const cloneStatusEl = document.getElementById("gh-clone-status");

  const syncSection = document.getElementById("gh-sync-section");
  const syncRepoTitle = document.getElementById("gh-sync-repo-title");
  const syncBranchSelect = document.getElementById("gh-sync-branch-select");
  const btnNewBranch = document.getElementById("btn-gh-new-branch");
  const newBranchBox = document.getElementById("gh-new-branch-box");
  const newBranchInput = document.getElementById("gh-new-branch-input");
  const btnCreateBranch = document.getElementById("btn-gh-create-branch");
  const btnCancelBranch = document.getElementById("btn-gh-cancel-branch");
  const branchStatusEl = document.getElementById("gh-branch-status");
  const pullBtn = document.getElementById("btn-gh-pull");
  const changesListEl = document.getElementById("gh-changes-list");
  const commitMsgInput = document.getElementById("gh-commit-msg");
  const pushBtn = document.getElementById("btn-gh-push");
  const pushStatusEl = document.getElementById("gh-push-status");

  const conflictBox = document.getElementById("gh-conflict-box");
  const conflictMsg = document.getElementById("gh-conflict-msg");
  const conflictList = document.getElementById("gh-conflict-list");
  const conflictMergeBtn = document.getElementById("btn-gh-conflict-merge");
  const conflictApplyBtn = document.getElementById("btn-gh-conflict-apply");
  const conflictViewBtn = document.getElementById("btn-gh-conflict-view");
  const conflictForceBtn = document.getElementById("btn-gh-conflict-force");

  const tokenWarning = document.getElementById("explorer-token-warning");
  const tokenWarningText = document.getElementById("explorer-token-warning-text");
  const tokenReconnectBtn = document.getElementById("btn-token-reconnect");

  const INVALID_TOKEN_MSG =
    "Token inválido o vencido. Revisá que lo hayas copiado completo o generá uno nuevo en GitHub.";

  function showTokenWarning(message) {
    if (tokenWarningText) tokenWarningText.textContent = message;
    if (tokenWarning) tokenWarning.hidden = false;
  }

  function hideTokenWarning() {
    if (tokenWarning) tokenWarning.hidden = true;
  }

  tokenReconnectBtn?.addEventListener("click", () => {
    openDialogBtn?.click();
    window.setTimeout(() => {
      tokenInput?.focus();
      tokenInput?.select();
    }, 50);
  });

  window?.addEventListener?.("studio-credentials-updated", () => {
    const updatedToken = getGithubToken();
    syncTokenPlaceholder(updatedToken);
    if (updatedToken) hideTokenWarning();
  });

  let reposCache = [];
  let connectedUserLogin = getCachedGithubUserLogin();
  let isSessionConnected = false;
  let pendingPullConfirm = false;
  let pullConfirmTimer = 0;
  /** @type {"live" | "clone" | null} */
  let pendingOpenConfirmKind = null;
  let openConfirmTimer = 0;
  let activeConflict = null;
  let activeMergeClassification = null;
  let isPushing = false;
  let isOpeningRepo = false;
  let isPulling = false;
  let isSwitchingBranch = false;
  let branchesRequestSeq = 0;
  let syncPanelRequestSeq = 0;

  function applyConnectedSessionUi(login, repos) {
    const cleanLogin = String(login || "").trim();
    if (userStatusEl && cleanLogin) {
      userStatusEl.textContent = `@${cleanLogin}`;
    }
    const list = Array.isArray(repos) ? repos : [];
    const repoCount = list.length;
    if (cleanLogin) {
      setStatus(
        authMsgEl,
        `Conectado como @${cleanLogin} (${repoCount} ${repoCount === 1 ? "repositorio disponible" : "repositorios disponibles"}).`,
        "ok"
      );
    }
    if (repoSelect && list.length > 0) {
      const prevSelected = repoSelect.value;
      repoSelect.innerHTML = "";
      for (const r of list) {
        const opt = document.createElement("option");
        opt.value = r.full_name;
        opt.textContent = `${r.full_name}${r.private ? " (privado)" : ""}`;
        repoSelect.appendChild(opt);
      }
      if (prevSelected && list.some((r) => r.full_name === prevSelected)) {
        repoSelect.value = prevSelected;
      }
    }
    if (list.length > 0 && manualRepoInput && !manualRepoInput.value.trim()) {
      manualRepoInput.value = list[0].full_name;
    }
  }

  function resetPullConfirm() {
    pendingPullConfirm = false;
    window.clearTimeout(pullConfirmTimer);
    if (pullBtn) {
      pullBtn.className = "btn btn-ghost btn-sm";
      pullBtn.innerHTML = `${icon("refreshCw")}<span>Actualizar remoto</span>`;
    }
  }

  function resetOpenConfirm() {
    pendingOpenConfirmKind = null;
    window.clearTimeout(openConfirmTimer);
    if (openLiveBtn) {
      openLiveBtn.className = "btn";
      openLiveBtn.innerHTML = `${icon("folderOpen")}<span>Abrir sin descargar</span>`;
    }
    if (cloneBtn) {
      cloneBtn.className = "btn";
      cloneBtn.innerHTML = `${icon("cloudDownload")}<span>Guardar copia offline</span>`;
    }
  }

  function hideConflictBox() {
    activeConflict = null;
    activeMergeClassification = null;
    if (conflictBox) conflictBox.hidden = true;
    if (conflictApplyBtn) conflictApplyBtn.hidden = true;
    if (conflictList) {
      conflictList.hidden = true;
      conflictList.innerHTML = "";
    }
  }

  const localBackupPanel = initGithubLocalBackupPanel({
    dialog,
    tokenInput,
    getActiveProject,
    onFlushPendingSaves,
    onProjectClonedOrSynced,
    onRefreshSyncPanel: () => refreshSyncPanel()
  });

  function hidePublishRepoBox() {
    localBackupPanel.hidePublishRepoBox();
  }

  let lockoutUiTimer = 0;

  function cleanupDialogTransientState() {
    if (tokenInput) tokenInput.value = "";
    window.clearTimeout(lockoutUiTimer);
    lockoutUiTimer = 0;
    resetPullConfirm();
    resetOpenConfirm();
    hideConflictBox();
    hidePublishRepoBox();
  }

  function syncTokenPlaceholder(storedToken) {
    if (!tokenInput) return;
    tokenInput.value = "";
    tokenInput.placeholder = storedToken
      ? `Token guardado (${maskCredentialPreview(storedToken)}) — pegá otro para reemplazar`
      : "github_pat_…";
  }

  function syncLockoutUi() {
    window.clearTimeout(lockoutUiTimer);
    const lock = checkAuthLockout("github");
    if (lock.locked) {
      if (connectBtn) connectBtn.disabled = true;
      setStatus(
        authMsgEl,
        `Bloqueo temporal de seguridad por múltiples intentos fallidos. Reintentá en ${formatRemainingCooldown(lock.remainingMs)}.`,
        "error"
      );
      lockoutUiTimer = window.setTimeout(syncLockoutUi, Math.min(lock.remainingMs + 50, 1000));
      return true;
    }
    if (connectBtn) connectBtn.disabled = false;
    return false;
  }

  openDialogBtn?.addEventListener("click", async () => {
    if (!dialog) return;
    resetPullConfirm();
    resetOpenConfirm();
    hideConflictBox();
    hidePublishRepoBox();
    await onFlushPendingSaves?.();
    const storedToken = getGithubToken();
    syncTokenPlaceholder(storedToken);
    await refreshSyncPanel();
    dialog.showModal();
    if (syncLockoutUi()) return;
    if (storedToken) {
      if (!isSessionConnected || reposCache.length === 0) {
        await connectAndLoadRepos(storedToken);
      } else {
        applyConnectedSessionUi(connectedUserLogin, reposCache);
      }
    }
  });

  dialog?.addEventListener("close", cleanupDialogTransientState);

  closeDialogBtn?.addEventListener("click", () => {
    cleanupDialogTransientState();
    dialog?.close();
  });

  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      cleanupDialogTransientState();
      dialog.close();
    }
  });

  tokenInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      connectBtn?.click();
    }
  });

  connectBtn?.addEventListener("click", async () => {
    if (syncLockoutUi()) return;

    const typedToken = (tokenInput?.value || "").trim();
    const token = typedToken || getGithubToken();
    if (!token) {
      setStatus(authMsgEl, "Pegá un Personal Access Token (PAT) de GitHub.", "error");
      return;
    }

    // Se verifica ANTES de guardar: un token inválido no debe quedar guardado.
    connectBtn.disabled = true;
    setStatus(authMsgEl, "Verificando el token con GitHub…", "neutral");
    const check = await verifyGithubToken(token);
    connectBtn.disabled = false;

    if (check.status === "locked") {
      if (tokenInput) tokenInput.value = "";
      syncLockoutUi();
      return;
    }

    if (check.status === "invalid") {
      setStatus(authMsgEl, redactSensitiveTokens(check.message, [token]), "error");
      syncLockoutUi();
      return;
    }

    saveGithubToken(token);
    syncTokenPlaceholder(token);
    hideTokenWarning();
    try {
      if (getKeyStorageMode() === "session" || !hasStoredCredentials()) {
        void saveCredentialsBackup("");
      } else {
        void saveCredentialsBackup(exportKeysBundle());
      }
    } catch {}

    if (check.status !== "valid") {
      // Sin internet o GitHub sin responder: se guarda para usarlo cuando vuelva la conexión.
      setStatus(authMsgEl, `${redactSensitiveTokens(check.message, [token])} El token quedó guardado.`, "error");
      return;
    }
    await connectAndLoadRepos(token);
  });

  clearTokenBtn?.addEventListener("click", () => {
    clearGithubToken();
    hideTokenWarning();
    cleanupDialogTransientState();
    try {
      if (getKeyStorageMode() === "session" || !hasStoredCredentials()) {
        void saveCredentialsBackup("");
      } else {
        void saveCredentialsBackup(exportKeysBundle());
      }
    } catch {}
    reposCache = [];
    connectedUserLogin = "";
    isSessionConnected = false;
    onReposListChanged?.([]);
    syncTokenPlaceholder("");
    if (userStatusEl) userStatusEl.textContent = "Sin sesión";
    if (repoSelect) repoSelect.innerHTML = '<option value="">Conectá tu token para listar repositorios</option>';
    setStatus(authMsgEl, "Token eliminado de este navegador.", "neutral");
  });

  repoSelect?.addEventListener("change", async () => {
    resetOpenConfirm();
    const fullName = repoSelect.value;
    if (manualRepoInput && fullName) {
      manualRepoInput.value = fullName;
    }
    if (fullName) {
      await loadBranchesForRepo(fullName);
    }
  });

  manualRepoInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      manualRepoInput.dispatchEvent(new Event("change"));
    }
  });

  manualRepoInput?.addEventListener("change", async () => {
    resetOpenConfirm();
    const fullName = manualRepoInput.value.trim();
    if (parseRepoFullName(fullName)) {
      await loadBranchesForRepo(fullName);
    }
  });

  branchSelect?.addEventListener("change", () => {
    resetOpenConfirm();
  });

  async function guardOverwritePendingChanges(owner, repo, branch, kind, triggerBtn) {
    const targetId = makeGithubProjectId(owner, repo, branch);
    const pendingChanges = await getPendingGithubChanges(targetId);
    if (pendingChanges.length > 0 && pendingOpenConfirmKind !== kind) {
      resetOpenConfirm();
      pendingOpenConfirmKind = kind;
      if (triggerBtn) {
        triggerBtn.className = "tree-confirm-delete";
        triggerBtn.textContent = "Confirmar descarte";
      }
      setStatus(
        cloneStatusEl,
        `Tenés ${pendingChanges.length} archivo(s) locales sin commitear en ${owner}/${repo} (${branch}). Tocá Confirmar descarte si querés sobrescribirlos.`,
        "error"
      );
      openConfirmTimer = window.setTimeout(() => {
        resetOpenConfirm();
      }, 4500);
      return false;
    }
    resetOpenConfirm();
    return true;
  }

  async function handleOpenOrClone(kind, triggerBtn, fallbackErrorMsg, runAction) {
    if (isOpeningRepo) return;
    const targetFullName = (manualRepoInput?.value || repoSelect?.value || "").trim();
    const parsedRepo = parseRepoFullName(targetFullName);
    const branch = (branchSelect?.value || "main").trim();

    if (!parsedRepo) {
      setStatus(cloneStatusEl, "Elegí un repositorio válido (usuario/repositorio).", "error");
      return;
    }

    // Bloquear ambos botones ANTES del primer await para impedir envíos duplicados al doble toque.
    isOpeningRepo = true;
    if (openLiveBtn) openLiveBtn.disabled = true;
    if (cloneBtn) cloneBtn.disabled = true;
    const token = getGithubToken();

    try {
      await onFlushPendingSaves?.();
      const { owner, repo } = parsedRepo;
      const canProceed = await guardOverwritePendingChanges(owner, repo, branch, kind, triggerBtn);
      if (!canProceed) return;

      await runAction({ token, owner, repo, branch });
    } catch (error) {
      setStatus(cloneStatusEl, formatSafeErrorMessage(error, [token], fallbackErrorMsg), "error");
    } finally {
      isOpeningRepo = false;
      if (openLiveBtn) openLiveBtn.disabled = false;
      if (cloneBtn) cloneBtn.disabled = false;
    }
  }

  openLiveBtn?.addEventListener("click", () => {
    void handleOpenOrClone("live", openLiveBtn, "No se pudo abrir el repositorio.", async ({ token, owner, repo, branch }) => {
      setStatus(cloneStatusEl, `Cargando árbol de ${owner}/${repo} (${branch})…`, "neutral");
      const index = await fetchRepoTreeIndex({ token, owner, repo, branch });
      const project = await hydrateLazyGithubProject({
        owner,
        repo,
        branch: index.branch || branch,
        commitSha: index.commitSha,
        entries: index.entries
      });

      if (index.isTruncated) {
        setStatus(
          cloneStatusEl,
          `Atención: Árbol truncado por GitHub (>100.000 entradas). Se indexaron ${index.entries.length} archivos, pero el listado puede estar incompleto.`,
          "error"
        );
      } else {
        setStatus(
          cloneStatusEl,
          `Árbol cargado al instante (${index.entries.length} archivos en el Explorador, sin descargar todo).`,
          "ok"
        );
      }
      await onProjectClonedOrSynced(project.id);
      await refreshSyncPanel();
      dialog?.close();
    });
  });

  cloneBtn?.addEventListener("click", () => {
    void handleOpenOrClone("clone", cloneBtn, "No se pudo descargar el repositorio.", async ({ token, owner, repo, branch }) => {
      setStatus(cloneStatusEl, `Conectando con ${owner}/${repo} (${branch})…`, "neutral");
      const { commitSha, files, isTruncated } = await downloadRepoFiles({
        token,
        owner,
        repo,
        branch,
        onProgress(done, total) {
          setStatus(cloneStatusEl, `Descargando a IndexedDB: ${done} de ${total} archivos…`, "neutral");
        }
      });

      const project = await hydrateGithubProject({
        owner,
        repo,
        branch,
        commitSha,
        files
      });

      if (isTruncated) {
        setStatus(
          cloneStatusEl,
          `Atención: Repositorio clonado parcialmente (árbol truncado por GitHub en ${files.length} archivos).`,
          "error"
        );
      } else {
        setStatus(cloneStatusEl, `Repositorio listo (${files.length} archivos guardados para editar en el iPad).`, "ok");
      }
      await onProjectClonedOrSynced(project.id);
      await refreshSyncPanel();
    });
  });

  pullBtn?.addEventListener("click", async () => {
    if (isPulling) return;
    const project = getActiveProject();
    if (!project || project.kind !== "github" || !project.github) return;

    isPulling = true;
    pullBtn.disabled = true;
    const token = getGithubToken();

    try {
      await onFlushPendingSaves?.();
      const pendingChanges = await getPendingGithubChanges(project.id);

      if (pendingChanges.length > 0 && !pendingPullConfirm) {
        pendingPullConfirm = true;
        pullBtn.className = "tree-confirm-delete";
        pullBtn.textContent = "Confirmar descarte";
        setStatus(
          pushStatusEl,
          `Tenés ${pendingChanges.length} archivo(s) locales sin subir. Tocá Confirmar descarte si querés sobrescribirlos con la versión remota.`,
          "error"
        );
        pullConfirmTimer = window.setTimeout(() => {
          resetPullConfirm();
        }, 4500);
        return;
      }

      resetPullConfirm();

      const { owner, repo, branch } = project.github;
      setStatus(pushStatusEl, `Actualizando ${owner}/${repo} (${branch}) desde GitHub…`, "neutral");

      let updated;
      let wasTruncated = false;
      if (project.offlineCached) {
        const { commitSha, files, isTruncated } = await downloadRepoFiles({ token, owner, repo, branch });
        wasTruncated = Boolean(isTruncated);
        updated = await hydrateGithubProject({ owner, repo, branch, commitSha, files });
      } else {
        const index = await fetchRepoTreeIndex({ token, owner, repo, branch });
        wasTruncated = Boolean(index.isTruncated);
        updated = await hydrateLazyGithubProject({
          owner,
          repo,
          branch: index.branch || branch,
          commitSha: index.commitSha,
          entries: index.entries
        });
      }
      await onProjectClonedOrSynced(updated.id);
      await refreshSyncPanel();
      if (wasTruncated) {
        setStatus(pushStatusEl, "Atención: Árbol remoto truncado por GitHub (>100.000 entradas). El listado puede estar incompleto.", "error");
      } else {
        setStatus(pushStatusEl, "Árbol y archivos sincronizados con la última versión remota.", "ok");
      }
    } catch (error) {
      setStatus(pushStatusEl, formatSafeErrorMessage(error, [token], "Error al actualizar."), "error");
    } finally {
      isPulling = false;
      pullBtn.disabled = false;
    }
  });

  async function executePush(force = false) {
    if (isPushing) return;
    const project = getActiveProject();
    if (!project || project.kind !== "github" || !project.github) return;

    isPushing = true;
    if (pushBtn) pushBtn.disabled = true;
    if (conflictForceBtn) conflictForceBtn.disabled = true;
    let token = "";
    let changes = [];

    try {
      await onFlushPendingSaves?.();

      token = getGithubToken();
      if (!token) {
        setStatus(pushStatusEl, "Necesitás conectar tu Personal Access Token arriba para hacer push.", "error");
        return;
      }

      const message = (commitMsgInput?.value || "").trim();
      if (!message) {
        commitMsgInput?.focus();
        setStatus(pushStatusEl, "Escribí un mensaje descriptivo para el commit.", "error");
        return;
      }

      changes = await getPendingGithubChanges(project.id);
      if (changes.length === 0) {
        setStatus(pushStatusEl, "No hay cambios pendientes frente al repositorio.", "neutral");
        return;
      }

      setStatus(pushStatusEl, `Enviando commit con ${changes.length} archivo(s) a ${project.github.branch}…`, "neutral");

      const { commitSha } = await pushAtomicCommit({
        token,
        owner: project.github.owner,
        repo: project.github.repo,
        branch: project.github.branch,
        message,
        changes,
        expectedBaseSha: project.github.commitSha || null,
        force
      });

      hideConflictBox();
      // Solo se consolida lo que viajó en este commit: lo editado mientras tanto sigue pendiente.
      await markProjectSynced(project.id, commitSha, changes);
      if (commitMsgInput) commitMsgInput.value = "";
      await onProjectClonedOrSynced(project.id);
      await refreshSyncPanel();
      setStatus(pushStatusEl, `Commit publicado con éxito (${commitSha.slice(0, 7)}).`, "ok");
    } catch (error) {
      if (error?.partialCommitSha && error?.initializedFilePath) {
        // Si un repo vacío alcanzó a crear el commit inicial antes de fallar fase 2, sincronizar ese archivo.
        try {
          const initializedChange = changes.find((c) => c.path === error.initializedFilePath);
          if (initializedChange) {
            await markProjectSynced(project.id, error.partialCommitSha, [initializedChange]);
            await onProjectClonedOrSynced(project.id);
            await refreshSyncPanel();
          }
        } catch {}
      }
      if (error instanceof RemoteAheadError) {
        showConflictBox(error, project);
      } else if (error?.status === 401 || error?.credentialRejected) {
        setStatus(pushStatusEl, INVALID_TOKEN_MSG, "error");
        showTokenWarning("Tu token de GitHub venció o fue revocado: no se pudo hacer push.");
      } else {
        setStatus(pushStatusEl, formatSafeErrorMessage(error, [token], "Error al publicar commit."), "error");
      }
    } finally {
      isPushing = false;
      if (pushBtn) pushBtn.disabled = false;
      if (conflictForceBtn) conflictForceBtn.disabled = false;
    }
  }

  function showConflictBox(error, project) {
    // Nunca almacenar el token en memoria dentro de activeConflict: leerlo dinámicamente vía getGithubToken().
    activeConflict = {
      remoteSha: error.remoteSha,
      expectedSha: error.expectedSha,
      project
    };
    activeMergeClassification = null;
    if (conflictApplyBtn) conflictApplyBtn.hidden = true;
    if (conflictBox) conflictBox.hidden = false;
    if (conflictMsg) {
      const baseShort = (error.expectedSha || "inicial").slice(0, 7);
      const remoteShort = (error.remoteSha || "").slice(0, 7);
      conflictMsg.textContent = `Push bloqueado: GitHub avanzó a ${remoteShort} desde tu última versión (${baseShort}). Podés traer e integrar cambios sin perder los tuyos, inspeccionar el Diff o forzar el envío.`;
    }
    setStatus(pushStatusEl, "Hay commits nuevos en GitHub que no tenés localmente.", "error");
  }

  function formatFetchedForDiff(fetched) {
    if (fetched && typeof fetched === "object" && fetched.isBinary) {
      return `[Archivo binario (${(fetched.base64 || "").length} caracteres Base64)]`;
    }
    return String(fetched ?? "");
  }

  async function openRemoteVsLocalDiff(file) {
    if (!activeConflict) return;
    const token = getGithubToken();
    const allEntries = await getProjectEntries(activeConflict.project.id);
    const localFile = allEntries.find((f) => f.path === file.path);
    let remoteContent = "";
    if (file.blobSha) {
      try {
        const fetched = await fetchSingleRepoBlob({
          token,
          owner: activeConflict.project.github.owner,
          repo: activeConflict.project.github.repo,
          blobSha: file.blobSha,
          path: file.path
        });
        remoteContent = formatFetchedForDiff(fetched);
      } catch {
        remoteContent = "(No se pudo descargar el archivo remoto)";
      }
    }
    let localContent = "(Archivo no existe localmente)";
    if (localFile) {
      if (localFile.isBinary) {
        localContent = `[Archivo binario local (${(localFile.base64 || "").length} caracteres Base64)]`;
      } else if (localFile.contentLoaded !== false && typeof localFile.content === "string") {
        localContent = localFile.content;
      } else if (localFile.blobSha) {
        try {
          const fetchedLocal = await fetchSingleRepoBlob({
            token,
            owner: activeConflict.project.github.owner,
            repo: activeConflict.project.github.repo,
            blobSha: localFile.blobSha,
            path: localFile.path
          });
          localContent = formatFetchedForDiff(fetchedLocal);
        } catch {
          localContent = "(No se pudo descargar el archivo local)";
        }
      }
    }
    onOpenDiff?.({
      title: `Remoto (${file.path}) vs Local`,
      oldCode: remoteContent,
      newCode: localContent
    });
  }

  function createDiffPreviewButton(file) {
    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "btn btn-ghost btn-sm";
    viewBtn.innerHTML = `${icon("gitCompare")}<span>Diff</span>`;
    viewBtn.addEventListener("click", () => void openRemoteVsLocalDiff(file));
    return viewBtn;
  }

  commitMsgInput?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (isPushing) return;
      void executePush(false);
    }
  });

  pushBtn?.addEventListener("click", () => {
    if (!isPushing) void executePush(false);
  });

  conflictForceBtn?.addEventListener("click", () => {
    if (!isPushing) void executePush(true);
  });

  conflictViewBtn?.addEventListener("click", async () => {
    if (!activeConflict || !conflictList) return;
    if (!activeConflict.expectedSha) {
      setStatus(pushStatusEl, "Sin commit base local para comparar automáticamente.", "error");
      return;
    }
    const token = getGithubToken();
    if (!token) {
      setStatus(pushStatusEl, "Conectá tu Personal Access Token arriba para comparar cambios.", "error");
      return;
    }
    if (conflictApplyBtn) conflictApplyBtn.hidden = true;
    conflictViewBtn.disabled = true;
    try {
      const diffFiles = await compareRemoteCommits({
        token,
        owner: activeConflict.project.github.owner,
        repo: activeConflict.project.github.repo,
        base: activeConflict.expectedSha,
        head: activeConflict.remoteSha
      });
      conflictList.innerHTML = "";
      conflictList.hidden = false;
      if (diffFiles.length === 0) {
        const li = document.createElement("li");
        li.className = "gh-change-item";
        li.textContent = "No se detectaron diferencias en archivos de texto.";
        conflictList.appendChild(li);
      } else {
        for (const file of diffFiles) {
          const li = document.createElement("li");
          li.className = "gh-change-item";
          const nameSpan = document.createElement("span");
          nameSpan.className = "code-font gh-change-path";
          nameSpan.textContent = file.path;

          const actionWrap = document.createElement("div");
          actionWrap.className = "gh-change-actions";

          const viewBtn = createDiffPreviewButton(file);
          const tag = document.createElement("span");
          tag.className = `gh-change-tag ${file.status === "added" ? "is-added" : file.status === "removed" ? "is-deleted" : "is-modified"}`;
          tag.textContent = file.status;

          actionWrap.append(viewBtn, tag);
          li.append(nameSpan, actionWrap);
          conflictList.appendChild(li);
        }
      }
    } catch (err) {
      setStatus(pushStatusEl, formatSafeErrorMessage(err, [token], "No se pudo comparar con GitHub."), "error");
    } finally {
      conflictViewBtn.disabled = false;
    }
  });

  conflictMergeBtn?.addEventListener("click", async () => {
    if (!activeConflict || !conflictList) return;
    if (!activeConflict.expectedSha) {
      setStatus(pushStatusEl, "No hay commit base previo; usá Actualizar remoto o Forzar igual.", "error");
      return;
    }
    const token = getGithubToken();
    if (!token) {
      setStatus(pushStatusEl, "Conectá tu Personal Access Token arriba para analizar la integración.", "error");
      return;
    }
    conflictMergeBtn.disabled = true;
    setStatus(pushStatusEl, "Analizando diferencias remotas frente a tus cambios locales…", "neutral");
    try {
      const [diffFiles, localEntries, localPendingChanges] = await Promise.all([
        compareRemoteCommits({
          token,
          owner: activeConflict.project.github.owner,
          repo: activeConflict.project.github.repo,
          base: activeConflict.expectedSha,
          head: activeConflict.remoteSha
        }),
        getProjectEntries(activeConflict.project.id),
        getPendingGithubChanges(activeConflict.project.id)
      ]);

      const classification = classifyRemotePullChanges({
        localEntries,
        localPendingChanges,
        remoteDiffFiles: diffFiles
      });
      activeMergeClassification = classification;

      conflictList.innerHTML = "";
      conflictList.hidden = false;

      const { safeUpdates, safeDeletions, conflicts } = classification;
      if (safeUpdates.length > 0 || safeDeletions.length > 0) {
        const infoLi = document.createElement("li");
        infoLi.className = "gh-change-item";
        infoLi.textContent = `Sin conflicto (se integran automático): +${safeUpdates.length} actualizado(s), -${safeDeletions.length} eliminado(s).`;
        conflictList.appendChild(infoLi);
      }

      if (conflicts.length === 0) {
        const okLi = document.createElement("li");
        okLi.className = "gh-change-item";
        okLi.textContent = "Cero archivos en conflicto: tus cambios locales se conservarán intactos.";
        conflictList.appendChild(okLi);
      } else {
        for (const conflict of conflicts) {
          const li = document.createElement("li");
          li.className = "gh-change-item";

          const nameSpan = document.createElement("span");
          nameSpan.className = "code-font gh-change-path";
          nameSpan.textContent = `${conflict.path} (${conflict.localStatus} vs ${conflict.remoteStatus})`;

          const actionWrap = document.createElement("div");
          actionWrap.className = "gh-change-actions";

          const diffBtn = createDiffPreviewButton(conflict);
          const btnLocal = document.createElement("button");
          btnLocal.type = "button";
          btnLocal.className = "gh-conflict-choice is-active";
          btnLocal.textContent = "Conservar local";
          btnLocal.setAttribute("aria-pressed", "true");

          const btnRemote = document.createElement("button");
          btnRemote.type = "button";
          btnRemote.className = "gh-conflict-choice";
          btnRemote.textContent = "Usar remoto";
          btnRemote.setAttribute("aria-pressed", "false");

          btnLocal.addEventListener("click", () => {
            conflict.resolution = "keep-local";
            btnLocal.classList.add("is-active");
            btnLocal.setAttribute("aria-pressed", "true");
            btnRemote.classList.remove("is-active");
            btnRemote.setAttribute("aria-pressed", "false");
          });
          btnRemote.addEventListener("click", () => {
            conflict.resolution = "take-remote";
            btnRemote.classList.add("is-active");
            btnRemote.setAttribute("aria-pressed", "true");
            btnLocal.classList.remove("is-active");
            btnLocal.setAttribute("aria-pressed", "false");
          });

          actionWrap.append(diffBtn, btnLocal, btnRemote);
          li.append(nameSpan, actionWrap);
          conflictList.appendChild(li);
        }
      }

      if (conflictApplyBtn) conflictApplyBtn.hidden = false;
      setStatus(
        pushStatusEl,
        conflicts.length > 0
          ? `Revisá ${conflicts.length} conflicto(s) abajo y tocá "Aplicar integración".`
          : 'Sin conflictos superpuestos. Tocá "Aplicar integración" para actualizar tu base.',
        conflicts.length > 0 ? "neutral" : "ok"
      );
    } catch (err) {
      setStatus(pushStatusEl, formatSafeErrorMessage(err, [token], "No se pudo preparar la integración."), "error");
    } finally {
      conflictMergeBtn.disabled = false;
    }
  });

  conflictApplyBtn?.addEventListener("click", async () => {
    if (!activeConflict || !activeMergeClassification) return;
    const targetToken = getGithubToken();
    if (!targetToken) {
      setStatus(pushStatusEl, "Conectá tu Personal Access Token arriba para aplicar la integración.", "error");
      return;
    }
    conflictApplyBtn.disabled = true;
    setStatus(pushStatusEl, "Aplicando integración segura en el workspace…", "neutral");
    try {
      const targetProject = activeConflict.project;
      const remoteSha = activeConflict.remoteSha;
      const localEntries = await getProjectEntries(targetProject.id);

      const plan = await buildRemotePullPlan({
        project: targetProject,
        localEntries,
        classification: activeMergeClassification,
        newCommitSha: remoteSha,
        fetchBlob: (blobSha, filePath) =>
          fetchSingleRepoBlob({
            token: targetToken,
            owner: targetProject.github.owner,
            repo: targetProject.github.repo,
            blobSha,
            path: filePath
          })
      });

      const result = await applyRemotePullPlan(targetProject.id, plan);
      hideConflictBox();
      await onProjectClonedOrSynced?.(result?.project?.id || targetProject.id);
      await refreshSyncPanel();
      setStatus(
        pushStatusEl,
        `Integración aplicada (${result.updatesCount} actualizado(s), ${result.deletionsCount} eliminado(s), ${result.keptLocalCount} conflicto(s) conservando local). Ya podés hacer Commit y Push.`,
        "ok"
      );
    } catch (err) {
      setStatus(pushStatusEl, formatSafeErrorMessage(err, [targetToken], "Error al aplicar la integración."), "error");
    } finally {
      conflictApplyBtn.disabled = false;
    }
  });

  btnNewBranch?.addEventListener("click", () => {
    if (newBranchBox) {
      newBranchBox.hidden = false;
      newBranchInput?.focus();
    }
  });

  btnCancelBranch?.addEventListener("click", () => {
    if (newBranchBox) {
      newBranchBox.hidden = true;
      if (newBranchInput) newBranchInput.value = "";
    }
    if (branchStatusEl) branchStatusEl.hidden = true;
  });

  newBranchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      btnCreateBranch?.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      btnCancelBranch?.click();
    }
  });

  btnCreateBranch?.addEventListener("click", async () => {
    const project = getActiveProject();
    if (!project || !project.github) return;
    const branchName = String(newBranchInput?.value || "").trim();
    if (!branchName) {
      if (branchStatusEl) {
        branchStatusEl.hidden = false;
        branchStatusEl.textContent = "Escribí un nombre para la nueva rama.";
      }
      return;
    }
    const token = getGithubToken();
    if (!token) {
      if (branchStatusEl) {
        branchStatusEl.hidden = false;
        branchStatusEl.textContent = "Conectá tu token de GitHub antes de crear ramas.";
      }
      return;
    }

    if (btnCreateBranch) btnCreateBranch.disabled = true;
    if (branchStatusEl) {
      branchStatusEl.hidden = false;
      branchStatusEl.textContent = `Creando rama "${branchName}" en GitHub…`;
    }

    try {
      await onFlushPendingSaves?.();
      const createdBranch = await createRepoBranch({
        token,
        owner: project.github.owner,
        repo: project.github.repo,
        branchName,
        fromSha: project.github.commitSha
      });
      const migrated = await migrateGithubProjectBranch(
        project.id,
        branchName,
        createdBranch?.commitSha || project.github.commitSha || null
      );
      if (newBranchBox) {
        newBranchBox.hidden = true;
        if (newBranchInput) newBranchInput.value = "";
      }
      await onProjectClonedOrSynced?.(migrated.id);
      if (branchStatusEl) {
        branchStatusEl.hidden = false;
        branchStatusEl.textContent = `Rama "${branchName}" creada y activa.`;
      }
      await refreshSyncPanel();
    } catch (err) {
      if (branchStatusEl) {
        branchStatusEl.hidden = false;
        branchStatusEl.textContent = formatSafeErrorMessage(err, [token], "Error al crear la rama");
      }
    } finally {
      if (btnCreateBranch) btnCreateBranch.disabled = false;
    }
  });

  syncBranchSelect?.addEventListener("change", async () => {
    if (isSwitchingBranch) return;
    const project = getActiveProject();
    if (!project || !project.github) return;
    const prevBranch = project.github.branch;
    const chosen = syncBranchSelect.value;
    if (!chosen || chosen === prevBranch) return;

    // Bloquear selector ANTES del primer await para evitar cambios concurrentes de rama.
    isSwitchingBranch = true;
    syncBranchSelect.disabled = true;
    const token = getGithubToken();

    try {
      await onFlushPendingSaves?.();
      const pendingChanges = await getPendingGithubChanges(project.id);
      if (pendingChanges.length > 0) {
        syncBranchSelect.value = prevBranch;
        setStatus(
          pushStatusEl,
          `Tenés ${pendingChanges.length} cambio(s) locales pendientes en "${prevBranch}". Hacé commit/push o creá una nueva rama (+) para no mezclar bases.`,
          "error"
        );
        return;
      }

      const { owner, repo } = project.github;
      setStatus(pushStatusEl, `Cambiando y sincronizando rama "${chosen}" desde GitHub…`, "neutral");
      const updated = project.offlineCached
        ? await (() =>
            downloadRepoFiles({ token, owner, repo, branch: chosen }).then(({ commitSha, files }) =>
              hydrateGithubProject({ owner, repo, branch: chosen, commitSha, files })
            ))()
        : await (() =>
            fetchRepoTreeIndex({ token, owner, repo, branch: chosen }).then((idx) =>
              hydrateLazyGithubProject({
                owner,
                repo,
                branch: idx.branch || chosen,
                commitSha: idx.commitSha,
                entries: idx.entries
              })
            ))();
      await onProjectClonedOrSynced?.(updated.id);
      await refreshSyncPanel();
      setStatus(pushStatusEl, `Rama activa cambiada a "${chosen}".`, "ok");
    } catch (error) {
      syncBranchSelect.value = prevBranch;
      setStatus(pushStatusEl, formatSafeErrorMessage(error, [token], "No se pudo cambiar de rama."), "error");
    } finally {
      isSwitchingBranch = false;
      syncBranchSelect.disabled = false;
    }
  });

  async function connectAndLoadRepos(token) {
    if (connectBtn) connectBtn.disabled = true;
    setStatus(authMsgEl, "Verificando cuenta y repositorios en GitHub…", "neutral");
    try {
      const [user, repos] = await Promise.all([
        fetchGithubUser(token),
        fetchUserRepositories(token)
      ]);
      reposCache = Array.isArray(repos) ? repos : [];
      connectedUserLogin = user?.login || connectedUserLogin || "";
      isSessionConnected = true;
      onReposListChanged?.(reposCache);
      applyConnectedSessionUi(connectedUserLogin, reposCache);

      if (reposCache.length > 0) {
        if (manualRepoInput) manualRepoInput.value = reposCache[0].full_name;
        await loadBranchesForRepo(reposCache[0].full_name, reposCache[0].default_branch);
      }
    } catch (error) {
      if (error?.status === 401 || error?.credentialRejected) {
        isSessionConnected = false;
        setStatus(authMsgEl, INVALID_TOKEN_MSG, "error");
        showTokenWarning("Tu token de GitHub venció o fue revocado. Conectá uno nuevo para ver tus repos y hacer push.");
      } else {
        setStatus(authMsgEl, formatSafeErrorMessage(error, [token], "Token inválido o sin permisos."), "error");
      }
    } finally {
      if (connectBtn) connectBtn.disabled = false;
    }
  }

  async function loadBranchesForRepo(fullName, preferredBranch) {
    const parsed = parseRepoFullName(fullName);
    if (!parsed || !branchSelect) return;

    const seq = ++branchesRequestSeq;
    const token = getGithubToken();
    try {
      const branches = await fetchRepositoryBranches(token, parsed.owner, parsed.repo);
      if (seq !== branchesRequestSeq) return;
      branchSelect.innerHTML = "";
      for (const b of branches) {
        const opt = document.createElement("option");
        opt.value = b.name;
        opt.textContent = b.name;
        branchSelect.appendChild(opt);
      }
      if (preferredBranch && branches.some((b) => b.name === preferredBranch)) {
        branchSelect.value = preferredBranch;
      }
    } catch {
      if (seq !== branchesRequestSeq) return;
      branchSelect.innerHTML = '<option value="main">main</option><option value="master">master</option>';
    }
  }

  async function refreshSyncPanel() {
    const seq = ++syncPanelRequestSeq;
    const project = getActiveProject();
    if (!project || project.kind !== "github" || !project.github) {
      if (syncSection) syncSection.hidden = true;
      localBackupPanel.setSectionVisible(true, project);
      await refreshTopbarBadge();
      return;
    }

    localBackupPanel.setSectionVisible(false);
    if (syncSection) syncSection.hidden = false;
    if (syncRepoTitle) {
      syncRepoTitle.textContent = `${project.github.owner}/${project.github.repo} (${project.github.branch})`;
    }

    if (syncBranchSelect) {
      const renderFallbackBranchOption = () => {
        syncBranchSelect.textContent = "";
        const opt = document.createElement("option");
        opt.value = project.github.branch || "main";
        opt.textContent = project.github.branch || "main";
        opt.selected = true;
        syncBranchSelect.appendChild(opt);
      };

      const token = getGithubToken();
      if (token && project.github.owner && project.github.repo) {
        fetchRepositoryBranches(token, project.github.owner, project.github.repo)
          .then((branches) => {
            if (seq !== syncPanelRequestSeq) return;
            if (!Array.isArray(branches) || branches.length === 0) {
              renderFallbackBranchOption();
              return;
            }
            syncBranchSelect.textContent = "";
            for (const b of branches) {
              const opt = document.createElement("option");
              opt.value = b.name;
              opt.textContent = b.name;
              if (b.name === project.github.branch) {
                opt.selected = true;
              }
              syncBranchSelect.appendChild(opt);
            }
          })
          .catch(() => {
            if (seq !== syncPanelRequestSeq) return;
            renderFallbackBranchOption();
          });
      } else {
        renderFallbackBranchOption();
      }
    }

    const changes = await getPendingGithubChanges(project.id);
    if (seq !== syncPanelRequestSeq) return;
    if (changesListEl) {
      changesListEl.innerHTML = "";
      if (changes.length === 0) {
        const emptyLi = document.createElement("li");
        emptyLi.className = "gh-change-item";
        emptyLi.textContent = "Todo al día con el último commit descargado.";
        changesListEl.appendChild(emptyLi);
      } else {
        const statusMap = {
          added: { label: "Nuevo", cls: "is-added" },
          modified: { label: "Editado", cls: "is-modified" },
          deleted: { label: "Borrado", cls: "is-deleted" }
        };
        for (const ch of changes) {
          const li = document.createElement("li");
          li.className = "gh-change-item";
          const st = statusMap[ch.status] || statusMap.modified;

          const pathSpan = document.createElement("span");
          pathSpan.className = "code-font gh-change-path";
          pathSpan.textContent = ch.path;

          const rightWrap = document.createElement("div");
          rightWrap.className = "gh-change-actions";

          const diffBtn = document.createElement("button");
          diffBtn.type = "button";
          diffBtn.className = "btn btn-ghost btn-sm";
          diffBtn.innerHTML = `${icon("gitCompare")}<span>Diff</span>`;
          diffBtn.addEventListener("click", () => {
            onOpenDiff?.({
              title: `Cambios en ${ch.path}`,
              oldCode: ch.baseContent || "",
              newCode: ch.status === "deleted" ? "" : ch.content || ""
            });
          });

          const tagSpan = document.createElement("span");
          tagSpan.className = `gh-change-tag ${st.cls}`;
          tagSpan.textContent = st.label;

          rightWrap.append(diffBtn, tagSpan);
          li.append(pathSpan, rightWrap);
          changesListEl.appendChild(li);
        }
      }
    }

    if (pushBtn) {
      pushBtn.disabled = changes.length === 0;
    }

    await refreshTopbarBadge(changes.length);
  }

  async function refreshTopbarBadge(precomputedCount) {
    if (!topbarRepoLabel) return;
    const project = getActiveProject();
    if (!project || project.kind !== "github") {
      topbarRepoLabel.textContent = "Repositorio";
      openDialogBtn?.classList.remove("has-pending-commits");
      return;
    }
    const count =
      typeof precomputedCount === "number"
        ? precomputedCount
        : await countPendingGithubChanges(project.id);

    topbarRepoLabel.textContent = count > 0 ? `Commit (${count})` : "Repositorio";
    if (count > 0) {
      openDialogBtn?.classList.add("has-pending-commits");
    } else {
      openDialogBtn?.classList.remove("has-pending-commits");
    }
  }

  async function syncExplorerReposInBackground() {
    const token = getGithubToken();
    if (!token) {
      onReposListChanged?.([]);
      return;
    }

    const cached = getCachedUserRepositories();
    if (cached.length > 0) {
      reposCache = cached;
      onReposListChanged?.(cached);
    }
    const cachedUser = getCachedGithubUserLogin();
    if (cachedUser) {
      connectedUserLogin = cachedUser;
      isSessionConnected = true;
      applyConnectedSessionUi(cachedUser, reposCache);
    }

    try {
      const [liveUser, liveRepos] = await Promise.all([
        fetchGithubUser(token),
        fetchUserRepositories(token)
      ]);
      if (liveUser?.login) {
        connectedUserLogin = liveUser.login;
        isSessionConnected = true;
      }
      if (Array.isArray(liveRepos)) {
        reposCache = liveRepos;
        onReposListChanged?.(liveRepos);
      }
      applyConnectedSessionUi(connectedUserLogin, reposCache);
      hideTokenWarning();
    } catch (error) {
      if (error?.status === 401 || error?.credentialRejected) {
        // El token guardado dejó de funcionar: avisar ahora y no recién al intentar el push.
        showTokenWarning("Tu token de GitHub venció o fue revocado. Conectá uno nuevo para ver tus repos y hacer push.");
      }
      // Sin conexión: silencioso, se mantienen los repositorios cacheados localmente
    }
  }

  return {
    refreshTopbarBadge,
    syncExplorerReposInBackground
  };
}
