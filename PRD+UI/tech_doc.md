# WEBMAP_VS 技术文档

本文档用于让后续 AI 或开发者快速理解项目结构、技术栈、代码职责和优先阅读路径，避免每次迭代都全量阅读项目文件。

## 1. 项目概览

WEBMAP_VS 是一个前后端分离的旅行地图路线规划应用。

核心架构：
- 前端：Vite + 原生 JavaScript 单页应用，负责 UI、地图交互、高德 JS 地图初始化、路线图层编辑、AI 聊天面板、浏览器端导出和本地状态缓存。
- 后端：FastAPI 服务，负责调用智谱 AI、高德 Web Service、POI 检索、路线规划、AI 路线构建、JSON/GPX 导出。
- 数据存储：不使用数据库。路线图层、历史路线和主题等状态主要保存在浏览器 `localStorage`；AI 对话存储在 IndexedDB，并兼容旧版 localStorage 聊天记录迁移。

核心数据流：

```text
用户搜索/选点/编辑路线
  -> src/apiClient.js 调用后端 /api/*
  -> backend/app/main.py 分发到服务模块
  -> 后端调用高德 REST 或智谱 API
  -> 返回标准化 POI、路线段、AI plan
  -> 前端写入 state.layers、localStorage/IndexedDB
  -> src/mapService.js 绘制高德地图覆盖物
```

## 2. 技术栈

### 前端

- Vite 5：前端构建与开发服务器。
- 原生 JavaScript：项目没有使用 React/Vue。
- 高德 JS API：地图渲染、点选、逆地理编码、搜索、路线预览、控件。
- `sortablejs`：路线点位拖拽排序。
- `html2canvas`、`jspdf`、`canvg`：地图截图、PDF 导出、SVG/canvas 兼容处理。
- `@amap/screenshot`：由 `src/mapService.js` 动态加载，用于地图截图。
- CSS：`src/styles.css` 手写样式，包含响应式布局。

### 后端

- FastAPI 0.135.3：HTTP API。
- Uvicorn 0.44.0：ASGI 服务。
- httpx 0.28.1：异步调用高德 REST 和智谱 API。
- Pydantic 2.13.1：请求/响应模型。
- python-dotenv 1.2.2：读取 `.env`。

### 外部服务

- 高德 JS API：前端地图。
- 高德 Web Service：后端 POI 搜索、步行/骑行/驾车/公交路线规划。
- 智谱 Open Platform：AI 聊天和路线生成。

## 3. 环境变量

环境变量模板在 `.env.example`：

```dotenv
VITE_AMAP_KEY=
VITE_AMAP_SECURITY_CODE=
VITE_BACKEND_BASE_URL=http://127.0.0.1:8000

AMAP_WEB_SERVICE_KEY=
ZHIPU_API_KEY=
ZHIPU_API_ID=
ZHIPU_MODEL=glm-4-flash
```

含义：
- `VITE_AMAP_KEY`：浏览器端高德 JS API Key。
- `VITE_AMAP_SECURITY_CODE`：高德 JS API 安全密钥。
- `VITE_BACKEND_BASE_URL`：前端调用的后端地址。
- `AMAP_WEB_SERVICE_KEY`：后端调用高德 Web Service 的 Key。
- `ZHIPU_API_KEY` / `ZHIPU_API_ID`：智谱 API 鉴权。
- `ZHIPU_MODEL`：智谱模型，默认 `glm-4-flash`。
- `CORS_ORIGINS`：后端允许的跨域来源，未配置时默认允许 `http://localhost:5173,http://127.0.0.1:5173`。

注意：不要把真实 `.env` 内容写入文档或提交。

## 4. 目录与文件职责

### 根目录

