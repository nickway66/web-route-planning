const SCRIPT_ID = "amap-jsapi-loader";
const SCREENSHOT_SCRIPT_ID = "amap-screenshot-loader";
const SCREENSHOT_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/@amap/screenshot/dist/index.js";
const SUBWAY_LINE_COLORS = [
  "#e23b3b",
  "#28a745",
  "#f2b705",
  "#6f42c1",
  "#00a3e0",
  "#d63384",
  "#20c997",
  "#fd7e14",
  "#0d6efd",
  "#6c757d",
  "#8bc34a",
  "#795548"
];

function parseLngLatPoint(point) {
  if (!point) {
    return null;
  }
  let lng, lat;
  if (typeof point === "string") {
    const parts = point.split(",");
    if (parts.length >= 2) {
      lng = Number(parts[0]);
      lat = Number(parts[1]);
    }
  } else if (Array.isArray(point) && point.length >= 2) {
    lng = Number(point[0]);
    lat = Number(point[1]);
  } else if (point.lng !== undefined && point.lat !== undefined) {
    lng = Number(point.lng);
    lat = Number(point.lat);
  } else if (typeof point.getLng === "function" && typeof point.getLat === "function") {
    lng = Number(point.getLng());
    lat = Number(point.getLat());
  }
  
  if (lng !== undefined && lat !== undefined && !Number.isNaN(lng) && !Number.isNaN(lat)) {
    return [lng, lat];
  }
  return null;
}

function dedupePath(path = []) {
  const result = [];
  let last = null;
  path.forEach((point) => {
    if (!point) {
      return;
    }
    const current = [Number(point[0]), Number(point[1])];
    if (!Number.isFinite(current[0]) || !Number.isFinite(current[1])) {
      return;
    }
    if (!last || last[0] !== current[0] || last[1] !== current[1]) {
      result.push(current);
      last = current;
    }
  });
  return result;
}

function parsePolylineString(polyline = "") {
  if (!polyline || typeof polyline !== "string") {
    return [];
  }

  const normalized = polyline.replace(/\|/g, ";").trim();
  const matches = normalized.match(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g) || [];
  const parsed = matches
    .map((pair) => pair.split(","))
    .map(([lng, lat]) => [Number(lng), Number(lat)])
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));

  return dedupePath(parsed);
}

function flattenStepPath(steps = []) {
  const path = [];
  steps.forEach((step) => {
    const stepPath = Array.isArray(step.path) ? step.path : [];
    stepPath.forEach((point) => {
      const p = parseLngLatPoint(point);
      if (p) {
        path.push(p);
      }
    });
  });
  return dedupePath(path);
}

function flattenTmcsPath(steps = []) {
  const path = [];
  steps.forEach((step) => {
    const tmcsList = Array.isArray(step?.tmcs) ? step.tmcs : Array.isArray(step?.tmcsPaths) ? step.tmcsPaths : [];
    tmcsList.forEach((tmcs) => {
      const tmcsPath = Array.isArray(tmcs?.path) ? tmcs.path : [];
      tmcsPath.forEach((point) => {
        const p = parseLngLatPoint(point);
        if (p) {
          path.push(p);
        }
      });
      if (typeof tmcs?.polyline === "string") {
        path.push(...parsePolylineString(tmcs.polyline));
      }
    });
  });
  return dedupePath(path);
}

function flattenStepPolyline(steps = []) {
  const path = [];
  steps.forEach((step) => {
    if (typeof step?.polyline === "string") {
      path.push(...parsePolylineString(step.polyline));
    }
  });
  return dedupePath(path);
}

function parseRoutePath(route = {}) {
  const steps = Array.isArray(route?.steps) ? route.steps : [];
  const rides = Array.isArray(route?.rides) ? route.rides : [];
  const allSteps = [...steps, ...rides];

  const candidates = [
    flattenTmcsPath(allSteps),
    flattenStepPath(allSteps),
    flattenStepPolyline(allSteps),
    parsePolylineString(route?.polyline || "")
  ];

  return candidates.find((path) => Array.isArray(path) && path.length >= 2) || [];
}

function calcPathDistanceMeters(path = []) {
  if (!Array.isArray(path) || path.length < 2) {
    return 0;
  }

  let total = 0;
  const toRad = (deg) => (deg * Math.PI) / 180;
  for (let i = 1; i < path.length; i += 1) {
    const [lng1, lat1] = path[i - 1];
    const [lng2, lat2] = path[i];

    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    total += 6378137 * c;
  }

  return total;
}

function parseRouteDistance(route, path) {
  const fromApi = Number(route?.distance);
  if (Number.isFinite(fromApi) && fromApi > 0) {
    return fromApi;
  }
  return calcPathDistanceMeters(path);
}

function parseRouteDuration(route) {
  const fromTime = Number(route?.time);
  if (Number.isFinite(fromTime) && fromTime > 0) {
    return fromTime;
  }
  const fromDuration = Number(route?.duration);
  if (Number.isFinite(fromDuration) && fromDuration > 0) {
    return fromDuration;
  }
  return 0;
}

