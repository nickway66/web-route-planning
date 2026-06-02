# WEBMAP_VS

前后端分离的路线规划应用。

## 前端

- Vite 前端保留页面布局、交互状态、高德 JS 地图初始化、地图缩放/平移/点击选点、覆盖物绘制、浏览器 localStorage 缓存，以及截图/PDF 这类依赖浏览器 canvas 的导出。
- 启动：

```powershell
npm run dev
```

如果当前 shell 没有 `npm`，可用本机 Node 直接运行 Vite：

```powershell
& 'C:\Users\wade\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js --host
```

## 后端

- Python 后端使用 FastAPI，负责 AI、POI 搜索、路线规划、路线归一化，以及 JSON/GPX 导出。
- 不使用数据库；路线、图层、聊天记录等用户数据仍保存在浏览器 localStorage。
- 在 `conda map` 环境启动：

```powershell
conda run -n map uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

## 环境变量

复制 `.env.example` 为 `.env` 后填写：

```dotenv
VITE_AMAP_KEY=
VITE_AMAP_SECURITY_CODE=
VITE_BACKEND_BASE_URL=http://127.0.0.1:8000

AMAP_WEB_SERVICE_KEY=
ZHIPU_API_KEY=
ZHIPU_API_ID=
ZHIPU_MODEL=glm-4-flash
```

`VITE_AMAP_KEY` 只用于浏览器内初始化高德 JS 地图；`AMAP_WEB_SERVICE_KEY` 和智谱密钥只由后端读取。
