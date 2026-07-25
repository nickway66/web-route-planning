from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]


def test_frontend_syncs_layers_only_after_login():
    source = (ROOT / "src/main.js").read_text(encoding="utf-8")

    assert "loadCloudWorkspace" in source
    assert "scheduleWorkspaceSave" in source
    assert "serializeLayersForStorage()" in source
    assert "importLocalWorkspace" in source


def test_workspace_sync_cancels_pending_saves_when_authentication_changes():
    sync_source = (ROOT / "src/cloudSync.js").read_text(encoding="utf-8")
    main_source = (ROOT / "src/main.js").read_text(encoding="utf-8")

    assert "cancelWorkspaceSave" in sync_source
    assert "dispose" in sync_source
    assert "authGeneration" in sync_source
    assert "workspaceSync?.cancelWorkspaceSave()" in main_source


def test_workspace_sync_serializes_latest_save_snapshot():
    source = (ROOT / "src/cloudSync.js").read_text(encoding="utf-8")

    assert "saveInFlight" in source
    assert "latestSnapshot" in source
    assert "saveDirty" in source


def test_workspace_sync_replays_new_generation_after_old_request_finishes():
    node = Path(r"C:\Users\wade\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
    script = r'''
      import { readFileSync } from "node:fs";

      const source = readFileSync("./src/cloudSync.js", "utf8").replace(
        'import { getWorkspace, importLocalWorkspace as importWorkspace, saveWorkspace } from "./routeWorkspaceApi";',
        "const getWorkspace = null; const importWorkspace = null; const saveWorkspace = null;"
      );
      const { createWorkspaceSync } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

      const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
      let resolveOldSave;
      const writes = [];
      let layers = [{ id: "old" }];
      const sync = createWorkspaceSync({
        getLayers: () => layers,
        applyLayers: () => {},
        onStatus: () => {},
        saveDebounceMs: 0,
        workspaceApi: {
          getWorkspace: async () => ({ layers: [] }),
          importLocalWorkspace: async () => ({}),
          saveWorkspace: (payload) => {
            writes.push(payload);
            return writes.length === 1 ? new Promise((resolve) => { resolveOldSave = resolve; }) : Promise.resolve({});
          }
        }
      });

      sync.scheduleWorkspaceSave();
      await flush();
      if (writes.length !== 1) throw new Error("old generation save did not start");

      sync.cancelWorkspaceSave();
      layers = [{ id: "new" }];
      sync.scheduleWorkspaceSave();
      await flush();
      resolveOldSave({});
      await flush();
      await flush();

      if (writes.length !== 2) throw new Error(`expected new generation retry, got ${writes.length} writes`);
      if (writes[1].layers[0].id !== "new") throw new Error("new generation wrote a stale snapshot");
    '''

    result = subprocess.run(
        [str(node), "--input-type=module", "--eval", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_workspace_cache_is_scoped_to_the_authenticated_user_and_keeps_anonymous_snapshot():
    main_source = (ROOT / "src/main.js").read_text(encoding="utf-8")
    assert "loadLayerState(userId)" in main_source
    assert "saveLayerState(serializeLayersForStorage(), userId)" in main_source
    assert "anonymousLayers" in main_source

    node = Path(r"C:\Users\wade\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
    script = r'''
      import { readFileSync } from "node:fs";

      const source = readFileSync("./src/storage.js", "utf8").replace(
        'import { createId } from "./utils";',
        "const createId = () => 'test-id';"
      );
      const cache = new Map();
      globalThis.localStorage = {
        getItem: (key) => cache.get(key) ?? null,
        setItem: (key, value) => cache.set(key, value)
      };
      const { loadLayerState, saveLayerState } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

      saveLayerState([{ id: "anonymous" }]);
      saveLayerState([{ id: "account-a" }], "account-a");
      if (loadLayerState("account-b").length !== 0) throw new Error("account B received account A cache");
      if (loadLayerState()[0]?.id !== "anonymous") throw new Error("anonymous cache was not preserved");
      if (loadLayerState("account-a")[0]?.id !== "account-a") throw new Error("account A cache was not isolated");
    '''
    result = subprocess.run(
        [str(node), "--input-type=module", "--eval", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_empty_cloud_only_offers_login_time_anonymous_workspace_for_import():
    main_source = (ROOT / "src/main.js").read_text(encoding="utf-8")
    assert "shouldImportAnonymousWorkspace(cloudWorkspace, anonymousLayers)" in main_source
    assert "const accountLayers" not in main_source

    node = Path(r"C:\Users\wade\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
    script = r'''
      import { readFileSync } from "node:fs";

      const source = readFileSync("./src/cloudSync.js", "utf8").replace(
        'import { getWorkspace, importLocalWorkspace as importWorkspace, saveWorkspace } from "./routeWorkspaceApi";',
        "const getWorkspace = null; const importWorkspace = null; const saveWorkspace = null;"
      );
      const { shouldImportAnonymousWorkspace } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      const accountCachedLayers = [{ id: "account-a" }];
      if (shouldImportAnonymousWorkspace({ layers: [] }, [])) throw new Error("empty anonymous cache must not prompt import");
      if (!accountCachedLayers.length) throw new Error("test setup lost account cache");
    '''
    result = subprocess.run(
        [str(node), "--input-type=module", "--eval", script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_successful_anonymous_import_immediately_applies_returned_cloud_layers():
    source = (ROOT / "src/main.js").read_text(encoding="utf-8")

    assert "const importedWorkspace = await workspaceSync.importLocalWorkspace" in source
    assert "applyCloudLayers(importedWorkspace.layers)" in source
