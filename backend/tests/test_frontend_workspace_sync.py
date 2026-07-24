from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_frontend_syncs_layers_only_after_login():
    source = (ROOT / "src/main.js").read_text(encoding="utf-8")

    assert "loadCloudWorkspace" in source
    assert "scheduleWorkspaceSave" in source
    assert "serializeLayersForStorage()" in source
    assert "importLocalWorkspace" in source
