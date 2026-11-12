import { icon } from "./icons.js";
import { inferFileMeta, validateUserPath } from "../storage/workspaceDb.js";
import { decodeImportedFile, MAX_IMPORT_FILE_BYTES } from "../storage/fileImport.js";
import { getStorageQuotaEstimate } from "../storage/storageQuota.js";

/**
 * Genera una ruta única para un duplicado insertando ".copia" antes de la extensión.
 * Si ya existe, añade un sufijo numérico secuencial: ".copia 2", ".copia 3", etc.
 * @param {string} sourcePath
 * @param {Set<string>|string[]} existingPaths
 * @returns {string}
 */
export function generateDuplicatePath(sourcePath, existingPaths) {
  const existingSet = existingPaths instanceof Set ? existingPaths : new Set(existingPaths || []);
  const lastSlash = sourcePath.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : sourcePath.slice(0, lastSlash + 1);
  const fileName = lastSlash === -1 ? sourcePath : sourcePath.slice(lastSlash + 1);

  let baseName = fileName;
  let ext = "";

  const lastDot = fileName.lastIndexOf(".");
  if (lastDot > 0) {
    baseName = fileName.slice(0, lastDot);
    ext = fileName.slice(lastDot);
  }

  const candidate = `${dir}${baseName}.copia${ext}`;
  if (!existingSet.has(candidate)) {
    return candidate;
  }

  let counter = 2;
  while (existingSet.has(`${dir}${baseName}.copia ${counter}${ext}`)) {
    counter++;
  }
  return `${dir}${baseName}.copia ${counter}${ext}`;
}

/**
 * Controlador del Explorador jerárquico con creación/renombrado inline,
 * confirmación de borrado sin popups nativos de Safari, selector de proyectos e importación/exportación.
 */
