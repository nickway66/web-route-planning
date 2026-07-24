import { apiRequest } from "./apiClient";

function toTimestamp(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function normalizeMessage(message = {}) {
  return {
    id: String(message.id || ""),
    role: message.role === "assistant" ? "assistant" : "user",
    content: String(message.content || ""),
    sequence: Number(message.sequence || 0),
    createdAt: toTimestamp(message.createdAt)
  };
}

export function normalizeCloudConversation(conversation = {}) {
  return {
    id: String(conversation.id || ""),
    title: String(conversation.title || "新对话"),
    city: String(conversation.city || ""),
    pinned: Boolean(conversation.pinned),
    archived: Boolean(conversation.archived),
    routeCount: Number(conversation.routeCount || 0),
    messageCount: Number(conversation.messageCount || 0),
    lastPreview: String(conversation.lastPreview || ""),
    createdAt: toTimestamp(conversation.createdAt),
    updatedAt: toTimestamp(conversation.updatedAt),
    messages: Array.isArray(conversation.messages) ? conversation.messages.map(normalizeMessage) : []
  };
}

export async function listCloudConversations() {
  const conversations = await apiRequest("/api/conversations");
  return (Array.isArray(conversations) ? conversations : []).map(normalizeCloudConversation);
}

export async function createCloudConversation(payload = {}) {
  return normalizeCloudConversation(
    await apiRequest("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ title: payload.title || "新对话", city: payload.city || "" })
    })
  );
}

export async function getCloudConversation(conversationId) {
  return normalizeCloudConversation(await apiRequest(`/api/conversations/${conversationId}`));
}

export async function updateCloudConversation(conversationId, changes = {}) {
  const payload = {};
  for (const key of ["title", "city", "pinned", "archived"]) {
    if (Object.hasOwn(changes, key)) payload[key] = changes[key];
  }
  return normalizeCloudConversation(
    await apiRequest(`/api/conversations/${conversationId}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    })
  );
}

export async function appendCloudMessage(conversationId, message = {}) {
  return normalizeMessage(
    await apiRequest(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ role: message.role, content: String(message.content || "") })
    })
  );
}

export async function deleteCloudConversation(conversationId) {
  await apiRequest(`/api/conversations/${conversationId}`, { method: "DELETE" });
}