- `package.json`：前端脚本和 JS 依赖。脚本包括 `npm run dev`、`npm run build`、`npm run preview`。
- `package-lock.json`：npm 锁文件，只有排查依赖版本时需要阅读。
- `requirements.txt`：后端运行依赖。当前未列出 `pytest`，测试环境需要额外安装。
- `README.md`：项目启动方式、前后端职责和环境变量说明。
- `.env.example`：环境变量模板。
- `.gitignore`：忽略依赖、构建产物、缓存、日志和 `.env`。
- `index.html`：Vite 应用 HTML 入口。
- `backend-server.log`、`frontend-server.log` 等：本地服务日志，仅排查运行时问题时阅读。
- `node_modules/`：npm 依赖目录，不应全量阅读。
- `dist/`：Vite 构建输出，不作为源码阅读。
- `.vite-build-check/`：历史或临时构建校验产物，不作为源码阅读。
- `.pytest_cache/`、`__pycache__/`：测试/Python 缓存，不必阅读。

### 后端目录

#### `backend/app/main.py`

FastAPI 应用入口：
- 创建 `FastAPI(title="WEBMAP_VS Backend")`。
- 配置 CORS。
- 注册所有 `/api/*` 路由。
- 将 HTTP 请求分发到 `services` 层。

路由：
- `GET /api/health`：健康检查。
- `POST /api/ai/chat`：AI 聊天和路线生成。
- `GET /api/pois/search`：POI 搜索。
- `GET /api/pois/suggest`：搜索建议。
- `POST /api/routes/plan`：按点位规划路线。
- `POST /api/routes/ai-build`：根据 AI plan 构建地图图层。
- `POST /api/exports/json`：导出 JSON。
- `POST /api/exports/gpx`：导出 GPX。

#### `backend/app/config.py`

从环境变量读取配置：
- 高德 Web Service Key。
- 智谱 API Key、API ID、模型名。
- CORS origins。

#### `backend/app/schemas.py`

Pydantic schema：
- `ChatMessage`：AI 聊天消息，`role=user|assistant`。
- `AIChatRequest` / `AIChatResponse`：AI 聊天请求和响应。响应类型为 `chat`、`travel_advice`、`route_plan`、`cancel_or_negative`。
- `Point`：路线点位。
- `PlanRouteRequest` / `PlanRouteResponse`：路线规划接口模型。
- `AIBuildRequest`：AI 路线落图请求。
- `ExportRequest`：导出接口请求。

#### `backend/app/services/ai.py`

AI 聊天核心模块：
- 构造智谱 JWT 鉴权。
- 维护 AI system prompt。
- 调用智谱 chat completions。
- 解析 AI 返回的 JSON envelope。
- 兼容 fenced JSON、嵌套 JSON、截断 JSON、旧格式 route JSON。
- 识别路线请求和路线修订请求。
- 对 `route_plan` 生成自然语言详细行程 reply。
- 当模型误回 `chat/travel_advice` 时重试严格 route prompt。
- 在历史已有路线时，可从自然语言路线内容重建最小可用 `route_plan`，保证前端可继续添加地图。

重要函数族：
- JSON 解析：`extract_json_object`、`_json_object_candidates`、`parse_ai_envelope`。
- plan 归一化：`normalize_place`、`normalize_ai_plan`、`parse_ai_plan`。
- 回复清洗：`sanitize_ai_reply`、`visible_plan_text`。
- 意图识别：`is_route_request_message`、`is_route_revision_message`、`_has_recent_route_context`。
- 智谱调用：`request_zhipu_reply`、`_fetch_zhipu_reply`。

#### `backend/app/services/amap.py`

高德 Web Service 客户端和路线标准化：
- POI 搜索、POI suggest。
- 高德 QPS 限流退避：固定请求间隔和 backoff。
- POI 标准化，包括导航入口坐标。
- 驾车、步行、骑行、公交路线规划。
- 多点驾车 waypoint 支持，超过高德限制时分块。
- polyline 解析、路线距离/时长统计。
- 公交/地铁/步行/铁路 segment 拆分。
- 地铁线路颜色和 transit 类型标记。

#### `backend/app/services/routes.py`

路线业务编排：
- 地点名称清洗。
- 点位直线距离排序。
- 小规模点位可基于高德估算驾车成本优化顺序。
- POI 匹配评分，降低同名地点误选。
- `plan_route`：普通点位路线规划。
- `build_points_from_places`：AI 地点名转 POI 点位。
- `build_ai_layers`：根据 AI 多日行程生成图层和路线。

