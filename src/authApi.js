import { apiRequest } from "./apiClient";

export function register(payload) {
  return apiRequest("/api/auth/register", { method: "POST", body: JSON.stringify(payload) });
}

export function login(payload) {
  return apiRequest("/api/auth/login", { method: "POST", body: JSON.stringify(payload) });
}

export function getCurrentUser() {
  return apiRequest("/api/auth/me");
}
