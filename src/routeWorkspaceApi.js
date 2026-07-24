import { apiRequest } from "./apiClient";

export function getWorkspace() {
  return apiRequest("/api/workspace");
}

export function saveWorkspace(payload) {
  return apiRequest("/api/workspace", { method: "PUT", body: JSON.stringify(payload) });
}

export function importLocalWorkspace(payload) {
  return apiRequest("/api/workspace/import-local", { method: "POST", body: JSON.stringify(payload) });
}