#### `backend/app/services/exports.py`

导出模块：
- `create_json(layers)`：导出结构化 JSON。
- `create_gpx(layers)`：导出 GPX，包含 track 和 waypoint。

#### `backend/tests/`

- `test_services.py`：后端服务单元测试，覆盖 POI、路线解析、AI envelope、智谱重试、路线修订、GPX 等。
- `test_frontend_route_editor.py`：通过静态读取前端源码断言路线编辑器、AI 行为、排序和 UI 约束。

### 前端目录

#### `src/main.js`

前端主入口和主要业务文件。职责较多，后续迭代建议按函数名定位，不要从头全量阅读。

主要职责：
- 全局 `state` 管理。
- 构建页面布局。
- 搜索、搜索推荐、搜索结果操作。
- 手动路线编辑器。
- 图层和多路线管理。
- AI 聊天面板和会话操作。
- AI route_plan 清洗、展示和落图。
- 路线生成、重算、撤销/重做。
- 历史路线 overlay。
- 导入导出。
- 事件绑定和启动流程。

关键函数区域：
- AI JSON/plan 解析：`extractAIEnvelope`、`normalizeAIPlan`、`normalizeAIChatResponse`。
- AI 聊天：`submitAIChat`、`renderAIChatPanel`、`handleAIChatAction`、`pushAIChatMessage`。
- AI 落图：`applyAIRouteToMap`、`buildRoutePointsFromPlaces`、`planAIRouteSegmentsWithFallback`。
- 路线编辑：`generateRouteLayer`、`recalcSelectedLayer`、`createRouteRecord`。
- 历史路线：`saveSelectedLayerToHistory`、`renderHistoryOverlay`。
- 导出：`exportCheckedRoutesAsMap`、`createGpxFromLayers`。
- 启动：`buildLayout`、`initMap`、`boot`。

#### `src/mapService.js`

高德 JS API 封装：
- 动态加载高德 JS API 和截图插件。
- 初始化地图、ToolBar、Scale、PlaceSearch、AutoComplete。
- 地图点击选点。
- 逆地理编码和城市识别。
- 搜索 POI 和搜索建议。
- 路线规划：驾车、步行、骑行、公交。
- 路线 path 解析、segment 归一化。
- 绘制路线图层、点位 marker、历史预览。
- 控制图层显隐、聚焦点位、适配视野。
- 地图截图和截图下载。

#### `src/apiClient.js`

后端 API 客户端：
- `chatWithAI(messages)` -> `/api/ai/chat`
- `searchPOI(keyword, options)` -> `/api/pois/search`
- `getSearchSuggestions(keyword, options)` -> `/api/pois/suggest`
- `planRoute(points, segmentModes, transitCity)` -> `/api/routes/plan`
- `buildAIRoutes(payload)` -> `/api/routes/ai-build`
- `exportRouteData(format, layers)` -> `/api/exports/{format}`

#### `src/aiChatStore.js`

AI 会话 IndexedDB 存储：
- DB：`webmap_ai_chat_db`
- store：`conversations`
- 当前会话 ID：`localStorage:webmap_ai_current_conversation_v1`
- 支持 list/get/upsert/create/save/rename/delete/clear。
- 支持导入导出 AI 对话。
- IndexedDB 不可用时降级到内存。

#### `src/storage.js`

路线和图层本地存储：
- 历史路线：`localStorage:webmap_routes_v1`
- 图层状态：`localStorage:webmap_layers_v2`
- 支持读取、写入、删除历史路线。

#### `src/config.js`

读取 Vite 环境变量：
- `AMAP_KEY`
- `AMAP_SECURITY_CODE`
- `BACKEND_BASE_URL`

#### `src/utils.js`

通用工具：
- ID 生成。
- 图层颜色选择。
- 图层默认命名。
- 距离/时间格式化。
- JSON 深拷贝。
- 点位名压缩。

#### `src/styles.css`

