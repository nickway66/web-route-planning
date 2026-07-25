import "./styles.css";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import Sortable from "sortablejs";
import { AMAP_KEY, AMAP_SECURITY_CODE } from "./config";
import { buildAIRoutes, chatWithAI, exportRouteData, getSearchSuggestions as requestSearchSuggestions, planRoute, searchPOI as requestSearchPOI, setUnauthorizedHandler } from "./apiClient";
import { login, register } from "./authApi";
import { clearAuthSession, getAuthState, setAuthSession, subscribeAuth } from "./authStore";
import { createWorkspaceSync, shouldImportAnonymousWorkspace } from "./cloudSync";
import {
  clearAIConversations,
  createAIConversation,
  deleteAIConversation,
  exportAIConversations,
  getAIConversation,
  importAIConversations,
  initAIChatStore,
  listAIConversations,
  saveAIConversationMessages,
  updateAIConversation
} from "./aiChatStore";
import {
  appendCloudMessage,
  createCloudConversation,
  deleteCloudConversation,
  getCloudConversation,
  listCloudConversations,
  updateCloudConversation
} from "./conversationApi";
import { MapService } from "./mapService";
import { loadHistoryRoutes, loadLayerState, removeHistoryRoute, saveLayerState, upsertHistoryRoute } from "./storage";
import {
  cloneJSON,
  compactPointName,
  createId,
  formatDistance,
  formatDuration,
  nextLayerName,
  pickUniqueColor
} from "./utils";

const TRAVEL_MODES = [
  { value: "driving", label: "驾车" },
  { value: "walking", label: "步行" },
  { value: "transit", label: "公共交通" },
  { value: "riding", label: "骑行" }
];

const THEME_STORAGE_KEY = "webmap_theme_mode_v1";
const AI_CHAT_STORAGE_KEY = "webmap_ai_chat_v1";
const CANVAS_COLOR_FALLBACK = "rgba(7, 18, 36, 0.92)";
const app = document.getElementById("app");
let workspaceSync = null;

const CN_DAY_NUMBER_MAP = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10
};

function loadThemeMode() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "day" ? "day" : "night";
  } catch (error) {
    return "night";
  }
}

function loadAIChatMessages() {
  try {
    const raw = localStorage.getItem(AI_CHAT_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
      .map((item) => ({
        id: item.id,
        role: item.role,
        content: item.content,
        createdAt: item.createdAt,
        routePlaces: Array.isArray(item.routePlaces) ? item.routePlaces : undefined,
        routeDayPlans: Array.isArray(item.routeDayPlans) ? item.routeDayPlans : undefined,
        routeTargetCity: item.routeTargetCity,
        routeActionStatus: item.routeActionStatus,
        routeActionError: item.routeActionError
      }))
      .slice(-80);
  } catch (error) {
    return [];
  }
}

function saveAIChatMessages(messages = []) {
  if (isCloudConversationMode()) {
    return;
  }
  try {
    localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify(messages));
  } catch (error) {
    console.warn("保存AI聊天记录失败", error);
  }
  if (state?.aiConversationId) {
    persistCurrentAIConversation();
  }
}

function escapeHtml(text = "") {
  const source = String(text);
  return source.replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return map[char] || char;
  });
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function dataUrlToUint8Array(dataUrl = "") {
  const base64 = String(dataUrl).split(",")[1] || "";
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function concatUint8Arrays(chunks = []) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.length;
  });
  return result;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}

