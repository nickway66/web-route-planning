import { BACKEND_BASE_URL } from "./config";

async function request(path, options = {}) {
  const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    let message = `后端请求失败（${response.status}）`;
    try {
      const data = await response.json();
      message = data?.detail || message;
    } catch (error) {
      const text = await response.text().catch(() => "");
      message = text || message;
    }
    throw new Error(message);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export function chatWithAI(messages) {
  return request("/api/ai/chat", {
    method: "POST",
    body: JSON.stringify({ messages })
  });
}

export function searchPOI(keyword, options = {}) {
  const params = new URLSearchParams({
    keyword,
    preferred_city: options.preferredCity || "",
    use_map_city: options.useMapCity === false ? "false" : "true"
  });
  return request(`/api/pois/search?${params.toString()}`);
}

export function getSearchSuggestions(keyword, options = {}) {
  const params = new URLSearchParams({
    keyword,
    preferred_city: options.preferredCity || ""
  });
  return request(`/api/pois/suggest?${params.toString()}`);
}

export function planRoute(points, segmentModes, transitCity) {
  return request("/api/routes/plan", {
    method: "POST",
    body: JSON.stringify({ points, segmentModes, transitCity })
  });
}

export function buildAIRoutes(payload) {
  return request("/api/routes/ai-build", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function exportRouteData(format, layers) {
  return fetch(`${BACKEND_BASE_URL}/api/exports/${format}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ layers })
  }).then(async (response) => {
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `后端导出失败（${response.status}）`);
    }
    return text;
  });
}
