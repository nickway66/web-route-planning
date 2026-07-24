from pathlib import Path


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
