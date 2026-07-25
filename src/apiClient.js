import { BACKEND_BASE_URL } from "./config";
import { getAuthState } from "./authStore";

let unauthorizedHandler = null;

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === "function" ? handler : null;
}

async function fetchApiResponse(path, options = {}) {
  const { token } = getAuthState();
  let response;
  try {
    response = await fetch(`${BACKEND_BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("无法连接认证服务，请确认后端已启动");
  }

  if (!response.ok) await throwRequestError(response);
  return response;
}

async function throwRequestError(response) {
  let message = `请求失败（${response.status}）`;
  try {
    const data = await response.json();
    message = data?.detail || message;
  } catch (error) {
    const text = await response.text().catch(() => "");
    message = text || message;
  }
  if (response.status === 401) unauthorizedHandler?.();
  throw new Error(message);
}

export async function apiRequest(path, options = {}) {
  const response = await fetchApiResponse(path, options);
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

export function chatWithAI(messages) {
  return apiRequest("/api/ai/chat", { method: "POST", body: JSON.stringify({ messages }) });
}

export function searchPOI(keyword, options = {}) {
  const params = new URLSearchParams({
    keyword,
    preferred_city: options.preferredCity || "",
    use_map_city: options.useMapCity === false ? "false" : "true"
  });
  return apiRequest(`/api/pois/search?${params.toString()}`);
}

export function getSearchSuggestions(keyword, options = {}) {
  const params = new URLSearchParams({ keyword, preferred_city: options.preferredCity || "" });
  return apiRequest(`/api/pois/suggest?${params.toString()}`);
}

export function planRoute(points, segmentModes, transitCity) {
  return apiRequest("/api/routes/plan", {
    method: "POST",
    body: JSON.stringify({ points, segmentModes, transitCity })
  });
}

export function buildAIRoutes(payload) {
  return apiRequest("/api/routes/ai-build", { method: "POST", body: JSON.stringify(payload) });
}

export async function exportRouteData(format, layers) {
  const response = await fetchApiResponse(`/api/exports/${format}`, {
    method: "POST",
    body: JSON.stringify({ layers })
  });
  return response.text();
}
