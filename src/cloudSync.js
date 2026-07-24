import { getWorkspace, importLocalWorkspace as importWorkspace, saveWorkspace } from "./routeWorkspaceApi";

const SAVE_DEBOUNCE_MS = 800;

export function createWorkspaceSync({ getLayers, applyLayers, onStatus, normalizeLayers = (layers) => layers }) {
  let saveTimer = null;

  const reportStatus = (status) => onStatus?.(status);

  async function loadCloudWorkspace() {
    reportStatus("loading");
    try {
      const workspace = await getWorkspace();
      const layers = Array.isArray(workspace?.layers) ? workspace.layers : [];
      if (layers.length) {
        applyLayers(normalizeLayers(layers));
      }
      reportStatus("synced");
      return workspace;
    } catch (error) {
      reportStatus("unsynced");
      return null;
    }
  }

  async function saveNow() {
    reportStatus("saving");
    try {
      const workspace = await saveWorkspace({ dataVersion: 1, layers: getLayers() });
      reportStatus("synced");
      return workspace;
    } catch (error) {
      reportStatus("unsynced");
      return null;
    }
  }

  function scheduleWorkspaceSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  async function importLocalWorkspace(payload) {
    reportStatus("saving");
    try {
      const workspace = await importWorkspace(payload);
      reportStatus("synced");
      return workspace;
    } catch (error) {
      reportStatus("unsynced");
      return null;
    }
  }

  return { loadCloudWorkspace, scheduleWorkspaceSave, importLocalWorkspace };
}