全局样式：
- CSS 变量和主题。
- 左右侧面板。
- 地图区域和顶部搜索。
- 搜索结果。
- 按钮体系。
- 路线管理列表。
- 路线编辑点位卡片。
- toast。
- AI 聊天面板、消息气泡、路线按钮。
- 历史路线 overlay。
- 响应式布局。

### PRD+UI 目录

- `PRD+UI/旅游规划Web产品（地图+路线+图层）PRD文档.docx`：现有 PRD 文档。
- `PRD+UI/旅行地图规划应用/index.html`：静态 UI 原型。
- `PRD+UI/旅行地图规划应用/landing.html`：落地页静态稿。
- `PRD+UI/旅行地图规划应用/share_view.html`：分享视图静态稿。
- `PRD+UI/tech_doc.md`：本文档。
- `PRD+UI/product_doc.md`：产品文档。

## 5. 后端 API 契约

### `GET /api/health`

健康检查。

返回：

```json
{"status":"ok"}
```

### `POST /api/ai/chat`

AI 聊天和路线规划。

请求：

```json
{
  "messages": [
    {"role": "user", "content": "生成一条深圳一日游路线"}
  ]
}
```

响应：

```json
{
  "type": "route_plan",
  "reply": "给用户看的自然语言",
  "plan": {
    "city": "深圳",
    "days": [
      {
        "day": 1,
        "places": [
          {
            "name": "桔钓沙",
            "duration": "2小时",
            "cost": "免费",
            "hours": "全天开放",
            "description": "..."
          }
        ]
      }
    ]
  },
  "parsedPlan": {}
}
```

`type` 可选值：
- `chat`
- `travel_advice`
- `route_plan`
- `cancel_or_negative`

### `GET /api/pois/search`

POI 搜索。

参数：
- `keyword`
- `preferred_city`
- `use_map_city`

返回：

```json
{
  "pois": [],
  "fallbackUsed": false,
  "searchCity": "深圳"
}
```

### `GET /api/pois/suggest`

搜索建议。

返回：

```json
{"suggestions": []}
```

### `POST /api/routes/plan`

普通路线规划。

请求字段：
- `points`
- `segmentModes`
- `transitCity`

返回字段：
- `segments`
- `stats`

### `POST /api/routes/ai-build`

AI 路线落图。

请求字段：
- `placeNames`
- `dayPlans`
- `preferredCity`
- `existingColors`

返回为可直接写入前端图层的 layer 数据。

### `POST /api/exports/json`

导出图层 JSON。

### `POST /api/exports/gpx`

导出 GPX 文件内容。

## 6. 关键业务行为

### AI 聊天

后端要求 AI 返回 JSON envelope，但用户不能看到 JSON。后端和前端都有清洗逻辑：
- 后端解析并修复不规范 AI JSON。
- 后端对 `route_plan` 用 `plan` 生成详细自然语言行程。
- 前端收到 `route_plan + plan` 后，保留 route metadata，但只展示自然语言 `reply`。
- 前端若发现 reply 过短或缺少地点，会从 plan 生成详细文本兜底。

路线修订场景：
- 如果已有路线语境，用户输入“我想去桔钓沙”“加上世界之窗”“换成亲子路线”等，后端视为路线修订。
- 若模型返回 `chat/travel_advice`，后端会重试。
- 若重试仍失败，后端可从上一条路线或自然语言路线中重建 plan，保证前端仍可显示“是/否”添加到地图。

### 路线与地图

普通路线：
- 用户通过搜索或地图点选构造起点、终点、途经点。
- 前端调用 `/api/routes/plan`。
- 后端调用高德 Web Service。
- 前端将 route 写入图层并绘制到地图。

AI 路线：
- 用户在 AI 面板提出路线需求。
- 后端返回 `route_plan`。
- 前端显示详细行程和“是/否”按钮。
- 用户点击“是”，前端调用 `/api/routes/ai-build`。
- 后端根据地点名搜索 POI、优化顺序、生成图层路线。

### 本地状态

- 图层：`localStorage:webmap_layers_v2`
- 历史路线：`localStorage:webmap_routes_v1`
- 主题：`localStorage:webmap_theme_mode_v1`
- AI 当前会话 ID：`localStorage:webmap_ai_current_conversation_v1`
- AI 会话主体：IndexedDB `webmap_ai_chat_db`
- 旧 AI 聊天记录：`localStorage:webmap_ai_chat_v1`

