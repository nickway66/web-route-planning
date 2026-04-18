const SCRIPT_ID = "amap-jsapi-loader";

function parseLngLatPoint(point) {
  if (!point) {
    return null;
  }
  if (Array.isArray(point) && point.length >= 2) {
    return [Number(point[0]), Number(point[1])];
  }
  if (typeof point.lng === "number" && typeof point.lat === "number") {
    return [point.lng, point.lat];
  }
  if (typeof point.getLng === "function" && typeof point.getLat === "function") {
    return [point.getLng(), point.getLat()];
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

function normalizeCityText(city) {
  const raw = Array.isArray(city) ? city[0] : city;
  return String(raw || "").trim();
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

function lineShift(path, shiftSeed = 0) {
  if (!shiftSeed) {
    return path;
  }
  const delta = shiftSeed * 0.00002;
  return path.map(([lng, lat]) => [lng + delta, lat + delta]);
}

function makePointHtml(index, color) {
  return `<div class="point-marker" style="--point-color:${color}"><span>${index + 1}</span></div>`;
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
    await this.ensurePlugins(["AMap.ToolBar", "AMap.Scale", "AMap.PlaceSearch"]);

    this.map = new window.AMap.Map(containerId, {
      zoom: 5,
      center: [104.0668, 30.5728],
      mapStyle: this.getMapStyleByTheme(this.themeMode),
      resizeEnable: true,
      viewMode: "2D"
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
        extensions: "base"
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

  async searchPOI(keyword) {
    if (!this.placeSearch) {
      throw new Error("地图还未初始化");
    }
    if (!keyword.trim()) {
      return [];
    }

    return new Promise((resolve, reject) => {
      this.placeSearch.search(keyword, (status, result) => {
        if (status !== "complete") {
          reject(new Error("POI 检索失败"));
          return;
        }

        const pois = (result?.poiList?.pois || []).map((poi) => ({
          id: poi.id,
          name: poi.name,
          address: poi.address || poi.district || "",
          city: poi.cityname || "",
          location: parseLngLatPoint(poi.location)
        }));

        resolve(pois.filter((item) => Array.isArray(item.location)));
      });
    });
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

    if (this.searchMarkers.length > 0) {
      this.map.setFitView(this.searchMarkers);
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

        const path = [];
        const segments = plan.segments || [];

        pushPath(path, parsePolylineString(plan?.polyline || ""));

        segments.forEach((segment) => {
          pushPath(path, segment?.path || []);
          pushPath(path, segment?.transit?.path || []);

          const walkingPath = flattenStepPath(segment?.walking?.steps || []);
          path.push(...walkingPath);
          path.push(...parsePolylineString(segment?.walking?.polyline || ""));

          const busLines = segment?.bus?.buslines || [];
          busLines.forEach((line) => {
            path.push(...parsePolylineString(line.polyline || ""));
            pushPath(path, line?.via_stops || []);
            pushPath(path, line?.path || []);
          });

          const transitBusLines = segment?.transit?.bus?.buslines || [];
          transitBusLines.forEach((line) => {
            path.push(...parsePolylineString(line.polyline || ""));
            pushPath(path, line?.via_stops || []);
            pushPath(path, line?.path || []);
          });

          const legacyBusline = segment?.busline;
          if (legacyBusline?.polyline) {
            path.push(...parsePolylineString(legacyBusline.polyline));
          }

          const rail = segment?.railway || segment?.rail;
          if (rail && rail.polyline) {
            path.push(...parsePolylineString(rail.polyline));
          }

          pushPath(path, rail?.path || []);
        });

        const dedupedPath = dedupePath(path);
        if (dedupedPath.length < 2) {
          console.warn("Transit parse payload", result);
          reject(new Error("公交路径解析失败，请更换起终点或公交城市"));
          return;
        }

        const transitTools = collectTransitTools(plan);

        resolve({
          mode: "transit",
          distance: parseRouteDistance(plan, dedupedPath),
          duration: parseRouteDuration(plan),
          path: dedupedPath,
          transitTools
        });
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
      results.push(segment);
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
        strokeColor: color,
        strokeOpacity: 0.65,
        strokeWeight: 5,
        strokeStyle: "solid",
        zIndex: 68
      });
      polyline.setMap(this.map);
      overlays.push(polyline);
    });

    (route.points || []).forEach((point, index) => {
      const marker = new window.AMap.Marker({
        position: [point.lng, point.lat],
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
        const shiftedPath = lineShift(basePath, shift);
        const polyline = new window.AMap.Polyline({
          path: shiftedPath,
          strokeColor: color,
          strokeOpacity: routeVisible ? 0.93 : 0,
          strokeWeight: 5,
          strokeStyle: segment.mode === "transit" ? "dashed" : "solid",
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
        const marker = new window.AMap.Marker({
          position: [point.lng, point.lat],
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
          this.poiInfoWindow.open(this.map, [point.lng, point.lat]);
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
    const markers = points.map(
      (point) =>
        new window.AMap.Marker({
          position: [point.lng, point.lat]
        })
    );
    this.map.setFitView(markers, false, [100, 100, 100, 100]);
  }

  setEditorOverlayOpen(open) {
    if (!this.toolBarControl || typeof this.toolBarControl.setPosition !== "function") {
      return;
    }
    this.toolBarControl.setPosition("RB");
  }
}
