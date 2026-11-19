import {
  fetchGistBackupContent,
  fetchUserGistBackups,
  getGithubToken,
  publishProjectAsNewRepository,
  saveProjectToGist
} from "./githubService.js";
import { formatSafeErrorMessage } from "../security/credentialGuard.js";
import {
  convertLocalProjectToGithub,
  createProjectFromGistBackup,
  getProjectEntries,
  saveProjectGistId
} from "../storage/workspaceDb.js";
import { slugifyName } from "../utils/encoding.js";

/**
 * Actualiza un mensaje de estado en el diálogo de GitHub (`neutral`, `ok` o `error`).
 */
export function setGithubStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove("is-error", "is-ok");
  if (kind === "error") el.classList.add("is-error");
  if (kind === "ok") el.classList.add("is-ok");
}

/**
 * Controlador de respaldo de proyectos locales en Gists privados,
 * restauración desde Gist y publicación directa como nuevo repositorio de GitHub.
 */
export function initGithubLocalBackupPanel({
  dialog,
  tokenInput,
  getActiveProject,
  onFlushPendingSaves,
  onProjectClonedOrSynced,
  onRefreshSyncPanel
}) {
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

  let gistRefreshSeq = 0;
  let gistFetchController = null;
  let isPanelActionBusy = false;
  let destroyed = false;
  const listenerController = typeof AbortController === "function" ? new AbortController() : null;
  const listenOpts = listenerController ? { signal: listenerController.signal } : undefined;

  function setActionBusy(busy) {
    isPanelActionBusy = busy;
    if (backupGistBtn) backupGistBtn.disabled = busy;
    if (confirmPublishBtn) confirmPublishBtn.disabled = busy;
    if (cancelPublishBtn) cancelPublishBtn.disabled = busy;
    if (publishRepoBtn) publishRepoBtn.disabled = busy;
    if (restoreGistBtn) restoreGistBtn.disabled = busy || !gistSelect?.value;
  }

  function hidePublishRepoBox() {
    if (publishRepoBox) publishRepoBox.hidden = true;
  }

  function setSectionVisible(visible, project = null) {
    if (localBackupSection) {
      localBackupSection.hidden = !visible;
    }
    if (visible && project) {
      void refresh(project);
    }
  }

  async function refresh(project) {
    if (!project || destroyed) return;
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
      const seq = ++gistRefreshSeq;
      if (!token) {
        gistSelect.innerHTML = '<option value="">Conectá tu token arriba para listar tus respaldos en Gists</option>';
        if (restoreGistBtn) restoreGistBtn.disabled = true;
        return;
      }

      gistSelect.innerHTML = '<option value="">Cargando respaldos en Gists…</option>';
      if (restoreGistBtn) restoreGistBtn.disabled = true;

      gistFetchController?.abort();
      gistFetchController = typeof AbortController === "function" ? new AbortController() : null;
      const fetchSignal = gistFetchController ? gistFetchController.signal : null;

      fetchUserGistBackups(token, { signal: fetchSignal })
        .then((backups) => {
          if (destroyed || seq !== gistRefreshSeq) return;
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
        .catch((err) => {
          if (destroyed || seq !== gistRefreshSeq) return;
          const msg = formatSafeErrorMessage(err, [token], "");
          const isAuth401 = err?.status === 401 || err?.credentialRejected;
          const isPermission403 =
            err?.status === 403 &&
            (msg.includes("Resource not accessible") ||
              msg.includes("permiso") ||
              msg.toLowerCase().includes("gist") ||
              msg.toLowerCase().includes("scope"));
          if (isAuth401) {
            gistSelect.innerHTML = '<option value="">Token inválido o vencido (reconectá arriba)</option>';
          } else if (isPermission403 || msg.includes("permiso para Gists")) {
            gistSelect.innerHTML =
              '<option value="">Tu token no tiene permiso para Gists (podés publicar en repositorio)</option>';
          } else {
            gistSelect.innerHTML = '<option value="">No se pudieron listar los Gists (revisá tu conexión)</option>';
          }
          if (restoreGistBtn) restoreGistBtn.disabled = true;
        });
    }
  }

  backupGistBtn?.addEventListener("click", async () => {
    if (isPanelActionBusy) return;
    const token = getGithubToken();
    if (!token) {
      setGithubStatus(localBackupStatus, "Conectá tu token de GitHub arriba primero.", "error");
      tokenInput?.focus();
      return;
    }

    const project = getActiveProject();
    if (!project) return;
    const sourceProjectId = project.id;

    setActionBusy(true);
    setGithubStatus(localBackupStatus, "Guardando copia en Gist privado de GitHub…", "neutral");

    try {
      await onFlushPendingSaves?.();
      const entries = await getProjectEntries(sourceProjectId);
      const result = await saveProjectToGist(token, {
        projectName: project.name,
        entries,
        existingGistId: project.gistId || null
      });

      const currentProj = getActiveProject();
      if (destroyed || !currentProj || currentProj.id !== sourceProjectId || currentProj.kind === "github") {
        return;
      }

      project.gistId = result.id;
      await saveProjectGistId(sourceProjectId, result.id);
      if (destroyed) return;

      setGithubStatus(
        localBackupStatus,
        `¡Proyecto respaldado con éxito en tu Gist privado! (ID: ${result.id.slice(0, 8)})`,
        "ok"
      );
      if (backupGistText) {
        backupGistText.textContent = "Actualizar Gist Privado";
      }
      void refresh(project);
    } catch (err) {
      if (destroyed) return;
      const msg = formatSafeErrorMessage(err, [token], "No se pudo guardar el Gist.");
      if (msg.includes("Resource not accessible") || msg.includes("permiso para Gists")) {
        setGithubStatus(
          localBackupStatus,
          "Tu token actual no tiene permiso de Gists. Para habilitarlo en GitHub: editá tu token y marcá 'Account permissions -> Gists: Read and write' (o creá un Token Classic con la casilla 'gist').",
          "error"
        );
      } else {
        setGithubStatus(localBackupStatus, `Error al respaldar en Gist: ${msg}`, "error");
      }
    } finally {
      if (!destroyed) setActionBusy(false);
    }
  }, listenOpts);

  publishRepoBtn?.addEventListener("click", () => {
    if (isPanelActionBusy) return;
    const token = getGithubToken();
    if (!token) {
      setGithubStatus(localBackupStatus, "Conectá tu token de GitHub arriba primero.", "error");
      tokenInput?.focus();
      return;
    }

    const project = getActiveProject();
    if (!project) return;

    if (publishRepoBox) {
      const willShow = publishRepoBox.hidden;
      publishRepoBox.hidden = !willShow;
      if (willShow && publishNameInput) {
        publishNameInput.value =
          slugifyName(project.name, { allowDots: true, collapse: false, fallback: "" }) || project.name;
        publishNameInput.focus();
        publishNameInput.select();
      }
    }
  }, listenOpts);

  cancelPublishBtn?.addEventListener("click", () => {
    hidePublishRepoBox();
  }, listenOpts);

  publishNameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmPublishBtn?.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      hidePublishRepoBox();
    }
  }, listenOpts);

  confirmPublishBtn?.addEventListener("click", async () => {
    if (isPanelActionBusy) return;
    const token = getGithubToken();
    if (!token) {
      setGithubStatus(localBackupStatus, "Conectá tu token de GitHub arriba primero.", "error");
      tokenInput?.focus();
      return;
    }

    const project = getActiveProject();
    if (!project) return;

    const rawName = (publishNameInput?.value || "").trim();
    if (!rawName) {
      publishNameInput?.focus();
      setGithubStatus(localBackupStatus, "Ingresá un nombre para el repositorio en GitHub.", "error");
      return;
    }

    const isPrivate = publishVisibilitySelect ? publishVisibilitySelect.value === "private" : true;
    const visibilityLabel = isPrivate ? "privado" : "público";

    setActionBusy(true);
    setGithubStatus(localBackupStatus, `Creando repositorio ${visibilityLabel} y subiendo archivos a GitHub…`, "neutral");

    try {
      await onFlushPendingSaves?.();
      const entries = await getProjectEntries(project.id);
      const res = await publishProjectAsNewRepository(token, {
        repoName: rawName,
        isPrivate,
        entries
      });

      const converted = await convertLocalProjectToGithub(project.id, {
        owner: res.owner,
        repo: res.repo,
        branch: res.branch,
        commitSha: res.commitSha || null,
        publishedEntries: entries
      });
      if (destroyed) return;

      hidePublishRepoBox();
      setGithubStatus(localBackupStatus, `¡Publicado con éxito como ${res.fullName} (${visibilityLabel})!`, "ok");
      await onProjectClonedOrSynced?.(converted?.id || project.id);
      await onRefreshSyncPanel?.();
    } catch (err) {
      if (destroyed) return;
      const msg = formatSafeErrorMessage(err, [token], "No se pudo crear el repositorio en GitHub.");
      if (msg.includes("Resource not accessible")) {
        setGithubStatus(
          localBackupStatus,
          "Tu token no tiene permiso para crear repositorios. Usá un Token Classic con permiso 'repo' o un Fine-Grained con 'All repositories'.",
          "error"
        );
      } else {
        setGithubStatus(localBackupStatus, `Error al publicar repositorio: ${msg}`, "error");
      }
    } finally {
      if (!destroyed) setActionBusy(false);
    }
  }, listenOpts);

  gistSelect?.addEventListener("change", () => {
    if (restoreGistBtn) {
      restoreGistBtn.disabled = isPanelActionBusy || !gistSelect.value;
    }
  }, listenOpts);

  restoreGistBtn?.addEventListener("click", async () => {
    if (isPanelActionBusy) return;
    const token = getGithubToken();
    const gistId = gistSelect?.value;
    if (!token || !gistId) return;

    setActionBusy(true);
    setGithubStatus(gistRestoreStatus, "Descargando y restaurando proyecto desde Gist…", "neutral");

    try {
      const gistData = await fetchGistBackupContent(token, gistId);
      const newProject = await createProjectFromGistBackup(gistData);
      if (destroyed) return;
      setGithubStatus(gistRestoreStatus, `¡Proyecto '${newProject.name}' restaurado con éxito!`, "ok");
      await onProjectClonedOrSynced?.(newProject.id);
      dialog?.close();
    } catch (err) {
      if (destroyed) return;
      const msg = formatSafeErrorMessage(err, [token], "No se pudo restaurar el Gist.");
      setGithubStatus(gistRestoreStatus, `Error al restaurar: ${msg}`, "error");
    } finally {
      if (!destroyed) setActionBusy(false);
    }
  }, listenOpts);

  return {
    hidePublishRepoBox,
    setSectionVisible,
    refresh,
    destroy() {
      destroyed = true;
      gistRefreshSeq += 1;
      gistFetchController?.abort();
      gistFetchController = null;
      listenerController?.abort();
    }
  };
}
