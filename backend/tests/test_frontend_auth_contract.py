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


def test_export_route_data_preserves_exact_server_response_text_for_every_format():
    source = (ROOT / "src" / "apiClient.js").read_text(encoding="utf-8")
    export_block = source[source.index("export async function exportRouteData") :]

    assert "return response.text()" in export_block
    assert "response.json()" not in export_block
    assert "JSON.stringify(data)" not in export_block
    assert "return apiRequest(`/api/exports/${format}`" not in export_block


def test_api_client_reports_a_clear_message_when_the_auth_service_is_unreachable():
    source = (ROOT / "src" / "apiClient.js").read_text(encoding="utf-8")

    assert "无法连接认证服务，请确认后端已启动" in source
    assert "catch (error)" in source
    assert "if (!response.ok) await throwRequestError(response);" in source
