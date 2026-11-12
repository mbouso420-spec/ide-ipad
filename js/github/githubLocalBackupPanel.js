import {
  fetchGistBackupContent,
  fetchUserGistBackups,
  getGithubToken,
  publishProjectAsNewRepository,
  saveProjectToGist
} from "./githubService.js";
import {
  convertLocalProjectToGithub,
  createProjectFromGistBackup,
  getProjectEntries,
  saveProjectState
} from "../storage/workspaceDb.js";

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
        .catch((err) => {
          const msg = String(err?.message || "");
          const isPermission403 =
            err?.status === 403 &&
            (msg.includes("Resource not accessible") ||
              msg.includes("permiso") ||
              msg.toLowerCase().includes("gist") ||
              msg.toLowerCase().includes("scope"));
          if (isPermission403 || msg.includes("permiso para Gists")) {
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
    const token = getGithubToken();
    if (!token) {
      setGithubStatus(localBackupStatus, "Conectá tu token de GitHub arriba primero.", "error");
      tokenInput?.focus();
      return;
    }

    const project = getActiveProject();
    if (!project) return;

    backupGistBtn.disabled = true;
    setGithubStatus(localBackupStatus, "Guardando copia en Gist privado de GitHub…", "neutral");

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

      setGithubStatus(
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
        setGithubStatus(
          localBackupStatus,
          "Tu token actual no tiene permiso de Gists. Para habilitarlo en GitHub: editá tu token y marcá 'Account permissions -> Gists: Read and write' (o creá un Token Classic con la casilla 'gist').",
          "error"
        );
      } else {
        setGithubStatus(localBackupStatus, `Error al respaldar en Gist: ${msg}`, "error");
      }
    } finally {
      backupGistBtn.disabled = false;
    }
  });

  publishRepoBtn?.addEventListener("click", () => {
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
          project.name.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || project.name;
        publishNameInput.focus();
        publishNameInput.select();
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

    if (confirmPublishBtn) confirmPublishBtn.disabled = true;
    if (cancelPublishBtn) cancelPublishBtn.disabled = true;
    if (publishRepoBtn) publishRepoBtn.disabled = true;
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
        commitSha: res.commitSha || null
      });

      hidePublishRepoBox();
      setGithubStatus(localBackupStatus, `¡Publicado con éxito como ${res.fullName} (${visibilityLabel})!`, "ok");
      await onProjectClonedOrSynced?.(converted?.id || project.id);
      await onRefreshSyncPanel?.();
    } catch (err) {
      const msg = err?.message || "No se pudo crear el repositorio en GitHub.";
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
    setGithubStatus(gistRestoreStatus, "Descargando y restaurando proyecto desde Gist…", "neutral");

    try {
      const gistData = await fetchGistBackupContent(token, gistId);
      const newProject = await createProjectFromGistBackup(gistData);
      setGithubStatus(gistRestoreStatus, `¡Proyecto '${newProject.name}' restaurado con éxito!`, "ok");
      await onProjectClonedOrSynced?.(newProject.id);
      dialog?.close();
    } catch (err) {
      const msg = err?.message || "No se pudo restaurar el Gist.";
      setGithubStatus(gistRestoreStatus, `Error al restaurar: ${msg}`, "error");
    } finally {
      restoreGistBtn.disabled = false;
    }
  });

  return {
    hidePublishRepoBox,
    setSectionVisible,
    refresh
  };
}