### 导入导出

- JSON/GPX：后端导出。
- PNG/PDF 地图截图：前端导出。
- AI 对话：前端 IndexedDB 数据导入导出。

## 7. 运行、构建、测试

前端：

```powershell
npm install
npm run dev
npm run build
npm run preview
```

如果当前 shell 没有 `npm`，可用本机 Node 直接运行 Vite：

```powershell
& 'C:\Users\wade\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js --host
```

后端：

```powershell
pip install -r requirements.txt
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

conda 环境方式：

```powershell
conda run -n map uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

测试：

```powershell
$env:PYTHONPATH='E:\WEBMAP_VS'; pytest E:\WEBMAP_VS\backend\tests
```

## 8. 后续 AI 开发优先阅读路径

通用改动优先读：
1. `README.md`
2. `backend/app/main.py`
3. `backend/app/schemas.py`
4. `src/apiClient.js`
5. `src/main.js`

地图/路线问题优先读：
1. `src/mapService.js`
2. `backend/app/services/amap.py`
3. `backend/app/services/routes.py`
4. `backend/tests/test_services.py`

AI 聊天/路线助手问题优先读：
1. `backend/app/services/ai.py`
2. `src/main.js` 中 AI 相关函数
3. `src/aiChatStore.js`
4. `backend/tests/test_services.py` 中 AI 测试

状态存储/历史问题优先读：
1. `src/storage.js`
2. `src/aiChatStore.js`
3. `src/main.js` 中 history、conversation、persist 相关函数

样式/UI 问题优先读：
1. `src/styles.css`
2. `src/main.js` 中 `render*`、`buildLayout`
3. `PRD+UI/旅行地图规划应用/*.html`

不必全量阅读：
- `node_modules/`
- `dist/`
- `.vite-build-check/`
- `.pytest_cache/`
- `__pycache__/`
- `.git/`
- 日志文件
- `package-lock.json`，除非排查依赖版本

## 9. 已知技术债和注意事项

- `src/main.js` 文件很大，聚合了状态、UI、业务、导入导出和 AI 逻辑。后续迭代建议按功能拆分，但不要在小改动中做大重构。
- 终端中部分中文可能显示乱码，这是读取/编码显示问题。实际文案应以浏览器显示和源文件编码为准。
- 旧 PRD 曾提到纯前端形态，但当前实现已经是 Vite 前端 + FastAPI 后端。
- 前端 `applyAIRouteToMap` 优先走后端 `/api/routes/ai-build`，其后仍保留一段本地兜底构建逻辑，当前正常路径下不可达，可视为历史代码或技术债。
- GPX 可以导出，但前端直接导入 GPX 当前未完整实现。
- 截图导出依赖浏览器 canvas、高德渲染和跨域资源，已有超时和颜色兼容兜底，但仍可能受环境影响。
- AI 输出不可完全控，后端和前端都有 JSON 修复/清洗/兜底逻辑。修改 AI 相关功能时要同时看后端解析和前端展示。

## 10. 文档生成时实际参考的文件

- `package.json`
- `requirements.txt`
- `README.md`
- `.env.example`
- `index.html`
- `backend/app/config.py`
- `backend/app/main.py`
- `backend/app/schemas.py`
- `backend/app/services/ai.py`
- `backend/app/services/amap.py`
- `backend/app/services/routes.py`
- `backend/app/services/exports.py`
- `backend/tests/test_services.py`
- `backend/tests/test_frontend_route_editor.py`
- `src/main.js`
- `src/mapService.js`
- `src/apiClient.js`
- `src/aiChatStore.js`
- `src/storage.js`
- `src/config.js`
- `src/utils.js`
- `src/styles.css`
- `PRD+UI/旅行地图规划应用/index.html`
- `PRD+UI/旅行地图规划应用/landing.html`
- `PRD+UI/旅行地图规划应用/share_view.html`

未读取真实 `.env`，避免接触本地密钥。
