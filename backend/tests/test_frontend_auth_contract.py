from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_frontend_exposes_auth_api_and_authorized_request_client():
    auth_store = (ROOT / "src" / "authStore.js").read_text(encoding="utf-8")
    auth_api = (ROOT / "src" / "authApi.js").read_text(encoding="utf-8")
    api_client = (ROOT / "src" / "apiClient.js").read_text(encoding="utf-8")

    for export_name in ("getAuthState", "setAuthSession", "clearAuthSession", "subscribeAuth"):
        assert f"export function {export_name}" in auth_store
    for export_name in ("register", "login", "getCurrentUser"):
        assert f"export function {export_name}" in auth_api
    assert "localStorage" not in auth_store
    assert "export async function apiRequest" in api_client
    assert 'Authorization: `Bearer ${token}`' in api_client
    assert "setUnauthorizedHandler" in api_client
