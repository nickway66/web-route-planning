# WEBMAP_VS 技术文档

## 1. 架构概览

WEBMAP_VS 是 Vite 原生 JavaScript 前端与 FastAPI 后端组成的旅行地图路线规划应用。

- 前端负责地图渲染、路线编辑、图层管理、AI 对话界面、浏览器本地持久化和云同步状态提示。
- 后端负责高德/智谱服务调用、路线规划、导出、账户认证，以及用户工作区和 AI 对话的持久化 API。
- 数据库使用 SQLAlchemy + Alembic 管理的 SQLite。默认文件为 `backend/data/web_route_planning.db`，由 `DATABASE_URL` 覆盖。

## 2. 配置与启动

`.env.example` 包含所有配置项。登录和云同步至少需要配置：

```dotenv
DATABASE_URL=sqlite:///./backend/data/web_route_planning.db
JWT_SECRET=随机且保密的长字符串
ACCESS_TOKEN_EXPIRE_MINUTES=30
```

`JWT_SECRET` 缺失时注册仍可创建账户，但登录与受保护 API 会失败，避免使用不安全的默认密钥。其余地图、AI、CORS 配置保持与 `.env.example` 一致。

执行迁移：

```powershell
$env:PYTHONPATH = (Get-Location).Path
alembic -c backend/alembic.ini upgrade head
```

启动服务：

```powershell
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
npm run dev
```

## 3. 数据模型与迁移

`backend/app/models.py` 定义以下实体，主键均为 UUID：

- `users`：邮箱、密码哈希、显示名、启用状态和创建时间。邮箱唯一。
- `workspaces`：每个用户唯一的一份工作区，保存 `data_version` 和完整 JSON `layers_data`。
- `conversations`：会话标题、城市、置顶/归档状态、消息数、路线数、最后预览和时间戳。
- `chat_messages`：归属会话的有序用户/助手消息。

迁移位于 `backend/alembic/versions/`。`0001` 创建基础表，`0002` 补齐 SQLite 的 UUID 默认值。所有环境均应通过 Alembic 升级，不应靠删除数据库或手工 DDL 来升级。

SQLite 连接启用外键、WAL 模式和忙等待；`backend/app/database.py` 也会在需要时创建数据库父目录。

## 4. 认证与 API

认证路由前缀为 `/api/auth`：

- `POST /register`：创建账户，重复邮箱返回 409。
- `POST /login`：校验邮箱和密码，返回访问令牌及用户信息。
- `GET /me`：要求 `Authorization: Bearer <token>`，返回当前用户。

路线工作区路由前缀为 `/api/workspace`，全部要求认证：

- `GET /`：读取当前用户的工作区；未创建时返回空工作区。
- `PUT /`：创建或覆盖当前用户工作区。
- `POST /import-local`：仅在云端工作区为空时导入匿名本地路线；已有工作区返回 409，防止覆盖。

工作区限制为 5 MiB，且验证图层、路线、点位、分段与路径坐标的结构和数量，避免异常 JSON 占用数据库。

AI 会话路由前缀为 `/api/conversations`，全部按当前用户隔离：

- `GET /`、`POST /`：列出或创建会话。
- `GET /{conversation_id}`、`PATCH /{conversation_id}`、`DELETE /{conversation_id}`：读取、更新或删除本人会话。
- `POST /{conversation_id}/messages`：追加本人会话中的用户或助手消息。

后端限制每用户最多 100 个会话、每会话最多 1000 条消息，并对并发写入做事务与冲突处理。所有不存在或不属于当前用户的会话均返回 404。

## 5. 前端存储与同步

`src/authStore.js` 维护仅存于内存的访问令牌和当前用户。`src/apiClient.js` 集中处理 Bearer Token、401 失效及 API 请求。

### 路线工作区

`src/storage.js` 始终将图层写入 `localStorage:webmap_layers_v2`，确保断网或同步失败时仍有本地副本。登录后，`src/cloudSync.js`：

1. 拉取云端工作区；若有图层，归一化后应用到地图。
2. 云端为空且匿名本地有图层时，征求用户确认，确认后调用一次导入 API。
3. 后续本地变更在约 800ms 防抖后提交云端；同步状态为加载中、保存中、已同步或未同步。
4. 请求失败不会清除本地路线，后续变更可再次触发保存。

### AI 对话

未登录时，`src/aiChatStore.js` 使用 IndexedDB `webmap_ai_chat_db`（必要时降级内存）保存会话；本地会话不自动迁移到云端。

登录时，`src/conversationApi.js` 调用会话 API，`src/main.js` 切换为云端会话列表和详情。创建、重命名、置顶、归档、删除以及追加消息均写入服务端。提交 AI 请求时先写入用户消息；仅当 `/api/ai/chat` 成功时写入助手消息，因此失败内容不会污染云端历史。退出登录后切回本地 IndexedDB 会话，且不合并两类数据。

## 6. 常用源码位置

- `backend/app/main.py`：FastAPI、CORS、中间件和路由注册。
- `backend/app/database.py`、`models.py`：数据库连接与 ORM 模型。
- `backend/app/routers/auth.py`、`workspace.py`、`conversations.py`：认证、路线工作区和会话 API。
- `backend/app/repositories/`：并发与数据访问逻辑。
- `src/main.js`：应用状态、UI 及登录/同步流程。
- `src/cloudSync.js`：工作区加载、导入及防抖保存。
- `src/conversationApi.js`、`src/aiChatStore.js`：云端和本地 AI 会话存储。

## 7. 测试与人工验收

```powershell
$env:PYTHONPATH = (Get-Location).Path
pytest backend/tests
npm run build
```

人工验收应覆盖：注册登录、跨刷新和跨浏览器路线恢复、空云工作区导入确认、同步失败后的本地保留与恢复、云端 AI 对话跨设备恢复，以及退出登录后回到未合并的本地模式。
