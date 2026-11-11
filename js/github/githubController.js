import { icon } from "../ui/icons.js";
import {
  clearGithubToken,
  compareRemoteCommits,
  createRepoBranch,
  downloadRepoFiles,
  fetchGistBackupContent,
  fetchGithubUser,
  fetchRepoTreeIndex,
  fetchRepositoryBranches,
  fetchSingleRepoBlob,
  fetchUserGistBackups,
  fetchUserRepositories,
  getCachedGithubUserLogin,
  getCachedUserRepositories,
  getGithubToken,
  publishProjectAsNewRepository,
  pushAtomicCommit,
  RemoteAheadError,
  saveGithubToken,
  saveProjectToGist,
  verifyGithubToken
} from "./githubService.js";
import {
  convertLocalProjectToGithub,
  createProjectFromGistBackup,
  getPendingGithubChanges,
  getProjectEntries,
  hydrateGithubProject,
  hydrateLazyGithubProject,
  makeGithubProjectId,
  markProjectSynced,
  saveCredentialsBackup,
  saveProjectState
} from "../storage/workspaceDb.js";
import { exportKeysBundle, getKeyStorageMode, hasStoredCredentials } from "../ai/providers.js";

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
  const conflictViewBtn = document.getElementById("btn-gh-conflict-view");
  const conflictForceBtn = document.getElementById("btn-gh-conflict-force");

  const localBackupSection = document.getElementById("gh-local-backup-section");
  const localProjectNameEl = document.getElementById("gh-local-project-name");
  const backupGistBtn = document.getElementById("btn-gh-backup-gist");
  const backupGistText = document.getElementById("btn-gh-backup-gist-text");
  const publishRepoBtn = document.getElementById("btn-gh-publish-repo");
  const publishRepoBox = document.getElementById("gh-publish-repo-box");
  const publishNameInput = document.getElementById("gh-publish-name-input");
  const publishVisibilitySelect = document.getElementById("gh-publish-visibility-select");
  const confirmPublishBtn = document.getElementById("btn-gh-confirm-publish");
  const cancelPublishBtn = document.getElementById("btn-gh-cancel-publish");
  const localBackupStatus = document.getElementById("gh-local-backup-status");
  const gistSelect = document.getElementById("gh-gist-select");
  const restoreGistBtn = document.getElementById("btn-gh-restore-gist");
  const gistRestoreStatus = document.getElementById("gh-gist-restore-status");

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

  let reposCache = [];
  let connectedUserLogin = getCachedGithubUserLogin();
  let isSessionConnected = false;
  let pendingPullConfirm = false;
  let pullConfirmTimer = 0;
  /** @type {"live" | "clone" | null} */
  let pendingOpenConfirmKind = null;
  let openConfirmTimer = 0;
  let activeConflict = null;

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
    if (conflictBox) conflictBox.hidden = true;
    if (conflictList) {
      conflictList.hidden = true;
      conflictList.innerHTML = "";
    }
  }

  function hidePublishRepoBox() {
    if (publishRepoBox) publishRepoBox.hidden = true;
  }

  openDialogBtn?.addEventListener("click", async () => {
    if (!dialog) return;
    resetPullConfirm();
    resetOpenConfirm();
    hideConflictBox();
    hidePublishRepoBox();
    await onFlushPendingSaves?.();
    const storedToken = getGithubToken();
    if (tokenInput) {
      tokenInput.value = storedToken;
    }
    await refreshSyncPanel();
    dialog.showModal();
    if (storedToken) {
      if (!isSessionConnected || reposCache.length === 0) {
        await connectAndLoadRepos(storedToken);
      } else {
        applyConnectedSessionUi(connectedUserLogin, reposCache);
      }
    }
  });

  closeDialogBtn?.addEventListener("click", () => {
    resetPullConfirm();
    resetOpenConfirm();
    hideConflictBox();
    hidePublishRepoBox();
    dialog?.close();
  });

  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) {
      resetPullConfirm();
      resetOpenConfirm();
      hideConflictBox();
      hidePublishRepoBox();
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
    const token = (tokenInput?.value || "").trim();
    if (!token) {
      setStatus(authMsgEl, "Pegá un Personal Access Token (PAT) de GitHub.", "error");
      return;
    }

    // Se verifica ANTES de guardar: un token inválido no debe quedar guardado.
    connectBtn.disabled = true;
    setStatus(authMsgEl, "Verificando el token con GitHub…", "neutral");
    const check = await verifyGithubToken(token);
    connectBtn.disabled = false;

    if (check.status === "invalid") {
      setStatus(authMsgEl, check.message, "error");
      return;
    }

    saveGithubToken(token);
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
      setStatus(authMsgEl, `${check.message} El token quedó guardado.`, "error");
      return;
    }
    await connectAndLoadRepos(token);
  });

  clearTokenBtn?.addEventListener("click", () => {
    clearGithubToken();
    hideTokenWarning();
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
    if (tokenInput) tokenInput.value = "";
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
    if (fullName.includes("/")) {
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

  openLiveBtn?.addEventListener("click", async () => {
    await onFlushPendingSaves?.();
    const token = getGithubToken();
    const targetFullName = (manualRepoInput?.value || repoSelect?.value || "").trim();
    const [owner, repo] = targetFullName.split("/");
    const branch = (branchSelect?.value || "main").trim();

    if (!owner || !repo) {
      setStatus(cloneStatusEl, "Elegí un repositorio o escribí usuario/repositorio.", "error");
      return;
    }

    const canProceed = await guardOverwritePendingChanges(owner, repo, branch, "live", openLiveBtn);
    if (!canProceed) return;

    openLiveBtn.disabled = true;
    setStatus(cloneStatusEl, `Cargando árbol de ${owner}/${repo} (${branch})…`, "neutral");

    try {
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
    } catch (error) {
      setStatus(cloneStatusEl, error instanceof Error ? error.message : "No se pudo abrir el repositorio.", "error");
    } finally {
      openLiveBtn.disabled = false;
    }
  });

  cloneBtn?.addEventListener("click", async () => {
    await onFlushPendingSaves?.();
    const token = getGithubToken();
    const targetFullName = (manualRepoInput?.value || repoSelect?.value || "").trim();
    const [owner, repo] = targetFullName.split("/");
    const branch = (branchSelect?.value || "main").trim();

    if (!owner || !repo) {
      setStatus(cloneStatusEl, "Elegí un repositorio o escribí usuario/repositorio.", "error");
      return;
    }

    const canProceed = await guardOverwritePendingChanges(owner, repo, branch, "clone", cloneBtn);
    if (!canProceed) return;

    cloneBtn.disabled = true;
    setStatus(cloneStatusEl, `Conectando con ${owner}/${repo} (${branch})…`, "neutral");

    try {
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
    } catch (error) {
      setStatus(cloneStatusEl, error instanceof Error ? error.message : "No se pudo descargar el repositorio.", "error");
    } finally {
      cloneBtn.disabled = false;
    }
  });

  pullBtn?.addEventListener("click", async () => {
    const project = getActiveProject();
    if (!project || project.kind !== "github" || !project.github) return;

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

    const token = getGithubToken();
    const { owner, repo, branch } = project.github;
    pullBtn.disabled = true;
    setStatus(pushStatusEl, `Actualizando ${owner}/${repo} (${branch}) desde GitHub…`, "neutral");

    try {
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
      setStatus(pushStatusEl, error instanceof Error ? error.message : "Error al actualizar.", "error");
    } finally {
      pullBtn.disabled = false;
    }
  });

  async function executePush(force = false) {
    const project = getActiveProject();
    if (!project || project.kind !== "github" || !project.github) return;

    await onFlushPendingSaves?.();

    const token = getGithubToken();
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

    const changes = await getPendingGithubChanges(project.id);
    if (changes.length === 0) {
      setStatus(pushStatusEl, "No hay cambios pendientes frente al repositorio.", "neutral");
      return;
    }

    pushBtn.disabled = true;
    if (conflictForceBtn) conflictForceBtn.disabled = true;
    setStatus(pushStatusEl, `Enviando commit con ${changes.length} archivo(s) a ${project.github.branch}…`, "neutral");

    try {
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
      if (error instanceof RemoteAheadError) {
        showConflictBox(error, project, token);
      } else if (error?.status === 401) {
        setStatus(pushStatusEl, INVALID_TOKEN_MSG, "error");
        showTokenWarning("Tu token de GitHub venció o fue revocado: no se pudo hacer push.");
      } else {
        setStatus(pushStatusEl, error instanceof Error ? error.message : "Error al publicar commit.", "error");
      }
    } finally {
      pushBtn.disabled = false;
      if (conflictForceBtn) conflictForceBtn.disabled = false;
    }
  }

  function showConflictBox(error, project, token) {
    activeConflict = {
      remoteSha: error.remoteSha,
      expectedSha: error.expectedSha,
      project,
      token
    };
    if (conflictBox) conflictBox.hidden = false;
    if (conflictMsg) {
      const baseShort = (error.expectedSha || "inicial").slice(0, 7);
      const remoteShort = (error.remoteSha || "").slice(0, 7);
      conflictMsg.textContent = `Push bloqueado: GitHub avanzó a ${remoteShort} desde tu última versión (${baseShort}). Podés ver qué cambió en remoto antes de decidir o forzar el envío con tu versión local.`;
    }
    setStatus(pushStatusEl, "Hay commits nuevos en GitHub que no tenés localmente.", "error");
  }

  commitMsgInput?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void executePush(false);
    }
  });

  pushBtn?.addEventListener("click", () => executePush(false));

  conflictForceBtn?.addEventListener("click", () => executePush(true));

  conflictViewBtn?.addEventListener("click", async () => {
    if (!activeConflict || !conflictList) return;
    conflictViewBtn.disabled = true;
    try {
      const diffFiles = await compareRemoteCommits({
        token: activeConflict.token,
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

          const viewBtn = document.createElement("button");
          viewBtn.type = "button";
          viewBtn.className = "btn btn-ghost btn-sm";
          viewBtn.innerHTML = `${icon("gitCompare")}<span>Diff</span>`;
          viewBtn.addEventListener("click", async () => {
            const allEntries = await getProjectEntries(activeConflict.project.id);
            const localFile = allEntries.find((f) => f.path === file.path);
            let remoteContent = "";
            if (file.blobSha) {
              try {
                remoteContent = await fetchSingleRepoBlob({
                  token: activeConflict.token,
                  owner: activeConflict.project.github.owner,
                  repo: activeConflict.project.github.repo,
                  blobSha: file.blobSha
                });
              } catch {
                remoteContent = "(No se pudo descargar el archivo remoto)";
              }
            }
            let localContent = "(Archivo no existe localmente)";
            if (localFile) {
              if (localFile.contentLoaded !== false && typeof localFile.content === "string") {
                localContent = localFile.content;
              } else if (localFile.blobSha) {
                try {
                  localContent = await fetchSingleRepoBlob({
                    token: activeConflict.token,
                    owner: activeConflict.project.github.owner,
                    repo: activeConflict.project.github.repo,
                    blobSha: localFile.blobSha
                  });
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
          });

          const tag = document.createElement("span");
          tag.className = `gh-change-tag ${file.status === "added" ? "is-added" : file.status === "removed" ? "is-deleted" : "is-modified"}`;
          tag.textContent = file.status;

          actionWrap.append(viewBtn, tag);
          li.append(nameSpan, actionWrap);
          conflictList.appendChild(li);
        }
      }
    } catch (err) {
      setStatus(pushStatusEl, err instanceof Error ? err.message : "No se pudo comparar con GitHub.", "error");
    } finally {
      conflictViewBtn.disabled = false;
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
      await createRepoBranch({
        token,
        owner: project.github.owner,
        repo: project.github.repo,
        branchName,
        fromSha: project.github.commitSha || project.github.baseCommitSha
      });
      project.github.branch = branchName;
      await saveProjectState(project);
      if (newBranchBox) {
        newBranchBox.hidden = true;
        if (newBranchInput) newBranchInput.value = "";
      }
      if (branchStatusEl) {
        branchStatusEl.textContent = `Rama "${branchName}" creada y activa.`;
      }
      await refreshSyncPanel();
    } catch (err) {
      if (branchStatusEl) {
        branchStatusEl.hidden = false;
        branchStatusEl.textContent = err instanceof Error ? err.message : "Error al crear la rama";
      }
    } finally {
      if (btnCreateBranch) btnCreateBranch.disabled = false;
    }
  });

  syncBranchSelect?.addEventListener("change", async () => {
    const project = getActiveProject();
    if (!project || !project.github) return;
    const chosen = syncBranchSelect.value;
    if (!chosen || chosen === project.github.branch) return;

    project.github.branch = chosen;
    await saveProjectState(project);
    await refreshSyncPanel();
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
      if (error?.status === 401) {
        isSessionConnected = false;
        setStatus(authMsgEl, INVALID_TOKEN_MSG, "error");
        showTokenWarning("Tu token de GitHub venció o fue revocado. Conectá uno nuevo para ver tus repos y hacer push.");
      } else {
        setStatus(authMsgEl, error instanceof Error ? error.message : "Token inválido o sin permisos.", "error");
      }
    } finally {
      if (connectBtn) connectBtn.disabled = false;
    }
  }

  async function loadBranchesForRepo(fullName, preferredBranch) {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo || !branchSelect) return;

    const token = getGithubToken();
    try {
      const branches = await fetchRepositoryBranches(token, owner, repo);
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
      branchSelect.innerHTML = '<option value="main">main</option><option value="master">master</option>';
    }
  }

  async function refreshLocalBackupSection(project) {
    if (!project) return;
    hidePublishRepoBox();
    if (localProjectNameEl) {
      localProjectNameEl.textContent = project.name;
    }
    if (backupGistText) {
      backupGistText.textContent = project.gistId ? "Actualizar Gist Privado" : "Respaldar en Gist Privado";
    }
    if (localBackupStatus) {
      localBackupStatus.textContent = project.gistId
        ? "Este proyecto ya tiene un Gist vinculado. Podés actualizarlo con un toque."
        : "";
      localBackupStatus.className = "gh-status-msg";
    }

    const token = getGithubToken();
    if (gistSelect) {
      if (!token) {
        gistSelect.innerHTML = '<option value="">Conectá tu token arriba para listar tus respaldos en Gists</option>';
        if (restoreGistBtn) restoreGistBtn.disabled = true;
        return;
      }

      fetchUserGistBackups(token)
        .then((backups) => {
          gistSelect.innerHTML = "";
          if (backups.length === 0) {
            gistSelect.innerHTML = '<option value="">No tenés respaldos de Studio IDE en tus Gists</option>';
            if (restoreGistBtn) restoreGistBtn.disabled = true;
            return;
          }
          const defaultOpt = document.createElement("option");
          defaultOpt.value = "";
          defaultOpt.textContent = `Elegí un proyecto para restaurar (${backups.length} disponibles)…`;
          gistSelect.appendChild(defaultOpt);

          for (const b of backups) {
            const opt = document.createElement("option");
            opt.value = b.id;
            const dateStr = b.updatedAt ? new Date(b.updatedAt).toLocaleDateString() : "";
            opt.textContent = `${b.name} ${dateStr ? `(${dateStr})` : ""}`;
            gistSelect.appendChild(opt);
          }
          if (restoreGistBtn) restoreGistBtn.disabled = true;
        })
        .catch(() => {
          gistSelect.innerHTML = '<option value="">No se pudieron listar los Gists (revisá tu conexión)</option>';
          if (restoreGistBtn) restoreGistBtn.disabled = true;
        });
    }
  }

  backupGistBtn?.addEventListener("click", async () => {
    const token = getGithubToken();
    if (!token) {
      setStatus(localBackupStatus, "Conectá tu token de GitHub arriba primero.", "error");
      tokenInput?.focus();
      return;
    }

    const project = getActiveProject();
    if (!project) return;

    backupGistBtn.disabled = true;
    setStatus(localBackupStatus, "Guardando copia en Gist privado de GitHub…", "neutral");

    try {
      await onFlushPendingSaves?.();
      const entries = await getProjectEntries(project.id);
      const result = await saveProjectToGist(token, {
        projectName: project.name,
        entries,
        existingGistId: project.gistId || null
      });

      project.gistId = result.id;
      await saveProjectState(project);

      setStatus(
        localBackupStatus,
        `¡Proyecto respaldado con éxito en tu Gist privado! (ID: ${result.id.slice(0, 8)})`,
        "ok"
      );
      if (backupGistText) {
        backupGistText.textContent = "Actualizar Gist Privado";
      }
    } catch (err) {
      const msg = err?.message || "No se pudo guardar el Gist.";
      if (msg.includes("Resource not accessible") || msg.includes("permiso para Gists")) {
        setStatus(
          localBackupStatus,
          "Tu token actual no tiene permiso de Gists. Para habilitarlo en GitHub: editá tu token y marcá 'Account permissions -> Gists: Read and write' (o creá un Token Classic con la casilla 'gist').",
          "error"
        );
      } else {
        setStatus(localBackupStatus, `Error al respaldar en Gist: ${msg}`, "error");
      }
    } finally {
      backupGistBtn.disabled = false;
    }
  });

  publishRepoBtn?.addEventListener("click", () => {
    const token = getGithubToken();
    if (!token) {
      setStatus(localBackupStatus, "Conectá tu token de GitHub arriba primero.", "error");
      tokenInput?.focus();
      return;
    }

    const project = getActiveProject();
    if (!project) return;

    if (publishRepoBox) {
      const willShow = publishRepoBox.hidden;
      publishRepoBox.hidden = !willShow;
      if (willShow) {
        if (publishNameInput) {
          publishNameInput.value =
            project.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || project.name;
          publishNameInput.focus();
          publishNameInput.select();
        }
      }
    }
  });

  cancelPublishBtn?.addEventListener("click", () => {
    hidePublishRepoBox();
  });

  publishNameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmPublishBtn?.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      hidePublishRepoBox();
    }
  });

  confirmPublishBtn?.addEventListener("click", async () => {
    const token = getGithubToken();
    if (!token) {
      setStatus(localBackupStatus, "Conectá tu token de GitHub arriba primero.", "error");
      tokenInput?.focus();
      return;
    }

    const project = getActiveProject();
    if (!project) return;

    const rawName = (publishNameInput?.value || "").trim();
    if (!rawName) {
      publishNameInput?.focus();
      setStatus(localBackupStatus, "Ingresá un nombre para el repositorio en GitHub.", "error");
      return;
    }

    const isPrivate = publishVisibilitySelect ? publishVisibilitySelect.value === "private" : true;
    const visibilityLabel = isPrivate ? "privado" : "público";

    if (confirmPublishBtn) confirmPublishBtn.disabled = true;
    if (cancelPublishBtn) cancelPublishBtn.disabled = true;
    if (publishRepoBtn) publishRepoBtn.disabled = true;
    setStatus(localBackupStatus, `Creando repositorio ${visibilityLabel} y subiendo archivos a GitHub…`, "neutral");

    try {
      await onFlushPendingSaves?.();
      const entries = await getProjectEntries(project.id);
      const res = await publishProjectAsNewRepository(token, {
        repoName: rawName,
        isPrivate,
        entries
      });

      await convertLocalProjectToGithub(project.id, {
        owner: res.owner,
        repo: res.repo,
        branch: res.branch
      });

      hidePublishRepoBox();
      setStatus(localBackupStatus, `¡Publicado con éxito como ${res.fullName} (${visibilityLabel})!`, "ok");
      await onProjectClonedOrSynced?.(project.id);
      await refreshSyncPanel();
    } catch (err) {
      const msg = err?.message || "No se pudo crear el repositorio en GitHub.";
      if (msg.includes("Resource not accessible")) {
        setStatus(
          localBackupStatus,
          "Tu token no tiene permiso para crear repositorios. Usá un Token Classic con permiso 'repo' o un Fine-Grained con 'All repositories'.",
          "error"
        );
      } else {
        setStatus(localBackupStatus, `Error al publicar repositorio: ${msg}`, "error");
      }
    } finally {
      if (confirmPublishBtn) confirmPublishBtn.disabled = false;
      if (cancelPublishBtn) cancelPublishBtn.disabled = false;
      if (publishRepoBtn) publishRepoBtn.disabled = false;
    }
  });

  gistSelect?.addEventListener("change", () => {
    if (restoreGistBtn) {
      restoreGistBtn.disabled = !gistSelect.value;
    }
  });

  restoreGistBtn?.addEventListener("click", async () => {
    const token = getGithubToken();
    const gistId = gistSelect?.value;
    if (!token || !gistId) return;

    restoreGistBtn.disabled = true;
    setStatus(gistRestoreStatus, "Descargando y restaurando proyecto desde Gist…", "neutral");

    try {
      const gistData = await fetchGistBackupContent(token, gistId);
      const newProject = await createProjectFromGistBackup(gistData);
      setStatus(gistRestoreStatus, `¡Proyecto '${newProject.name}' restaurado con éxito!`, "ok");
      await onProjectClonedOrSynced?.(newProject.id);
      dialog?.close();
    } catch (err) {
      const msg = err?.message || "No se pudo restaurar el Gist.";
      setStatus(gistRestoreStatus, `Error al restaurar: ${msg}`, "error");
    } finally {
      restoreGistBtn.disabled = false;
    }
  });

  async function refreshSyncPanel() {
    const project = getActiveProject();
    if (!project || project.kind !== "github" || !project.github) {
      if (syncSection) syncSection.hidden = true;
      if (localBackupSection) {
        localBackupSection.hidden = false;
        void refreshLocalBackupSection(project);
      }
      await refreshTopbarBadge();
      return;
    }

    if (localBackupSection) localBackupSection.hidden = true;
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
            renderFallbackBranchOption();
          });
      } else {
        renderFallbackBranchOption();
      }
    }

    const changes = await getPendingGithubChanges(project.id);
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
      return;
    }
    const count =
      typeof precomputedCount === "number"
        ? precomputedCount
        : (await getPendingGithubChanges(project.id)).length;

    topbarRepoLabel.textContent = count > 0 ? `Commit (${count})` : "Repositorio";
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
      if (error?.status === 401) {
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

function setStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove("is-error", "is-ok");
  if (kind === "error") el.classList.add("is-error");
  if (kind === "ok") el.classList.add("is-ok");
}
