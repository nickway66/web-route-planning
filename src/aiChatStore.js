const DB_NAME = "webmap_ai_chat_db";
const DB_VERSION = 1;
const STORE_NAME = "conversations";
const CURRENT_KEY = "webmap_ai_current_conversation_v1";

let dbPromise = null;
let memoryConversations = [];

function createId(prefix = "chat") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return Date.now();
}

function getMessagePreview(messages = []) {
  const last = [...messages].reverse().find((message) => message?.content);
  return String(last?.content || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function getConversationTitle(messages = [], fallback = "新对话") {
  const firstUser = messages.find((message) => message?.role === "user" && message?.content);
  return String(firstUser?.content || fallback).replace(/\s+/g, " ").trim().slice(0, 24) || fallback;
}

function normalizeConversation(conversation = {}) {
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const createdAt = Number(conversation.createdAt || now());
  const updatedAt = Number(conversation.updatedAt || createdAt);
  return {
    id: conversation.id || createId("conv"),
    title: String(conversation.title || getConversationTitle(messages)).trim() || "新对话",
    createdAt,
    updatedAt,
    pinned: Boolean(conversation.pinned),
    archived: Boolean(conversation.archived),
    city: String(conversation.city || "").trim(),
    routeCount: Number(conversation.routeCount || 0),
    messageCount: messages.length,
    lastPreview: getMessagePreview(messages),
    messages
  };
}

function openDB() {
  if (!("indexedDB" in window)) {
    return Promise.resolve(null);
  }
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    console.warn("IndexedDB 初始化失败，AI 历史将临时保存在内存中", error);
    return null;
  });
  return dbPromise;
}

async function withStore(mode, callback) {
  const db = await openDB();
  if (!db) {
    return callback(null);
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const result = callback(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function getCurrentConversationId() {
  try {
    return localStorage.getItem(CURRENT_KEY) || "";
  } catch (error) {
    return "";
  }
}

export function setCurrentConversationId(id) {
  try {
    localStorage.setItem(CURRENT_KEY, id || "");
  } catch (error) {
    // Ignore storage quota/privacy mode errors.
  }
}

export async function listAIConversations() {
  const db = await openDB();
  if (!db) {
    return [...memoryConversations].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const conversations = await withStore("readonly", (store) => requestToPromise(store.getAll()));
  return conversations.map(normalizeConversation).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

export async function getAIConversation(id) {
  const db = await openDB();
  if (!db) {
    return memoryConversations.find((conversation) => conversation.id === id) || null;
  }
  return withStore("readonly", (store) => requestToPromise(store.get(id))).then((conversation) =>
    conversation ? normalizeConversation(conversation) : null
  );
}

export async function upsertAIConversation(conversation) {
  const normalized = normalizeConversation(conversation);
  if (!(await openDB())) {
    const index = memoryConversations.findIndex((item) => item.id === normalized.id);
    if (index >= 0) memoryConversations[index] = normalized;
    else memoryConversations.push(normalized);
    return normalized;
  }
  await withStore("readwrite", (store) => store.put(normalized));
  return normalized;
}

export async function createAIConversation(title = "新对话", messages = []) {
  const timestamp = now();
  const conversation = await upsertAIConversation({
    id: createId("conv"),
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages
  });
  setCurrentConversationId(conversation.id);
  return conversation;
}

export async function saveAIConversationMessages(id, messages = []) {
  let conversation = id ? await getAIConversation(id) : null;
  if (!conversation) {
    conversation = await createAIConversation(getConversationTitle(messages), messages);
  }
  const timestamp = now();
  return upsertAIConversation({
    ...conversation,
    title: conversation.title === "新对话" ? getConversationTitle(messages) : conversation.title,
    updatedAt: timestamp,
    messages
  });
}

export async function renameAIConversation(id, title) {
  const conversation = await getAIConversation(id);
  if (!conversation) return null;
  return upsertAIConversation({ ...conversation, title: String(title || "").trim() || conversation.title });
}

export async function deleteAIConversation(id) {
  if (!id) return null;
  const db = await openDB();
  if (!db) {
    memoryConversations = memoryConversations.filter((conversation) => conversation.id !== id);
  } else {
    await withStore("readwrite", (store) => store.delete(id));
  }
  const remaining = await listAIConversations();
  const next = remaining[0] || (await createAIConversation());
  setCurrentConversationId(next.id);
  return next;
}

export async function clearAIConversations() {
  const db = await openDB();
  if (!db) {
    memoryConversations = [];
  } else {
    await withStore("readwrite", (store) => store.clear());
  }
  return createAIConversation();
}

export async function exportAIConversations() {
  return {
    version: 1,
    exportedAt: now(),
    conversations: await listAIConversations()
  };
}

export async function importAIConversations(data, mode = "append") {
  const conversations = Array.isArray(data?.conversations) ? data.conversations : Array.isArray(data) ? data : [];
  if (!conversations.length) {
    throw new Error("未找到可导入的 AI 对话记录");
  }
  if (mode === "replace") {
    await clearAIConversations();
  }
  let first = null;
  for (const item of conversations) {
    const normalized = normalizeConversation({
      ...item,
      id: createId("conv"),
      title: item.title || getConversationTitle(item.messages || []),
      createdAt: item.createdAt || now(),
      updatedAt: item.updatedAt || now()
    });
    first = first || normalized;
    await upsertAIConversation(normalized);
  }
  if (first) {
    setCurrentConversationId(first.id);
  }
  return first;
}

export async function initAIChatStore(legacyMessages = []) {
  let conversations = await listAIConversations();
  if (!conversations.length) {
    const initialMessages = Array.isArray(legacyMessages) ? legacyMessages : [];
    await createAIConversation(initialMessages.length ? getConversationTitle(initialMessages) : "新对话", initialMessages);
    conversations = await listAIConversations();
  }
  let currentId = getCurrentConversationId();
  let current = currentId ? await getAIConversation(currentId) : null;
  if (!current) {
    current = conversations[0];
    setCurrentConversationId(current.id);
  }
  return {
    conversations,
    currentConversationId: current.id,
    messages: current.messages || []
  };
}
