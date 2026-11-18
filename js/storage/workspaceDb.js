/**
 * Fachada unificada de almacenamiento IndexedDB, rutas, plantillas de proyecto y sincronización con GitHub.
 */

export {
  requestPersistentStorage,
  inferFileMeta,
  normalizePath,
  validateUserPath,
  getSavedActiveProjectId,
  setSavedActiveProjectId,
  closeWorkspaceBroadcast,
  broadcastWorkspaceChange,
  onWorkspaceBroadcast,
  saveCredentialsBackup,
  readCredentialsBackup
} from "./db/dbCore.js";

export { PROJECT_TEMPLATES } from "./db/projectTemplates.js";

export {
  ensureInitialWorkspace,
  listProjects,
  getProject,
  createLocalProject,
  saveProjectState,
  saveProjectTabsState,
  saveProjectGistId,
  saveProjectChatHistory,
  deleteProject,
  createProjectFromGistBackup
} from "./db/workspaceProjects.js";

export {
  getProjectEntries,
  getAllRawProjectEntries,
  entryExists,
  getEntryRecord,
  upsertEntry,
  updateFileContent,
  renameProjectEntry,
  deleteProjectEntry,
  discardEntryChange
} from "./db/workspaceEntries.js";

export {
  makeGithubProjectId,
  hydrateLazyGithubProject,
  cacheSingleGithubFileContent,
  cacheBatchGithubFileContents,
  markProjectOfflineCached,
  hydrateGithubProject,
  countPendingGithubChanges,
  getPendingGithubChanges,
  markProjectSynced,
  applyRemotePullPlan,
  migrateGithubProjectBranch,
  convertLocalProjectToGithub
} from "./db/workspaceGithubSync.js";