export function initExplorerController({
  onSelectFile,
  onCreateEntry,
  onRenameEntry,
  onDeleteEntry,
  onDuplicateEntry,
  onDownloadFile,
  onSwitchProject,
  onCreateProject,
  onDeleteCurrentProject,
  onImportFiles,
  onDownloadActiveFile,
  onExportProjectZip,
  onSaveRepoOffline,
  onCloudBackupProject
}) {
  const projectSelect = document.getElementById("explorer-project-select");
  const btnNewProject = document.getElementById("btn-new-project");
  const btnDeleteProject = document.getElementById("btn-delete-project");
  const btnNewFile = document.getElementById("btn-new-file");
  const btnNewFolder = document.getElementById("btn-new-folder");
  const btnCloudBackup = document.getElementById("btn-cloud-backup");
  const btnOfflineRepo = document.getElementById("btn-offline-repo");
  const btnImport = document.getElementById("btn-import-files");
  const importInput = document.getElementById("explorer-import-input");
  const btnExport = document.getElementById("btn-export-file");
  const btnExportZip = document.getElementById("btn-export-zip");
  const inlineSlot = document.getElementById("explorer-inline-slot");
  const treeContainer = document.getElementById("file-tree");
  const autosaveLabel = document.getElementById("explorer-autosave-status");
  const storageLabel = document.getElementById("explorer-storage-status");

  async function refreshStorageIndicator() {
    if (!storageLabel) return;
    const est = await getStorageQuotaEstimate();
    if (est.supported && est.usageBytes > 0) {
      storageLabel.textContent = `${est.usageFormatted} usados`;
      storageLabel.hidden = false;
    } else {
      storageLabel.hidden = true;
    }
  }

  void refreshStorageIndicator();

  /** @type {Set<string>} */
  const collapsedFolders = new Set();
  let selectedFolderPath = "";
  let pendingDeletePath = null;
  let pendingProjectDelete = false;
  let renamingTarget = null; // { path, isFolder }
  let currentEntries = [];
  let currentActiveFileId = null;
  let contextMenuEl = null;
  let cancelActiveLongPress = null;

  const explorerPanelBody =
    treeContainer?.closest?.(".panel-body") ||
    (typeof document.querySelector === "function"
      ? document.querySelector("#panel-explorer .panel-body")
      : null);

  function handleTreeContainerScroll() {
    cancelActiveLongPress?.();
    closeContextMenu();
  }

  explorerPanelBody?.addEventListener?.("scroll", handleTreeContainerScroll, { passive: true });
  treeContainer?.addEventListener?.("scroll", handleTreeContainerScroll, { passive: true });

  treeContainer?.addEventListener?.("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (contextMenuEl && !contextMenuEl.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeContextMenu();
      return;
    }
    if (pendingDeletePath) {
      event.preventDefault();
      event.stopPropagation();
      pendingDeletePath = null;
      renderTree(currentEntries, currentActiveFileId);
    }
  });

  function closeContextMenu() {
    if (contextMenuEl) {
      contextMenuEl.hidden = true;
    }
  }

  function getOrCreateContextMenu() {
    if (contextMenuEl) return contextMenuEl;
    contextMenuEl = document.createElement("div");
    contextMenuEl.id = "tree-context-menu";
    contextMenuEl.className = "tree-context-menu";
    contextMenuEl.hidden = true;
    document.body.appendChild(contextMenuEl);

    document.addEventListener("pointerdown", (event) => {
      if (contextMenuEl && !contextMenuEl.hidden && !contextMenuEl.contains(event.target)) {
        closeContextMenu();
      }
    });

    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && contextMenuEl && !contextMenuEl.hidden) {
          event.preventDefault();
          event.stopPropagation();
          closeContextMenu();
        }
      },
      { capture: true }
    );

    window.addEventListener("scroll", handleTreeContainerScroll, { passive: true });
    window.addEventListener("blur", closeContextMenu);

    return contextMenuEl;
  }

  function openContextMenu(node, clientX, clientY) {
    const menu = getOrCreateContextMenu();
    menu.innerHTML = "";

    const renameItem = document.createElement("button");
    renameItem.type = "button";
    renameItem.className = "tree-context-item";
    renameItem.innerHTML = `${icon("edit")}<span>Renombrar</span>`;
    renameItem.addEventListener("click", () => {
      closeContextMenu();
      renamingTarget = { path: node.path, isFolder: node.isFolder };
      renderTree(currentEntries, currentActiveFileId);
    });
    menu.appendChild(renameItem);

    if (!node.isFolder) {
      if (onDuplicateEntry) {
        const dupItem = document.createElement("button");
        dupItem.type = "button";
        dupItem.className = "tree-context-item";
        dupItem.innerHTML = `${icon("copy")}<span>Duplicar</span>`;
        dupItem.addEventListener("click", () => {
          closeContextMenu();
          onDuplicateEntry(node.path);
        });
        menu.appendChild(dupItem);
      }

      if (onDownloadFile) {
        const dlItem = document.createElement("button");
        dlItem.type = "button";
        dlItem.className = "tree-context-item";
        dlItem.innerHTML = `${icon("download")}<span>Descargar</span>`;
        dlItem.addEventListener("click", () => {
          closeContextMenu();
          onDownloadFile(node.path);
        });
        menu.appendChild(dlItem);
      }
    }

    const delItem = document.createElement("button");
    delItem.type = "button";
    delItem.className = "tree-context-item is-danger";
    delItem.innerHTML = `${icon("trash")}<span>Eliminar</span>`;
    delItem.addEventListener("click", () => {
      closeContextMenu();
      pendingDeletePath = node.path;
      renderTree(currentEntries, currentActiveFileId);
    });
    menu.appendChild(delItem);

    menu.hidden = false;
    const menuWidth = 180;
    const menuHeight = node.isFolder ? 80 : 160;
    const posX = Math.min(clientX, Math.max(12, window.innerWidth - menuWidth - 12));
    const posY = Math.min(clientY, Math.max(12, window.innerHeight - menuHeight - 12));
    menu.style.left = `${Math.max(12, posX)}px`;
    menu.style.top = `${Math.max(12, posY)}px`;
  }

  projectSelect?.addEventListener("change", () => {
    pendingProjectDelete = false;
    syncProjectDeleteButton();
    onSwitchProject(projectSelect.value);
  });

  btnNewProject?.addEventListener("click", () => {
    openInlineCreator({
      placeholder: "nombre-del-proyecto",
      initialValue: "",
      ariaLabel: "Nombre del nuevo proyecto local",
      onSubmit: async (rawVal) => {
        const clean = rawVal.trim();
        if (clean) {
          await onCreateProject(clean);
        }
      }
    });
  });

  btnDeleteProject?.addEventListener("click", async () => {
    if (!pendingProjectDelete) {
      pendingProjectDelete = true;
      syncProjectDeleteButton();
      window.setTimeout(() => {
        if (pendingProjectDelete) {
          pendingProjectDelete = false;
          syncProjectDeleteButton();
        }
      }, 3500);
      return;
    }
    pendingProjectDelete = false;
    syncProjectDeleteButton();
    await onDeleteCurrentProject();
  });

  function syncProjectDeleteButton() {
    if (!btnDeleteProject) return;
    if (pendingProjectDelete) {
      btnDeleteProject.className = "tree-confirm-delete";
      btnDeleteProject.innerHTML = "Confirmar";
    } else {
      btnDeleteProject.className = "btn btn-ghost btn-sm btn-icon";
      btnDeleteProject.innerHTML = icon("trash");
    }
  }

  btnNewFile?.addEventListener("click", () => {
    const prefix = selectedFolderPath ? `${selectedFolderPath}/` : "";
    openInlineCreator({
      placeholder: "src/archivo.cpp",
      initialValue: prefix,
      ariaLabel: "Ruta del nuevo archivo",
      onSubmit: async (val) => {
        const clean = validateUserPath(val);
        await onCreateEntry(clean, false);
      }
    });
  });

  btnNewFolder?.addEventListener("click", () => {
    const prefix = selectedFolderPath ? `${selectedFolderPath}/` : "";
    openInlineCreator({
      placeholder: "nueva-carpeta",
      initialValue: prefix,
      ariaLabel: "Ruta de la nueva carpeta",
      onSubmit: async (val) => {
        const clean = validateUserPath(val);
        collapsedFolders.delete(clean);
        selectedFolderPath = clean;
        await onCreateEntry(clean, true);
      }
    });
  });

  btnImport?.addEventListener("click", () => {
    importInput?.click();
  });

  importInput?.addEventListener("change", async () => {
    const fileList = importInput.files ? [...importInput.files] : [];
    importInput.value = "";
    if (fileList.length === 0) return;

    const imported = [];
    const rejected = [];
    for (const file of fileList) {
      if (typeof file.size === "number" && file.size > MAX_IMPORT_FILE_BYTES) {
        rejected.push(`${file.name} (supera el límite de 5 MB por archivo)`);
        continue;
      }
      const targetPath = selectedFolderPath ? `${selectedFolderPath}/${file.name}` : file.name;
      let cleanPath;
      try {
        cleanPath = validateUserPath(targetPath);
      } catch {
        rejected.push(`${file.name} (el nombre tiene caracteres no permitidos)`);
        continue;
      }
      const decoded = decodeImportedFile(new Uint8Array(await file.arrayBuffer()), file.name, {
        allowBinaryAssets: true
      });
      if (!decoded.ok) {
        rejected.push(`${file.name} (${decoded.reason})`);
        continue;
      }
      imported.push({
        path: cleanPath,
        content: decoded.text,
        isBinary: Boolean(decoded.isBinary),
        base64: decoded.base64 || null
      });
    }

    const rejectedMsg = rejected.length > 0 ? `No se importó: ${rejected.join(", ")}` : "";
    if (imported.length === 0) {
      if (rejectedMsg) setAutosaveStatus(rejectedMsg);
      return;
    }

    const existingFiles = new Set(currentEntries.filter((e) => !e.isFolder).map((e) => e.path));
    const conflicts = imported.filter((item) => existingFiles.has(item.path));
    if (conflicts.length === 0) {
      await onImportFiles(imported);
      if (rejectedMsg) setAutosaveStatus(rejectedMsg);
      return;
    }

    // Hay archivos con el mismo nombre: no se pisa nada sin una confirmación explícita.
    openImportOverwriteConfirm(conflicts.map((c) => c.path), async () => {
      await onImportFiles(imported);
      if (rejectedMsg) setAutosaveStatus(rejectedMsg);
    }, rejectedMsg);
  });

  function openImportOverwriteConfirm(conflictPaths, onConfirm, rejectedMsg) {
    if (!inlineSlot) return;
    inlineSlot.hidden = false;
    inlineSlot.innerHTML = "";

    const box = document.createElement("div");
    box.className = "explorer-import-confirm";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-label", "Confirmar reemplazo de archivos");

    const msg = document.createElement("p");
    msg.className = "explorer-inline-error";
    const shown = conflictPaths.slice(0, 3).join(", ");
    const more = conflictPaths.length > 3 ? ` y ${conflictPaths.length - 3} más` : "";
    msg.textContent =
      conflictPaths.length === 1
        ? `Ya existe "${shown}". ¿Reemplazarlo con el archivo importado?`
        : `Ya existen ${shown}${more}. ¿Reemplazarlos con los archivos importados?`;

    const actions = document.createElement("div");
    actions.className = "tree-confirm-bar";

    const replaceBtn = document.createElement("button");
    replaceBtn.type = "button";
    replaceBtn.className = "tree-confirm-delete";
    replaceBtn.textContent = "Reemplazar";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "tree-icon-btn";
    cancelBtn.setAttribute("aria-label", "Cancelar importación");
    cancelBtn.innerHTML = icon("x");

    const close = () => {
      inlineSlot.hidden = true;
      inlineSlot.innerHTML = "";
    };
    replaceBtn.addEventListener("click", async () => {
      close();
      await onConfirm();
    });
    const handleCancel = () => {
      close();
      setAutosaveStatus(rejectedMsg ? `Importación cancelada. ${rejectedMsg}` : "Importación cancelada");
    };
    cancelBtn.addEventListener("click", handleCancel);
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handleCancel();
      }
    });

    actions.append(replaceBtn, cancelBtn);
    box.append(msg, actions);
    inlineSlot.appendChild(box);
    replaceBtn.focus();
  }

  btnExport?.addEventListener("click", () => {
    onDownloadActiveFile();
  });

  btnExportZip?.addEventListener("click", () => {
    onExportProjectZip?.();
  });

  btnCloudBackup?.addEventListener("click", () => {
    onCloudBackupProject?.();
  });

  btnOfflineRepo?.addEventListener("click", () => {
    onSaveRepoOffline?.();
  });

  function openInlineCreator({ placeholder, initialValue, ariaLabel, onSubmit }) {
    if (!inlineSlot) return;
    inlineSlot.hidden = false;
    inlineSlot.innerHTML = "";

    const form = document.createElement("form");
    form.className = "inline-edit-form";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-edit-input";
    input.placeholder = placeholder;
    input.value = initialValue;
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.setAttribute("aria-label", ariaLabel);

    const okBtn = document.createElement("button");
    okBtn.type = "submit";
    okBtn.className = "tree-icon-btn";
    okBtn.setAttribute("aria-label", "Confirmar");
    okBtn.innerHTML = icon("check");

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "tree-icon-btn";
    cancelBtn.setAttribute("aria-label", "Cancelar");
    cancelBtn.innerHTML = icon("x");

    const errEl = document.createElement("p");
    errEl.className = "explorer-inline-error";
    errEl.hidden = true;

    const close = () => {
      inlineSlot.hidden = true;
      inlineSlot.innerHTML = "";
    };

    cancelBtn.addEventListener("click", close);
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") {
        const focusable = [input, okBtn, cancelBtn];
        const idx = focusable.indexOf(document.activeElement);
        if (event.shiftKey && idx <= 0) {
          event.preventDefault();
          cancelBtn.focus();
        } else if (!event.shiftKey && idx === focusable.length - 1) {
          event.preventDefault();
          input.focus();
        }
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const val = input.value;
      try {
        await onSubmit(val);
        close();
      } catch (error) {
        errEl.hidden = false;
        errEl.textContent = error instanceof Error ? error.message : "No se pudo crear el elemento.";
        input.focus();
      }
    });

    form.append(input, okBtn, cancelBtn);
    inlineSlot.append(form, errEl);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  let lastRemoteRepos = [];
  let currentRenderedProjectId = "";

  function renderProjects(projects, activeProjectId, remoteGithubRepos = null) {
    closeContextMenu();
    if (Array.isArray(remoteGithubRepos)) {
      lastRemoteRepos = remoteGithubRepos;
    }
    if (currentRenderedProjectId !== activeProjectId) {
      currentRenderedProjectId = activeProjectId;
      selectedFolderPath = "";
      pendingDeletePath = null;
      renamingTarget = null;
      pendingProjectDelete = false;
      collapsedFolders.clear();
      if (inlineSlot) {
        inlineSlot.hidden = true;
        inlineSlot.innerHTML = "";
      }
      syncProjectDeleteButton();
    }
    if (!projectSelect) return;
    projectSelect.innerHTML = "";

    const localProjects = projects.filter((p) => p.kind !== "github");
    const githubProjects = projects.filter((p) => p.kind === "github");

    const localGroup = document.createElement("optgroup");
    localGroup.label = "En este iPad";
    for (const proj of localProjects) {
      const opt = document.createElement("option");
      opt.value = proj.id;
      opt.textContent = proj.name;
      localGroup.appendChild(opt);
    }
    projectSelect.appendChild(localGroup);

    if (githubProjects.length > 0 || lastRemoteRepos.length > 0) {
      const ghGroup = document.createElement("optgroup");
      ghGroup.label = "Mis repos de GitHub";

      const seenRepos = new Set();
      for (const proj of githubProjects) {
        const opt = document.createElement("option");
        opt.value = proj.id;
        opt.textContent = proj.offlineCached ? `${proj.name} [Offline]` : proj.name;
        ghGroup.appendChild(opt);
        if (proj.github?.owner && proj.github?.repo) {
          seenRepos.add(`${proj.github.owner}/${proj.github.repo}`.toLowerCase());
        }
      }

      for (const remote of lastRemoteRepos) {
        if (!remote?.full_name) continue;
        if (seenRepos.has(remote.full_name.toLowerCase())) continue;
        const branch = remote.default_branch || "main";
        const opt = document.createElement("option");
        opt.value = `ghlive::${remote.full_name}::${branch}`;
        opt.textContent = remote.full_name;
        ghGroup.appendChild(opt);
      }

      projectSelect.appendChild(ghGroup);
    }

    projectSelect.value = activeProjectId;

    if (btnDeleteProject) {
      btnDeleteProject.disabled = projects.length <= 1;
    }
  }

  function renderTree(entries, activeFileId) {
    currentEntries = entries;
    currentActiveFileId = activeFileId;
    closeContextMenu();

    if (!treeContainer) return;
    const prevScrollTop = treeContainer.scrollTop;
    treeContainer.innerHTML = "";

    const hierarchy = buildHierarchy(entries);
    const flatRows = flattenVisibleTree(hierarchy, 0, collapsedFolders);

    for (const node of flatRows) {
      const li = document.createElement("li");

      if (renamingTarget && renamingTarget.path === node.path) {
        li.appendChild(buildInlineRenameRow(node));
        treeContainer.appendChild(li);
        continue;
      }

      const depthClass = `tree-depth-${Math.min(node.depth, 6)}`;
      const isActiveFile = !node.isFolder && node.path === activeFileId;
      const isSelectedFolder = node.isFolder && node.path === selectedFolderPath;

      const row = document.createElement("div");
      row.className = [
        "tree-row",
        depthClass,
        isActiveFile ? "is-active" : "",
        isSelectedFolder ? "is-selected-folder" : ""
      ]
        .filter(Boolean)
        .join(" ");

      let touchStartX = 0;
      let touchStartY = 0;
      let longPressTimer = null;
      let longPressTriggered = false;

      const clearLongPress = () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        if (cancelActiveLongPress === clearLongPress) {
          cancelActiveLongPress = null;
        }
      };

      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openContextMenu(node, event.clientX, event.clientY);
      });

      row.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch" || event.isPrimary === false) return;
        if (event.target?.closest?.(".tree-node-actions, .tree-confirm-bar, form, input")) {
          clearLongPress();
          return;
        }
        touchStartX = event.clientX;
        touchStartY = event.clientY;
        longPressTriggered = false;
        cancelActiveLongPress?.();
        cancelActiveLongPress = clearLongPress;
        longPressTimer = window.setTimeout(() => {
          longPressTimer = null;
          if (cancelActiveLongPress === clearLongPress) {
            cancelActiveLongPress = null;
          }
          longPressTriggered = true;
          openContextMenu(node, touchStartX, touchStartY);
        }, 500);
      });

      row.addEventListener("pointermove", (event) => {
        if (longPressTimer && event.pointerType === "touch") {
          const dist = Math.hypot(event.clientX - touchStartX, event.clientY - touchStartY);
          if (dist > 8) {
            clearLongPress();
          }
        }
      });

      row.addEventListener("pointerup", (event) => {
        clearLongPress();
        if (longPressTriggered) {
          event.preventDefault();
          event.stopPropagation();
          window.setTimeout(() => {
            longPressTriggered = false;
          }, 350);
        }
      });

      row.addEventListener("pointercancel", () => {
        clearLongPress();
        longPressTriggered = false;
      });
      row.addEventListener("pointerleave", () => {
        clearLongPress();
      });

      const mainBtn = document.createElement("button");
      mainBtn.type = "button";
      mainBtn.className = "tree-node-btn";
      if (isActiveFile) {
        mainBtn.setAttribute("aria-current", "page");
      }

      if (node.isFolder) {
        const isCollapsed = collapsedFolders.has(node.path);
        mainBtn.setAttribute("aria-expanded", String(!isCollapsed));
        mainBtn.innerHTML = `
          ${icon(isCollapsed ? "chevronRight" : "chevronDown")}
          ${icon(isCollapsed ? "folder" : "folderOpen")}
          <span class="file-tree-name">${escapeHtml(node.name)}</span>
        `;
        mainBtn.addEventListener("click", () => {
          if (longPressTriggered) {
            longPressTriggered = false;
            return;
          }
          if (collapsedFolders.has(node.path)) {
            collapsedFolders.delete(node.path);
          } else {
            collapsedFolders.add(node.path);
          }
          selectedFolderPath = selectedFolderPath === node.path ? "" : node.path;
          renderTree(currentEntries, currentActiveFileId);
        });
      } else {
        const meta = inferFileMeta(node.path);
        mainBtn.innerHTML = `
          ${icon(meta.icon)}
          <span class="file-tree-name">${escapeHtml(node.name)}</span>
          <span class="file-tree-lang">${escapeHtml(meta.badge)}</span>
        `;
        mainBtn.addEventListener("click", () => {
          if (longPressTriggered) {
            longPressTriggered = false;
            return;
          }
          const idx = node.path.lastIndexOf("/");
          selectedFolderPath = idx > 0 ? node.path.slice(0, idx) : "";
          onSelectFile(node.path);
        });
      }

      row.appendChild(mainBtn);

      if (pendingDeletePath === node.path) {
        const confirmBar = document.createElement("div");
        confirmBar.className = "tree-confirm-bar";

        const yesBtn = document.createElement("button");
        yesBtn.type = "button";
        yesBtn.className = "tree-confirm-delete";
        yesBtn.textContent = "Borrar";
        yesBtn.addEventListener("click", async () => {
          pendingDeletePath = null;
          if (selectedFolderPath === node.path) {
            selectedFolderPath = "";
          }
          await onDeleteEntry(node.path, node.isFolder);
        });

        const noBtn = document.createElement("button");
        noBtn.type = "button";
        noBtn.className = "tree-icon-btn";
        noBtn.setAttribute("aria-label", "Cancelar borrado");
        noBtn.innerHTML = icon("x");
        noBtn.addEventListener("click", () => {
          pendingDeletePath = null;
          renderTree(currentEntries, currentActiveFileId);
        });

        confirmBar.append(yesBtn, noBtn);
        row.appendChild(confirmBar);
      } else {
        const actions = document.createElement("div");
        actions.className = "tree-node-actions";

        const renameBtn = document.createElement("button");
        renameBtn.type = "button";
        renameBtn.className = "tree-icon-btn";
        renameBtn.setAttribute("aria-label", `Renombrar ${node.name}`);
        renameBtn.title = "Renombrar";
        renameBtn.innerHTML = icon("edit");
        renameBtn.addEventListener("click", () => {
          renamingTarget = { path: node.path, isFolder: node.isFolder };
          renderTree(currentEntries, currentActiveFileId);
        });

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "tree-icon-btn";
        delBtn.setAttribute("aria-label", `Eliminar ${node.name}`);
        delBtn.title = "Eliminar";
        delBtn.innerHTML = icon("trash");
        delBtn.addEventListener("click", () => {
          pendingDeletePath = node.path;
          renderTree(currentEntries, currentActiveFileId);
        });

        actions.append(renameBtn, delBtn);
        row.appendChild(actions);
      }

      li.appendChild(row);
      treeContainer.appendChild(li);
    }

    if (prevScrollTop > 0) {
      treeContainer.scrollTop = prevScrollTop;
    }
  }

  function buildInlineRenameRow(node) {
    const form = document.createElement("form");
    form.className = "inline-edit-form";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline-edit-input";
    input.value = node.path;
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.setAttribute("aria-label", `Nueva ruta para ${node.name}`);

    const okBtn = document.createElement("button");
    okBtn.type = "submit";
    okBtn.className = "tree-icon-btn";
    okBtn.setAttribute("aria-label", "Guardar nuevo nombre");
    okBtn.innerHTML = icon("check");

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "tree-icon-btn";
    cancelBtn.setAttribute("aria-label", "Cancelar renombrado");
    cancelBtn.innerHTML = icon("x");

    const cancel = () => {
      renamingTarget = null;
      renderTree(currentEntries, currentActiveFileId);
    };

    cancelBtn.addEventListener("click", cancel);
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      } else if (event.key === "Tab") {
        const focusable = [input, okBtn, cancelBtn];
        const idx = focusable.indexOf(document.activeElement);
        if (event.shiftKey && idx <= 0) {
          event.preventDefault();
          cancelBtn.focus();
        } else if (!event.shiftKey && idx === focusable.length - 1) {
          event.preventDefault();
          input.focus();
        }
      }
    });

    const wrapper = document.createElement("div");

    const errEl = document.createElement("p");
    errEl.className = "explorer-inline-error";
    errEl.hidden = true;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const oldPath = node.path;
      const isFolder = node.isFolder;
      let targetPath;
      try {
        targetPath = validateUserPath(input.value);
      } catch (error) {
        errEl.hidden = false;
        errEl.textContent = error instanceof Error ? error.message : "Nombre inválido.";
        input.focus();
        return;
      }
      if (targetPath === oldPath) {
        renamingTarget = null;
        renderTree(currentEntries, currentActiveFileId);
        return;
      }
      try {
        renamingTarget = null;
        await onRenameEntry(oldPath, targetPath, isFolder);
      } catch (error) {
        renamingTarget = { path: oldPath, isFolder };
        errEl.hidden = false;
        errEl.textContent = error instanceof Error ? error.message : "No se pudo renombrar.";
        input.focus();
      }
    });

    form.append(input, okBtn, cancelBtn);
    wrapper.append(form, errEl);
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return wrapper;
  }

  function setAutosaveStatus(message) {
    if (autosaveLabel) {
      autosaveLabel.textContent = message;
    }
  }

  function setOfflineRepoState({ visible, isOfflineReady = false, pendingCount = 0, busy = false }) {
    if (btnCloudBackup) {
      btnCloudBackup.hidden = Boolean(visible);
    }
    if (!btnOfflineRepo) return;
    btnOfflineRepo.hidden = !visible;
    if (!visible) return;

    btnOfflineRepo.disabled = busy;
    btnOfflineRepo.classList.toggle("is-offline-ready", Boolean(isOfflineReady));
    const statusLabel = isOfflineReady
      ? "Copia completa guardada en el iPad (disponible sin internet)"
      : pendingCount > 0
        ? `Guardar copia offline en el iPad (${pendingCount} archivos restantes)`
        : "Guardar copia offline en el iPad";
    btnOfflineRepo.title = statusLabel;
    btnOfflineRepo.setAttribute("aria-label", statusLabel);
  }

  return {
    renderProjects,
    renderTree,
    setAutosaveStatus,
    setOfflineRepoState,
    refreshStorageIndicator
  };
}

export function buildHierarchy(entries) {
  const root = { children: new Map() };

  for (const item of entries) {
    const parts = item.path.split("/").filter(Boolean);
    let cursor = root;
    let accum = "";

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      accum = accum ? `${accum}/${part}` : part;
      const isLast = i === parts.length - 1;
      const isFolder = isLast ? Boolean(item.isFolder) : true;

      if (!cursor.children.has(part)) {
        cursor.children.set(part, {
          name: part,
          path: accum,
          isFolder,
          children: new Map()
        });
      } else if (isFolder) {
        cursor.children.get(part).isFolder = true;
      }

      cursor = cursor.children.get(part);
    }
  }

  return root;
}

export function flattenVisibleTree(node, depth, collapsedFolders) {
  const items = [...node.children.values()];
  items.sort((a, b) => {
    if (a.isFolder !== b.isFolder) {
      return a.isFolder ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const result = [];
  for (const child of items) {
    result.push({
      name: child.name,
      path: child.path,
      isFolder: child.isFolder,
      depth
    });

    if (child.isFolder && !collapsedFolders.has(child.path)) {
      result.push(...flattenVisibleTree(child, depth + 1, collapsedFolders));
    }
  }
  return result;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
