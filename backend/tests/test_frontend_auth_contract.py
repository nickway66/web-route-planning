from pathlib import Path
import os
import subprocess
import shutil

import pytest


ROOT = Path(__file__).resolve().parents[2]


def test_frontend_runtime_contract_does_not_hardcode_a_developer_node_path():
    source = Path(__file__).read_text(encoding="utf-8")

    node_assignments = [line for line in source.splitlines() if "node =" in line]
    assert all("Users" not in line for line in node_assignments)
    assert "shutil.which(\"node\")" in source


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


def test_api_client_distinguishes_network_failures_from_aborted_or_http_requests():
    node = os.environ.get("NODE_BINARY") or shutil.which("node")
    if not node:
        pytest.skip("Node.js is required to run the frontend API client contract test")
    script = r'''
      import { readFileSync } from "node:fs";

      const source = readFileSync("./src/apiClient.js", "utf8")
        .replace('import { BACKEND_BASE_URL } from "./config";', 'const BACKEND_BASE_URL = "http://localhost:8000";')
        .replace('import { getAuthState } from "./authStore";', 'const getAuthState = () => ({ token: "" });');
      const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

      globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
      await module.apiRequest("/api/auth/register").then(
        () => { throw new Error("network failure should reject"); },
        (error) => {
          if (error.message !== "无法连接认证服务，请确认后端已启动") throw error;
        }
      );

      const abortError = Object.assign(new Error("cancelled"), { name: "AbortError" });
      globalThis.fetch = async () => { throw abortError; };
      await module.apiRequest("/api/auth/register").then(
        () => { throw new Error("abort should reject"); },
        (error) => {
          if (error !== abortError || error.name !== "AbortError") throw error;
        }
      );

      globalThis.fetch = async () => ({
        ok: false,
        status: 409,
        json: async () => ({ detail: "该邮箱已注册" }),
        text: async () => "unexpected",
      });
      await module.apiRequest("/api/auth/register").then(
        () => { throw new Error("HTTP failure should reject"); },
        (error) => {
          if (error.message !== "该邮箱已注册") throw error;
        }
      );
    '''
    result = subprocess.run(
        [str(node), "--input-type=module", "--eval", script],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