async function convertDataUrlToJpeg(dataUrl) {
  const image = await loadImageElement(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return {
    dataUrl: canvas.toDataURL("image/jpeg", 0.92),
    width: canvas.width,
    height: canvas.height
  };
}

function createImagePdfBlob(jpegDataUrl, width, height) {
  const encoder = new TextEncoder();
  const imageBytes = dataUrlToUint8Array(jpegDataUrl);
  const pageWidth = 842;
  const pageHeight = 595;
  const margin = 24;
  const scale = Math.min((pageWidth - margin * 2) / width, (pageHeight - margin * 2) / height);
  const drawWidth = Math.round(width * scale * 100) / 100;
  const drawHeight = Math.round(height * scale * 100) / 100;
  const x = Math.round(((pageWidth - drawWidth) / 2) * 100) / 100;
  const y = Math.round(((pageHeight - drawHeight) / 2) * 100) / 100;
  const content = `q\n${drawWidth} 0 0 ${drawHeight} ${x} ${y} cm\n/Im0 Do\nQ\n`;
  const objects = [
    encoder.encode("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    encoder.encode(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`),
    encoder.encode(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`),
    concatUint8Arrays([
      encoder.encode(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`),
      imageBytes,
      encoder.encode("\nendstream\nendobj\n")
    ]),
    encoder.encode(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`)
  ];
  const chunks = [encoder.encode("%PDF-1.4\n")];
  const offsets = [0];
  let offset = chunks[0].length;
  objects.forEach((object) => {
    offsets.push(offset);
    chunks.push(object);
    offset += object.length;
  });
  const xrefOffset = offset;
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((item) => `${String(item).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    `${xrefOffset}`,
    "%%EOF"
  ].join("\n");
  chunks.push(encoder.encode(xref));
  return new Blob([concatUint8Arrays(chunks)], { type: "application/pdf" });
}

function extractJsonObjectText(rawText = "") {
  const text = String(rawText || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!text) {
    return "";
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    return text;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}

function stripMarkdownJsonFence(rawText = "") {
  return String(rawText || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeAIEnvelope(value) {
  return isPlainObject(value) && (
    typeof value.reply === "string" ||
    value.plan ||
    typeof value.type === "string" ||
    Array.isArray(value.days) ||
    Array.isArray(value.routes) ||
    Array.isArray(value.places)
  );
}

function extractBalancedJsonSegments(rawText = "") {
  const text = String(rawText || "");
  const results = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  if (start >= 0 && depth > 0) {
    results.push(text.slice(start));
  }

  return results;
}

function tryParseJsonCandidate(candidate = "") {
  const text = stripMarkdownJsonFence(candidate);
  if (!text) {
    return null;
  }

  const attempts = [text];
  const objectText = extractJsonObjectText(text);
  if (objectText && objectText !== text) {
    attempts.push(objectText);
  }

  for (const item of attempts) {
    try {
      return JSON.parse(item);
    } catch (error) {
      continue;
    }
  }

  return null;
}

function extractAIEnvelope(rawValue) {
  if (looksLikeAIEnvelope(rawValue)) {
    return rawValue;
  }

  const text = typeof rawValue === "string"
    ? rawValue
    : typeof rawValue?.reply === "string"
      ? rawValue.reply
      : "";
  if (!text) {
    return null;
  }

  const candidates = [];
  const trimmed = text.trim();
  if (trimmed) {
    candidates.push(trimmed);
    const stripped = stripMarkdownJsonFence(trimmed);
    if (stripped && stripped !== trimmed) {
      candidates.push(stripped);
    }
  }

  const fencedMatches = text.match(/```(?:json)?\s*[\s\S]*?(?:```|$)/gi) || [];
  fencedMatches.forEach((match) => candidates.push(match));
  extractBalancedJsonSegments(text).forEach((segment) => candidates.push(segment));
  if (typeof rawValue?.reply === "string" && rawValue.reply !== text) {
    candidates.push(rawValue.reply);
  }

  for (const candidate of candidates) {
    const parsed = tryParseJsonCandidate(candidate);
    if (!parsed) {
      continue;
    }
    if (looksLikeAIEnvelope(parsed)) {
      return parsed;
    }
    if (typeof parsed?.reply === "string") {
      const nested = extractAIEnvelope(parsed.reply);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function normalizeAIJsonPlace(place) {
  if (typeof place === "string") {
    const name = normalizeAIRoutePlaceName(place);
    return name ? { name } : null;
  }
  if (!place || typeof place !== "object") {
    return null;
  }
  const name = normalizeAIRoutePlaceName(place.name || place.place || place.title || "");
  if (!name) {
    return null;
  }
  return {
    name,
    duration: String(place.duration || place.playTime || "").trim(),
    cost: String(place.cost || place.price || "").trim(),
    hours: String(place.hours || place.openingHours || "").trim(),
    description: String(place.description || place.intro || place.note || "").trim()
  };
}

function normalizeAIPlan(planLike) {
  const source = looksLikeAIEnvelope(planLike) && planLike.plan ? planLike.plan : planLike;
  if (!source || typeof source !== "object") {
    return null;
  }

  const rawDays = Array.isArray(source.days)
    ? source.days
    : Array.isArray(source.routes)
      ? source.routes
      : Array.isArray(source.itinerary)
        ? source.itinerary
        : Array.isArray(source.places)
          ? [{ day: 1, places: source.places }]
          : [];
  const days = rawDays
    .map((day, index) => {
      const rawPlaces = Array.isArray(day?.places)
        ? day.places
        : Array.isArray(day?.items)
          ? day.items
          : Array.isArray(day)
            ? day
            : [];
      const places = rawPlaces.map(normalizeAIJsonPlace).filter(Boolean);
      return {
        day: Number(day?.day || day?.index || index + 1),
        places
      };
    })
    .filter((day) => day.places.length)
    .slice(0, 10);

  if (!days.length) {
    return null;
  }

  return {
    city: normalizeTransitCity(source.city || source.targetCity || source.destination || ""),
    days
  };
}

function parseAIJsonPlan(rawText = "") {
  const envelope = extractAIEnvelope(rawText);
  if (envelope?.plan) {
    return normalizeAIPlan(envelope.plan);
  }

  const parsed = tryParseJsonCandidate(rawText);
  if (parsed) {
    return normalizeAIPlan(parsed);
  }

  return normalizeAIPlan(envelope);
}

function formatAIJsonVisibleText(plan) {
  return plan.days
    .map((day, dayIndex) => {
      const prefix = plan.days.length > 1 ? `第${day.day || dayIndex + 1}天\n` : "";
      return `${prefix}${day.places
        .map((place) => {
          const lines = [`"${place.name}"`];
          if (place.duration) lines.push(`预估游玩${place.duration}`);
          if (place.cost) lines.push(place.cost);
          if (place.hours) lines.push(`营业时间：${place.hours}`);
          if (place.description) lines.push(place.description);
          return lines.join("\n");
        })
        .join("\n\n")}`;
    })
    .join("\n\n");
}

function extractQuotedPlaceNames(rawText = "") {
  const text = String(rawText || "");
  const quotePatterns = [/"([^"\n]{1,80})"/g, /“([^”\n]{1,80})”/g, /「([^」\n]{1,80})」/g, /『([^』\n]{1,80})』/g];
  const places = [];
  let lastName = "";

  for (const pattern of quotePatterns) {
    for (const match of text.matchAll(pattern)) {
      const normalized = normalizeAIRoutePlaceName(match?.[1] || "")
        .replace(/[，,。；;：:]+$/g, "")
        .trim();

      if (!normalized) {
        continue;
      }
      if (!/[a-zA-Z\u4e00-\u9fa5]/.test(normalized)) {
        continue;
      }
      if (normalized.length < 2) {
        continue;
      }
      if (normalized === lastName) {
        continue;
      }

      places.push(normalized);
      lastName = normalized;
      if (places.length >= 60) {
        return places;
      }
    }
  }

  return places;
}

function parseDayOrderToken(token = "") {
  const text = String(token || "").trim();
  if (!text) {
    return 0;
  }

  const digit = Number.parseInt(text, 10);
  if (Number.isFinite(digit)) {
    return digit;
  }

  if (text === "十") {
    return 10;
  }

  const tenIndex = text.indexOf("十");
  if (tenIndex >= 0) {
    const leftRaw = text.slice(0, tenIndex);
    const rightRaw = text.slice(tenIndex + 1);
    const left = leftRaw ? CN_DAY_NUMBER_MAP[leftRaw] || 0 : 1;
    const right = rightRaw ? CN_DAY_NUMBER_MAP[rightRaw] || 0 : 0;
    return left * 10 + right;
  }

  return CN_DAY_NUMBER_MAP[text] || 0;
}

function extractDailyQuotedPlacePlans(rawText = "") {
  const text = String(rawText || "");
  const lines = text.split(/\r?\n/);
  const dayPlans = [];
  let currentDayIndex = -1;
  let hasDayMarker = false;

  const ensureDayPlan = (index) => {
    while (dayPlans.length <= index) {
      dayPlans.push([]);
    }
  };

  lines.forEach((line) => {
    const dayMatch = line.match(/(?:第\s*([零一二三四五六七八九十两\d]+)\s*天|day\s*([0-9]+)|d\s*([0-9]+))/i);
    if (dayMatch) {
      hasDayMarker = true;
      const token = dayMatch[1] || dayMatch[2] || dayMatch[3] || "";
      const dayNumber = parseDayOrderToken(token);
      currentDayIndex = dayNumber > 0 ? Math.min(dayNumber - 1, 29) : dayPlans.length;
      ensureDayPlan(currentDayIndex);
    }

    const linePlaces = extractQuotedPlaceNames(line);
    if (!linePlaces.length) {
      return;
    }

    if (currentDayIndex < 0) {
      currentDayIndex = 0;
      ensureDayPlan(currentDayIndex);
    }

    const currentDayPlaces = dayPlans[currentDayIndex];
    linePlaces.forEach((name) => {
      if (currentDayPlaces[currentDayPlaces.length - 1] !== name) {
        currentDayPlaces.push(name);
      }
    });
  });

  const cleaned = dayPlans
    .map((places) => places.filter((name) => Boolean(name && String(name).trim())))
    .filter((places) => places.length >= 2)
    .slice(0, 10);

  if (hasDayMarker && cleaned.length >= 2) {
    return cleaned;
  }

  const fallback = extractQuotedPlaceNames(text);
  if (fallback.length >= 2) {
    return [fallback];
  }

  return [];
}

function parseAIPlannedPlaces(rawText = "") {
  const text = String(rawText || "");
  const jsonPlan = parseAIJsonPlan(text);
  if (jsonPlan) {
    const dayPlans = jsonPlan.days.map((day) => day.places.map((place) => place.name));
    const places = dayPlans.flat();
    return {
      visibleText: formatAIJsonVisibleText(jsonPlan),
      places,
      dayPlans,
      targetCity: jsonPlan.city
    };
  }

  const dayPlans = extractDailyQuotedPlacePlans(text);
  const places = dayPlans.flat();
  const visibleText = text.trim();
  return {
    visibleText,
    places: places.length >= 2 ? places : [],
    dayPlans
  };
}

function buildNaturalLanguagePlanReply(plan) {
  if (!plan?.days?.length) {
    return "";
  }

  const title = plan.city ? `为您规划了一条${plan.city}路线：` : "已整理行程建议：";
  const sections = plan.days
    .map((day, dayIndex) => {
      const places = Array.isArray(day?.places) ? day.places.filter((place) => place?.name) : [];
      if (!places.length) {
        return "";
      }

      const placeLines = places.map((place, placeIndex) => {
        const lines = [`${placeIndex + 1}. ${place.name}`];
        if (place.duration) {
          lines.push(`   游玩时长：${place.duration}`);
        }
        if (place.cost) {
          lines.push(`   费用：${place.cost}`);
        }
        if (place.hours) {
          lines.push(`   营业时间：${place.hours}`);
        }
        if (place.description) {
          lines.push(`   简介：${place.description}`);
        }
        return lines.join("\n");
      });

      return [`第${day.day || dayIndex + 1}天：`, ...placeLines].join("\n");
    })
    .filter(Boolean);

  return [title, ...sections].join("\n\n");
}

function getPlanPlaceNames(plan) {
  return (plan?.days || [])
    .flatMap((day) => (Array.isArray(day?.places) ? day.places : []))
    .map((place) => normalizeAIRoutePlaceName(place?.name || ""))
    .filter(Boolean);
}

function replyMentionsPlanPlace(reply = "", plan = null) {
  const compareReply = normalizePlaceForCompare(reply);
  if (!compareReply) {
    return false;
  }

  return getPlanPlaceNames(plan).some((name) => compareReply.includes(normalizePlaceForCompare(name)));
}

function ensureRoutePlanReplyDetails(reply = "", plan = null) {
  const planReply = buildNaturalLanguagePlanReply(plan);
  const cleanedReply = String(reply || "").trim();
  if (!planReply) {
    return cleanedReply;
  }
  if (!cleanedReply) {
    return planReply;
  }

  const hasPlaceMention = replyMentionsPlanPlace(cleanedReply, plan);
  const hasDetailLabels = /(?:游玩时长|费用|营业时间|简介)：/.test(cleanedReply);
  if (cleanedReply.length < 24 || !hasPlaceMention) {
    return planReply;
  }
  if (!hasDetailLabels) {
    return `${cleanedReply}\n\n${planReply}`;
  }
  return cleanedReply;
}

function looksLikeJsonEnvelopeText(rawText = "") {
  const text = String(rawText || "").trim();
  if (!text) {
    return false;
  }
  if (/^```(?:json)?/i.test(text)) {
    return true;
  }
  const envelope = extractAIEnvelope(text);
  return Boolean(envelope && typeof envelope === "object");
}

function sanitizeAssistantReply(rawReply = "", plan = null, type = "") {
  const reply = String(rawReply || "").trim();
  const envelope = extractAIEnvelope(reply);
  if (envelope && envelope !== rawReply) {
    const nestedPlan = normalizeAIPlan(envelope.plan || envelope) || plan;
    const nestedReply = typeof envelope.reply === "string" ? sanitizeAssistantReply(envelope.reply, nestedPlan, envelope.type || type) : "";
    if (nestedReply) {
      return nestedReply;
    }
    if (nestedPlan) {
      return buildNaturalLanguagePlanReply(nestedPlan);
    }
  }

  if (!reply || looksLikeJsonEnvelopeText(reply)) {
    if (plan) {
      return buildNaturalLanguagePlanReply(plan);
    }
    if (type === "cancel_or_negative") {
      return "已取消这次路线添加。";
    }
    return "已收到回复。";
  }

  return reply.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim() || buildNaturalLanguagePlanReply(plan) || "已收到回复。";
}

function deriveRouteMetadataFromPlan(plan) {
  const normalizedPlan = normalizeAIPlan(plan);
  if (!normalizedPlan) {
    return {
      routePlaces: [],
      routeDayPlans: [],
      routeTargetCity: "",
      routeActionStatus: ""
    };
  }

  const routeDayPlans = normalizedPlan.days
    .map((day) => day.places.map((place) => normalizeAIRoutePlaceName(place.name)).filter(Boolean))
    .filter((places) => places.length >= 2);
  const routePlaces = routeDayPlans.flat();

  return {
    routePlaces,
    routeDayPlans,
    routeTargetCity: normalizedPlan.city || "",
    routeActionStatus: routePlaces.length >= 2 ? "pending" : ""
  };
}

function normalizeAIChatResponse(response) {
  const envelope = extractAIEnvelope(response) || (isPlainObject(response) ? response : null);
  const plan = normalizeAIPlan(envelope?.plan || envelope);
  const type = String(envelope?.type || (plan ? "route_plan" : "reply") || "reply").trim() || "reply";
  const replySource = typeof envelope?.reply === "string"
    ? envelope.reply
    : typeof response === "string"
      ? response
      : typeof response?.reply === "string"
        ? response.reply
        : "";
  const reply = type === "route_plan" && plan
    ? ensureRoutePlanReplyDetails(sanitizeAssistantReply(replySource, plan, type), plan)
    : sanitizeAssistantReply(replySource, plan, type);

  return {
    type,
    reply,
    plan
  };
}

function normalizeAIChatMessage(message = {}) {
  if (!message || (message.role !== "user" && message.role !== "assistant")) {
    return { normalized: message, changed: false };
  }

  if (message.role === "user") {
    const content = String(message.content || "");
    const normalized = content === message.content ? message : { ...message, content };
    return { normalized, changed: normalized !== message };
  }

  const normalizedResponse = normalizeAIChatResponse(message.content || "");
  const derivedFromPlan = deriveRouteMetadataFromPlan(normalizedResponse.plan);
  const existingDayPlans = Array.isArray(message.routeDayPlans) ? message.routeDayPlans : [];
  const existingPlaces = Array.isArray(message.routePlaces) ? message.routePlaces : [];
  const routeDayPlans = derivedFromPlan.routeDayPlans.length ? derivedFromPlan.routeDayPlans : existingDayPlans;
  const routePlaces = derivedFromPlan.routePlaces.length ? derivedFromPlan.routePlaces : existingPlaces;
  const routeTargetCity = derivedFromPlan.routeTargetCity || String(message.routeTargetCity || "").trim();
  const routeActionStatus = routePlaces.length >= 2
    ? (message.routeActionStatus || derivedFromPlan.routeActionStatus || "pending")
    : (message.routeActionStatus || "");

  const normalized = {
    ...message,
    content: normalizedResponse.reply,
    routePlaces,
    routeDayPlans,
    routeTargetCity,
    routeActionStatus
  };
  const changed = JSON.stringify({
    content: message.content,
    routePlaces: existingPlaces,
    routeDayPlans: existingDayPlans,
    routeTargetCity: message.routeTargetCity || "",
    routeActionStatus: message.routeActionStatus || ""
  }) !== JSON.stringify({
    content: normalized.content,
    routePlaces: normalized.routePlaces,
    routeDayPlans: normalized.routeDayPlans,
    routeTargetCity: normalized.routeTargetCity,
    routeActionStatus: normalized.routeActionStatus
  });

  return { normalized, changed };
}

function normalizeAIChatMessages(messages = []) {
  let changed = false;
  const normalized = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .map((message) => {
      const result = normalizeAIChatMessage(message);
      changed = changed || result.changed;
      return result.normalized;
    })
    .slice(-80);

  return { messages: normalized, changed };
}

function getAIRouteActionLabel(status = "pending") {
  if (status === "accepted") {
    return "已添加到地图";
  }
  if (status === "rejected") {
    return "已取消添加";
  }
  if (status === "failed") {
    return "添加失败，可重试";
  }
  if (status === "processing") {
    return "正在生成路线...";
  }
  return "是否将路线添加至地图？";
}

function stripAIRouteActionTail(content = "") {
  const labels = [
    getAIRouteActionLabel("accepted"),
    getAIRouteActionLabel("rejected"),
    getAIRouteActionLabel("failed"),
    getAIRouteActionLabel("processing"),
    getAIRouteActionLabel("pending")
  ];
  const pattern = new RegExp(`\\n\\n(?:${labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:[（(][\\s\\S]*[）)])?\\s*$`);
  return String(content || "").replace(pattern, "").trim();
}

function formatMultilineTextHtml(text = "") {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

function normalizeAIRoutePlaceName(name = "") {
  return String(name || "")
    .trim()
    .replace(/^[\d一二三四五六七八九十]+[\.、\)）\-\s]*/, "")
    .replace(/^(起点|终点)\s*[:：]/, "")
    .replace(/\s*(?:\(|（)\s*(?:地铁|公交|驾车|步行|骑行|约|分钟|小时|公里)[^\)）]*(?:\)|）)\s*/g, "")
    .trim();
}

function normalizePlaceForCompare(name = "") {
  return normalizeAIRoutePlaceName(name)
    .toLowerCase()
    .replace(/[\s·・\-—_（）()【】\[\]{}<>《》'"`~!@#$%^&*,，。；;：:\/\\|?]/g, "");
}

function getPointDistanceKm(from, to) {
  if (!from || !to) {
    return Number.POSITIVE_INFINITY;
  }

  const fromLng = Number(from.lng ?? from.location?.[0] ?? from[0]);
  const fromLat = Number(from.lat ?? from.location?.[1] ?? from[1]);
  const toLng = Number(to.lng ?? to.location?.[0] ?? to[0]);
  const toLat = Number(to.lat ?? to.location?.[1] ?? to[1]);
  if (![fromLng, fromLat, toLng, toLat].every(Number.isFinite)) {
    return Number.POSITIVE_INFINITY;
  }

  const rad = Math.PI / 180;
  const dLat = (toLat - fromLat) * rad;
  const dLng = (toLng - fromLng) * rad;
  const lat1 = fromLat * rad;
  const lat2 = toLat * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isPoiCityCompatible(poi, preferredCity = "") {
  const city = normalizeTransitCity(preferredCity || "");
  if (!city) {
    return true;
  }

  const fields = [poi?.city, poi?.province, poi?.district, poi?.address]
    .map((value) => normalizeTransitCity(value || ""))
    .filter(Boolean);
  if (!fields.length) {
    return true;
  }

  return fields.some((field) => field === city || field.includes(city) || city.includes(field));
}

function scoreRoutePOICandidate(poi, targetName, preferredCity = "", context = {}) {
  const target = normalizePlaceForCompare(targetName);
  const poiName = normalizePlaceForCompare(poi?.name || "");
  const poiAddress = normalizePlaceForCompare(poi?.address || "");
  const poiCity = normalizeTransitCity(poi?.city || "");
  const city = normalizeTransitCity(preferredCity || "");

  let score = 0;

  if (target && poiName) {
    if (poiName === target) {
      score += 120;
    } else if (poiName.includes(target) || target.includes(poiName)) {
      score += 70;
    }
  }

  if (target && poiAddress && poiAddress.includes(target)) {
    score += 20;
  }

  if (city) {
    // 港澳台在地图 API 中可能 city 获取为空，需要退而使用 province 等字段，如果匹配直接加分
    const poiProvince = normalizeTransitCity(poi?.province || "");
    const poiDistrict = normalizeTransitCity(poi?.district || "");
    
    if (poiCity === city || poiProvince === city || poiDistrict === city || (city.includes("香港") && (poiCity.includes("香港") || poiProvince.includes("香港")))) {
      score += 45;
    } else if (poiCity && (poiCity.includes(city) || city.includes(poiCity))) {
      score += 25;
    } else if (poiProvince && (poiProvince.includes(city) || city.includes(poiProvince))) {
      score += 25;
    } else {
      // 避免因为 AMap 数据不全把正常 POI 扣掉分
      if (poiCity || poiProvince) {
         score -= 15;
      }
    }
  }

  if (context.anchorPoint && Array.isArray(poi?.location)) {
    const distanceKm = getPointDistanceKm(context.anchorPoint, poi.location);
    if (Number.isFinite(distanceKm)) {
      if (distanceKm <= 3) {
        score += 45;
      } else if (distanceKm <= 15) {
        score += 30;
      } else if (distanceKm <= 60) {
        score += 10;
      } else if (city && !isPoiCityCompatible(poi, city)) {
        score -= 120;
      } else if (distanceKm > 200) {
        score -= 50;
      }
    }
  }

  const lengthGap = Math.abs((poiName || "").length - (target || "").length);
  score -= Math.min(20, lengthGap);

  return score;
}

function pickBestRoutePOI(pois = [], targetName = "", preferredCity = "", context = {}) {
  if (!Array.isArray(pois) || !pois.length) {
    return null;
  }

  const scored = pois
    .map((poi) => ({
      poi,
      score: scoreRoutePOICandidate(poi, targetName, preferredCity, context)
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) {
    return null;
  }

  if (preferredCity && context.anchorPoint && Array.isArray(best.poi?.location)) {
    const distanceKm = getPointDistanceKm(context.anchorPoint, best.poi.location);
    if (distanceKm > 120 && !isPoiCityCompatible(best.poi, preferredCity)) {
      return null;
    }
  }

  return best.poi;
}

function optimizeRoutePointOrder(points = []) {
  if (!Array.isArray(points) || points.length <= 2) {
    return points;
  }

  const ordered = [points[0]];
  const remaining = points.slice(1);
  while (remaining.length) {
    const current = ordered[ordered.length - 1];
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    remaining.forEach((point, index) => {
      const distance = getPointDistanceKm(current, point);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }

  return ordered;
}

function extractCityFromText(text = "") {
  const source = String(text || "");
  const bySuffix = source.match(/([\u4e00-\u9fa5]{2,8})(?:市|特别行政区|自治区)/);
  if (bySuffix?.[1]) {
    return normalizeTransitCity(bySuffix[1]);
  }

  const cityList = [
    "北京",
    "上海",
    "广州",
    "深圳",
    "香港",
    "澳门",
    "台湾",
    "成都",
    "重庆",
    "天津",
    "武汉",
    "西安",
    "杭州",
    "南京",
    "苏州",
    "长沙",
    "郑州",
    "青岛",
    "厦门",
    "福州",
    "昆明",
    "大连",
    "沈阳",
    "哈尔滨",
    "长春",
    "济南",
    "合肥",
    "南昌",
    "南宁",
    "海口",
    "三亚",
    "贵阳",
    "兰州",
    "银川",
    "西宁",
    "拉萨",
    "乌鲁木齐",
    "呼和浩特",
    "石家庄",
    "太原",
    "宁波",
    "无锡",
    "佛山",
    "东莞"
  ];

  const escaped = cityList.map((city) => city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const travelIntentRegex = new RegExp(`(?:^|[\\s，,。；;：:【\[（(])(${escaped})(?:\\s*)(?:一日游|二日游|三日游|路线|行程|旅游|旅行|攻略|打卡)`, "i");
  const travelMatched = source.match(travelIntentRegex);
  if (travelMatched?.[1]) {
    return normalizeTransitCity(travelMatched[1]);
  }

  return "";
}

async function inferAIRouteCity(placeNames = [], textContext = "") {
  const cityFromText = extractCityFromText(textContext);

  const counter = new Map();
  const seeds = placeNames.slice(0, 4);
  for (const rawName of seeds) {
    const name = normalizeAIRoutePlaceName(rawName);
    if (!name) {
      continue;
    }

    try {
      const { pois } = await state.mapService.searchPOI(name, { useMapCity: false });
      pois.slice(0, 3).forEach((poi) => {
        const city = normalizeTransitCity(poi.city || poi.province || poi.district || poi.address || "");
        if (!city) {
          return;
        }
        counter.set(city, (counter.get(city) || 0) + 1);
      });
    } catch (error) {
      continue;
    }
  }

  let bestCity = "";
  let bestScore = 0;
  counter.forEach((score, city) => {
    if (score > bestScore) {
      bestScore = score;
      bestCity = city;
    }
  });

  if (cityFromText && bestCity && cityFromText !== bestCity && bestScore >= 2) {
    return bestCity;
  }

  return cityFromText || bestCity;
}

const state = {
  mapService: null,
  mapReady: false,
  themeMode: loadThemeMode(),
  editorVisible: false,
  newRouteEditorOpen: false,
  searchResults: [],
  searchResultsOpen: false,
  searchSuggestions: [],
  searchSuggestionsOpen: false,
  searchSuggestTimer: null,
  draft: createEmptyDraft(),
  layers: loadLayerState(),
  selectedLayerId: null,
  historyRoutes: loadHistoryRoutes(),
  historyDetailId: null,
  historyOpen: false,
  editHistory: {
    layerId: null,
    undo: [],
    redo: []
  },
  aiChatOpen: false,
  aiChatPending: false,
  aiChatMessages: [],
  aiConversations: [],
  aiConversationId: "",
  aiConversationLoading: false,
  aiConversationError: "",
  aiHistoryOpen: false,
  aiRenamingConversationId: "",
  aiRouteNotice: null,
  pickMode: null,
  toastTimer: null,
  mobileLeftOpen: false,
  mobileRightOpen: false,
  pointSortable: null,
  pendingPointOrders: {},
  authDialogMode: "",
  authPending: false,
  authRequired: false
};

function createEmptyDraft() {
  return {
    start: null,
    vias: [],
    end: null,
    defaultMode: "driving",
    segmentModes: [],
    transitCity: "成都"
  };
}

function createPoint({ name, lng, lat, address = "", city = "" }) {
  return {
    id: createId("pt"),
    name: normalizePointDisplayName(name),
    address,
    city,
    lng: Number(lng),
    lat: Number(lat),
    priority: 1
  };
}

function normalizePointDisplayName(name = "") {
  const text = String(name || "").trim();
  return text.replace(/地图点\s*[\(（]\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*[\)）]/g, "地图点");
}

function normalizeRoute(route, index = 0) {
  const meta = route?.meta || {};
  return {
    id: route?.id || createId("route"),
    visible: route?.visible !== false,
    historyId: route?.historyId || null,
    points: cloneJSON(route?.points || []).map((point) => ({
      ...point,
      name: normalizePointDisplayName(point?.name)
    })),
    segmentModes: cloneJSON(route?.segmentModes || []),
    segments: cloneJSON(route?.segments || []),
    stats: cloneJSON(route?.stats || { distance: 0, duration: 0 }),
    meta: {
      name: meta.name || route?.name || `路线${index + 1}`,
      days: Math.max(1, Number(meta.days || route?.days || 1)),
      note: meta.note || route?.note || ""
    }
  };
}

function ensureLayerRoutes(layer) {
  if (!Array.isArray(layer.routes) || !layer.routes.length) {
    const legacy = layer.route
      ? {
          ...layer.route,
          meta: layer.meta || layer.route.meta || {},
          historyId: layer.historyId || layer.route.historyId || null
        }
      : null;
    layer.routes = legacy ? [normalizeRoute(legacy, 0)] : [];
  }

  layer.routes = layer.routes.map((route, index) => normalizeRoute(route, index));

  if (!layer.selectedRouteId || !layer.routes.some((route) => route.id === layer.selectedRouteId)) {
    layer.selectedRouteId = layer.routes[0]?.id || null;
  }

  const activeRoute = layer.routes.find((route) => route.id === layer.selectedRouteId) || layer.routes[0] || null;
  layer.route = activeRoute;
  layer.meta = activeRoute?.meta || { name: layer.name, days: 1, note: "" };

  return layer;
}

function normalizeLayers(rawLayers = []) {
  if (!Array.isArray(rawLayers)) {
    return [];
  }

  const usedColors = [];
  return rawLayers.map((layer, index) => {
    const normalized = {
      id: layer?.id || createId("layer"),
      name: layer?.name || `路线${index + 1}`,
      color: layer?.color || pickUniqueColor(usedColors),
      visible: layer?.visible !== false,
      routes: layer?.routes,
      selectedRouteId: layer?.selectedRouteId,
      route: layer?.route,
      meta: layer?.meta,
      historyId: layer?.historyId || null
    };
    usedColors.push(normalized.color);
    return ensureLayerRoutes(normalized);
  });
}

function serializeLayersForStorage() {
  return state.layers.map((layer) => {
    const safeLayer = ensureLayerRoutes(layer);
    return {
      id: safeLayer.id,
      name: safeLayer.name,
      color: safeLayer.color,
      visible: safeLayer.visible !== false,
      selectedRouteId: safeLayer.selectedRouteId,
      routes: safeLayer.routes.map((route) => ({
        id: route.id,
        visible: route.visible !== false,
        historyId: route.historyId || null,
        points: cloneJSON(route.points || []),
        segmentModes: cloneJSON(route.segmentModes || []),
        segments: cloneJSON(route.segments || []),
        stats: cloneJSON(route.stats || { distance: 0, duration: 0 }),
        meta: cloneJSON(route.meta || { name: "未命名路线", days: 1, note: "" })
      }))
    };
  });
}

function persistLayersState() {
  const auth = getAuthState();
  const userId = auth.isAuthenticated ? String(auth.user?.id || "") : "";
  saveLayerState(serializeLayersForStorage(), userId);
  if (auth.isAuthenticated) {
    workspaceSync?.scheduleWorkspaceSave();
  }
}

function switchLayerCache(userId = "") {
  state.layers = normalizeLayers(loadLayerState(userId));
  if (state.selectedLayerId && !state.layers.some((layer) => layer.id === state.selectedLayerId)) {
    state.selectedLayerId = null;
  }
  rebuildLayers();
  renderLeftPanel();
  renderRightPanel();
}

function applyCloudLayers(layers) {
  state.layers = normalizeLayers(layers);
  if (state.selectedLayerId && !state.layers.some((layer) => layer.id === state.selectedLayerId)) {
    state.selectedLayerId = null;
  }
  persistLayersState();
  rebuildLayers();
  renderLeftPanel();
  renderRightPanel();
}

async function syncWorkspaceAfterLogin(anonymousLayers = []) {
  if (!workspaceSync) {
    return;
  }
  const cloudWorkspace = await workspaceSync.loadCloudWorkspace();
  if (!cloudWorkspace || !shouldImportAnonymousWorkspace(cloudWorkspace, anonymousLayers)) {
    return;
  }
  if (window.confirm("云端路线为空，是否导入当前设备上的本地路线？")) {
    const importedWorkspace = await workspaceSync.importLocalWorkspace({ dataVersion: 1, layers: anonymousLayers });
    if (Array.isArray(importedWorkspace?.layers)) {
      applyCloudLayers(importedWorkspace.layers);
    }
  }
}

function getLayerSnapshot(layer) {
  if (!layer) {
    return null;
  }
  ensureLayerRoutes(layer);
  return cloneJSON({
    id: layer.id,
    name: layer.name,
    routes: layer.routes,
    selectedRouteId: layer.selectedRouteId
  });
}

function applyLayerSnapshot(snapshot) {
  if (!snapshot) {
    return null;
  }
  const layer = state.layers.find((item) => item.id === snapshot.id);
  if (!layer) {
    return null;
  }
  layer.name = snapshot.name;
  layer.routes = cloneJSON(snapshot.routes || []);
  layer.selectedRouteId = snapshot.selectedRouteId || layer.routes[0]?.id || null;
  ensureLayerRoutes(layer);
  return layer;
}

function ensureEditHistory(layerId) {
  if (state.editHistory.layerId !== layerId) {
    state.editHistory = {
      layerId,
      undo: [],
      redo: []
    };
  }
}

function pushEditHistory(layer) {
  if (!layer) {
    return;
  }
  ensureEditHistory(layer.id);
  const snapshot = getLayerSnapshot(layer);
  if (!snapshot) {
    return;
  }
  state.editHistory.undo.push(snapshot);
  if (state.editHistory.undo.length > 40) {
    state.editHistory.undo.shift();
  }
  state.editHistory.redo = [];
}

function undoLayerEdit() {
  const layer = getSelectedLayer();
  if (!layer) {
    return;
  }
  ensureEditHistory(layer.id);
  const snapshot = state.editHistory.undo.pop();
  if (!snapshot) {
    setToast("没有可后退的操作", "info");
    return;
  }
  const current = getLayerSnapshot(layer);
  if (current) {
    state.editHistory.redo.push(current);
  }
  const restored = applyLayerSnapshot(snapshot);
  if (restored) {
    rebuildLayers();
    persistLayersState();
    renderLeftPanel();
    renderRightPanel();
  }
}

function redoLayerEdit() {
  const layer = getSelectedLayer();
  if (!layer) {
    return;
  }
  ensureEditHistory(layer.id);
  const snapshot = state.editHistory.redo.pop();
  if (!snapshot) {
    setToast("没有可前进的操作", "info");
    return;
  }
  const current = getLayerSnapshot(layer);
  if (current) {
    state.editHistory.undo.push(current);
  }
  const restored = applyLayerSnapshot(snapshot);
  if (restored) {
    rebuildLayers();
    persistLayersState();
    renderLeftPanel();
    renderRightPanel();
  }
}

function getCheckedExportLayers() {
  return state.layers
    .filter((layer) => layer.visible !== false)
    .map((layer) => {
      const safeLayer = ensureLayerRoutes(layer);
      const routes = safeLayer.routes.filter((route) => route.visible !== false);
      if (!routes.length) {
        return null;
      }
      return {
        ...cloneJSON(safeLayer),
        routes: cloneJSON(routes),
        route: cloneJSON(routes[0]),
        selectedRouteId: routes[0]?.id || null
      };
    })
    .filter(Boolean);
}

function countExportRoutes(layers = []) {
  return layers.reduce((sum, layer) => sum + (Array.isArray(layer.routes) ? layer.routes.length : 0), 0);
}

function createGpxFromLayers(exportLayers = []) {
  let gpxData = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Voyage Plan">
`;
  exportLayers.forEach((layer) => {
    if (!layer.routes) return;
    layer.routes.forEach((route) => {
      const nameEscaped = (route.meta?.name || layer.name || "未命名路线")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      gpxData += `  <trk>\n    <name>${nameEscaped}</name>\n    <trkseg>\n`;

      if (route.segments && route.segments.length) {
        route.segments.forEach((segment) => {
          if (segment.path && segment.path.length) {
            segment.path.forEach((pt) => {
              const lng = Array.isArray(pt) ? pt[0] : pt.lng || pt.getLng();
              const lat = Array.isArray(pt) ? pt[1] : pt.lat || pt.getLat();
              gpxData += `      <trkpt lat="${lat}" lon="${lng}"></trkpt>\n`;
            });
          }
        });
      } else if (route.points && route.points.length) {
        route.points.forEach((pt) => {
          const ptName = pt.name
            ? `<name>${pt.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</name>`
            : "";
          gpxData += `      <trkpt lat="${pt.lat}" lon="${pt.lng}">${ptName}</trkpt>\n`;
        });
      }
      gpxData += `    </trkseg>\n  </trk>\n`;
    });
  });
  gpxData += `</gpx>`;
  return gpxData;
}

function patchUnsupportedCanvasColors(root) {
  if (!root) {
    return;
  }

  const ownerWindow = root.ownerDocument?.defaultView || window;
  const colorProps = [
    "color",
    "background-color",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "outline-color",
    "text-decoration-color",
    "column-rule-color",
    "caret-color",
    "fill",
    "stroke",
    "box-shadow",
    "text-shadow"
  ];
  const hasUnsupportedColor = (value = "") => /(color|color-mix|oklch|lab|lch)\(/i.test(String(value));
  const nodes = [root, ...root.querySelectorAll("*")];
  nodes.forEach((node) => {
    const style = node.getAttribute?.("style");
    if (style && /(color|color-mix|oklch|lab|lch)\(/i.test(style)) {
      node.setAttribute(
        "style",
        style
          .replace(/color-mix\([^)]+\)/gi, CANVAS_COLOR_FALLBACK)
          .replace(/color\([^)]+\)/gi, CANVAS_COLOR_FALLBACK)
          .replace(/oklch\([^)]+\)/gi, CANVAS_COLOR_FALLBACK)
          .replace(/lab\([^)]+\)/gi, CANVAS_COLOR_FALLBACK)
          .replace(/lch\([^)]+\)/gi, CANVAS_COLOR_FALLBACK)
      );
    }

    if (!node.style || typeof ownerWindow.getComputedStyle !== "function") {
      return;
    }

    const computed = ownerWindow.getComputedStyle(node);
    colorProps.forEach((prop) => {
      const value = computed.getPropertyValue(prop);
      if (!hasUnsupportedColor(value)) {
        return;
      }

      if (prop.includes("shadow")) {
        node.style.setProperty(prop, "none", "important");
      } else if (prop === "background-color") {
        node.style.setProperty(prop, "transparent", "important");
      } else if (prop === "fill" || prop === "stroke") {
        node.style.setProperty(prop, "currentColor", "important");
      } else {
        node.style.setProperty(prop, CANVAS_COLOR_FALLBACK, "important");
      }
    });

    const backgroundImage = computed.getPropertyValue("background-image");
    if (hasUnsupportedColor(backgroundImage)) {
      node.style.setProperty("background-image", "none", "important");
    }
    const filter = computed.getPropertyValue("filter");
    if (hasUnsupportedColor(filter)) {
      node.style.setProperty("filter", "none", "important");
    }
  });
}

async function exportCheckedRoutesAsMap(format, exportLayers = []) {
  if (!isMapReady()) {
    throw new Error("地图尚未加载完成");
  }

  const oldSearchResultsOpen = state.searchResultsOpen;
  const oldBodyExporting = document.body.classList.contains("export-capturing");
  const oldViewState = state.mapService.getViewState?.();
  state.searchResultsOpen = false;
  renderSearchResults();
  state.mapService.clearSearchMarkers();
  rebuildLayers();

  try {
    document.body.classList.add("export-capturing");
    state.mapService.fitLayers(exportLayers);
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    const target = document.getElementById("map");
    if (!target) {
      throw new Error("未找到地图容器，无法导出");
    }
    const canvas = await Promise.race([
      html2canvas(target, {
        backgroundColor: null,
        useCORS: true,
        allowTaint: false,
        logging: false,
        scale: Math.min(2, window.devicePixelRatio || 1),
        onclone: (documentClone) => {
          documentClone.querySelectorAll("style").forEach((styleNode) => {
            styleNode.textContent = String(styleNode.textContent || "")
              .replace(/color-mix\([^)]+\)/gi, CANVAS_COLOR_FALLBACK)
              .replace(/color\([^)]+\)/gi, CANVAS_COLOR_FALLBACK)
              .replace(/oklch\([^)]+\)/gi, CANVAS_COLOR_FALLBACK)
              .replace(/lab\([^)]+\)/gi, CANVAS_COLOR_FALLBACK)
              .replace(/lch\([^)]+\)/gi, CANVAS_COLOR_FALLBACK);
          });
          patchUnsupportedCanvasColors(documentClone.getElementById("map"));
        }
      }),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("地图截图生成超时")), 12000))
    ]);
    if (!canvas.width || !canvas.height) {
      throw new Error("地图截图为空");
    }

    if (format === "png") {
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => {
          if (value) {
            resolve(value);
          } else {
            reject(new Error("地图截图生成失败"));
          }
        }, "image/png");
      });
      downloadBlob(blob, "voyage_routes_map.png");
      return;
    }

    const imageData = canvas.toDataURL("image/jpeg", 0.92);
    const orientation = canvas.width >= canvas.height ? "landscape" : "portrait";
    const pdf = new jsPDF({ orientation, unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 24;
    const scale = Math.min((pageWidth - margin * 2) / canvas.width, (pageHeight - margin * 2) / canvas.height);
    const width = canvas.width * scale;
    const height = canvas.height * scale;
    pdf.addImage(imageData, "JPEG", (pageWidth - width) / 2, (pageHeight - height) / 2, width, height);
    pdf.save("voyage_routes_map.pdf");
  } finally {
    if (!oldBodyExporting) {
      document.body.classList.remove("export-capturing");
    }
    state.mapService.restoreViewState?.(oldViewState);
    state.searchResultsOpen = oldSearchResultsOpen;
    renderSearchResults();
    if (oldSearchResultsOpen && state.searchResults.length) {
      state.mapService.renderSearchMarkers(state.searchResults, (poi) => {
        setToast(`已选中：${poi.name}`);
      });
    }
  }
}

function getThemeToggleIcon(mode) {
  return mode === "day" ? "🌙" : "☀️";
}

function applyThemeMode(mode, persist = true) {
  const normalized = mode === "day" ? "day" : "night";
  state.themeMode = normalized;
  document.body.dataset.theme = normalized;

  const btn = document.getElementById("theme-toggle-btn");
  if (btn) {
    btn.textContent = getThemeToggleIcon(normalized);
    btn.setAttribute("aria-label", normalized === "day" ? "切换到夜间模式" : "切换到白天模式");
    btn.title = normalized === "day" ? "切换到夜间模式" : "切换到白天模式";
  }

  if (state.mapService) {
    state.mapService.setThemeMode(normalized);
  }

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, normalized);
    } catch (error) {
      console.warn("保存主题设置失败", error);
    }
  }
}

function toggleThemeMode() {
  applyThemeMode(state.themeMode === "day" ? "night" : "day", true);
}

function setToast(message, type = "info") {
  const toast = document.getElementById("status-toast");
  if (!toast) {
    return;
  }
  toast.textContent = message;
  toast.dataset.type = type;
  toast.classList.add("show");
  if (state.toastTimer) {
    window.clearTimeout(state.toastTimer);
  }
  state.toastTimer = window.setTimeout(() => {
    toast.classList.remove("show");
  }, 2600);
}

function setAIRouteNotice(message = "") {
  state.aiRouteNotice = {
    type: "danger",
    title: "路线添加失败",
    message: String(message || "请检查后端路线规划服务后重试。")
  };
  renderAIRouteNotice();
}

function clearAIRouteNotice() {
  state.aiRouteNotice = null;
  renderAIRouteNotice();
}

function renderAIRouteNotice() {
  const notice = document.getElementById("ai-route-notice");
  if (!notice) {
    return;
  }
  if (!state.aiRouteNotice) {
    notice.classList.add("hidden");
    notice.innerHTML = "";
    return;
  }
  notice.classList.remove("hidden");
  notice.dataset.type = state.aiRouteNotice.type || "info";
  notice.innerHTML = `
    <div>
      <strong>${escapeHtml(state.aiRouteNotice.title || "路线状态")}</strong>
      <p>${escapeHtml(state.aiRouteNotice.message || "")}</p>
    </div>
    <button data-action="close-ai-route-notice" class="icon-btn" type="button" aria-label="关闭">×</button>
  `;
}

function showFloatingTooltip(target, text = "") {
  const tooltip = document.getElementById("floating-tooltip");
  if (!tooltip || !target || !text) {
    return;
  }

  const rect = target.getBoundingClientRect();
  tooltip.textContent = text;
  tooltip.classList.remove("hidden");
  tooltip.style.left = "0px";
  tooltip.style.top = "0px";

  const tooltipRect = tooltip.getBoundingClientRect();
  const gap = 10;
  let left = rect.left - tooltipRect.width - gap;
  let top = rect.top + rect.height / 2 - tooltipRect.height / 2;

  if (left < gap) {
    left = rect.right + gap;
  }
  left = Math.min(Math.max(gap, left), window.innerWidth - tooltipRect.width - gap);
  top = Math.min(Math.max(gap, top), window.innerHeight - tooltipRect.height - gap);

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideFloatingTooltip() {
  const tooltip = document.getElementById("floating-tooltip");
  if (!tooltip) {
    return;
  }
  tooltip.classList.add("hidden");
  tooltip.textContent = "";
}

function isCloudConversationMode() {
  return getAuthState().isAuthenticated;
}

function appendMessageToState(message, extras = {}) {
  const normalizedInput = message.role === "assistant"
    ? normalizeAIChatMessage({ ...message, ...extras }).normalized
    : { ...message, content: String(message.content || "").trim(), ...extras };
  const text = String(normalizedInput.content || "").trim();
  if (!text) return null;
  const storedMessage = {
    id: normalizedInput.id || createId("chat"),
    role: normalizedInput.role,
    content: text,
    createdAt: Number(normalizedInput.createdAt || Date.now()),
    ...normalizedInput
  };
  state.aiChatMessages.push(storedMessage);
  if (state.aiChatMessages.length > 80) {
    state.aiChatMessages = state.aiChatMessages.slice(-80);
  }
  return storedMessage;
}

function pushAIChatMessage(role, content, extras = {}) {
  const message = appendMessageToState({ id: createId("chat"), role, content, createdAt: Date.now() }, extras);
  if (message && !isCloudConversationMode()) saveAIChatMessages(state.aiChatMessages);
  return message;
}

function clearPendingAIRouteActions() {
  let changed = false;
  state.aiChatMessages.forEach((message) => {
    if (message?.role !== "assistant" || !["pending", "failed"].includes(message.routeActionStatus)) {
      return;
    }
    message.routeActionStatus = "rejected";
    message.routeActionError = "";
    message.content = stripAIRouteActionTail(message.content);
    changed = true;
  });
  if (changed) {
    clearAIRouteNotice();
    saveAIChatMessages(state.aiChatMessages);
  }
}

function listCurrentAIConversations() {
  return isCloudConversationMode() ? listCloudConversations() : listAIConversations();
}

function getCurrentAIConversation(id) {
  return isCloudConversationMode() ? getCloudConversation(id) : getAIConversation(id);
}

function refreshAIConversations() {
  return listCurrentAIConversations()
    .then(async (conversations) => {
      const normalizedConversations = isCloudConversationMode()
        ? conversations
        : await normalizeAllStoredAIConversations(conversations);
      state.aiConversations = normalizedConversations;
      return normalizedConversations;
    })
    .catch((error) => {
      console.warn("刷新 AI 会话列表失败", error);
      state.aiConversationError = error.message || "AI 对话同步失败";
      return [];
    });
}

function persistCurrentAIConversation() {
  if (isCloudConversationMode()) return Promise.resolve(null);
  return saveAIConversationMessages(state.aiConversationId, state.aiChatMessages)
    .then((conversation) => {
      state.aiConversationId = conversation.id;
      return refreshAIConversations();
    })
    .catch((error) => {
      console.warn("保存 AI 会话失败", error);
    });
}

async function createAIChatSubmission() {
  const mode = isCloudConversationMode() ? "cloud" : "local";
  const authToken = mode === "cloud" ? getAuthState().token : "";
  const authGeneration = aiConversationAuthGeneration;
  const selectionGeneration = aiConversationSelectionGeneration;
  let conversationId = state.aiConversationId;
  const submission = { mode, authToken, authGeneration, selectionGeneration, conversationId };
  if (!conversationId) {
    const conversation = mode === "cloud" ? await createCloudConversation() : await createAIConversation();
    submission.conversationId = conversation.id;
    if (!isCurrentAIChatCreation(submission)) return null;
    if (!state.aiConversationId) {
      state.aiConversationId = submission.conversationId;
      state.aiConversations = [conversation, ...state.aiConversations];
    }
  }
  return submission;
}

function isCurrentAIChatSubmission(submission) {
  if (submission.authGeneration !== aiConversationAuthGeneration) return false;
  if (submission.mode === "cloud") {
    return isCloudConversationMode() && getAuthState().token === submission.authToken;
  }
  return !isCloudConversationMode();
}

function isCurrentAIChatCreation(submission) {
  return isCurrentAIChatSubmission(submission)
    && submission.selectionGeneration === aiConversationSelectionGeneration;
}

async function appendSubmissionMessage(submission, role, content, extras = {}) {
  if (!isCurrentAIChatSubmission(submission)) return null;
  if (submission.mode === "cloud") {
    const stored = await appendCloudMessage(submission.conversationId, { role, content });
    if (!isCurrentAIChatSubmission(submission)) return null;
    if (state.aiConversationId === submission.conversationId) {
      appendMessageToState(stored, extras);
    }
    await refreshAIConversations();
    return stored;
  }

  const conversation = await getAIConversation(submission.conversationId);
  if (!conversation || !isCurrentAIChatSubmission(submission)) return null;
  const message = {
    id: createId("chat"),
    role,
    content: String(content || "").trim(),
    createdAt: Date.now(),
    ...extras
  };
  if (!message.content) return null;
  const messages = [...conversation.messages, message].slice(-80);
  await saveAIConversationMessages(submission.conversationId, messages);
  if (!isCurrentAIChatSubmission(submission)) return null;
  if (state.aiConversationId === submission.conversationId) {
    state.aiChatMessages = messages;
  }
  await refreshAIConversations();
  return message;
}

async function getSubmissionMessages(submission) {
  if (!isCurrentAIChatSubmission(submission)) return null;
  const conversation = submission.mode === "cloud"
    ? await getCloudConversation(submission.conversationId)
    : await getAIConversation(submission.conversationId);
  if (!conversation || !isCurrentAIChatSubmission(submission)) return null;
  return conversation.messages || [];
}

function captureAIConversationCreation() {
  const mode = isCloudConversationMode() ? "cloud" : "local";
  return {
    mode,
    authToken: mode === "cloud" ? getAuthState().token : "",
    authGeneration: aiConversationAuthGeneration,
    selectionGeneration: aiConversationSelectionGeneration
  };
}

function isCurrentAIConversationCreation(creation) {
  return isCurrentAIChatSubmission(creation)
    && creation.selectionGeneration === aiConversationSelectionGeneration;
}

async function createCurrentAIConversation(creation) {
  const conversation = creation.mode === "cloud" ? await createCloudConversation() : await createAIConversation();
  return isCurrentAIConversationCreation(creation) ? conversation : null;
}

async function updateCurrentAIConversation(id, changes) {
  if (isCloudConversationMode()) return updateCloudConversation(id, changes);
  return updateAIConversation(id, changes);
}

async function deleteCurrentAIConversation(id) {
  if (isCloudConversationMode()) {
    await deleteCloudConversation(id);
    return null;
  }
  return deleteAIConversation(id);
}

async function normalizeConversationMessagesIfNeeded(conversation, options = {}) {
  if (!conversation) {
    return conversation;
  }

  const result = normalizeAIChatMessages(conversation.messages || []);
  if (!result.changed) {
    return {
      ...conversation,
      messages: result.messages
    };
  }

  if (options.persist !== false && !isCloudConversationMode()) {
    await saveAIConversationMessages(conversation.id, result.messages);
  }

  return {
    ...conversation,
    messages: result.messages
  };
}

async function normalizeAllStoredAIConversations(conversations = []) {
  const normalized = [];
  for (const conversation of conversations) {
    normalized.push(await normalizeConversationMessagesIfNeeded(conversation));
  }
  return normalized;
}

let aiConversationLoadGeneration = 0;
let aiConversationAuthGeneration = 0;
let aiConversationSelectionGeneration = 0;

async function switchAIConversationStore() {
  aiConversationSelectionGeneration += 1;
  const generation = ++aiConversationLoadGeneration;
  state.aiConversationLoading = true;
  state.aiConversationError = "";
  state.aiHistoryOpen = false;
  state.aiRenamingConversationId = "";
  state.aiConversations = [];
  state.aiConversationId = "";
  state.aiChatMessages = [];
  renderAIChatPanel();

  try {
    if (isCloudConversationMode()) {
      const conversations = await listCloudConversations();
      if (generation !== aiConversationLoadGeneration || !isCloudConversationMode()) return;
      state.aiConversations = conversations;
      const current = conversations[0] ? await getCloudConversation(conversations[0].id) : null;
      if (generation !== aiConversationLoadGeneration || !isCloudConversationMode()) return;
      state.aiConversationId = current?.id || "";
      state.aiChatMessages = current ? normalizeAIChatMessages(current.messages).messages : [];
    } else {
      const localState = await initAIChatStore();
      if (generation !== aiConversationLoadGeneration || isCloudConversationMode()) return;
      state.aiConversations = await normalizeAllStoredAIConversations(localState.conversations);
      state.aiConversationId = localState.currentConversationId;
      state.aiChatMessages = normalizeAIChatMessages(localState.messages).messages;
    }
  } catch (error) {
    if (generation !== aiConversationLoadGeneration) return;
    state.aiConversations = [];
    state.aiConversationId = "";
    state.aiChatMessages = [];
    state.aiConversationError = error.message || "AI 对话加载失败";
  } finally {
    if (generation === aiConversationLoadGeneration) {
      state.aiConversationLoading = false;
      renderAIChatPanel();
    }
  }
}

function getEditorOverlayOpenState() {
  const layer = getSelectedLayer();
  const editorOpen = state.newRouteEditorOpen || Boolean(layer && layer.route && state.editorVisible);
  return editorOpen || state.aiChatOpen;
}

async function submitAIChat() {
  if (state.aiChatPending) {
    return;
  }

  const input = document.getElementById("ai-chat-input");
  const question = String(input?.value || "").trim();
  if (!question) {
    return;
  }

  state.aiChatPending = true;
  input.value = "";
  renderAIChatPanel();

  try {
    const submission = await createAIChatSubmission();
    if (!submission || !isCurrentAIChatSubmission(submission)) return;
    await appendSubmissionMessage(submission, "user", question);
    const submissionMessages = await getSubmissionMessages(submission);
    if (!submissionMessages) return;
    const response = normalizeAIChatResponse(await chatWithAI(submissionMessages));
    if (!isCurrentAIChatSubmission(submission)) return;
    const answer = response.reply || "";
    const plan = response.plan || null;
    const routeMeta = deriveRouteMetadataFromPlan(plan);
    if (response.type === "route_plan" && plan) {
      const dayPlans = routeMeta.routeDayPlans;
      const places = routeMeta.routePlaces;
      if (places.length < 2) {
        await appendSubmissionMessage(submission, "assistant", answer);
        return;
      }
      const assistantContent = answer;
      await appendSubmissionMessage(submission, "assistant", assistantContent, {
        routePlaces: places,
        routeDayPlans: dayPlans,
        routeTargetCity: routeMeta.routeTargetCity,
        routeActionStatus: "pending"
      });
    } else if (response.type === "cancel_or_negative") {
      if (state.aiConversationId === submission.conversationId) clearPendingAIRouteActions();
      await appendSubmissionMessage(submission, "assistant", answer);
    } else {
      await appendSubmissionMessage(submission, "assistant", answer);
    }
  } catch (error) {
    setToast(error.message || "AI 请求失败，已保留已发送的问题", "danger");
  } finally {
    state.aiChatPending = false;
    renderAIChatPanel();
  }
}

function toggleAIChatPanel() {
  const nextOpen = !state.aiChatOpen;
  state.aiChatOpen = nextOpen;

  if (nextOpen) {
    state.newRouteEditorOpen = false;
    state.editorVisible = false;
    state.mobileRightOpen = false;
  }

  renderRightPanel();
  renderAIChatPanel();
}

function closeAIChatForRouteEdit() {
  if (!state.aiChatOpen) {
    return;
  }
  state.aiChatOpen = false;
  renderAIChatPanel();
}

async function handleAIChatAction(event) {
  const target = event.target.closest("[data-ai-action]");
  if (!target) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();

  const action = target.dataset.aiAction;
  if (action === "toggle") {
    toggleAIChatPanel();
    return;
  }

  if (action === "clear-history") {
    if (!state.aiChatMessages.length) {
      setToast("当前没有历史对话", "info");
      return;
    }

    const ok = window.confirm("确认清除全部历史对话吗？");
    if (!ok) {
      return;
    }

    aiConversationSelectionGeneration += 1;
    const creation = captureAIConversationCreation();

    if (isCloudConversationMode()) {
      try {
        const conversationId = state.aiConversationId;
        if (conversationId) await deleteCloudConversation(conversationId);
        if (!isCurrentAIConversationCreation(creation)) return;
        const conversation = await createCurrentAIConversation(creation);
        if (!conversation || !isCurrentAIConversationCreation(creation)) return;
        state.aiConversationId = conversation.id;
        state.aiChatMessages = [];
        await refreshAIConversations();
        renderAIChatPanel();
        setToast("当前云端对话已清空", "success");
      } catch (error) {
        setToast(error.message || "清空云端对话失败", "danger");
      }
      return;
    }

    state.aiChatMessages = [];
    saveAIChatMessages(state.aiChatMessages);
    renderAIChatPanel();
    setToast("历史对话已清除", "success");
    return;
  }

  if (action === "toggle-history") {
    state.aiHistoryOpen = !state.aiHistoryOpen;
    await refreshAIConversations();
    renderAIChatPanel();
    return;
  }

  if (action === "new-conversation") {
    aiConversationSelectionGeneration += 1;
    const creation = captureAIConversationCreation();
    const conversation = await createCurrentAIConversation(creation);
    if (!conversation || !isCurrentAIConversationCreation(creation)) return;
    state.aiConversationId = conversation.id;
    state.aiChatMessages = [];
    state.aiHistoryOpen = true;
    await refreshAIConversations();
    renderAIChatPanel();
    setToast("已新建 AI 对话", "success");
    return;
  }

  if (action === "select-conversation") {
    aiConversationSelectionGeneration += 1;
    const conversation = await normalizeConversationMessagesIfNeeded(await getCurrentAIConversation(target.dataset.conversationId));
    if (!conversation) {
      setToast("未找到该对话", "warning");
      return;
    }
    state.aiConversationId = conversation.id;
    state.aiChatMessages = conversation.messages || [];
    state.aiHistoryOpen = false;
    renderAIChatPanel();
    return;
  }

  if (action === "rename-conversation") {
    const conversation = await normalizeConversationMessagesIfNeeded(await getCurrentAIConversation(target.dataset.conversationId), { persist: false });
    if (!conversation) {
      return;
    }
    if (state.aiRenamingConversationId && state.aiRenamingConversationId !== conversation.id) {
      const input = document.querySelector(`[data-ai-rename-input="${state.aiRenamingConversationId}"]`);
      const previousTitle = input?.value?.trim();
      if (previousTitle) {
        await updateCurrentAIConversation(state.aiRenamingConversationId, { title: previousTitle });
        state.aiConversations = state.aiConversations.map((item) =>
          item.id === state.aiRenamingConversationId ? { ...item, title: previousTitle } : item
        );
      }
    }
    state.aiRenamingConversationId = conversation.id;
    renderAIChatPanel();
    window.setTimeout(() => {
      const input = document.querySelector(`[data-ai-rename-input="${conversation.id}"]`);
      input?.focus();
      input?.select();
    }, 0);
    return;
  }

  if (action === "cancel-rename-conversation") {
    state.aiRenamingConversationId = "";
    renderAIChatPanel();
    return;
  }

  if (action === "save-rename-conversation") {
    const conversationId = target.dataset.conversationId;
    const input = document.querySelector(`[data-ai-rename-input="${conversationId}"]`);
    const nextTitle = input?.value?.trim();
    if (nextTitle) {
      await updateCurrentAIConversation(conversationId, { title: nextTitle });
      state.aiConversations = state.aiConversations.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, title: nextTitle } : conversation
      );
    }
    state.aiRenamingConversationId = "";
    renderAIChatPanel();
    return;
  }

  if (action === "toggle-pin-conversation" || action === "toggle-archive-conversation") {
    const conversationId = target.dataset.conversationId;
    const conversation = state.aiConversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    const field = action === "toggle-pin-conversation" ? "pinned" : "archived";
    const updated = await updateCurrentAIConversation(conversationId, { [field]: !conversation[field] });
    state.aiConversations = state.aiConversations.map((item) => item.id === conversationId ? { ...item, ...updated } : item);
    await refreshAIConversations();
    renderAIChatPanel();
    return;
  }

  if (action === "delete-conversation") {
    aiConversationSelectionGeneration += 1;
    const conversation = await normalizeConversationMessagesIfNeeded(await getCurrentAIConversation(target.dataset.conversationId), { persist: false });
    if (!conversation) {
      return;
    }
    const ok = window.confirm(`确认删除 AI 对话“${conversation.title}”吗？`);
    if (!ok) {
      return;
    }
    const next = await deleteCurrentAIConversation(conversation.id);
    const remaining = await refreshAIConversations();
    const nextConversation = next || remaining[0] || null;
    state.aiConversationId = nextConversation?.id || "";
    state.aiChatMessages = nextConversation
      ? normalizeAIChatMessages((await getCurrentAIConversation(nextConversation.id)).messages).messages
      : [];
    renderAIChatPanel();
    return;
  }

  if (action === "export-conversations") {
    if (isCloudConversationMode()) {
      const summaries = await listCloudConversations();
      const conversations = await Promise.all(summaries.map((conversation) => getCloudConversation(conversation.id)));
      downloadBlob(
        new Blob([JSON.stringify({ version: 1, exportedAt: Date.now(), conversations }, null, 2)], { type: "application/json" }),
        "webmap_ai_conversations.json"
      );
      return;
    }
    const payload = await exportAIConversations();
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), "webmap_ai_conversations.json");
    return;
  }

  if (action === "import-conversations") {
    if (isCloudConversationMode()) {
      setToast("云端模式不会导入或合并本地 AI 对话", "info");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      try {
        const text = await file.text();
        const imported = await importAIConversations(JSON.parse(text), "append");
        if (imported) {
          const normalizedImported = await normalizeConversationMessagesIfNeeded(imported);
          state.aiConversationId = normalizedImported.id;
          state.aiChatMessages = normalizedImported.messages || [];
        }
        await refreshAIConversations();
        renderAIChatPanel();
        setToast("AI 对话已导入", "success");
      } catch (error) {
        setToast(error.message || "AI 对话导入失败", "danger");
      }
    };
    input.click();
    return;
  }

  if (action === "clear-all-conversations") {
    const ok = window.confirm("确认清空全部 AI 对话历史吗？此操作不可恢复。");
    if (!ok) {
      return;
    }
    aiConversationSelectionGeneration += 1;
    if (isCloudConversationMode()) {
      try {
        await Promise.all(state.aiConversations.map((conversation) => deleteCloudConversation(conversation.id)));
        state.aiConversationId = "";
        state.aiChatMessages = [];
        state.aiConversations = [];
        renderAIChatPanel();
        setToast("全部云端 AI 对话已清空", "success");
      } catch (error) {
        setToast(error.message || "清空云端 AI 对话失败", "danger");
      }
      return;
    }
    const conversation = await clearAIConversations();
    state.aiConversationId = conversation.id;
    state.aiChatMessages = normalizeAIChatMessages(conversation.messages).messages;
    await refreshAIConversations();
    renderAIChatPanel();
    setToast("全部 AI 对话已清空", "success");
    return;
  }

  if (action === "send") {
    submitAIChat();
    return;
  }

  if (action === "apply-route-yes") {
    const messageId = target.dataset.messageId;
    applyAIRouteToMap(messageId);
    return;
  }

  if (action === "apply-route-no") {
    const messageId = target.dataset.messageId;
    const message = state.aiChatMessages.find((item) => item.id === messageId);
    if (!message || message.role !== "assistant" || !["pending", "failed"].includes(message.routeActionStatus)) {
      return;
    }
    message.routeActionStatus = "rejected";
    message.routeActionError = "";
    message.content = stripAIRouteActionTail(message.content);
    clearAIRouteNotice();
    saveAIChatMessages(state.aiChatMessages);
    renderAIChatPanel();
    return;
  }
}

function updateRouteActionMessage(message, status, extraMessage = "") {
  const base = stripAIRouteActionTail(message.content);
  message.routeActionStatus = status;
  message.routeActionError = status === "failed" ? extraMessage : "";
  message.content = base;
  if (status === "failed") {
    setAIRouteNotice(extraMessage || "路线添加失败");
  }
}

function getRouteModeLabel(mode = "driving") {
  if (mode === "walking") {
    return "步行";
  }
  if (mode === "riding") {
    return "骑行";
  }
  if (mode === "transit") {
    return "公共交通";
  }
  return "驾车";
}

function getAIRouteFallbackModes(fromPoint, toPoint, preferredMode = "driving") {
  const queue = [preferredMode, "driving", "riding", "walking"];
  const fromCity = normalizeTransitCity(fromPoint?.city || "");
  const toCity = normalizeTransitCity(toPoint?.city || "");

  if (fromCity && toCity && fromCity === toCity) {
    queue.push("transit");
  }

  return [...new Set(queue)];
}

async function planAIRouteSegmentsWithFallback(points = [], preferredMode = "driving", transitCity = "成都") {
  const segments = [];
  const segmentModes = [];
  const degraded = [];

  for (let i = 0; i < points.length - 1; i += 1) {
    const fromPoint = points[i];
    const toPoint = points[i + 1];
    const from = [fromPoint.lng, fromPoint.lat];
    const to = [toPoint.lng, toPoint.lat];
    const candidateModes = getAIRouteFallbackModes(fromPoint, toPoint, preferredMode);

    let planned = null;
    let usedMode = preferredMode;
    let lastError = null;

    for (const mode of candidateModes) {
      try {
        planned = await state.mapService.planSegment(from, to, mode, transitCity);
        usedMode = mode;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!planned) {
      throw new Error(`第${i + 1}段规划失败：${lastError?.message || "未知错误"}`);
    }

    segments.push(planned);
    segmentModes.push(usedMode);

    if (usedMode !== preferredMode) {
      degraded.push(`${i + 1}段改为${getRouteModeLabel(usedMode)}`);
    }
  }

  return { segments, segmentModes, degraded };
}

async function buildRoutePointsFromPlaces(placeNames = [], options = {}) {
  const points = [];
  const misses = [];
  const preferredCity = normalizeTransitCity(options?.preferredCity || "");

  for (const rawName of placeNames) {
    const name = normalizeAIRoutePlaceName(rawName);
    if (!name) {
      misses.push(String(rawName || ""));
      continue;
    }

    let pois = [];
    try {
      const queries = [name];
      if (preferredCity && !name.startsWith(preferredCity)) {
        queries.unshift(`${preferredCity}${name}`);
      }

      for (const query of queries) {
        const result = await state.mapService.searchPOI(
          query,
          preferredCity
            ? {
                preferredCity,
                useMapCity: false,
                disableCityFallback: true
              }
            : {
                useMapCity: false
              }
        );
        const currentPois = Array.isArray(result?.pois) ? result.pois : [];
        if (currentPois.length) {
          pois = currentPois;
          break;
        }
      }

      if (!pois.length && preferredCity) {
        const fallback = await state.mapService.searchPOI(name, { useMapCity: false });
        pois = Array.isArray(fallback?.pois) ? fallback.pois : [];
      }
    } catch (error) {
      misses.push(name);
      continue;
    }

    const anchorPoint = points[points.length - 1] || null;
    const poi = pickBestRoutePOI(pois, name, preferredCity, { anchorPoint });
    if (!poi || !poi.location) {
      misses.push(name);
      continue;
    }
    points.push(
      createPoint({
        name: poi.name || name,
        lng: poi.location[0],
        lat: poi.location[1],
        address: poi.address,
        city: poi.city || poi.province || poi.district || preferredCity
      })
    );
  }

  return { points, misses };
}

async function applyAIRouteToMap(messageId) {
  const messageIndex = state.aiChatMessages.findIndex((item) => item.id === messageId);
  const message = messageIndex >= 0 ? state.aiChatMessages[messageIndex] : null;
  if (!message || message.role !== "assistant") {
    return;
  }
  if (!["pending", "failed"].includes(message.routeActionStatus)) {
    return;
  }
  if (!isMapReady()) {
    setToast("地图尚未加载完成", "warning");
    return;
  }

  const routePlaces = Array.isArray(message.routePlaces) ? message.routePlaces : [];
  const routeDayPlansRaw = Array.isArray(message.routeDayPlans) ? message.routeDayPlans : [];
  const routeDayPlans = (routeDayPlansRaw.length ? routeDayPlansRaw : [routePlaces])
    .map((plan) => (Array.isArray(plan) ? plan.map((name) => normalizeAIRoutePlaceName(name)).filter(Boolean) : []))
    .filter((plan) => plan.length >= 2)
    .slice(0, 10);

  if (routeDayPlans.length < 1) {
    updateRouteActionMessage(message, "failed", "地点不足");
    saveAIChatMessages(state.aiChatMessages);
    renderAIChatPanel();
    return;
  }

  message.routeActionError = "";
  clearAIRouteNotice();
  updateRouteActionMessage(message, "processing");
  saveAIChatMessages(state.aiChatMessages);
  renderAIChatPanel();

  try {
    const response = await buildAIRoutes({
      dayPlans: routeDayPlans,
      preferredCity: normalizeTransitCity(message.routeTargetCity || ""),
      existingColors: state.layers.map((item) => item.color)
    });
    const backendBuiltLayers = Array.isArray(response.layers) ? response.layers : [];
    if (!backendBuiltLayers.length) {
      throw new Error("可识别地点不足，无法生成路线");
    }

    state.layers.push(...backendBuiltLayers);
    state.selectedLayerId = backendBuiltLayers[0].id;
    state.editorVisible = true;
    state.newRouteEditorOpen = false;
    state.mobileRightOpen = false;

    rebuildLayers();
    state.mapService.fitLayers(backendBuiltLayers);
    persistLayersState();
    renderLeftPanel();
    renderRightPanel();

    const backendNotes = [];
    if (response.inferredCity) {
      backendNotes.push(`目标城市：${response.inferredCity}`);
    }
    if (Array.isArray(response.misses) && response.misses.length) {
      backendNotes.push(
        response.misses
          .map((item) => `第${item.day}天未命中：${(item.places || []).join("、")}`)
          .join("；")
      );
    }
    updateRouteActionMessage(message, "accepted", backendNotes.join("\n"));
    clearAIRouteNotice();
    saveAIChatMessages(state.aiChatMessages);
    renderAIChatPanel();
    setToast("AI 路线已添加到地图", "success");
    return;

    let latestUserPrompt = "";
    for (let i = messageIndex - 1; i >= 0; i -= 1) {
      const item = state.aiChatMessages[i];
      if (item?.role === "user" && typeof item.content === "string" && item.content.trim()) {
        latestUserPrompt = item.content.trim();
        break;
      }
    }

    const inferContext = [latestUserPrompt, message.content].filter(Boolean).join("\n");
    const inferPlaces = routeDayPlans.flat();
    const inferredCity = normalizeTransitCity(message.routeTargetCity || "") || await inferAIRouteCity(inferPlaces, inferContext);

    const routeBaseName = inferredCity || nextLayerName(state.layers);
    const builtLayers = [];
    const missedByDay = [];
    const degradedByDay = [];
    const skippedDays = [];
    const usedColors = state.layers.map((item) => item.color);

    for (let dayIndex = 0; dayIndex < routeDayPlans.length; dayIndex += 1) {
      const dayPlaces = routeDayPlans[dayIndex];
      const { points, misses } = await buildRoutePointsFromPlaces(dayPlaces, {
        preferredCity: inferredCity
      });

      if (misses.length) {
        missedByDay.push(`第${dayIndex + 1}天未命中：${misses.join("、")}`);
      }

      if (points.length < 2) {
        skippedDays.push(`第${dayIndex + 1}天`);
        continue;
      }

      const orderedPoints = optimizeRoutePointOrder(points);
      const preferredMode = "driving";
      const transitCity = normalizeTransitCity(orderedPoints[0]?.city || inferredCity || state.draft.transitCity) || "成都";
      const { segments, segmentModes, degraded } = await planAIRouteSegmentsWithFallback(
        orderedPoints,
        preferredMode,
        transitCity
      );

      if (degraded.length) {
        degradedByDay.push(`第${dayIndex + 1}天：${degraded.join("，")}`);
      }

      const routeName = routeDayPlans.length > 1 ? `${routeBaseName}-第${dayIndex + 1}天` : routeBaseName;
      const route = createRouteRecord({
        points: orderedPoints,
        segmentModes,
        segments,
        name: routeName
      });

      const dayColor = pickUniqueColor(usedColors);
      usedColors.push(dayColor);
      const layer = createLayerWithRoute(route, routeName, dayColor);
      builtLayers.push(layer);
    }

    if (!builtLayers.length) {
      throw new Error("可识别地点不足，无法生成路线");
    }

    state.layers.push(...builtLayers);
    state.selectedLayerId = builtLayers[0].id;
    state.editorVisible = true;
    state.newRouteEditorOpen = false;
    state.mobileRightOpen = false;

    rebuildLayers();
    state.mapService.fitLayers(builtLayers);
    persistLayersState();
    renderLeftPanel();
    renderRightPanel();

    const notes = [];
    if (inferredCity) {
      notes.push(`目标城市：${inferredCity}`);
    }
    if (routeDayPlans.length > 1) {
      notes.push(`按${routeDayPlans.length}天生成${builtLayers.length}个路线卡片`);
    }
    if (missedByDay.length) {
      notes.push(missedByDay.join("；"));
    }
    if (skippedDays.length) {
      notes.push(`未生成：${skippedDays.join("、")}`);
    }
    if (degradedByDay.length) {
      notes.push(degradedByDay.join("；"));
    }

    updateRouteActionMessage(message, "accepted", notes.join("；"));
    saveAIChatMessages(state.aiChatMessages);
    renderAIChatPanel();
    setToast(`AI路线已添加：${builtLayers.length}条`, "success");
  } catch (error) {
    updateRouteActionMessage(message, "failed", error.message || "未知错误");
    saveAIChatMessages(state.aiChatMessages);
    renderAIChatPanel();
    setToast(error.message || "AI路线添加失败", "danger");
  }
}

function handleAIChatKeydown(event) {
  if (event.target?.dataset?.aiRenameInput) {
    if (event.key === "Enter") {
      event.preventDefault();
      const conversationId = event.target.dataset.aiRenameInput;
      const actionTarget = document.querySelector(`[data-ai-action="save-rename-conversation"][data-conversation-id="${conversationId}"]`);
      actionTarget?.click();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      state.aiRenamingConversationId = "";
      renderAIChatPanel();
    }
    return;
  }
  if (event.target?.id !== "ai-chat-input") {
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitAIChat();
  }
}

function renderAIChatPanel() {
  const panel = document.getElementById("ai-chat-panel");
  const aiBtn = document.getElementById("ai-chat-btn");
  if (!panel) {
    return;
  }

  aiBtn?.classList.toggle("active", state.aiChatOpen);

  if (!state.aiChatOpen) {
    panel.classList.add("floating-hidden");
    panel.classList.remove("open-mobile");
    panel.innerHTML = "";
    setFloatingEditorState(getEditorOverlayOpenState());
    return;
  }

  const messagesHtml = state.aiChatMessages.length
    ? state.aiChatMessages
        .map(
          (message) => {
            const normalizedMessage = message.role === "assistant" ? normalizeAIChatMessage(message).normalized : message;
            const canRetryRoute = ["pending", "failed"].includes(normalizedMessage.routeActionStatus);
            const visibleContent = normalizedMessage.role === "assistant"
              ? stripAIRouteActionTail(normalizedMessage.content)
              : normalizedMessage.content;
            const routeStatus = normalizedMessage.routeActionStatus && normalizedMessage.routeActionStatus !== "pending"
              ? `<span class="ai-route-status" data-status="${normalizedMessage.routeActionStatus}">${escapeHtml(getAIRouteActionLabel(normalizedMessage.routeActionStatus))}</span>`
              : "";
            return `
            <article class="ai-chat-message ${normalizedMessage.role === "user" ? "user" : "assistant"}">
              <div class="ai-chat-message-content">
                <p>${formatMultilineTextHtml(visibleContent)}</p>
                ${
                  normalizedMessage.role === "assistant" && Array.isArray(normalizedMessage.routePlaces) && normalizedMessage.routePlaces.length >= 2
                    ? `<div class="ai-route-actions">
                        <button
                          data-ai-action="apply-route-yes"
                          data-message-id="${normalizedMessage.id}"
                          class="btn tiny"
                          type="button"
                          ${canRetryRoute ? "" : "disabled"}
                        >是</button>
                        <button
                          data-ai-action="apply-route-no"
                          data-message-id="${normalizedMessage.id}"
                          class="btn tiny soft"
                          type="button"
                          ${canRetryRoute ? "" : "disabled"}
                        >否</button>
                        ${routeStatus}
                      </div>`
                    : ""
                }
              </div>
            </article>
          `;
          }
        )
        .join("")
    : '<p class="muted ai-chat-empty">你好，我是你的路线助手。你可以问我路线规划、景点安排、出行建议等问题。</p>';
  const currentConversation = state.aiConversations.find((item) => item.id === state.aiConversationId);
  const conversationTitle = currentConversation?.title || "新对话";
  const conversationSyncHint = state.aiConversationLoading
    ? '<p class="muted">正在加载云端 AI 对话…</p>'
    : state.aiConversationError
      ? `<p class="muted">${escapeHtml(state.aiConversationError)}；本地历史未被修改。</p>`
      : "";
  const orderedAIConversations = [...state.aiConversations];
  const historyHtml = state.aiHistoryOpen
    ? `
      <section class="ai-history-popover">
        <div class="ai-history-head">
          <strong>历史对话</strong>
          <button data-ai-action="new-conversation" class="btn tiny primary" type="button">新建</button>
        </div>
        <div class="ai-history-toolbar">
        </div>
        <div class="ai-history-list">
          ${
            orderedAIConversations.length
                ? orderedAIConversations
                  .map(
                    (conversation) => {
                      const isRenaming = state.aiRenamingConversationId === conversation.id;
                      return `
                      <article class="ai-history-item ${conversation.id === state.aiConversationId ? "active" : ""} ${isRenaming ? "renaming" : ""}">
                        <div
                          ${isRenaming ? "" : `data-ai-action="select-conversation" data-conversation-id="${conversation.id}"`}
                          class="ai-history-main"
                          role="${isRenaming ? "group" : "button"}"
                          tabindex="${isRenaming ? "-1" : "0"}"
                        >
                          ${
                            isRenaming
                              ? `<input
                                  data-ai-rename-input="${conversation.id}"
                                  class="ai-history-rename-input"
                                  type="text"
                                  value="${escapeHtml(conversation.title)}"
                                  data-original-title="${escapeHtml(conversation.title)}"
                                />`
                              : `<strong>${escapeHtml(conversation.title)}</strong>`
                          }
                          <span>${escapeHtml(conversation.lastPreview || "空对话")}</span>
                          <small>${conversation.messageCount || 0} 条消息</small>
                        </div>
                        <div class="ai-history-actions">
                          ${
                            isRenaming
                              ? `<button data-ai-action="save-rename-conversation" data-conversation-id="${conversation.id}" class="icon-btn" type="button" title="保存名称" aria-label="保存名称">✓</button>`
                              : `<button data-ai-action="rename-conversation" data-conversation-id="${conversation.id}" class="icon-btn" type="button" title="重命名对话" aria-label="重命名对话">✎</button>`
                          }
                          <button data-ai-action="toggle-pin-conversation" data-conversation-id="${conversation.id}" class="icon-btn" type="button" title="${conversation.pinned ? "取消置顶" : "置顶对话"}" aria-label="${conversation.pinned ? "取消置顶" : "置顶对话"}">${conversation.pinned ? "★" : "☆"}</button>
                          <button data-ai-action="toggle-archive-conversation" data-conversation-id="${conversation.id}" class="icon-btn" type="button" title="${conversation.archived ? "取消归档" : "归档对话"}" aria-label="${conversation.archived ? "取消归档" : "归档对话"}">${conversation.archived ? "↩" : "⌑"}</button>
                          <button data-ai-action="delete-conversation" data-conversation-id="${conversation.id}" class="icon-btn delete" type="button" title="删除对话" aria-label="删除对话">×</button>
                        </div>
                      </article>
                    `;
                    }
                  )
                  .join("")
              : '<p class="muted">暂无 AI 对话历史</p>'
          }
        </div>
      </section>
    `
    : "";

  panel.classList.remove("floating-hidden");
  panel.classList.add("open-mobile");
  panel.innerHTML = `
    <div class="panel-header">
      <div>
        <h2>AI 路线助手</h2>
        <p class="ai-conversation-title">${escapeHtml(conversationTitle)}</p>
      </div>
      <div class="panel-header-actions">
        <button data-ai-action="toggle-history" class="icon-tool-btn ${state.aiHistoryOpen ? "active" : ""}" type="button" title="历史" aria-label="历史">⏱</button>
        <button data-ai-action="clear-history" class="icon-tool-btn" type="button" title="清空当前" aria-label="清空当前">clear</button>
        <button data-ai-action="toggle" class="icon-tool-btn" type="button" title="关闭" aria-label="关闭">×</button>
      </div>
    </div>
    ${historyHtml}
    ${conversationSyncHint}

    <div class="ai-chat-body">
      <section class="panel-block ai-chat-thread-block">
        <div class="ai-chat-messages">${messagesHtml}</div>
      </section>

      <section class="panel-block ai-chat-input-block">
        <div class="ai-chat-composer">
          <textarea id="ai-chat-input" rows="3" placeholder="输入内容，按 Enter 发送，Shift + Enter 换行" ${
            state.aiChatPending ? "disabled" : ""
          }></textarea>
          <button data-ai-action="send" class="btn primary ai-chat-send-btn" type="button" ${
            state.aiChatPending ? "disabled" : ""
          }>${state.aiChatPending ? "思考中..." : "发送"}</button>
        </div>
      </section>
    </div>
  `;

  setFloatingEditorState(true);
  const messages = panel.querySelector(".ai-chat-messages");
  if (messages) {
    messages.scrollTop = messages.scrollHeight;
  }
}

function renderAuthEntry() {
  const container = document.getElementById("auth-entry");
  if (!container) {
    return;
  }
  const auth = getAuthState();
  if (auth.isAuthenticated) {
    const name = escapeHtml(auth.user?.displayName || auth.user?.email || "已登录用户");
    container.innerHTML = `<span class="auth-user" title="${name}">${name}</span><button data-auth-action="logout" class="btn ghost" type="button">退出</button>`;
    return;
  }
  container.innerHTML = `<button data-auth-action="login" class="btn ghost" type="button">登录</button><button data-auth-action="register" class="btn soft" type="button">注册</button>`;
}

function renderAuthDialog() {
  const dialog = document.getElementById("auth-dialog");
  if (!dialog) {
    return;
  }
  const required = state.authRequired;
  const appShell = document.querySelector(".app-shell");
  appShell?.toggleAttribute("inert", required);
  if (!state.authDialogMode && !required) {
    dialog.className = "auth-dialog hidden";
    dialog.innerHTML = "";
    return;
  }
  if (required && !state.authDialogMode) {
    state.authDialogMode = "login";
  }
  const isRegister = state.authDialogMode === "register";
  dialog.className = `auth-dialog${required ? " auth-required" : ""}`;
  dialog.innerHTML = `
    <form class="auth-card" data-auth-form="${state.authDialogMode}">
      ${required ? "" : '<button data-auth-action="close" class="icon-tool-btn auth-close" type="button" aria-label="关闭">×</button>'}
      <h2>${isRegister ? "创建账户" : "登录账户"}</h2>
      <p>${isRegister ? "注册后可在设备间同步路线和会话。" : "登录后可恢复你的云端路线和会话。"}</p>
      <label>邮箱<input name="email" type="email" required autocomplete="email" /></label>
      <label>密码（至少 8 位）<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="${isRegister ? "new-password" : "current-password"}" /></label>
      <div class="auth-error" data-auth-error></div>
      <button class="btn primary" type="submit" ${state.authPending ? "disabled" : ""}>${state.authPending ? "处理中…" : isRegister ? "注册并登录" : "登录"}</button>
      <button data-auth-action="switch" class="btn ghost" type="button">${isRegister ? "已有账户？去登录" : "没有账户？去注册"}</button>
    </form>`;
}

function openAuthDialog(mode, { required = state.authRequired } = {}) {
  state.authRequired = Boolean(required);
  state.authDialogMode = mode;
  state.authPending = false;
  renderAuthDialog();
}

async function handleAuthSubmit(form) {
  const data = new FormData(form);
  const payload = { email: String(data.get("email") || "").trim(), password: String(data.get("password") || "") };
  state.authPending = true;
  renderAuthDialog();
  try {
    if (state.authDialogMode === "register") {
      await register(payload);
    }
    const response = await login(payload);
    const anonymousLayers = serializeLayersForStorage();
    state.authRequired = false;
    setAuthSession(response);
    await syncWorkspaceAfterLogin(anonymousLayers);
    state.authDialogMode = "";
    state.authPending = false;
    renderAuthDialog();
    setToast("登录成功", "success");
  } catch (error) {
    state.authPending = false;
    renderAuthDialog();
    const errorNode = document.querySelector("[data-auth-error]");
    if (errorNode) errorNode.textContent = error.message || "认证失败，请稍后重试。";
  }
}

function buildLayout() {
  app.innerHTML = `
    <div class="app-shell">
      <aside id="left-panel" class="side-panel left"></aside>
      <main class="map-stage">
        <div id="map"></div>
        <div class="atmosphere"></div>

        <div class="map-topbar">
          <section class="search-card">
            <div class="search-input-wrap">
              <input id="search-input" type="text" placeholder="搜索景点、地点、商圈..." />
              <button id="search-btn" class="btn primary" type="button">搜索</button>
              <button id="ai-chat-btn" class="btn primary" type="button">AI</button>
              <button id="theme-toggle-btn" class="btn ghost" type="button">${
                getThemeToggleIcon(state.themeMode)
              }</button>
            </div>
            <div id="search-results" class="search-results"></div>
          </section>
          <div class="top-actions">
            <button id="show-history-btn" class="btn ghost" type="button">历史路线</button>
            <div id="auth-entry" class="auth-entry"></div>
          </div>
        </div>

        <div class="mobile-actions">
          <button id="toggle-left-btn" class="btn soft" type="button">菜单</button>
          <button id="toggle-right-btn" class="btn soft" type="button">编辑</button>
        </div>

        <aside id="right-panel" class="side-panel right floating-hidden"></aside>
  <aside id="ai-chat-panel" class="side-panel right ai-chat-panel floating-hidden"></aside>

        <div id="ai-route-notice" class="ai-route-notice hidden"></div>
        <div id="floating-tooltip" class="floating-tooltip hidden"></div>
        <div id="key-warning" class="key-warning hidden"></div>
        <div id="status-toast" class="status-toast"></div>
      </main>
    </div>

    <section id="history-overlay" class="history-overlay hidden"></section>
    <section id="auth-dialog" class="auth-dialog hidden"></section>
  `;
  renderAuthEntry();
}

function getDraftPoints() {
  const points = [];
  if (state.draft.start) {
    points.push(cloneJSON(state.draft.start));
  }
  state.draft.vias.forEach((item) => points.push(cloneJSON(item)));
  if (state.draft.end) {
    points.push(cloneJSON(state.draft.end));
  }

  points.forEach((point, index) => {
    if (!Number.isFinite(point.priority) || point.priority <= 0) {
      point.priority = index + 1;
    }
  });
  return points;
}

function syncDraftSegmentModes() {
  const points = getDraftPoints();
  const needed = Math.max(0, points.length - 1);
  const existing = state.draft.segmentModes.slice(0, needed);
  while (existing.length < needed) {
    existing.push(state.draft.defaultMode);
  }
  state.draft.segmentModes = existing;
}

function syncLayerSegmentModes(layer) {
  ensureLayerRoutes(layer);
  if (!layer.route) {
    return;
  }
  const needed = Math.max(0, (layer.route.points || []).length - 1);
  const current = (layer.route.segmentModes || []).slice(0, needed);
  while (current.length < needed) {
    current.push("driving");
  }
  layer.route.segmentModes = current;
}

function getRouteEditKey(route) {
  return route?.id || "";
}

function getPendingPointOrder(route) {
  const key = getRouteEditKey(route);
  const order = key ? state.pendingPointOrders[key] : null;
  const points = route?.points || [];
  if (!Array.isArray(order) || order.length !== points.length) {
    return null;
  }
  const seen = new Set(order);
  if (seen.size !== points.length || order.some((index) => !Number.isInteger(index) || index < 0 || index >= points.length)) {
    return null;
  }
  return order;
}

function getRouteEditorPointEntries(route) {
  const points = route?.points || [];
  const order = getPendingPointOrder(route) || points.map((_, index) => index);
  return order.map((sourceIndex) => ({ point: points[sourceIndex], sourceIndex })).filter((entry) => entry.point);
}

function setPendingPointOrder(route, order) {
  const key = getRouteEditKey(route);
  if (!key) {
    return;
  }
  state.pendingPointOrders[key] = order;
}

function clearPendingPointOrder(route) {
  const key = getRouteEditKey(route);
  if (key) {
    delete state.pendingPointOrders[key];
  }
}

function clearPendingPointOrders() {
  state.pendingPointOrders = {};
}

function applyPendingPointOrder(route) {
  const order = getPendingPointOrder(route);
  if (!order) {
    return false;
  }
  route.points = order.map((index) => route.points[index]);
  clearPendingPointOrder(route);
  return true;
}

function isMapReady() {
  return Boolean(state.mapReady && state.mapService);
}

function getSelectedLayer() {
  const layer = state.layers.find((item) => item.id === state.selectedLayerId) || null;
  if (!layer) {
    return null;
  }
  return ensureLayerRoutes(layer);
}

function hasTransitMode(segmentModes = []) {
  return segmentModes.some((mode) => mode === "transit");
}

function normalizeTransitCity(city) {
  if (Array.isArray(city)) {
    return normalizeTransitCity(city[0] || "");
  }
  const text = String(city || "").trim();
  if (!text) {
    return "";
  }
  return text.replace(/(市|特别行政区|自治区|自治州|地区|盟)$/, "");
}

async function resolveTransitCityFromStart(startPoint, fallbackCity) {
  const fallback = normalizeTransitCity(fallbackCity) || "成都";
  const pointCity = normalizeTransitCity(startPoint?.city || "");
  if (pointCity) {
    return pointCity;
  }

  if (!isMapReady() || !startPoint) {
    return fallback;
  }

  try {
    const resolvedCity = await state.mapService.reverseGeocodeCity(startPoint);
    const normalized = normalizeTransitCity(resolvedCity);
    if (normalized) {
      startPoint.city = normalized;
      return normalized;
    }
  } catch (error) {
    console.warn("自动识别公交城市失败", error);
  }

  return fallback;
}

function modeOptions(selected) {
  return TRAVEL_MODES.map(
    (mode) => `<option value="${mode.value}" ${mode.value === selected ? "selected" : ""}>${mode.label}</option>`
  ).join("");
}

function formatPlaceCount(count = 0) {
  const safeCount = Math.max(0, Number(count) || 0);
  const cn = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  const prefix = safeCount <= 10 ? cn[safeCount] : `${safeCount}`;
  return `${prefix}个地点`;
}

function renderSearchResults() {
  const container = document.getElementById("search-results");
  if (!container) {
    return;
  }

  if (state.searchSuggestionsOpen && state.searchSuggestions.length) {
    container.innerHTML = `
      <div class="result-head">
        <span>搜索推荐 ${state.searchSuggestions.length} 条</span>
        <button data-action="suggest-close" class="btn tiny ghost" type="button">关闭</button>
      </div>
      <ul class="result-list suggestion-list">
        ${state.searchSuggestions
          .map(
            (poi, index) => `
              <li class="result-item" data-action="suggest-pick" data-index="${index}">
                <div class="result-title-row">
                  <strong>${escapeHtml(poi.name)}</strong>
                  <span>${escapeHtml(poi.district || poi.city || "")}</span>
                </div>
                <p>${escapeHtml(poi.address || "无详细地址")}</p>
              </li>
            `
          )
          .join("")}
      </ul>
    `;
    return;
  }

  if (!state.searchResultsOpen) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `
    <div class="result-head">
      <span>搜索结果 ${state.searchResults.length} 条</span>
      <button data-action="search-close" class="btn tiny ghost" type="button">关闭</button>
    </div>
    ${
      !state.searchResults.length
        ? '<p class="muted result-empty">暂无结果，请换个关键词试试。</p>'
        : `
    <ul class="result-list">
      ${state.searchResults
        .map(
          (poi, index) => `
            <li class="result-item" data-action="search-focus" data-index="${index}">
              <div class="result-title-row">
                <strong><span class="result-flag">🚩${index + 1}</span>${poi.name}</strong>
                <span>${poi.city || ""}</span>
              </div>
              <p>${poi.address || "无详细地址"}</p>
              <div class="result-actions">
                <button data-action="search-to-start" data-index="${index}" class="btn tiny">设为起点</button>
                <button data-action="search-to-end" data-index="${index}" class="btn tiny">设为终点</button>
                <button data-action="search-to-via" data-index="${index}" class="btn tiny">添加途经</button>
              </div>
            </li>
          `
        )
        .join("")}
    </ul>
    `
    }
  `;
}

function renderLeftPanel() {
  const panel = document.getElementById("left-panel");
  if (!panel) {
    return;
  }

  panel.classList.toggle("open-mobile", state.mobileLeftOpen);

  const layerRows = state.layers
    .map((layer) => {
      ensureLayerRoutes(layer);
      const selectedClass = layer.id === state.selectedLayerId ? "selected" : "";
      const activeRoute = layer.route || null;
      const summaryDistance = formatDistance(activeRoute?.stats?.distance || 0);
      const summaryPlaces = formatPlaceCount((activeRoute?.points || []).length);
      return `
        <li class="layer-item ${selectedClass}" data-action="layer-select" data-layer-id="${layer.id}">
          <label>
            <input data-action="layer-toggle" data-layer-id="${layer.id}" type="checkbox" ${
              layer.visible === false ? "" : "checked"
            } />
          </label>
          <div class="layer-main">
            <div class="layer-name-line">
              <span class="layer-color" style="background:${layer.color}"></span>
              <button data-action="layer-rename-inline" data-layer-id="${layer.id}" class="layer-name" type="button">${
                layer.name
              }</button>
              <div class="layer-inline-actions">
                <button data-action="layer-focus-icon" data-layer-id="${layer.id}" class="icon-btn" type="button" title="定位路线">🚩</button>
                <button data-action="layer-delete-inline" data-layer-id="${layer.id}" class="icon-btn delete" type="button" title="删除路线">✕</button>
              </div>
            </div>
            <p class="layer-summary">${summaryDistance} · ${summaryPlaces}</p>
          </div>
        </li>
      `;
    })
    .join("");

  panel.innerHTML = `
    <div class="panel-header">
      <h2>VOYAGE</h2>
    </div>

    <section class="panel-block" style="display: flex; flex-direction: column; flex: 1; position: relative;">
      <div class="panel-head-inline">
        <h3>路线管理</h3>
        <div style="display: flex; gap: 8px;">
          <button data-action="share-route" class="btn tiny" type="button" title="分享路线">分享</button>
          <button data-action="open-new-route-editor" class="btn tiny" type="button">+</button>
        </div>
      </div>
      <ul class="layer-list" style="flex: 1; overflow-y: auto;">
        ${layerRows || '<li class="muted">暂无图层，先生成一条路线。</li>'}
      </ul>
      <div style="text-align: right; padding-top: 15px;">
        <button data-action="import-route" class="btn primary tiny" type="button">导入路线</button>
        <input type="file" id="import-file-input" accept=".json,.gpx" style="display:none;" />
      </div>
    </section>
  `;
}

function setFloatingEditorState(open) {
  const mapStage = document.querySelector(".map-stage");
  const panel = document.getElementById("right-panel");

  mapStage?.classList.toggle("editor-floating-open", open);

  if (panel) {
    panel.classList.toggle("floating-hidden", !open);
    if (!open) {
      panel.classList.remove("open-mobile");
    }
  }

  if (state.mapService && typeof state.mapService.setEditorOverlayOpen === "function") {
    state.mapService.setEditorOverlayOpen(open);
  }
}

function renderRightPanel() {
  const panel = document.getElementById("right-panel");
  if (!panel) {
    return;
  }

  const layer = getSelectedLayer();
  const showNewRouteEditor = state.newRouteEditorOpen;
  const hasSelectedRoute = Boolean(layer && layer.route && state.editorVisible && !showNewRouteEditor);

  if (!showNewRouteEditor && !hasSelectedRoute) {
    setFloatingEditorState(state.aiChatOpen);
    panel.innerHTML = "";
    return;
  }

  setFloatingEditorState(true);
  panel.classList.toggle("open-mobile", state.mobileRightOpen);

  if (showNewRouteEditor) {
    syncDraftSegmentModes();
    const draftPoints = getDraftPoints();
    panel.innerHTML = `
      <div class="panel-header">
        <h2>新路线编辑</h2>
        <button data-action="close-new-route-editor" class="btn soft" type="button">关闭</button>
      </div>

      <section class="panel-block">
        <h3>起终点与初始途经点</h3>
        <p class="muted">可从搜索结果设置，也可直接地图点选。</p>

        <div class="point-line">
          <span class="tag start">起点</span>
          <strong>${state.draft.start ? compactPointName(state.draft.start.name) : "未设置"}</strong>
          <button data-action="pick-start-map" class="btn tiny" type="button">地图点选</button>
        </div>

        <ul class="via-list">
          ${state.draft.vias
            .map(
              (via, index) => `
                <li>
                  <span>${index + 1}. ${compactPointName(via.name)}</span>
                  <div>
                    <button data-action="via-up" data-index="${index}" class="btn tiny" type="button">上移</button>
                    <button data-action="via-down" data-index="${index}" class="btn tiny" type="button">下移</button>
                    <button data-action="remove-via" data-index="${index}" class="btn tiny danger" type="button">删除</button>
                  </div>
                </li>
              `
            )
            .join("")}
        </ul>

        <button data-action="pick-via-map" class="btn soft full" type="button">地图添加途经点</button>

        <div class="point-line">
          <span class="tag end">终点</span>
          <strong>${state.draft.end ? compactPointName(state.draft.end.name) : "未设置"}</strong>
          <button data-action="pick-end-map" class="btn tiny" type="button">地图点选</button>
        </div>
      </section>

      <section class="panel-block">
        <h3>出行方式</h3>
        <div class="inline-grid">
          <label>
            全段默认
            <select id="draft-default-mode">${modeOptions(state.draft.defaultMode)}</select>
          </label>
          <button data-action="apply-default-mode" class="btn tiny" type="button">应用到全部路段</button>
        </div>

        <label>
          公交规划城市
          <input id="draft-transit-city" value="${state.draft.transitCity}" placeholder="例如 成都" />
        </label>

        <div class="segment-list">
          ${
            draftPoints.length < 2
              ? `<p class="muted">先设置起点和终点后再配置路段方式。</p>`
              : state.draft.segmentModes
                  .map(
                    (mode, index) => `
                      <div class="segment-row">
                        <span>${index + 1}. ${compactPointName(draftPoints[index].name)} → ${compactPointName(
                          draftPoints[index + 1].name
                        )}</span>
                        <select data-action="draft-segment-mode" data-index="${index}">
                          ${modeOptions(mode)}
                        </select>
                      </div>
                    `
                  )
                  .join("")
          }
        </div>

        <div class="inline-grid">
          <button data-action="generate-route" class="btn primary full" type="button">生成新路线</button>
        </div>
      </section>
    `;
    return;
  }

  const pointEntries = getRouteEditorPointEntries(layer.route);
  const points = pointEntries.map((entry) => entry.point);
  syncLayerSegmentModes(layer);
  const segments = layer.route.segmentModes || [];
  ensureEditHistory(layer.id);
  const canUndo = state.editHistory.undo.length > 0;
  const canRedo = state.editHistory.redo.length > 0;

  panel.innerHTML = `
    <div class="panel-header">
      <h2>编辑：${layer.name}</h2>
      <div class="panel-header-actions">
        <button data-action="undo-edit" class="btn soft" type="button" ${canUndo ? "" : "disabled"}>后退</button>
        <button data-action="redo-edit" class="btn soft" type="button" ${canRedo ? "" : "disabled"}>前进</button>
        <button data-action="close-editor" class="btn soft" type="button">关闭</button>
      </div>
    </div>

    <section class="panel-block">
      <h3>图层内路线</h3>
      <ul class="inner-route-list">
        ${(layer.routes || [])
          .map((route, index) => {
            const isSelected = route.id === layer.selectedRouteId;
            return `
              <li class="inner-route-item ${isSelected ? "selected" : ""}">
                <label>
                  <input data-action="route-toggle" data-route-id="${route.id}" type="checkbox" ${
                    route.visible === false ? "" : "checked"
                  } />
                </label>
                <button data-action="route-select" data-route-id="${route.id}" class="layer-route-name" type="button">
                  ${route.meta?.name || `路线${index + 1}`}
                </button>
                <button data-action="route-delete" data-route-id="${route.id}" class="btn tiny danger" type="button">删除</button>
              </li>
            `;
          })
          .join("")}
      </ul>
    </section>

    <section class="panel-block">
      <label>
        路线名称
        <input data-action="meta-change" data-field="name" value="${layer.meta.name}" />
      </label>
      <label>
        备注（可选）
        <textarea data-action="meta-change" data-field="note" rows="3">${layer.meta.note || ""}</textarea>
      </label>

      <div class="summary-row">
        <span>总距离：${formatDistance(layer.route.stats.distance)}</span>
        <span>总时长：${formatDuration(layer.route.stats.duration)}</span>
      </div>
    </section>

    <section class="panel-block">
      <h3>点位顺序</h3>
      <ul class="edit-points" data-sortable="route-points">
        ${points
          .map((point, index) => {
            const sourceIndex = pointEntries[index]?.sourceIndex ?? index;
            const nextPoint = points[index + 1];
            const insertLabel = nextPoint ? `在 ${point.name} 和 ${nextPoint.name} 间加入途经点` : "";
            const segmentMode = segments[index] || "driving";
            const transitTools = getTransitToolsForLeg(layer.route, index);
            return `
              <li data-action="point-focus" data-index="${sourceIndex}" data-point-index="${sourceIndex}" class="point-focus-item" title="拖拽调整顺序，点击定位该点">
                <div class="point-card-main">
                  <strong>${index + 1}. ${point.name}</strong>
                  <button data-action="point-replace-map" data-index="${sourceIndex}" class="btn tiny point-replace-inline" type="button">地图替换</button>
                  <button
                    data-action="point-delete"
                    data-index="${index}"
                    class="icon-btn delete point-delete-btn"
                    type="button"
                    aria-label="删除点位"
                    title="删除点位"
                  >×</button>
                </div>
                <div class="point-card-footer">
                  <button data-action="point-replace-map" data-index="${sourceIndex}" class="btn tiny" type="button">地图替换</button>
                </div>
              </li>
              ${
                nextPoint
                  ? `<li class="point-connector-row" aria-hidden="false">
                      <span class="point-insert-line"></span>
                      <div class="point-connector-controls">
                        <select data-action="layer-segment-mode" data-index="${index}" aria-label="${escapeHtml(
                          `${point.name} 到 ${nextPoint.name} 的出行方式`
                        )}">
                          ${modeOptions(segmentMode)}
                        </select>
                        <button
                          data-action="insert-between-map"
                          data-index="${index}"
                          class="point-insert-btn"
                          type="button"
                          aria-label="${escapeHtml(insertLabel)}"
                          data-tooltip="${escapeHtml(insertLabel)}"
                        >+</button>
                      </div>
                      ${
                        segmentMode === "transit"
                          ? `<p class="segment-tools inline">公共交通：${transitTools.length ? transitTools.join(" / ") : "暂无线路详情"}</p>`
                          : ""
                      }
                    </li>`
                  : ""
              }
            `;
          })
          .join("")}
      </ul>
    </section>

    <section class="panel-block">
      <button data-action="recalc-layer" class="btn primary full" type="button">应用修改并重算路线</button>
    </section>
  `;
  initPointSortable();
}

function applyDraggedPointOrder(layer, orderedIndexes) {
  if (!layer?.route || !Array.isArray(layer.route.points)) {
    return;
  }

  const currentPoints = layer.route.points;
  if (orderedIndexes.length !== currentPoints.length) {
    return;
  }

  const nextPoints = orderedIndexes.map((index) => currentPoints[index]).filter(Boolean);
  if (nextPoints.length !== currentPoints.length) {
    return;
  }

  const changed = nextPoints.some((point, index) => point !== currentPoints[index]);
  if (!changed) {
    return;
  }

  setPendingPointOrder(layer.route, orderedIndexes);
  renderRightPanel();
  setToast("顺序已调整，点击下方按钮重算路线", "info");
}

function initPointSortable() {
  if (state.pointSortable) {
    state.pointSortable.destroy();
    state.pointSortable = null;
  }

  const list = document.querySelector('[data-sortable="route-points"]');
  if (!list) {
    return;
  }

  state.pointSortable = Sortable.create(list, {
    animation: 140,
    draggable: ".point-focus-item",
    filter: "button, select, input, textarea",
    preventOnFilter: false,
    ghostClass: "point-drag-ghost",
    chosenClass: "point-drag-chosen",
    onEnd: () => {
      const layer = getSelectedLayer();
      const orderedIndexes = [...list.querySelectorAll(".point-focus-item")]
        .map((item) => Number(item.dataset.index))
        .filter((index) => Number.isInteger(index));
      applyDraggedPointOrder(layer, orderedIndexes);
    }
  });
}

function renderHistoryOverlay() {
  const overlay = document.getElementById("history-overlay");
  if (!overlay) {
    return;
  }

  if (!state.historyOpen) {
    overlay.classList.add("hidden");
    overlay.innerHTML = "";
    return;
  }

  overlay.classList.remove("hidden");

  const detail = state.historyRoutes.find((route) => route.id === state.historyDetailId);

  if (!detail) {
    overlay.innerHTML = `
      <div class="history-panel">
        <header>
          <h2>历史路线</h2>
          <button data-action="history-close" class="btn soft" type="button">返回地图</button>
        </header>

        <div class="history-list">
          ${
            state.historyRoutes.length
              ? state.historyRoutes
                  .map(
                    (route) => `
                      <article class="history-card">
                        <div>
                          <h3>${route.name || route.layerName || "未命名路线"}</h3>
                          <p>${new Date(route.updatedAt).toLocaleString("zh-CN")} · ${route.days || 1}天</p>
                          <p>核心点位：${(route.points || [])
                            .slice(0, 4)
                            .map((point) => `${point.name}`)
                            .join("、")}</p>
                        </div>
                        <div class="history-actions">
                          <button data-action="history-detail" data-id="${route.id}" class="btn tiny">查看详情</button>
                          <button data-action="history-delete" data-id="${route.id}" class="btn tiny danger">删除</button>
                        </div>
                      </article>
                    `
                  )
                  .join("")
              : '<p class="muted">暂无已保存路线。</p>'
          }
        </div>
      </div>
    `;
    return;
  }

  overlay.innerHTML = `
    <div class="history-panel detail">
      <header>
        <button data-action="history-back" class="btn soft" type="button">返回历史列表</button>
        <button data-action="history-close" class="btn soft" type="button">返回地图</button>
      </header>

      <section>
        <h2>${detail.name || detail.layerName || "未命名路线"}</h2>
        <p>${detail.days || 1} 天 · ${formatDistance(detail?.stats?.distance || 0)} · ${formatDuration(
    detail?.stats?.duration || 0
  )}</p>
        <p>${detail.note || "无备注"}</p>
      </section>

      <section>
        <h3>点位顺序</h3>
        <ul class="history-point-list">
          ${(detail.points || [])
            .map(
              (point, index) => `
                <li>
                  <strong>${index + 1}. ${point.name}</strong>
                </li>
              `
            )
            .join("")}
        </ul>
      </section>

      <section class="history-actions">
        <button data-action="history-load-map" data-id="${detail.id}" class="btn primary" type="button">加载到当前地图并编辑</button>
        <button data-action="history-delete" data-id="${detail.id}" class="btn danger" type="button">删除该路线</button>
      </section>
    </div>
  `;
}

function setPickMode(mode) {
  state.pickMode = mode;
  if (mode) {
    setToast(`地图点选模式：${mode.label}`);
  }
}

function clearPickMode() {
  state.pickMode = null;
}

function applyPoiToDraft(poi, target) {
  if (!poi.location) {
    setToast("该地点无有效坐标数据", "warning");
    return;
  }
  const point = createPoint({
    name: poi.name,
    lng: poi.location[0],
    lat: poi.location[1],
    address: poi.address,
    city: poi.city
  });

  if (target === "start") {
    state.draft.start = point;
    if (poi.city) {
      state.draft.transitCity = normalizeTransitCity(poi.city) || state.draft.transitCity;
    }
  } else if (target === "end") {
    state.draft.end = point;
  } else {
    if (state.draft.vias.length >= 10) {
      setToast("初始途经点最多 10 个", "warning");
      return;
    }
    state.draft.vias.push(point);
  }

  syncDraftSegmentModes();
  renderLeftPanel();
  renderRightPanel();
}

function rebuildLayers() {
  if (!isMapReady()) {
    return;
  }

  state.layers.forEach((layer, index) => {
    ensureLayerRoutes(layer);
    state.mapService.drawLayer(layer, index + 1);
    state.mapService.setLayerVisibility(layer.id, layer.visible !== false);
  });
}

function collectStats(segments) {
  return segments.reduce(
    (acc, item) => {
      acc.distance += Number(item.distance || 0);
      acc.duration += Number(item.duration || 0);
      return acc;
    },
    { distance: 0, duration: 0 }
  );
}

function getTransitToolsForLeg(route, legIndex) {
  const routeSegments = route?.segments || [];
  const hasLegIndex = routeSegments.some((segment) => Number.isInteger(Number(segment?.legIndex)));
  const relatedSegments = hasLegIndex
    ? routeSegments.filter((segment) => Number(segment?.legIndex) === legIndex)
    : [routeSegments[legIndex]].filter(Boolean);
  const tools = [];
  const seen = new Set();

  relatedSegments.forEach((segment) => {
    (segment?.transitTools || []).forEach((tool) => {
      const text = String(tool || "").trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        tools.push(text);
      }
    });
  });

  return tools;
}

function createRouteRecord({ points, segmentModes, segments, name }) {
  return normalizeRoute({
    id: createId("route"),
    visible: true,
    points: points.map((point) => ({ ...point })),
    segmentModes: segmentModes.slice(),
    segments,
    stats: collectStats(segments),
    meta: {
      name,
      days: 1,
      note: ""
    }
  });
}

function createLayerWithRoute(route, layerName, preferredColor = "") {
  const layer = ensureLayerRoutes({
    id: createId("layer"),
    name: layerName,
    color: preferredColor || pickUniqueColor(state.layers.map((item) => item.color)),
    visible: true,
    routes: [route],
    selectedRouteId: route.id
  });
  return layer;
}

function createLayerWithRoutes(routes = [], layerName) {
  const validRoutes = routes.filter((route) => route && Array.isArray(route.points) && route.points.length >= 2);
  if (!validRoutes.length) {
    return null;
  }

  const normalizedRoutes = validRoutes.map((route, index) => normalizeRoute(route, index));
  const layer = ensureLayerRoutes({
    id: createId("layer"),
    name: layerName,
    color: pickUniqueColor(state.layers.map((item) => item.color)),
    visible: true,
    routes: normalizedRoutes,
    selectedRouteId: normalizedRoutes[0]?.id || null
  });
  return layer;
}

async function generateRouteLayer() {
  const points = getDraftPoints();
  if (!isMapReady()) {
    setToast("地图尚未加载完成", "warning");
    return;
  }
  if (!state.draft.start || !state.draft.end || points.length < 2) {
    setToast("请先设置起点和终点", "warning");
    return;
  }

  if (state.draft.vias.length > 10) {
    setToast("初始途经点最多 10 个", "warning");
    return;
  }

  try {
    setToast("正在规划路线，请稍候...");
    let transitCity = normalizeTransitCity(state.draft.transitCity) || "成都";
    if (hasTransitMode(state.draft.segmentModes)) {
      transitCity = await resolveTransitCityFromStart(points[0], transitCity);
      state.draft.transitCity = transitCity;
      renderLeftPanel();
    }

    const routePlan = await planRoute(
      points,
      state.draft.segmentModes,
      transitCity
    );
    const segments = routePlan.segments || [];

    const layerName = nextLayerName(state.layers);
    const route = createRouteRecord({
      points,
      segmentModes: state.draft.segmentModes,
      segments,
      name: layerName
    });
    const layer = createLayerWithRoute(route, layerName);
    state.layers.push(layer);
    state.selectedLayerId = layer.id;
    state.editorVisible = true;
    setToast(`新路线已生成：${layer.name}`, "success");

    rebuildLayers();
    state.mapService.fitLayers(state.layers);
    state.newRouteEditorOpen = false;
    state.editorVisible = true;
    persistLayersState();
    renderLeftPanel();
    renderRightPanel();
  } catch (error) {
    console.error(error);
    setToast(error.message || "路线规划失败", "danger");
  }
}

async function recalcSelectedLayer() {
  const layer = getSelectedLayer();
  if (!layer || !isMapReady()) {
    return;
  }

  let points = layer.route.points || [];
  if (points.length < 2) {
    setToast("点位不足，无法重算路线", "warning");
    return;
  }

  syncLayerSegmentModes(layer);

  try {
    pushEditHistory(layer);
    applyPendingPointOrder(layer.route);
    points = layer.route.points || [];
    syncLayerSegmentModes(layer);
    setToast("正在重算当前图层路线...");
    let transitCity = normalizeTransitCity(state.draft.transitCity) || "成都";
    if (hasTransitMode(layer.route.segmentModes || [])) {
      transitCity = await resolveTransitCityFromStart(points[0], transitCity);
      state.draft.transitCity = transitCity;
      renderLeftPanel();
    }

    const routePlan = await planRoute(
      points,
      layer.route.segmentModes,
      transitCity
    );
    const segments = routePlan.segments || [];
    layer.route.segments = segments;
    layer.route.stats = collectStats(segments);
    rebuildLayers();
    state.mapService.fitLayers([layer]);
    persistLayersState();
    saveSelectedLayerToHistory({ showToast: false });
    renderRightPanel();
    setToast("路线重算完成，已自动保存到本地缓存", "success");
  } catch (error) {
    console.error(error);
    setToast(error.message || "重算失败", "danger");
  }
}

function saveSelectedLayerToHistory(options = {}) {
  const { showToast = true } = options;
  const layer = getSelectedLayer();
  if (!layer) {
    return;
  }

  if (!layer.route) {
    setToast("当前图层没有可保存的路线", "warning");
    return;
  }

  const historyId = layer.route.historyId || createId("history");
  layer.route.historyId = historyId;

  const payload = {
    id: historyId,
    name: layer.meta.name,
    days: Number(layer.meta.days || 1),
    note: layer.meta.note || "",
    layerName: layer.name,
    color: layer.color,
    points: cloneJSON(layer.route.points || []),
    segmentModes: cloneJSON(layer.route.segmentModes || []),
    segments: cloneJSON(layer.route.segments || []),
    stats: cloneJSON(layer.route.stats || { distance: 0, duration: 0 }),
    updatedAt: Date.now()
  };

  state.historyRoutes = upsertHistoryRoute(payload);
  persistLayersState();
  renderHistoryOverlay();
  if (showToast) {
    setToast("路线已保存到本地缓存", "success");
  }
}

function deleteLayer(layerId) {
  const layer = state.layers.find((item) => item.id === layerId);
  if (!layer) {
    return;
  }
  const confirmDelete = window.confirm(`确认删除路线【${layer.name}】吗？`);
  if (!confirmDelete) {
    return;
  }
  if (state.mapService) {
    state.mapService.removeLayer(layer.id);
  }
  state.layers = state.layers.filter((item) => item.id !== layer.id);
  if (state.selectedLayerId === layer.id) {
    state.selectedLayerId = null;
    state.editorVisible = false;
  }
  persistLayersState();
  renderLeftPanel();
  renderRightPanel();
  setToast("图层已删除");
}

function focusLayer(layerId) {
  const layer = state.layers.find((item) => item.id === layerId);
  if (!layer) {
    return;
  }
  ensureLayerRoutes(layer);
  if (!isMapReady()) {
    setToast("地图尚未加载完成", "warning");
    return;
  }
  state.mapService.fitLayers([layer]);
}

function loadHistoryRouteToMap(historyId) {
  if (!isMapReady()) {
    setToast("地图尚未加载完成，请先配置并加载地图", "warning");
    return;
  }

  const route = state.historyRoutes.find((item) => item.id === historyId);
  if (!route) {
    return;
  }

  let boundLayer = null;
  let boundRoute = null;
  state.layers.forEach((layer) => {
    ensureLayerRoutes(layer);
    const found = layer.routes.find((item) => item.historyId === historyId);
    if (found) {
      boundLayer = layer;
      boundRoute = found;
    }
  });

  const historyRoutePayload = {
    historyId,
    points: cloneJSON(route.points || []),
    segmentModes: cloneJSON(route.segmentModes || []),
    segments: cloneJSON(route.segments || []),
    stats: cloneJSON(route.stats || { distance: 0, duration: 0 }),
    meta: {
      name: route.name || route.layerName || "未命名路线",
      days: Number(route.days || 1),
      note: route.note || ""
    }
  };

  if (!boundLayer) {
    const routeRecord = normalizeRoute(historyRoutePayload, 0);
    boundLayer = createLayerWithRoute(routeRecord, route.layerName || nextLayerName(state.layers));
    boundLayer.color = route.color || boundLayer.color;
    state.layers.push(boundLayer);
  } else if (boundRoute) {
    const refreshed = normalizeRoute({
      ...historyRoutePayload,
      id: boundRoute.id,
      visible: boundRoute.visible
    });
    const routeIndex = boundLayer.routes.findIndex((item) => item.id === boundRoute.id);
    if (routeIndex >= 0) {
      boundLayer.routes[routeIndex] = refreshed;
    }
    boundLayer.selectedRouteId = refreshed.id;
    ensureLayerRoutes(boundLayer);
  }

  ensureLayerRoutes(boundLayer);

  state.selectedLayerId = boundLayer.id;
  state.editorVisible = true;
  state.newRouteEditorOpen = false;
  rebuildLayers();
  state.mapService.fitLayers([boundLayer]);
  persistLayersState();

  state.historyOpen = false;
  state.historyDetailId = null;
  state.mapService.clearPreview();

  renderLeftPanel();
  renderRightPanel();
  renderHistoryOverlay();
  setToast("历史路线已加载到当前地图，可继续编辑", "success");
}

async function applyMapPick(point) {
  if (!state.pickMode) {
    return;
  }

  let resolved = null;
  try {
    resolved = await state.mapService.reverseGeocodePoint(point);
  } catch (error) {
    console.warn("地图点位命名失败，使用默认名称", error);
  }

  const mapPoint = createPoint({
    name: resolved?.name || "地图点",
    lng: point.lng,
    lat: point.lat,
    address: resolved?.address || "",
    city: resolved?.city || ""
  });

  if (state.pickMode.type === "draft-start") {
    state.draft.start = mapPoint;
    syncDraftSegmentModes();
    renderRightPanel();
    clearPickMode();
    return;
  }

  if (state.pickMode.type === "draft-end") {
    state.draft.end = mapPoint;
    syncDraftSegmentModes();
    renderRightPanel();
    clearPickMode();
    return;
  }

  if (state.pickMode.type === "draft-via") {
    if (state.draft.vias.length >= 10) {
      setToast("初始途经点最多 10 个", "warning");
      clearPickMode();
      return;
    }
    state.draft.vias.push(mapPoint);
    syncDraftSegmentModes();
    renderRightPanel();
    clearPickMode();
    return;
  }

  const layer = getSelectedLayer();
  if (!layer) {
    clearPickMode();
    return;
  }

  if (state.pickMode.type === "replace-layer-point") {
    const index = state.pickMode.index;
    pushEditHistory(layer);
    layer.route.points[index] = mapPoint;
    persistLayersState();
    renderRightPanel();
    clearPickMode();
    setToast("点位已替换，请重算路线");
    return;
  }

  if (state.pickMode.type === "insert-layer-point") {
    const index = state.pickMode.index;
    pushEditHistory(layer);
    layer.route.points.splice(index + 1, 0, mapPoint);
    syncLayerSegmentModes(layer);
    persistLayersState();
    renderRightPanel();
    clearPickMode();
    setToast("已插入途经点，请重算路线");
  }
}

function handleLeftPanelAction(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const { action } = target.dataset;

  if (action === "share-route") {
    // 强制优先在弹窗前校验是否有勾选的路线
    const exportLayers = getCheckedExportLayers();
    const exportRouteCount = countExportRoutes(exportLayers);
    if (exportRouteCount === 0) {
      return alert("提示：请在左侧列表中至少勾选一条需要导出的路线。");
    }

    const dialog = document.createElement("dialog");
    dialog.style.padding = "20px";
    dialog.style.borderRadius = "8px";
    dialog.style.border = "none";
    dialog.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
    dialog.style.maxWidth = "450px";
    dialog.style.width = "90%";
    dialog.innerHTML = `
      <h3 style="margin-top: 0">分享路线 <span style="font-size:12px;font-weight:normal;color:#666;">(仅导出已勾选的 ${exportRouteCount} 条路线)</span></h3>
      <div id="share-cards-container" style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 20px;">
        <div class="share-card selected" data-format="json" style="flex:1; padding:15px; border:2px solid cornflowerblue; border-radius:8px; cursor:pointer; text-align:center; font-weight:bold; background:#f0f6ff; transition:all 0.2s;">
          <div>JSON</div>
          <div style="font-size:12px; color:#666; font-weight:normal;">数据保留</div>
        </div>
        <div class="share-card" data-format="gpx" style="flex:1; padding:15px; border:2px solid #ddd; border-radius:8px; cursor:pointer; text-align:center; transition:all 0.2s;">
          <div>GPX</div>
          <div style="font-size:12px; color:#666; font-weight:normal;">(可导入其他地图软件)</div>
        </div>
        <div class="share-card" data-format="png" style="flex:1; padding:15px; border:2px solid #ddd; border-radius:8px; cursor:pointer; text-align:center; transition:all 0.2s;">
          <div>PNG</div>
          <div style="font-size:12px; color:#666; font-weight:normal;">地图截图</div>
        </div>
        <div class="share-card" data-format="pdf" style="flex:1; padding:15px; border:2px solid #ddd; border-radius:8px; cursor:pointer; text-align:center; transition:all 0.2s;">
          <div>PDF</div>
          <div style="font-size:12px; color:#666; font-weight:normal;">地图截图</div>
        </div>
      </div>
      <div style="text-align: right;">
        <button id="share-cancel" class="btn soft tiny">取消</button>
        <button id="share-confirm" class="btn primary tiny">确认导出</button>
      </div>
    `;
    document.body.appendChild(dialog);
    dialog.showModal();

    let selectedFormat = "json";
    const cards = dialog.querySelectorAll(".share-card");
    cards.forEach(card => {
      card.onclick = () => {
        cards.forEach(c => {
          c.style.border = "2px solid #ddd";
          c.style.background = "transparent";
          c.style.fontWeight = "normal";
          c.classList.remove("selected");
        });
        card.style.border = "2px solid cornflowerblue";
        card.style.background = "#f0f6ff";
        card.style.fontWeight = "bold";
        card.classList.add("selected");
        selectedFormat = card.dataset.format;
      };
    });

    dialog.querySelector("#share-cancel").onclick = () => {
      dialog.close();
      dialog.remove();
    };

    dialog.querySelector("#share-confirm").onclick = async () => {
      dialog.close();
      dialog.remove();

      try {
        if (selectedFormat === "json") {
          const content = await exportRouteData("json", exportLayers);
          downloadBlob(new Blob([content], { type: "application/json" }), "voyage_routes_data.json");
        } else if (selectedFormat === "gpx") {
          const content = await exportRouteData("gpx", exportLayers);
          downloadBlob(new Blob([content], { type: "application/gpx+xml" }), "voyage_routes_export.gpx");
        } else if (selectedFormat === "png" || selectedFormat === "pdf") {
          setToast("正在导出地图截图...", "info");
          await exportCheckedRoutesAsMap(selectedFormat, exportLayers);
        }
      } catch (error) {
        console.error(error);
        const message = error.message || "路线导出失败";
        setToast(message, "danger");
        window.alert(`导出失败：${message}`);
      }
      return;

      if (selectedFormat === "json") {
        const fileContent = JSON.stringify(exportLayers, null, 2);
        const blob = new Blob([fileContent], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "voyage_routes_data.json";
        link.click();
      } else if (selectedFormat === "gpx") {
        // 创建 GPX 结构
        let gpxData = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Voyage Plan">
`;
        exportLayers.forEach((layer) => {
          if (!layer.routes) return;
          layer.routes.filter(r => r.visible !== false).forEach((route) => {
            const nameEscaped = (route.meta?.name || layer.name || "未命名路线").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            gpxData += `  <trk>\n    <name>${nameEscaped}</name>\n    <trkseg>\n`;
            
            // 导出实际轨迹的分段路线坐标（高精度）
            if (route.segments && route.segments.length) {
              route.segments.forEach(segment => {
                if (segment.path && segment.path.length) {
                  segment.path.forEach(pt => {
                    const lng = Array.isArray(pt) ? pt[0] : (pt.lng || pt.getLng());
                    const lat = Array.isArray(pt) ? pt[1] : (pt.lat || pt.getLat());
                    gpxData += `      <trkpt lat="${lat}" lon="${lng}"></trkpt>\n`;
                  });
                }
              });
            } else if (route.points && route.points.length) {
               // 降级使用粗略的核心点替代
               route.points.forEach(pt => {
                  const ptName = pt.name ? `<name>${pt.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</name>` : '';
                  gpxData += `      <trkpt lat="${pt.lat}" lon="${pt.lng}">${ptName}</trkpt>\n`;
               });
            }
            gpxData += `    </trkseg>\n  </trk>\n`;
          });
        });
        gpxData += `</gpx>`;
        
        const blob = new Blob([gpxData], { type: "application/gpx+xml" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = "voyage_routes_export.gpx";
        link.click();
      }
    };
    return;
  }

  if (action === "close-ai-route-notice") {
    clearAIRouteNotice();
    return;
  }

  if (action === "import-route") {
    const input = document.getElementById("import-file-input");
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const name = file.name.toLowerCase();
      if (!name.endsWith(".json") && !name.endsWith(".gpx")) {
        alert("格式错误：仅支持 .json 或 .gpx 格式文件！");
        input.value = "";
        return;
      }
      
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target.result;
        try {
          if (name.endsWith(".json")) {
            const data = JSON.parse(text);
            if (Array.isArray(data)) {
               state.layers.push(...data);
               rebuildLayers();
               persistLayersState();
               renderLeftPanel();
               if (state.mapService && state.mapService.fitLayers) state.mapService.fitLayers(state.layers);
               setToast("成功导入路线数据");
            } else {
               alert("文件解析错误：导入的 JSON 中未能检测到合法的路线图层数组结构。");
            }
          } else if (name.endsWith(".gpx")) {
             alert("当前环境暂不支持直接解析 GPX 数据渲染，需转换为原生 JSON 格式。");
          }
        } catch (err) {
          alert("文件解析系统崩溃: " + err.message);
        }
        input.value = "";
      };
      reader.readAsText(file);
    };
    input.click();
    return;
  }

  if (action === "new-draft") {
    state.draft = createEmptyDraft();
    state.searchResults = [];
    state.searchResultsOpen = false;
    state.mapService?.clearSearchMarkers();
    renderLeftPanel();
    renderSearchResults();
    setToast("草稿已重置");
    return;
  }

  if (action === "pick-start-map") {
    setPickMode({ type: "draft-start", label: "设置起点" });
    return;
  }

  if (action === "pick-end-map") {
    setPickMode({ type: "draft-end", label: "设置终点" });
    return;
  }

  if (action === "pick-via-map") {
    setPickMode({ type: "draft-via", label: "添加途经点" });
    return;
  }

  if (action === "remove-via") {
    const index = Number(target.dataset.index);
    state.draft.vias.splice(index, 1);
    syncDraftSegmentModes();
    renderLeftPanel();
    return;
  }

  if (action === "via-up") {
    const index = Number(target.dataset.index);
    if (index > 0) {
      const temp = state.draft.vias[index - 1];
      state.draft.vias[index - 1] = state.draft.vias[index];
      state.draft.vias[index] = temp;
      syncDraftSegmentModes();
      renderLeftPanel();
    }
    return;
  }

  if (action === "via-down") {
    const index = Number(target.dataset.index);
    if (index < state.draft.vias.length - 1) {
      const temp = state.draft.vias[index + 1];
      state.draft.vias[index + 1] = state.draft.vias[index];
      state.draft.vias[index] = temp;
      syncDraftSegmentModes();
      renderLeftPanel();
    }
    return;
  }

  if (action === "apply-default-mode") {
    syncDraftSegmentModes();
    state.draft.segmentModes = state.draft.segmentModes.map(() => state.draft.defaultMode);
    renderLeftPanel();
    return;
  }

  if (action === "draft-segment-mode") {
    const index = Number(target.dataset.index);
    state.draft.segmentModes[index] = target.value;
    return;
  }

  if (action === "generate-route") {
    generateRouteLayer();
    return;
  }

  if (action === "open-new-route-editor") {
    closeAIChatForRouteEdit();
    state.newRouteEditorOpen = true;
    state.editorVisible = true;
    state.mobileRightOpen = true;
    state.draft = createEmptyDraft();
    renderRightPanel();
    return;
  }

  if (action === "layer-select") {
    closeAIChatForRouteEdit();
    clearPendingPointOrders();
    const nextId = target.dataset.layerId;
    state.selectedLayerId = nextId;
    state.editorVisible = true;
    state.newRouteEditorOpen = false;
    state.mobileRightOpen = true;
    renderLeftPanel();
    renderRightPanel();
    focusLayer(nextId);
    return;
  }

  if (action === "layer-toggle") {
    const layer = state.layers.find((item) => item.id === target.dataset.layerId);
    if (!layer) {
      return;
    }
    layer.visible = target.checked;
    rebuildLayers();
    persistLayersState();
    return;
  }

  if (action === "layer-focus-icon") {
    focusLayer(target.dataset.layerId);
    return;
  }

  if (action === "layer-rename-inline") {
    const layer = state.layers.find((item) => item.id === target.dataset.layerId);
    if (!layer) {
      return;
    }
    const nextName = window.prompt("输入新的图层名称", layer.name);
    if (!nextName || !nextName.trim()) {
      return;
    }
    layer.name = nextName.trim();
    persistLayersState();
    renderLeftPanel();
    renderRightPanel();
    return;
  }

  if (action === "layer-delete-inline") {
    deleteLayer(target.dataset.layerId);
  }
}

function handleLeftPanelInput(event) {
  const target = event.target;
  if (!target) {
    return;
  }

  if (target.id === "draft-default-mode") {
    state.draft.defaultMode = target.value;
    return;
  }

  if (target.id === "draft-transit-city") {
    state.draft.transitCity = target.value;
  }
}

function handleRightPanelAction(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const { action } = target.dataset;

  if (action === "close-new-route-editor" || action === "close-editor") {
    clearPendingPointOrders();
    state.newRouteEditorOpen = false;
    state.editorVisible = false;
    state.mobileRightOpen = false;
    renderRightPanel();
    return;
  }

  if (action === "new-draft") {
    state.draft = createEmptyDraft();
    renderRightPanel();
    setToast("草稿已重置");
    return;
  }

  if (action === "pick-start-map") {
    setPickMode({ type: "draft-start", label: "设置起点" });
    return;
  }

  if (action === "pick-end-map") {
    setPickMode({ type: "draft-end", label: "设置终点" });
    return;
  }

  if (action === "pick-via-map") {
    setPickMode({ type: "draft-via", label: "添加途经点" });
    return;
  }

  if (action === "remove-via") {
    const index = Number(target.dataset.index);
    state.draft.vias.splice(index, 1);
    syncDraftSegmentModes();
    renderRightPanel();
    return;
  }

  if (action === "via-up") {
    const index = Number(target.dataset.index);
    if (index > 0) {
      const temp = state.draft.vias[index - 1];
      state.draft.vias[index - 1] = state.draft.vias[index];
      state.draft.vias[index] = temp;
      syncDraftSegmentModes();
      renderRightPanel();
    }
    return;
  }

  if (action === "via-down") {
    const index = Number(target.dataset.index);
    if (index < state.draft.vias.length - 1) {
      const temp = state.draft.vias[index + 1];
      state.draft.vias[index + 1] = state.draft.vias[index];
      state.draft.vias[index] = temp;
      syncDraftSegmentModes();
      renderRightPanel();
    }
    return;
  }

  if (action === "apply-default-mode") {
    syncDraftSegmentModes();
    state.draft.segmentModes = state.draft.segmentModes.map(() => state.draft.defaultMode);
    renderRightPanel();
    return;
  }

  if (action === "draft-segment-mode") {
    const index = Number(target.dataset.index);
    state.draft.segmentModes[index] = target.value;
    return;
  }

  if (action === "generate-route") {
    generateRouteLayer();
    return;
  }

  const layer = getSelectedLayer();
  if (!layer) {
    return;
  }

  if (action === "route-select") {
    closeAIChatForRouteEdit();
    clearPendingPointOrders();
    layer.selectedRouteId = target.dataset.routeId;
    state.editorVisible = true;
    state.newRouteEditorOpen = false;
    state.mobileRightOpen = true;
    ensureLayerRoutes(layer);
    persistLayersState();
    renderRightPanel();
    focusLayer(layer.id);
    return;
  }

  if (action === "route-toggle") {
    const route = (layer.routes || []).find((item) => item.id === target.dataset.routeId);
    if (!route) {
      return;
    }
    route.visible = target.checked;
    rebuildLayers();
    persistLayersState();
    return;
  }

  if (action === "route-delete") {
    if ((layer.routes || []).length <= 1) {
      setToast("图层至少保留一条路线，如需清空请删除图层", "warning");
      return;
    }
    const routeId = target.dataset.routeId;
    const route = (layer.routes || []).find((item) => item.id === routeId);
    const ok = window.confirm(`确认删除路线【${route?.meta?.name || "未命名路线"}】吗？`);
    if (!ok) {
      return;
    }
    clearPendingPointOrder(route);
    layer.routes = (layer.routes || []).filter((item) => item.id !== routeId);
    if (layer.selectedRouteId === routeId) {
      layer.selectedRouteId = layer.routes[0]?.id || null;
    }
    ensureLayerRoutes(layer);
    rebuildLayers();
    persistLayersState();
    renderRightPanel();
    return;
  }

  if (action === "undo-edit") {
    undoLayerEdit();
    return;
  }

  if (action === "redo-edit") {
    redoLayerEdit();
    return;
  }

  if (action === "meta-change") {
    if (event.type === "click") {
      return;
    }

    const field = target.dataset.field;
    if (event.type === "change") {
      pushEditHistory(layer);
    }
    layer.meta[field] = target.value;

    if (field === "name" && (layer.routes || []).length === 1) {
      layer.name = target.value || layer.name;
    }

    if (event.type === "change") {
      renderLeftPanel();
      renderRightPanel();
    }

    persistLayersState();
    return;
  }

  if (action === "point-up") {
    const index = Number(target.dataset.index);
    if (index > 0) {
      pushEditHistory(layer);
      const temp = layer.route.points[index - 1];
      layer.route.points[index - 1] = layer.route.points[index];
      layer.route.points[index] = temp;
      syncLayerSegmentModes(layer);
      persistLayersState();
      renderRightPanel();
    }
    return;
  }

  if (action === "point-focus") {
    const index = Number(target.dataset.index);
    const point = layer.route.points[index];
    if (!point || !isMapReady()) {
      return;
    }
    state.mapService.focusPoint(point, index, layer);
    setToast(`已定位到：${point.name}`);
    return;
  }

  if (action === "point-down") {
    const index = Number(target.dataset.index);
    if (index < layer.route.points.length - 1) {
      pushEditHistory(layer);
      const temp = layer.route.points[index + 1];
      layer.route.points[index + 1] = layer.route.points[index];
      layer.route.points[index] = temp;
      syncLayerSegmentModes(layer);
      persistLayersState();
      renderRightPanel();
    }
    return;
  }

  if (action === "point-delete") {
    const index = Number(target.dataset.index);
    if (index < 0 || index >= layer.route.points.length) {
      return;
    }
    if (layer.route.points.length <= 2) {
      setToast("路线至少保留两个地点", "warning");
      return;
    }
    pushEditHistory(layer);
    clearPendingPointOrder(layer.route);
    layer.route.points.splice(index, 1);
    syncLayerSegmentModes(layer);
    persistLayersState();
    renderRightPanel();
    return;
  }

  if (action === "point-replace-map") {
    setPickMode({ type: "replace-layer-point", index: Number(target.dataset.index), label: "替换点位" });
    return;
  }

  if (action === "insert-between-map") {
    clearPendingPointOrder(layer.route);
    setPickMode({ type: "insert-layer-point", index: Number(target.dataset.index), label: "插入途经点" });
    return;
  }

  if (action === "layer-segment-mode") {
    const index = Number(target.dataset.index);
    pushEditHistory(layer);
    layer.route.segmentModes[index] = target.value;
    persistLayersState();
    return;
  }

  if (action === "recalc-layer") {
    recalcSelectedLayer();
    return;
  }
}

function handleHistoryAction(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const { action } = target.dataset;

  if (action === "history-close") {
    state.historyOpen = false;
    state.historyDetailId = null;
    if (state.mapService) {
      state.mapService.clearPreview();
    }
    renderHistoryOverlay();
    return;
  }

  if (action === "history-detail") {
    state.historyDetailId = target.dataset.id;
    const route = state.historyRoutes.find((item) => item.id === state.historyDetailId);
    if (route && state.mapService) {
      state.mapService.drawHistoryPreview(route, route.color || "#ffd166");
    }
    renderHistoryOverlay();
    return;
  }

  if (action === "history-back") {
    state.historyDetailId = null;
    if (state.mapService) {
      state.mapService.clearPreview();
    }
    renderHistoryOverlay();
    return;
  }

  if (action === "history-load-map") {
    loadHistoryRouteToMap(target.dataset.id);
    return;
  }

  if (action === "history-delete") {
    const routeId = target.dataset.id;
    const route = state.historyRoutes.find((item) => item.id === routeId);
    const ok = window.confirm(`确认删除历史路线【${route?.name || route?.layerName || "未命名"}】吗？`);
    if (!ok) {
      return;
    }

    state.historyRoutes = removeHistoryRoute(routeId);
    if (state.historyDetailId === routeId) {
      state.historyDetailId = null;
      if (state.mapService) {
        state.mapService.clearPreview();
      }
    }

    state.layers.forEach((layer) => {
      ensureLayerRoutes(layer);
      layer.routes.forEach((routeItem) => {
        if (routeItem.historyId === routeId) {
          routeItem.historyId = null;
        }
      });
    });

    persistLayersState();

    renderHistoryOverlay();
    setToast("历史路线已删除");
  }
}

async function doSearch() {
  const input = document.getElementById("search-input");
  const keyword = input?.value?.trim();
  if (!keyword) {
    setToast("请输入检索关键词", "warning");
    return;
  }
  if (!isMapReady()) {
    setToast("地图尚未加载完成", "warning");
    return;
  }

  try {
    state.searchResultsOpen = true;
    state.searchSuggestionsOpen = false;
    state.searchSuggestions = [];
    const { pois, fallbackUsed, searchCity } = await requestSearchPOI(keyword);
    state.searchResults = pois.slice(0, 8);
    renderSearchResults();
    state.mapService.renderSearchMarkers(state.searchResults, (poi) => {
      setToast(`已选中：${poi.name}`);
    });

    const usedFallback = Boolean(fallbackUsed && searchCity);
    const fallbackHint = usedFallback ? `当前城市“${searchCity}”未命中，已扩展到全国搜索` : "";
    const resultScope = state.searchResults[0]?.searchScope || "";

    if (!state.searchResults.length) {
      setToast(fallbackHint ? `${fallbackHint}，仍未检索到结果` : "未检索到结果", "warning");
      return;
    }

    if (resultScope === "viewport") {
      setToast(`${fallbackHint ? `${fallbackHint}；` : ""}已优先展示当前视窗内结果`, "info");
      return;
    }

    if (resultScope === "nearby") {
      setToast(`${fallbackHint ? `${fallbackHint}；` : ""}当前视窗无结果，已按距离由近到远展示`, "info");
      return;
    }

    if (usedFallback) {
      setToast(fallbackHint, "info");
      return;
    }

    if (pois.length > 8) {
      setToast(`检索到 ${pois.length} 条，仅展示前 8 条`, "info");
    }
  } catch (error) {
    console.error(error);
    setToast(error.message || "检索失败", "danger");
  }
}

function scheduleSearchSuggestions() {
  const input = document.getElementById("search-input");
  const keyword = input?.value?.trim() || "";
  if (state.searchSuggestTimer) {
    window.clearTimeout(state.searchSuggestTimer);
  }

  if (!keyword || keyword.length < 2 || !isMapReady()) {
    state.searchSuggestions = [];
    state.searchSuggestionsOpen = false;
    renderSearchResults();
    return;
  }

  state.searchSuggestTimer = window.setTimeout(async () => {
    try {
      const { suggestions } = await requestSearchSuggestions(keyword);
      if ((document.getElementById("search-input")?.value?.trim() || "") !== keyword) {
        return;
      }
      state.searchSuggestions = suggestions;
      state.searchSuggestionsOpen = suggestions.length > 0;
      state.searchResultsOpen = false;
      renderSearchResults();
    } catch (error) {
      state.searchSuggestions = [];
      state.searchSuggestionsOpen = false;
      renderSearchResults();
    }
  }, 260);
}

function handleSearchResultAction(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  if (target.dataset.action === "search-close") {
    state.searchResultsOpen = false;
    renderSearchResults();
    return;
  }

  if (target.dataset.action === "suggest-close") {
    state.searchSuggestionsOpen = false;
    renderSearchResults();
    return;
  }

  if (target.dataset.action === "suggest-pick") {
    const index = Number(target.dataset.index);
    const poi = state.searchSuggestions[index];
    const input = document.getElementById("search-input");
    if (poi && input) {
      input.value = poi.name;
      state.searchSuggestionsOpen = false;
      state.searchSuggestions = [];
      renderSearchResults();
      doSearch();
    }
    return;
  }

  const index = Number(target.dataset.index);
  const poi = state.searchResults[index];
  if (!poi) {
    return;
  }

  if (target.dataset.action === "search-focus") {
    if (!isMapReady()) {
      setToast("地图尚未加载完成", "warning");
      return;
    }
    state.mapService.focusSearchResult(poi, index);
    setToast(`已定位到：${poi.name}`);
    return;
  }

  if (target.dataset.action === "search-to-start") {
    applyPoiToDraft(poi, "start");
    setToast("已设为起点", "success");
    return;
  }

  if (target.dataset.action === "search-to-end") {
    applyPoiToDraft(poi, "end");
    setToast("已设为终点", "success");
    return;
  }

  if (target.dataset.action === "search-to-via") {
    applyPoiToDraft(poi, "via");
    setToast("已添加为途经点", "success");
  }
}

function bindEvents() {
  const leftPanel = document.getElementById("left-panel");
  const rightPanel = document.getElementById("right-panel");
  const aiChatPanel = document.getElementById("ai-chat-panel");
  const searchBtn = document.getElementById("search-btn");
  const aiChatBtn = document.getElementById("ai-chat-btn");
  const themeBtn = document.getElementById("theme-toggle-btn");
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");
  const historyBtn = document.getElementById("show-history-btn");
  const historyOverlay = document.getElementById("history-overlay");
  const aiRouteNotice = document.getElementById("ai-route-notice");
  const leftMobileBtn = document.getElementById("toggle-left-btn");
  const rightMobileBtn = document.getElementById("toggle-right-btn");
  const authEntry = document.getElementById("auth-entry");
  const authDialog = document.getElementById("auth-dialog");

  leftPanel.addEventListener("click", handleLeftPanelAction);
  leftPanel.addEventListener("change", handleLeftPanelAction);
  leftPanel.addEventListener("input", handleLeftPanelInput);

  rightPanel.addEventListener("click", handleRightPanelAction);
  rightPanel.addEventListener("change", handleRightPanelAction);
  rightPanel.addEventListener("input", handleRightPanelAction);
  rightPanel.addEventListener("mouseover", (event) => {
    const target = event.target.closest("[data-tooltip]");
    if (target && rightPanel.contains(target)) {
      showFloatingTooltip(target, target.dataset.tooltip);
    }
  });
  rightPanel.addEventListener("mouseout", (event) => {
    const target = event.target.closest("[data-tooltip]");
    if (target && rightPanel.contains(target)) {
      hideFloatingTooltip();
    }
  });
  rightPanel.addEventListener("change", handleLeftPanelInput);
  rightPanel.addEventListener("input", handleLeftPanelInput);
  aiChatPanel.addEventListener("click", handleAIChatAction);
  aiChatPanel.addEventListener("keydown", handleAIChatKeydown);
  aiChatPanel.addEventListener("focusout", (event) => {
    const conversationId = event.target?.dataset?.aiRenameInput;
    if (!conversationId) {
      return;
    }
    window.setTimeout(() => {
      if (document.activeElement?.closest(`[data-conversation-id="${conversationId}"]`)) {
        return;
      }
      const actionTarget = document.querySelector(`[data-ai-action="save-rename-conversation"][data-conversation-id="${conversationId}"]`);
      actionTarget?.click();
    }, 0);
  });

  searchBtn.addEventListener("click", doSearch);
  aiChatBtn?.addEventListener("click", () => {
    toggleAIChatPanel();
  });
  themeBtn?.addEventListener("click", () => {
    toggleThemeMode();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      doSearch();
      return;
    }

    if (event.key === "Escape") {
      state.searchResultsOpen = false;
      state.searchSuggestionsOpen = false;
      renderSearchResults();
    }
  });
  searchInput.addEventListener("input", () => {
    if (!searchInput.value.trim()) {
      state.searchResults = [];
      state.searchResultsOpen = false;
      state.searchSuggestions = [];
      state.searchSuggestionsOpen = false;
      state.mapService.clearSearchMarkers();
      renderSearchResults();
      return;
    }
    scheduleSearchSuggestions();
  });
  searchInput.addEventListener("focus", scheduleSearchSuggestions);
  searchResults.addEventListener("click", handleSearchResultAction);

  document.addEventListener("click", (event) => {
    const searchCard = document.querySelector(".search-card");
    if (!searchCard) {
      return;
    }
    if ((state.searchResultsOpen || state.searchSuggestionsOpen) && !searchCard.contains(event.target)) {
      state.searchResultsOpen = false;
      state.searchSuggestionsOpen = false;
      renderSearchResults();
    }
  });

  historyBtn.addEventListener("click", () => {
    state.historyRoutes = loadHistoryRoutes();
    state.historyOpen = true;
    state.historyDetailId = null;
    renderHistoryOverlay();
  });

  historyOverlay.addEventListener("click", handleHistoryAction);
  authEntry?.addEventListener("click", (event) => {
    const action = event.target.closest("[data-auth-action]")?.dataset.authAction;
    if (action === "logout") {
      clearAuthSession();
      openAuthDialog("login", { required: true });
      setToast("已退出登录，本地路线和历史记录保持不变。", "success");
      return;
    }
    if (action === "login" || action === "register") openAuthDialog(action);
  });
  authDialog?.addEventListener("click", (event) => {
    const action = event.target.closest("[data-auth-action]")?.dataset.authAction;
    if (action === "close") {
      if (state.authRequired) return;
      state.authDialogMode = "";
      renderAuthDialog();
    } else if (action === "switch") {
      openAuthDialog(state.authDialogMode === "login" ? "register" : "login");
    }
  });
  authDialog?.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-auth-form]");
    if (!form) return;
    event.preventDefault();
    handleAuthSubmit(form);
  });
  document.addEventListener("keydown", (event) => {
    if (state.authRequired && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  aiRouteNotice?.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action='close-ai-route-notice']");
    if (!target || !aiRouteNotice.contains(target)) {
      return;
    }
    clearAIRouteNotice();
  });

  leftMobileBtn.addEventListener("click", () => {
    state.mobileLeftOpen = !state.mobileLeftOpen;
    renderLeftPanel();
  });

  rightMobileBtn.addEventListener("click", () => {
    if (!state.editorVisible || (!getSelectedLayer() && !state.newRouteEditorOpen)) {
      setToast("请先选中一条路线再打开编辑", "warning");
      return;
    }
    state.mobileRightOpen = !state.mobileRightOpen;
    renderRightPanel();
  });
}

async function initMap() {
  const warning = document.getElementById("key-warning");
  if (!AMAP_KEY) {
    state.mapReady = false;
    warning.textContent = "尚未配置高德 Key：请在 .env 中填写 VITE_AMAP_KEY 后重启。";
    warning.classList.remove("hidden");
    return;
  }

  state.mapService = new MapService({ key: AMAP_KEY, securityCode: AMAP_SECURITY_CODE, themeMode: state.themeMode });

  try {
    await state.mapService.init("map");
    state.mapReady = true;
    state.mapService.setThemeMode(state.themeMode);
    state.mapService.setMapClickHandler((point) => applyMapPick(point));
    const layer = getSelectedLayer();
    const overlayOpen = state.aiChatOpen || state.newRouteEditorOpen || Boolean(layer && layer.route && state.editorVisible);
    setFloatingEditorState(overlayOpen);
    rebuildLayers();
    setToast("地图加载成功", "success");
  } catch (error) {
    console.error(error);
    warning.textContent = `地图初始化失败：${error.message}`;
    warning.classList.remove("hidden");
  }
}

async function boot() {
  const legacyMessages = normalizeAIChatMessages(loadAIChatMessages()).messages;
  if (legacyMessages.length) {
    saveAIChatMessages(legacyMessages);
  }
  const aiChatState = await initAIChatStore(legacyMessages);
  state.aiConversations = await normalizeAllStoredAIConversations(aiChatState.conversations);
  state.aiConversationId = aiChatState.currentConversationId;
  state.aiChatMessages = normalizeAIChatMessages(aiChatState.messages).messages;
  if (state.aiConversationId) {
    await saveAIConversationMessages(state.aiConversationId, state.aiChatMessages);
  }
  state.layers = normalizeLayers(state.layers);
  if (state.selectedLayerId && !state.layers.some((layer) => layer.id === state.selectedLayerId)) {
    state.selectedLayerId = null;
  }
  state.editorVisible = false;
  persistLayersState();

  workspaceSync = createWorkspaceSync({
    getLayers: serializeLayersForStorage,
    applyLayers: applyCloudLayers,
    onStatus: (status) => {
      if (status === "unsynced" && getAuthState().isAuthenticated) {
        setToast("云端路线同步失败，本地数据已保留。", "warning");
      }
    },
    normalizeLayers
  });

  buildLayout();
  setUnauthorizedHandler(() => {
    if (getAuthState().isAuthenticated) {
      clearAuthSession();
      setToast("登录已失效，请重新登录。", "warning");
    }
  });
  subscribeAuth(() => {
    aiConversationAuthGeneration += 1;
    workspaceSync?.cancelWorkspaceSave();
    const auth = getAuthState();
    const userId = auth.isAuthenticated ? String(auth.user?.id || "") : "";
    switchLayerCache(userId);
    void switchAIConversationStore();
    renderAuthEntry();
    if (!auth.isAuthenticated) {
      openAuthDialog("login", { required: true });
    }
  });
  if (!getAuthState().isAuthenticated) {
    openAuthDialog("login", { required: true });
  }
  applyThemeMode(state.themeMode, false);
  renderLeftPanel();
  renderRightPanel();
  renderAIChatPanel();
  renderSearchResults();
  renderHistoryOverlay();
  bindEvents();
  await initMap();
}

boot();
