import { createId } from "./utils";

const STORAGE_KEY = "webmap_routes_v1";
const LAYER_STATE_KEY = "webmap_layers_v2";

export function loadHistoryRoutes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (error) {
    console.warn("读取历史路线失败，已回退为空列表", error);
    return [];
  }
}

function writeHistoryRoutes(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function upsertHistoryRoute(route) {
  const routes = loadHistoryRoutes();
  const now = Date.now();

  const normalized = {
    ...route,
    id: route.id || createId("history"),
    updatedAt: now,
    createdAt: route.createdAt || now
  };

  const index = routes.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    routes[index] = normalized;
  } else {
    routes.unshift(normalized);
  }

  writeHistoryRoutes(routes);
  return routes;
}

export function removeHistoryRoute(routeId) {
  const routes = loadHistoryRoutes().filter((item) => item.id !== routeId);
  writeHistoryRoutes(routes);
  return routes;
}

export function loadLayerState() {
  try {
    const raw = localStorage.getItem(LAYER_STATE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("读取图层缓存失败，已回退为空", error);
    return [];
  }
}

export function saveLayerState(layers) {
  try {
    localStorage.setItem(LAYER_STATE_KEY, JSON.stringify(layers));
  } catch (error) {
    console.warn("保存图层缓存失败", error);
  }
}
