import { getWorkspace, importLocalWorkspace as importWorkspace, saveWorkspace } from "./routeWorkspaceApi";

const SAVE_DEBOUNCE_MS = 800;

export function createWorkspaceSync({ getLayers, applyLayers, onStatus, normalizeLayers = (layers) => layers }) {
  let saveTimer = null;
  let saveInFlight = false;
  let saveDirty = false;
  let latestSnapshot = null;
  let nextSaveDueAt = 0;
  let authGeneration = 0;
  let disposed = false;

  const reportStatus = (status) => onStatus?.(status);
  const isCurrentGeneration = (generation) => !disposed && generation === authGeneration;

  function scheduleSaveAttempt(generation, delay = 0) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveLatestSnapshot(generation);
    }, delay);
  }

  async function saveLatestSnapshot(generation) {
    if (!isCurrentGeneration(generation) || saveInFlight || !saveDirty || !latestSnapshot) {
      return;
    }

    const snapshot = latestSnapshot;
    saveDirty = false;
    saveInFlight = true;
    reportStatus("saving");
    try {
      await saveWorkspace(snapshot);
      if (isCurrentGeneration(generation)) reportStatus("synced");
    } catch (error) {
      if (isCurrentGeneration(generation)) reportStatus("unsynced");
    } finally {
      saveInFlight = false;
      if (isCurrentGeneration(generation) && saveDirty) {
        scheduleSaveAttempt(generation, Math.max(0, nextSaveDueAt - Date.now()));
      }
    }
  }

  async function loadCloudWorkspace() {
    const generation = authGeneration;
    reportStatus("loading");
    try {
      const workspace = await getWorkspace();
      if (!isCurrentGeneration(generation)) return null;
      const layers = Array.isArray(workspace?.layers) ? workspace.layers : [];
      if (layers.length) {
        applyLayers(normalizeLayers(layers));
      }
      reportStatus("synced");
      return workspace;
    } catch (error) {
      if (isCurrentGeneration(generation)) reportStatus("unsynced");
      return null;
    }
  }

  function scheduleWorkspaceSave() {
    if (disposed) return;
    latestSnapshot = { dataVersion: 1, layers: getLayers() };
    saveDirty = true;
    const generation = authGeneration;
    nextSaveDueAt = Date.now() + SAVE_DEBOUNCE_MS;
    scheduleSaveAttempt(generation, SAVE_DEBOUNCE_MS);
  }

  async function importLocalWorkspace(payload) {
    const generation = authGeneration;
    reportStatus("saving");
    try {
      const workspace = await importWorkspace(payload);
      if (isCurrentGeneration(generation)) reportStatus("synced");
      return isCurrentGeneration(generation) ? workspace : null;
    } catch (error) {
      if (isCurrentGeneration(generation)) reportStatus("unsynced");
      return null;
    }
  }

  function cancelWorkspaceSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    latestSnapshot = null;
    saveDirty = false;
    nextSaveDueAt = 0;
    authGeneration += 1;
  }

  function dispose() {
    cancelWorkspaceSave();
    disposed = true;
  }

  return { loadCloudWorkspace, scheduleWorkspaceSave, importLocalWorkspace, cancelWorkspaceSave, dispose };
}
