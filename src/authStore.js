let authState = { token: "", user: null, isAuthenticated: false };
const listeners = new Set();

function notifyAuthListeners() {
  listeners.forEach((listener) => listener(getAuthState()));
}

export function getAuthState() {
  return { ...authState };
}

export function setAuthSession(session = {}) {
  const token = String(session.accessToken || session.token || "");
  authState = { token, user: session.user || null, isAuthenticated: Boolean(token) };
  notifyAuthListeners();
  return getAuthState();
}

export function clearAuthSession() {
  authState = { token: "", user: null, isAuthenticated: false };
  notifyAuthListeners();
  return getAuthState();
}

export function subscribeAuth(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