function parseRouteMetric(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function isSubwayLine(name = "") {
  const text = String(name || "").toLowerCase();
  return ["地铁", "轨道", "轻轨", "metro", "subway", "mtr"].some((keyword) => text.includes(keyword));
}

function getSubwayLineColor(name = "") {
  const text = String(name || "");
  const numberMatch = text.match(/(\d+)/);
  const index = numberMatch
    ? Math.max(1, Number(numberMatch[1])) - 1
    : [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return SUBWAY_LINE_COLORS[index % SUBWAY_LINE_COLORS.length];
}

function getTransitToolName(segment = {}) {
  return String((segment.transitTools || []).find(Boolean) || segment.lineName || segment.name || "").trim();
}

function makeRouteSegment(mode, path = [], source = {}, transitTools = [], transitKind = "", transitColor = "") {
  const dedupedPath = dedupePath(path);
  if (dedupedPath.length < 2) {
    return null;
  }
  const segment = {
    mode,
    distance: parseRouteMetric(source?.distance, calcPathDistanceMeters(dedupedPath)),
    duration: parseRouteMetric(source?.duration ?? source?.time, 0),
    path: dedupedPath,
    transitTools
  };
  if (transitKind) {
    segment.transitKind = transitKind;
  }
  if (transitColor) {
    segment.transitColor = transitColor;
  }
  return segment;
}

function getTransitKind(segment = {}) {
  if (segment.mode !== "transit") {
    return "";
  }
  if (segment.transitKind === "subway") {
    return "subway";
  }
  if (segment.transitKind === "bus") {
    return "bus";
  }
  return isSubwayLine(getTransitToolName(segment)) ? "subway" : "bus";
}

function getSegmentStrokeColor(segment = {}, routeColor = "#1687ff") {
  return routeColor;
}

function getSegmentStrokeStyle(segment = {}) {
  const transitKind = getTransitKind(segment);
  return segment.mode === "walking" || (segment.mode === "transit" && transitKind === "subway") ? "dashed" : "solid";
}

function getSegmentDashArray(segment = {}) {
  if (segment.mode === "walking") {
    return [6, 8];
  }
  if (segment.mode === "transit" && getTransitKind(segment) === "subway") {
    return [18, 10];
  }
  return undefined;
}

function pushPath(path, points = []) {
  if (!Array.isArray(points) || !points.length) {
    return;
  }
  points.forEach((point) => {
    const p = parseLngLatPoint(point);
    if (p) {
      path.push(p);
    }
  });
}

function parseWalkingTransitSegment(walking = {}) {
  const path = [
    ...parsePolylineString(walking?.polyline || ""),
    ...flattenStepPath(walking?.steps || []),
    ...flattenStepPolyline(walking?.steps || [])
  ];
  return makeRouteSegment("walking", path, walking);
}

function parseTransitBusLine(line = {}) {
  const path = [...parsePolylineString(line?.polyline || "")];
  pushPath(path, line?.path || []);
  const tool = String(line?.name || line?.busline?.name || line?.lineName || "").trim();
  const transitKind = isSubwayLine(tool) ? "subway" : "bus";
  return makeRouteSegment(
    "transit",
    path,
    line,
    tool ? [tool] : [],
    transitKind,
    transitKind === "subway" ? getSubwayLineColor(tool) : ""
  );
}

function parseTransitRailLine(rail = {}) {
  const path = [...parsePolylineString(rail?.polyline || "")];
  pushPath(path, rail?.path || []);
  const tool = String(rail?.name || rail?.trip || "").trim();
  const transitKind = isSubwayLine(tool) ? "subway" : "rail";
  return makeRouteSegment(
    "transit",
    path,
    rail,
    tool ? [tool] : [],
    transitKind,
    transitKind === "subway" ? getSubwayLineColor(tool) : ""
  );
}

function parseTransitPlanSegments(plan = {}) {
  const parsedSegments = [];
  const rawSegments = Array.isArray(plan?.segments) ? plan.segments : [];

  rawSegments.forEach((segment) => {
    [segment?.walking, segment?.entrance].forEach((walkingSource) => {
      const walking = parseWalkingTransitSegment(walkingSource || {});
      if (walking) {
        parsedSegments.push(walking);
      }
    });

    const exitWalking = parseWalkingTransitSegment(segment?.exit || {});
    const appendExitWalking = () => {
      if (exitWalking) {
        parsedSegments.push(exitWalking);
      }
    };

    const transitCountBefore = parsedSegments.length;

    const busLines = [
      ...(segment?.bus?.buslines || []),
      ...(segment?.transit?.bus?.buslines || [])
    ];
    busLines.forEach((line) => {
      const busLine = parseTransitBusLine(line);
      if (busLine) {
        parsedSegments.push(busLine);
      }
    });

    const legacyBusline = parseTransitBusLine(segment?.busline || {});
    if (legacyBusline) {
      parsedSegments.push(legacyBusline);
    }

    const rail = parseTransitRailLine(segment?.railway || segment?.rail || {});
    if (rail) {
      parsedSegments.push(rail);
    }

    if (parsedSegments.length > transitCountBefore || !parsedSegments.includes(exitWalking)) {
      appendExitWalking();
    }
  });

  if (parsedSegments.length) {
    return parsedSegments;
  }

  const fallback = makeRouteSegment("transit", parsePolylineString(plan?.polyline || ""), plan, collectTransitTools(plan));
  return fallback ? [fallback] : [];
}

function normalizeCityText(city) {
  const raw = Array.isArray(city) ? city[0] : city;
  return String(raw || "").trim();
}

function normalizeSearchCity(city) {
  return normalizeCityText(city).replace(/(市|特别行政区|自治区|自治州|地区|盟)$/, "");
}

function collectTransitTools(plan = {}) {
  const tools = [];
  const pushed = new Set();

  const pushTool = (name) => {
    const text = String(name || "").trim();
    if (!text || pushed.has(text)) {
      return;
    }
    pushed.add(text);
    tools.push(text);
  };

  const segments = Array.isArray(plan?.segments) ? plan.segments : [];
  segments.forEach((segment) => {
    const busLines = [...(segment?.bus?.buslines || []), ...(segment?.transit?.bus?.buslines || [])];
    busLines.forEach((line) => {
      pushTool(line?.name || line?.busline?.name || line?.lineName);
    });

    if (segment?.busline) {
      pushTool(segment.busline?.name || segment.busline?.busline?.name);
    }

    const rail = segment?.railway || segment?.rail;
    if (rail) {
      pushTool(rail?.name || rail?.trip);
    }
  });

  return tools;
}

function makePointHtml(index, color) {
  return `<div class="point-marker" style="--point-color:${color}"><span>${index + 1}</span></div>`;
}

function getPointDisplayPosition(point) {
  if (!point) {
    return null;
  }
  const lng = Number(point.displayLng ?? point.lng);
  const lat = Number(point.displayLat ?? point.lat);
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
}

function modeToPlugin(mode) {
  switch (mode) {
    case "walking":
      return "AMap.Walking";
    case "riding":
      return "AMap.Riding";
    case "transit":
      return "AMap.Transfer";
    case "driving":
    default:
      return "AMap.Driving";
  }
}

export class MapService {
  constructor({ key, securityCode, themeMode = "night" }) {
    this.key = key;
    this.securityCode = securityCode;
    this.themeMode = themeMode;
    this.map = null;
    this.toolBarControl = null;
    this.placeSearch = null;
    this.searchMarkers = [];
    this.layerOverlays = new Map();
    this.previewOverlays = [];
    this.poiInfoWindow = null;
    this.geocoder = null;
    this.mapClickHandler = null;
  }

  getMapStyleByTheme(mode = "night") {
    return mode === "day" ? "amap://styles/normal" : "amap://styles/darkblue";
  }

  setThemeMode(mode = "night") {
    this.themeMode = mode === "day" ? "day" : "night";
    if (this.map && typeof this.map.setMapStyle === "function") {
      this.map.setMapStyle(this.getMapStyleByTheme(this.themeMode));
    }
  }

  async ensureScript() {
    if (window.AMap && window.AMap.Map) {
      return;
    }

    if (!this.key) {
      throw new Error("缺少高德 Key，请在 .env 中配置 VITE_AMAP_KEY");
    }

    if (this.securityCode) {
      window._AMapSecurityConfig = {
        securityJsCode: this.securityCode
      };
    }

    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      await new Promise((resolve, reject) => {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
      });
      return;
    }

    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.async = true;
      script.src = `https://webapi.amap.com/maps?v=2.0&key=${this.key}`;
      script.onload = resolve;
      script.onerror = () => reject(new Error("高德 JS API 加载失败"));
      document.head.appendChild(script);
    });
  }

  async ensurePlugins(plugins = []) {
    if (!plugins.length) {
      return;
    }
    await new Promise((resolve, reject) => {
      window.AMap.plugin(plugins, () => resolve());
      setTimeout(() => reject(new Error("插件加载超时")), 10000);
    });
  }

  async init(containerId) {
    await this.ensureScript();
    await this.ensurePlugins(["AMap.ToolBar", "AMap.Scale", "AMap.PlaceSearch", "AMap.AutoComplete"]);

    this.map = new window.AMap.Map(containerId, {
      zoom: 5,
      center: [104.0668, 30.5728],
      mapStyle: this.getMapStyleByTheme(this.themeMode),
      resizeEnable: true,
      WebGLParams: { preserveDrawingBuffer: true },
      viewMode: "3D",
      pitch: 0
    });

    this.toolBarControl = new window.AMap.ToolBar({ position: "RB" });
    this.map.addControl(this.toolBarControl);
    this.map.addControl(new window.AMap.Scale());

    this.map.on("click", (event) => {
      if (!this.mapClickHandler) {
        return;
      }
      const lnglat = event.lnglat;
      this.mapClickHandler({
        lng: lnglat.lng,
        lat: lnglat.lat
      });
    });

    this.placeSearch = new window.AMap.PlaceSearch({
      pageSize: 15,
      pageIndex: 1,
      extensions: "all"
    });
    this.autoComplete = new window.AMap.AutoComplete({
      citylimit: false
    });

    this.poiInfoWindow = new window.AMap.InfoWindow({
      offset: new window.AMap.Pixel(0, -12)
    });

    return this.map;
  }

  setMapClickHandler(handler) {
    this.mapClickHandler = handler;
  }

  async ensureGeocoder() {
    await this.ensurePlugins(["AMap.Geocoder"]);
    if (!this.geocoder) {
      this.geocoder = new window.AMap.Geocoder({
        extensions: "all"
      });
    }
    return this.geocoder;
  }

  async reverseGeocodeCity(point) {
    if (!point) {
      return "";
    }

    const lng = Number(point.lng);
    const lat = Number(point.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return "";
    }

    const geocoder = await this.ensureGeocoder();
    return new Promise((resolve, reject) => {
      geocoder.getAddress([lng, lat], (status, result) => {
        if (status !== "complete") {
          reject(new Error("逆地理编码失败"));
          return;
        }

        const component = result?.regeocode?.addressComponent || {};
        const city = normalizeCityText(component.city || component.province || "");
        resolve(city);
      });
    });
  }

  getMapCenterPoint() {
    if (!this.map || typeof this.map.getCenter !== "function") {
      return null;
    }

    const center = parseLngLatPoint(this.map.getCenter());
    if (!Array.isArray(center)) {
      return null;
    }

    return {
      lng: center[0],
      lat: center[1]
    };
  }

  getMapBounds() {
    if (!this.map || typeof this.map.getBounds !== "function") {
      return null;
    }
    return this.map.getBounds();
  }

  async reverseGeocodePoint(point) {
    if (!point) {
      return null;
    }

    const lng = Number(point.lng);
    const lat = Number(point.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return null;
    }

    const geocoder = await this.ensureGeocoder();
    return new Promise((resolve, reject) => {
      geocoder.getAddress([lng, lat], (status, result) => {
        if (status !== "complete") {
          reject(new Error("逆地理编码失败"));
          return;
        }

        const regeocode = result?.regeocode || {};
        const component = regeocode.addressComponent || {};
        const firstPoi = Array.isArray(regeocode.pois) ? regeocode.pois[0] : null;
        const road = component?.streetNumber?.street || component?.road || component?.street || "";
        const number = component?.streetNumber?.number || "";
        const roadName = [road, number].filter(Boolean).join("");
        const formattedTail = String(regeocode.formattedAddress || "")
          .replace(String(component.province || ""), "")
          .replace(String(component.city || ""), "")
          .replace(String(component.district || ""), "")
          .replace(String(component.township || ""), "")
          .trim();
        const name = String(firstPoi?.name || roadName || formattedTail || "地图点").trim();

        resolve({
          name,
          address: "",
          city: normalizeCityText(component.city || component.province || ""),
          lng,
          lat
        });
      });
    });
  }

  getViewState() {
    if (!this.map) {
      return null;
    }
    const center = this.getMapCenterPoint();
    return {
      center,
      zoom: typeof this.map.getZoom === "function" ? this.map.getZoom() : null
    };
  }

  restoreViewState(viewState) {
    if (!this.map || !viewState?.center) {
      return;
    }
    const zoom = Number(viewState.zoom);
    const center = [viewState.center.lng, viewState.center.lat];
    if (Number.isFinite(zoom) && typeof this.map.setZoomAndCenter === "function") {
      this.map.setZoomAndCenter(zoom, center);
    } else if (typeof this.map.setCenter === "function") {
      this.map.setCenter(center);
    }
  }

  async getSearchContext(preferredCity = "") {
    const center = this.getMapCenterPoint();
    const bounds = this.getMapBounds();
    let city = normalizeSearchCity(preferredCity);

    if (!city && center) {
      try {
        city = normalizeSearchCity(await this.reverseGeocodeCity(center));
      } catch (error) {
        console.warn("识别当前地图城市失败，改用全局检索", error);
      }
    }

    return { city, center, bounds };
  }

  isLocationInBounds(location, bounds) {
    if (!bounds || !Array.isArray(location) || location.length < 2 || typeof bounds.contains !== "function") {
      return false;
    }

    const [lng, lat] = location;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return false;
    }

    try {
      if (window.AMap?.LngLat) {
        return bounds.contains(new window.AMap.LngLat(lng, lat));
      }
      return bounds.contains([lng, lat]);
    } catch (error) {
      return false;
    }
  }

  getCenterDistance(location, center) {
    if (!Array.isArray(location) || !center) {
      return Number.POSITIVE_INFINITY;
    }
    const dx = Number(location[0]) - Number(center.lng);
    const dy = Number(location[1]) - Number(center.lat);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.hypot(dx, dy);
  }

  getCityMatchScore(poiCity, targetCity) {
    const poi = normalizeSearchCity(poiCity);
    const target = normalizeSearchCity(targetCity);
    if (!poi || !target) {
      return 0;
    }
    if (poi === target) {
      return 2;
    }
    if (poi.includes(target) || target.includes(poi)) {
      return 1;
    }
    return 0;
  }

  prioritizeSearchResults(pois = [], context = {}, keyword = "") {
    const city = normalizeSearchCity(context.city);
    const bounds = context.bounds;
    const center = context.center;
    const kw = (keyword || "").trim();

    const ranked = [...pois].map((poi, index) => {
      const distance = this.getCenterDistance(poi.location, center);
      return {
        poi,
        index,
        exact: kw && poi.name === kw ? 1 : 0,
        cityScore: this.getCityMatchScore(poi.city, city),
        inBounds: this.isLocationInBounds(poi.location, bounds),
        distance
      };
    });
    const hasBoundsMatch = ranked.some((item) => item.inBounds);
    const candidates = hasBoundsMatch ? ranked.filter((item) => item.inBounds) : ranked;

    return candidates
      .sort((a, b) => {
        if (a.exact !== b.exact) {
          return b.exact - a.exact;
        }
        if (hasBoundsMatch) {
          if (a.cityScore !== b.cityScore) {
            return b.cityScore - a.cityScore;
          }
          return a.index - b.index;
        }
        if (a.distance !== b.distance) {
          return a.distance - b.distance;
        }
        if (a.cityScore !== b.cityScore) {
          return b.cityScore - a.cityScore;
        }
        return a.index - b.index;
      })
      .map((item) => ({
        ...item.poi,
        inCurrentView: item.inBounds,
        distanceFromCenter: Number.isFinite(item.distance) ? item.distance : null,
        searchScope: hasBoundsMatch ? "viewport" : "nearby"
      }));
  }

  runPlaceSearch(keyword) {
    return new Promise((resolve, reject) => {
      this.placeSearch.search(keyword, (status, result) => {
        if (status === "no_data") {
          resolve([]);
          return;
        }

        if (status !== "complete") {
          const detail = String(result?.info || result?.infoText || "").trim();
          reject(new Error(detail ? `POI 检索失败：${detail}` : "POI 检索失败"));
          return;
        }

        const pois = (result?.poiList?.pois || []).map((poi) => ({
          id: poi.id,
          name: poi.name,
          address: poi.address || poi.district || "",
          city: poi.cityname || "",
          province: poi.pname || poi.province || "",
          district: poi.adname || poi.district || "",
          adcode: poi.adcode || "",
          location: parseLngLatPoint(poi.location)
        }));

        resolve(pois.filter((item) => Array.isArray(item.location)));
      });
    });
  }

  async searchPOI(keyword, options = {}) {
    if (!this.placeSearch) {
      throw new Error("地图还未初始化");
    }
    if (!keyword.trim()) {
      return { pois: [], fallbackUsed: false, searchCity: "" };
    }

    const preferredCity = normalizeSearchCity(options?.preferredCity || "");
    const useMapCity = options?.useMapCity !== false;
    const disableCityFallback = options?.disableCityFallback === true;

    const context = useMapCity
      ? await this.getSearchContext(preferredCity)
      : {
          city: preferredCity,
          center: this.getMapCenterPoint(),
          bounds: this.getMapBounds()
        };

    const searchCity = preferredCity || context.city || "";

    if (searchCity && typeof this.placeSearch.setCity === "function") {
      this.placeSearch.setCity(searchCity);
      if (typeof this.placeSearch.setCityLimit === "function") {
        const isSpArea = /香港|澳门|台湾/.test(searchCity);
        this.placeSearch.setCityLimit(!isSpArea);
      }

      let cityPois = [];
      try {
        cityPois = await this.runPlaceSearch(keyword);
      } catch (error) {
        cityPois = [];
      }

      if (cityPois.length) {
        return {
          pois: this.prioritizeSearchResults(cityPois, { ...context, city: searchCity }, keyword),
          fallbackUsed: false,
          searchCity
        };
      }

      if (disableCityFallback) {
        return {
          pois: [],
          fallbackUsed: false,
          searchCity
        };
      }

      if (typeof this.placeSearch.setCityLimit === "function") {
        this.placeSearch.setCityLimit(false);
      }
      if (typeof this.placeSearch.setCity === "function") {
        this.placeSearch.setCity("");
      }

      const fallbackPois = await this.runPlaceSearch(keyword);
      return {
        pois: this.prioritizeSearchResults(fallbackPois, { ...context, city: "" }, keyword),
        fallbackUsed: true,
        searchCity
      };
    }

    if (typeof this.placeSearch.setCityLimit === "function") {
      this.placeSearch.setCityLimit(false);
    }
    if (typeof this.placeSearch.setCity === "function") {
      this.placeSearch.setCity("");
    }
    const pois = await this.runPlaceSearch(keyword);
    return {
      pois: this.prioritizeSearchResults(pois, context, keyword),
      fallbackUsed: false,
      searchCity: ""
    };
  }

  clearSearchMarkers() {
    this.searchMarkers.forEach((marker) => marker.setMap(null));
    this.searchMarkers = [];
  }

  renderSearchMarkers(pois, onMarkerClick) {
    if (!this.map) {
      return;
    }

    this.clearSearchMarkers();

    this.searchMarkers = pois.map((poi, index) => {
      const marker = new window.AMap.Marker({
        position: poi.location,
        anchor: "bottom-center",
        content: `<div class="poi-flag"><span>🚩</span><em>${index + 1}</em></div>`
      });
      marker.on("click", () => {
        this.poiInfoWindow.setContent(`
          <div class="poi-info-window">
            <h4>${poi.name}</h4>
            <p>${poi.address || "无地址"}</p>
          </div>
        `);
        this.poiInfoWindow.open(this.map, poi.location);
        if (onMarkerClick) {
          onMarkerClick(poi);
        }
      });
      marker.setMap(this.map);
      return marker;
    });

    if (this.searchMarkers.length > 0 && pois?.fitView === true) {
      this.map.setFitView(this.searchMarkers);
    }
  }

  async getSearchSuggestions(keyword, options = {}) {
    const text = String(keyword || "").trim();
    if (!text) {
      return [];
    }

    if (!this.autoComplete) {
      await this.ensurePlugins(["AMap.AutoComplete"]);
      this.autoComplete = new window.AMap.AutoComplete({ citylimit: false });
    }

    const context = await this.getSearchContext(options?.preferredCity || "");
    const city = normalizeSearchCity(options?.preferredCity || context.city || "");
    if (city && typeof this.autoComplete.setCity === "function") {
      this.autoComplete.setCity(city);
    }

    return new Promise((resolve) => {
      this.autoComplete.search(text, (status, result) => {
        if (status !== "complete") {
          resolve([]);
          return;
        }
        const tips = (result?.tips || [])
          .filter((tip) => tip && tip.name && tip.location)
          .map((tip) => ({
            id: tip.id || `${tip.name}-${tip.adcode || ""}`,
            name: tip.name,
            district: tip.district || "",
            address: tip.address || tip.district || "",
            adcode: tip.adcode || "",
            location: parseLngLatPoint(tip.location)
          }))
          .filter((tip) => Array.isArray(tip.location));
        resolve(this.prioritizeSearchResults(tips, { ...context, city }, text).slice(0, 6));
      });
    });
  }

  ensureScreenshotPlugin() {
    if (window.AMap?.Screenshot) {
      return Promise.resolve();
    }

    const existing = document.getElementById(SCREENSHOT_SCRIPT_ID);
    if (existing) {
      return new Promise((resolve, reject) => {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("地图截图插件加载失败")), { once: true });
      });
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = SCREENSHOT_SCRIPT_ID;
      script.async = true;
      script.src = SCREENSHOT_SCRIPT_URL;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("地图截图插件加载失败"));
      document.head.appendChild(script);
    });
  }

  async captureMapDataURL(type = "image/png") {
    if (!this.map) {
      throw new Error("地图尚未初始化");
    }

    let screenshot = null;
    try {
      await this.ensureScreenshotPlugin();
      screenshot = new window.AMap.Screenshot(this.map);
      const dataUrl = await screenshot.toDataURL(type);
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/") && dataUrl.length > 1024) {
        return dataUrl;
      }
      throw new Error("截图插件返回了无效图片");
    } catch (error) {
      const canvas = this.map.getContainer?.().querySelector("canvas");
      if (!canvas || typeof canvas.toDataURL !== "function") {
        throw error;
      }
      try {
        const dataUrl = canvas.toDataURL(type);
        if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/") && dataUrl.length > 1024) {
          return dataUrl;
        }
      } catch (fallbackError) {
        throw error;
      }
      throw error;
    } finally {
      if (screenshot && typeof screenshot.destroy === "function") {
        screenshot.destroy();
      }
    }
  }

  async downloadMapScreenshot(filename = "voyage_routes_map.png", type = "image/png") {
    if (!this.map) {
      throw new Error("地图尚未初始化");
    }

    await this.ensureScreenshotPlugin();
    const screenshot = new window.AMap.Screenshot(this.map);
    try {
      const ok = await screenshot.download({ filename, type });
      if (ok === false) {
        throw new Error("地图截图下载失败");
      }
      return ok;
    } finally {
      if (typeof screenshot.destroy === "function") {
        screenshot.destroy();
      }
    }
  }

  focusSearchResult(poi, index) {
    if (!this.map || !poi || !Array.isArray(poi.location)) {
      return;
    }

    const [lng, lat] = poi.location;
    const zoom = Math.max(Number(this.map.getZoom()) || 5, 14);
    this.map.setZoomAndCenter(zoom, [lng, lat]);

    if (this.poiInfoWindow) {
      this.poiInfoWindow.setContent(`
        <div class="poi-info-window">
          <h4>${poi.name}</h4>
          <p>${poi.address || "无地址"}</p>
          <p>搜索序号：${index + 1}</p>
        </div>
      `);
      this.poiInfoWindow.open(this.map, [lng, lat]);
    }
  }

  async planSegment(from, to, mode, transitCity) {
    if (!this.map) {
      throw new Error("地图还未初始化");
    }

    const plugin = modeToPlugin(mode);
    await this.ensurePlugins([plugin]);

    if (mode === "walking") {
      return this.planByWalking(from, to);
    }
    if (mode === "riding") {
      return this.planByRiding(from, to);
    }
    if (mode === "transit") {
      return this.planByTransit(from, to, transitCity);
    }
    return this.planByDriving(from, to);
  }

  planByWalking(from, to) {
    return new Promise((resolve, reject) => {
      const service = new window.AMap.Walking({
        hideMarkers: true,
        map: null
      });
      service.search(from, to, (status, result) => {
        if (status !== "complete") {
          reject(new Error("步行规划失败"));
          return;
        }
        const route = result?.routes?.[0];
        if (!route) {
          reject(new Error("步行结果为空"));
          return;
        }
        const path = parseRoutePath(route);
        if (path.length < 2) {
          reject(new Error("步行路线解析失败，请重试"));
          return;
        }
        resolve({
          mode: "walking",
          distance: parseRouteDistance(route, path),
          duration: parseRouteDuration(route),
          path
        });
      });
    });
  }

  planByDriving(from, to) {
    return new Promise((resolve, reject) => {
      const service = new window.AMap.Driving({
        hideMarkers: true,
        map: null,
        policy: window.AMap.DrivingPolicy.LEAST_DISTANCE,
        extensions: "all"
      });
      service.search(from, to, (status, result) => {
        if (status !== "complete") {
          reject(new Error("驾车规划失败"));
          return;
        }
        const route = result?.routes?.[0];
        if (!route) {
          reject(new Error("驾车结果为空"));
          return;
        }
        const path = parseRoutePath(route);
        if (path.length < 2) {
          reject(new Error("驾车路线解析失败，请重试"));
          return;
        }
        resolve({
          mode: "driving",
          distance: parseRouteDistance(route, path),
          duration: parseRouteDuration(route),
          path
        });
      });
    });
  }

  planByRiding(from, to) {
    return new Promise((resolve, reject) => {
      const service = new window.AMap.Riding({
        hideMarkers: true,
        map: null
      });
      service.search(from, to, (status, result) => {
        if (status !== "complete") {
          reject(new Error("骑行规划失败"));
          return;
        }
        const route = result?.routes?.[0];
        if (!route) {
          reject(new Error("骑行结果为空"));
          return;
        }
        const path = parseRoutePath(route);
        if (path.length < 2) {
          reject(new Error("骑行路线解析失败，请重试"));
          return;
        }
        resolve({
          mode: "riding",
          distance: parseRouteDistance(route, path),
          duration: parseRouteDuration(route),
          path
        });
      });
    });
  }

  planByTransit(from, to, city = "成都") {
    return new Promise((resolve, reject) => {
      const service = new window.AMap.Transfer({
        city,
        policy: window.AMap.TransferPolicy.LEAST_TIME,
        extensions: "all",
        map: null
      });
      service.search(from, to, (status, result) => {
        if (status !== "complete") {
          reject(new Error("公交规划失败，请检查公交城市是否正确"));
          return;
        }

        const plan = result?.plans?.[0] || result?.transits?.[0];
        if (!plan) {
          reject(new Error("公交结果为空"));
          return;
        }

        const segments = parseTransitPlanSegments(plan);
        if (!segments.length) {
          console.warn("Transit parse payload", result);
          reject(new Error("公交路径解析失败，请更换起终点或公交城市"));
          return;
        }

        resolve(segments);
      });
    });
  }

  async planRouteSegments(points, segmentModes, transitCity) {
    const tasks = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const from = [points[i].lng, points[i].lat];
      const to = [points[i + 1].lng, points[i + 1].lat];
      const mode = segmentModes[i] || "driving";
      tasks.push(this.planSegment(from, to, mode, transitCity));
    }

    const results = [];
    for (let i = 0; i < tasks.length; i += 1) {
      const segment = await tasks[i];
      const plannedSegments = Array.isArray(segment) ? segment : [segment];
      plannedSegments.forEach((item) => {
        results.push({ ...item, legIndex: i, requestedMode: segmentModes[i] || "driving" });
      });
    }

    return results;
  }

  clearPreview() {
    this.previewOverlays.forEach((overlay) => overlay.setMap(null));
    this.previewOverlays = [];
  }

  drawHistoryPreview(route, color = "#ffd166") {
    if (!this.map || !route) {
      return;
    }

    this.clearPreview();

    const overlays = [];
    (route.segments || []).forEach((segment) => {
      const polyline = new window.AMap.Polyline({
        path: segment.path || [],
        strokeColor: getSegmentStrokeColor(segment, color),
        strokeOpacity: 0.65,
        strokeWeight: 5,
        strokeStyle: getSegmentStrokeStyle(segment),
        strokeDasharray: getSegmentDashArray(segment),
        lineCap: "round",
        zIndex: 68
      });
      polyline.setMap(this.map);
      overlays.push(polyline);
    });

    (route.points || []).forEach((point, index) => {
      const displayPosition = getPointDisplayPosition(point);
      if (!displayPosition) {
        return;
      }
      const marker = new window.AMap.Marker({
        position: displayPosition,
        anchor: "center",
        content: makePointHtml(index, color),
        zIndex: 72
      });
      marker.setMap(this.map);
      overlays.push(marker);
    });

    this.previewOverlays = overlays;

    if (overlays.length) {
      this.map.setFitView(overlays, false, [90, 90, 90, 90]);
    }
  }

  clearLayer(layerId) {
    const overlays = this.layerOverlays.get(layerId) || [];
    overlays.forEach((overlay) => overlay.setMap(null));
    this.layerOverlays.delete(layerId);
  }

  drawLayer(layer, index = 0) {
    if (!this.map || !layer) {
      return;
    }

    this.clearLayer(layer.id);

    const overlays = [];
    const color = layer.color;
    const layerVisible = layer.visible !== false;
    const routes = Array.isArray(layer.routes) && layer.routes.length ? layer.routes : layer.route ? [layer.route] : [];

    routes.forEach((route, routeIndex) => {
      const routeVisible = layerVisible && route.visible !== false;
      const shift = index + routeIndex;

      (route.segments || []).forEach((segment) => {
        const basePath = segment.path || [];
        const shiftedPath = basePath;
        const polyline = new window.AMap.Polyline({
          path: shiftedPath,
          strokeColor: getSegmentStrokeColor(segment, color),
          strokeOpacity: routeVisible ? 0.93 : 0,
          strokeWeight: 5,
          strokeStyle: getSegmentStrokeStyle(segment),
          strokeDasharray: getSegmentDashArray(segment),
          lineJoin: "round",
          lineCap: "round",
          zIndex: routeVisible ? 80 + shift : 1,
          showDir: true,
          isOutline: true,
          outlineColor: "rgba(8,16,38,0.85)"
        });
        polyline.setMap(routeVisible ? this.map : null);
        overlays.push(polyline);
      });

      (route.points || []).forEach((point, pointIndex) => {
        const displayPosition = getPointDisplayPosition(point);
        if (!displayPosition) {
          return;
        }
        const marker = new window.AMap.Marker({
          position: displayPosition,
          anchor: "center",
          content: makePointHtml(pointIndex, color),
          zIndex: routeVisible ? 130 + shift + pointIndex : 1
        });
        marker.on("click", () => {
          if (!this.poiInfoWindow) {
            return;
          }
          this.poiInfoWindow.setContent(`
            <div class="poi-info-window">
              <h4>${point.name}</h4>
              <p>${route.meta?.name || layer.name} · 顺序 ${pointIndex + 1}</p>
            </div>
          `);
          this.poiInfoWindow.open(this.map, displayPosition);
        });
        marker.setMap(routeVisible ? this.map : null);
        overlays.push(marker);
      });
    });

    this.layerOverlays.set(layer.id, overlays);
  }

  setLayerVisibility(layerId, visible) {
    const overlays = this.layerOverlays.get(layerId) || [];
    overlays.forEach((overlay) => overlay.setMap(visible ? this.map : null));
  }

  removeLayer(layerId) {
    this.clearLayer(layerId);
  }

  fitLayers(layers = []) {
    if (!this.map) {
      return;
    }
    const all = [];
    layers.forEach((layer) => {
      if (layer.visible === false) {
        return;
      }
      const overlays = this.layerOverlays.get(layer.id) || [];
      all.push(
        ...overlays.filter((overlay) =>
          typeof overlay.getMap === "function" ? overlay.getMap() === this.map : true
        )
      );
    });
    if (all.length > 0) {
      this.map.setFitView(all, false, [85, 85, 85, 85]);
    }
  }

  fitPoints(points = []) {
    if (!this.map || !points.length) {
      return;
    }
    const markers = points
      .map((point) => {
        const displayPosition = getPointDisplayPosition(point);
        if (!displayPosition) {
          return null;
        }
        return new window.AMap.Marker({
          position: displayPosition
        });
      })
      .filter(Boolean);
    if (!markers.length) {
      return;
    }
    this.map.setFitView(markers, false, [100, 100, 100, 100]);
  }

  focusPoint(point, index = 0, layer = null) {
    if (!this.map || !point) {
      return;
    }

    const displayPosition = getPointDisplayPosition(point);
    if (!displayPosition) {
      return;
    }

    const zoom = Math.max(Number(this.map.getZoom()) || 5, 15);
    this.map.setZoomAndCenter(zoom, displayPosition);

    if (this.poiInfoWindow) {
      this.poiInfoWindow.setContent(`
        <div class="poi-info-window">
          <h4>${point.name || `点位 ${index + 1}`}</h4>
          <p>${layer?.route?.meta?.name || layer?.name || "当前路线"} · 顺序 ${index + 1}</p>
        </div>
      `);
      this.poiInfoWindow.open(this.map, displayPosition);
    }
  }

  setEditorOverlayOpen(open) {
    if (!this.toolBarControl || typeof this.toolBarControl.setPosition !== "function") {
      return;
    }
    this.toolBarControl.setPosition("RB");
  }
}
