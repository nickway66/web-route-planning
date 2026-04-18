import "./styles.css";
import { AMAP_KEY, AMAP_SECURITY_CODE } from "./config";
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

const app = document.getElementById("app");

function loadThemeMode() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "day" ? "day" : "night";
  } catch (error) {
    return "night";
  }
}

const state = {
  mapService: null,
  mapReady: false,
  themeMode: loadThemeMode(),
  editorVisible: false,
  newRouteEditorOpen: false,
  searchResults: [],
  searchResultsOpen: false,
  draft: createEmptyDraft(),
  layers: loadLayerState(),
  selectedLayerId: null,
  historyRoutes: loadHistoryRoutes(),
  historyDetailId: null,
  historyOpen: false,
  pickMode: null,
  toastTimer: null,
  mobileLeftOpen: false,
  mobileRightOpen: false
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
    name,
    address,
    city,
    lng: Number(lng),
    lat: Number(lat),
    priority: 1
  };
}

function normalizeRoute(route, index = 0) {
  const meta = route?.meta || {};
  return {
    id: route?.id || createId("route"),
    visible: route?.visible !== false,
    historyId: route?.historyId || null,
    points: cloneJSON(route?.points || []),
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
  saveLayerState(serializeLayersForStorage());
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
              <button id="theme-toggle-btn" class="btn ghost" type="button">${
                getThemeToggleIcon(state.themeMode)
              }</button>
            </div>
            <div id="search-results" class="search-results"></div>
          </section>
          <div class="top-actions">
            <button id="show-history-btn" class="btn ghost" type="button">历史路线</button>
          </div>
        </div>

        <div class="mobile-actions">
          <button id="toggle-left-btn" class="btn soft" type="button">菜单</button>
          <button id="toggle-right-btn" class="btn soft" type="button">编辑</button>
        </div>

        <aside id="right-panel" class="side-panel right floating-hidden"></aside>

        <div id="key-warning" class="key-warning hidden"></div>
        <div id="status-toast" class="status-toast"></div>
      </main>
    </div>

    <section id="history-overlay" class="history-overlay hidden"></section>
  `;
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
  return text.replace(/市$/, "");
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

    <section class="panel-block">
      <div class="panel-head-inline">
        <h3>路线管理</h3>
        <button data-action="open-new-route-editor" class="btn tiny" type="button">+</button>
      </div>
      <ul class="layer-list">
        ${layerRows || '<li class="muted">暂无图层，先生成一条路线。</li>'}
      </ul>
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
    setFloatingEditorState(false);
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

  const points = layer.route.points || [];
  syncLayerSegmentModes(layer);
  const segments = layer.route.segmentModes || [];

  panel.innerHTML = `
    <div class="panel-header">
      <h2>编辑：${layer.name}</h2>
      <button data-action="focus-selected" class="btn soft" type="button">定位图层</button>
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
        出行天数
        <input data-action="meta-change" data-field="days" type="number" min="1" value="${layer.meta.days}" />
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
      <ul class="edit-points">
        ${points
          .map((point, index) => {
            const canDelete = index > 0 && index < points.length - 1;
            return `
              <li>
                <div>
                  <strong>${index + 1}. ${point.name}</strong>
                  <small>${point.lng.toFixed(5)}, ${point.lat.toFixed(5)}</small>
                </div>
                <div class="point-edit-actions">
                  <button data-action="point-up" data-index="${index}" class="btn tiny" type="button">上移</button>
                  <button data-action="point-down" data-index="${index}" class="btn tiny" type="button">下移</button>
                  ${
                    canDelete
                      ? `<button data-action="point-delete" data-index="${index}" class="btn tiny danger" type="button">删点</button>`
                      : ""
                  }
                  <button data-action="point-replace-map" data-index="${index}" class="btn tiny" type="button">地图替换</button>
                </div>
                ${
                  index < points.length - 1
                    ? `<div class="between-actions">
                        <button data-action="insert-between-map" data-index="${index}" class="btn tiny soft" type="button">在 ${
                        index + 1
                      } 和 ${index + 2} 之间插入途经点（地图）</button>
                      </div>`
                    : ""
                }
              </li>
            `;
          })
          .join("")}
      </ul>
    </section>

    <section class="panel-block">
      <h3>分段交通方式</h3>
      <div class="segment-list">
        ${segments
          .map((mode, index) => {
            const transitTools = layer.route.segments?.[index]?.transitTools || [];
            return `
              <div class="segment-entry">
                <div class="segment-row">
                  <span>${index + 1}. ${compactPointName(points[index]?.name || `点${index + 1}`)} → ${compactPointName(
                        points[index + 1]?.name || `点${index + 2}`
                      )}</span>
                  <select data-action="layer-segment-mode" data-index="${index}">
                    ${modeOptions(mode)}
                  </select>
                </div>
                ${
                  mode === "transit"
                    ? `<p class="segment-tools">公共交通：${transitTools.length ? transitTools.join(" / ") : "暂无线路详情"}</p>`
                    : ""
                }
              </div>
            `;
          })
          .join("")}
      </div>
      <button data-action="recalc-layer" class="btn primary full" type="button">应用修改并重算路线</button>
      <button data-action="save-layer" class="btn soft full" type="button">保存路线到本地缓存</button>
    </section>
  `;
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

function createLayerWithRoute(route, layerName) {
  const layer = ensureLayerRoutes({
    id: createId("layer"),
    name: layerName,
    color: pickUniqueColor(state.layers.map((item) => item.color)),
    visible: true,
    routes: [route],
    selectedRouteId: route.id
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

    const segments = await state.mapService.planRouteSegments(
      points,
      state.draft.segmentModes,
      transitCity
    );

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

  const points = layer.route.points || [];
  if (points.length < 2) {
    setToast("点位不足，无法重算路线", "warning");
    return;
  }

  syncLayerSegmentModes(layer);

  try {
    setToast("正在重算当前图层路线...");
    let transitCity = normalizeTransitCity(state.draft.transitCity) || "成都";
    if (hasTransitMode(layer.route.segmentModes || [])) {
      transitCity = await resolveTransitCityFromStart(points[0], transitCity);
      state.draft.transitCity = transitCity;
      renderLeftPanel();
    }

    const segments = await state.mapService.planRouteSegments(
      points,
      layer.route.segmentModes,
      transitCity
    );
    layer.route.segments = segments;
    layer.route.stats = collectStats(segments);
    rebuildLayers();
    state.mapService.fitLayers([layer]);
    persistLayersState();
    renderRightPanel();
    setToast("路线重算完成", "success");
  } catch (error) {
    console.error(error);
    setToast(error.message || "重算失败", "danger");
  }
}

function saveSelectedLayerToHistory() {
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
  setToast("路线已保存到本地缓存", "success");
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

function applyMapPick(point) {
  if (!state.pickMode) {
    return;
  }

  const mapPoint = createPoint({
    name: `地图点(${point.lng.toFixed(4)}, ${point.lat.toFixed(4)})`,
    lng: point.lng,
    lat: point.lat
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
    layer.route.points[index] = mapPoint;
    persistLayersState();
    renderRightPanel();
    clearPickMode();
    setToast("点位已替换，请重算路线");
    return;
  }

  if (state.pickMode.type === "insert-layer-point") {
    const index = state.pickMode.index;
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
    state.newRouteEditorOpen = true;
    state.editorVisible = true;
    state.mobileRightOpen = true;
    state.draft = createEmptyDraft();
    renderRightPanel();
    return;
  }

  if (action === "layer-select") {
    const nextId = target.dataset.layerId;
    const isSame = state.selectedLayerId === nextId;
    if (isSame && state.editorVisible && !state.newRouteEditorOpen) {
      state.editorVisible = false;
      state.mobileRightOpen = false;
      renderLeftPanel();
      renderRightPanel();
      return;
    }

    state.selectedLayerId = nextId;
    state.editorVisible = true;
    state.newRouteEditorOpen = false;
    state.mobileRightOpen = true;
    renderLeftPanel();
    renderRightPanel();
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

  if (action === "close-new-route-editor") {
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
    layer.selectedRouteId = target.dataset.routeId;
    state.editorVisible = true;
    state.newRouteEditorOpen = false;
    state.mobileRightOpen = true;
    ensureLayerRoutes(layer);
    persistLayersState();
    renderRightPanel();
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

  if (action === "focus-selected") {
    focusLayer(layer.id);
    return;
  }

  if (action === "meta-change") {
    const field = target.dataset.field;
    if (field === "days") {
      layer.meta.days = Math.max(1, Number(target.value || 1));
    } else {
      layer.meta[field] = target.value;
    }
    if (field === "name") {
      renderRightPanel();
    }
    persistLayersState();
    return;
  }

  if (action === "point-up") {
    const index = Number(target.dataset.index);
    if (index > 0) {
      const temp = layer.route.points[index - 1];
      layer.route.points[index - 1] = layer.route.points[index];
      layer.route.points[index] = temp;
      syncLayerSegmentModes(layer);
      persistLayersState();
      renderRightPanel();
    }
    return;
  }

  if (action === "point-down") {
    const index = Number(target.dataset.index);
    if (index < layer.route.points.length - 1) {
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
    if (index <= 0 || index >= layer.route.points.length - 1) {
      return;
    }
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
    setPickMode({ type: "insert-layer-point", index: Number(target.dataset.index), label: "插入途经点" });
    return;
  }

  if (action === "layer-segment-mode") {
    const index = Number(target.dataset.index);
    layer.route.segmentModes[index] = target.value;
    persistLayersState();
    return;
  }

  if (action === "recalc-layer") {
    recalcSelectedLayer();
    return;
  }

  if (action === "save-layer") {
    saveSelectedLayerToHistory();
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
    const pois = await state.mapService.searchPOI(keyword);
    state.searchResults = pois.slice(0, 8);
    renderSearchResults();
    state.mapService.renderSearchMarkers(state.searchResults, (poi) => {
      setToast(`已选中：${poi.name}`);
    });
    if (!state.searchResults.length) {
      setToast("未检索到结果", "warning");
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
  const searchBtn = document.getElementById("search-btn");
  const themeBtn = document.getElementById("theme-toggle-btn");
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");
  const historyBtn = document.getElementById("show-history-btn");
  const historyOverlay = document.getElementById("history-overlay");
  const leftMobileBtn = document.getElementById("toggle-left-btn");
  const rightMobileBtn = document.getElementById("toggle-right-btn");

  leftPanel.addEventListener("click", handleLeftPanelAction);
  leftPanel.addEventListener("change", handleLeftPanelAction);
  leftPanel.addEventListener("input", handleLeftPanelInput);

  rightPanel.addEventListener("click", handleRightPanelAction);
  rightPanel.addEventListener("change", handleRightPanelAction);
  rightPanel.addEventListener("input", handleRightPanelAction);
  rightPanel.addEventListener("change", handleLeftPanelInput);
  rightPanel.addEventListener("input", handleLeftPanelInput);

  searchBtn.addEventListener("click", doSearch);
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
      renderSearchResults();
    }
  });
  searchResults.addEventListener("click", handleSearchResultAction);

  document.addEventListener("click", (event) => {
    const searchCard = document.querySelector(".search-card");
    if (!searchCard) {
      return;
    }
    if (state.searchResultsOpen && !searchCard.contains(event.target)) {
      state.searchResultsOpen = false;
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
    const overlayOpen = state.newRouteEditorOpen || Boolean(layer && layer.route && state.editorVisible);
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
  state.layers = normalizeLayers(state.layers);
  if (state.selectedLayerId && !state.layers.some((layer) => layer.id === state.selectedLayerId)) {
    state.selectedLayerId = null;
  }
  state.editorVisible = false;
  persistLayersState();

  buildLayout();
  applyThemeMode(state.themeMode, false);
  renderLeftPanel();
  renderRightPanel();
  renderSearchResults();
  renderHistoryOverlay();
  bindEvents();
  await initMap();
}

boot();
