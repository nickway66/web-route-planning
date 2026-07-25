# 云端路线工作区与 AI 对话同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 WEBMAP_VS 增加邮箱认证、SQLite 持久化、用户路线工作区恢复，以及 AI 对话按用户同步。

**Architecture:** FastAPI 新增数据库、模型、认证依赖和两个独立路由域：工作区保存完整的前端 `layers` JSON；对话使用会话/消息规范化表。前端未登录时继续使用 localStorage/IndexedDB；登录后仅从云端读取并写入当前用户数据，路线工作区以防抖整体保存，对话以会话元数据与追加消息接口增量保存。

**Tech Stack:** FastAPI、Pydantic v2、SQLAlchemy 2、Alembic、SQLite、Argon2 (`pwdlib`)、PyJWT、Vite 原生 ES modules、pytest。

---

## File structure

- Create: `backend/app/database.py` — engine、会话工厂、Base、SQLite PRAGMA 和 `get_db`。
- Create: `backend/tests/conftest.py` — 未认证的 API 数据库测试夹具。
- Create: `backend/app/models/__init__.py`、`user.py`、`workspace.py`、`conversation.py` — SQLAlchemy 表模型。
- Create: `backend/app/repositories/__init__.py`、`users.py`、`workspaces.py`、`conversations.py` — 仅封装所属资源的数据库读写。
- Create: `backend/app/security.py`、`backend/app/dependencies/auth.py` — 密码/JWT 与当前用户依赖。
- Create: `backend/app/routers/__init__.py`、`auth.py`、`workspace.py`、`conversations.py` — HTTP 契约和权限入口。
- Create: `backend/app/auth_schemas.py`、`workspace_schemas.py`、`conversation_schemas.py`；保留现有 `backend/app/schemas.py`，避免建立同名目录。
- Create: `backend/alembic.ini`、`backend/alembic/env.py`、`backend/alembic/versions/<revision>_create_user_workspace_chat_tables.py` — 迁移基础设施和首版结构。
- Create: `backend/tests/conftest.py`、`backend/tests/test_auth_api.py`、`backend/tests/test_workspace_api.py`、`backend/tests/test_conversations_api.py` — 隔离 SQLite API 测试。
- Create: `src/authStore.js`、`src/authApi.js`、`src/routeWorkspaceApi.js`、`src/conversationApi.js`、`src/cloudSync.js` — 前端认证和同步边界。
- Modify: `backend/app/config.py`、`backend/app/main.py`、`requirements.txt`、`.env.example`、`.gitignore`、`README.md`。
- Modify: `src/apiClient.js`、`src/aiChatStore.js`、`src/main.js`、`src/styles.css`、`backend/tests/test_frontend_route_editor.py`。

### Task 1: 添加依赖、配置与 SQLite 会话基础

**Files:**
- Modify: `requirements.txt`
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `backend/app/config.py`
- Create: `backend/app/database.py`
- Create: `backend/tests/conftest.py`
- Test: `backend/tests/test_database.py`

- [ ] **Step 1: 写出数据库配置和外键启用的失败测试。**

```python
from sqlalchemy import text

from backend.app.database import make_engine


def test_sqlite_engine_enables_foreign_keys(tmp_path):
    engine = make_engine(f"sqlite:///{tmp_path / 'test.db'}")
    with engine.connect() as connection:
        assert connection.execute(text("PRAGMA foreign_keys")).scalar_one() == 1
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_database.py -q`

Expected: FAIL，因为 `backend.app.database` 尚不存在。

- [ ] **Step 3: 安装声明依赖并实现最小会话模块。**

在 `requirements.txt` 添加：

```text
sqlalchemy>=2.0,<3.0
alembic>=1.14,<2.0
pwdlib[argon2]>=0.2,<1.0
PyJWT>=2.10,<3.0
email-validator>=2.2,<3.0
```

在 `.env.example` 添加：

```dotenv
DATABASE_URL=sqlite:///./backend/data/web_route_planning.db
JWT_SECRET=
ACCESS_TOKEN_EXPIRE_MINUTES=30
```

在 `backend/app/database.py` 定义 `Base(DeclarativeBase)`、`make_engine(database_url)`、`engine`、`SessionLocal` 和生成后关闭会话的 `get_db()`；对 SQLite engine 注册 `connect` 监听器执行 `PRAGMA foreign_keys=ON`、`PRAGMA journal_mode=WAL`、`PRAGMA busy_timeout=5000`。在 `.gitignore` 添加 `backend/data/*.db`、`backend/data/*.sqlite`、`backend/data/*.sqlite3`，并创建 `backend/data/.gitkeep`。

- [ ] **Step 4: 扩展 `Settings` 并运行数据库测试。**

为 `Settings` 加入 `database_url`、`jwt_secret`、`access_token_expire_minutes`。当 `JWT_SECRET` 为空时，仅在认证依赖实际签发/校验令牌时抛出明确配置错误，不让地图公开接口启动失败。

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_database.py -q`

Expected: PASS。

- [ ] **Step 5: 建立可复用的 API 数据库测试夹具。**

创建 `backend/tests/conftest.py`，使用 `tmp_path` 创建每个测试会话独立 SQLite 文件；调用 `make_engine()` 和 `Base.metadata.create_all()`；通过 `app.dependency_overrides[get_db]` 提供该测试 Session；使用 `TestClient(app)` 作为未认证的 `client` fixture。每个测试结束时清空 `dependency_overrides` 并 `Base.metadata.drop_all()`。

- [ ] **Step 6: 提交基础设施。**

```powershell
git add requirements.txt .env.example .gitignore backend/data/.gitkeep backend/app/config.py backend/app/database.py backend/tests/conftest.py backend/tests/test_database.py
git commit -m "feat: add SQLite database foundation"
```

### Task 2: 建立模型与首版 Alembic 迁移

**Files:**
- Create: `backend/app/models/user.py`
- Create: `backend/app/models/workspace.py`
- Create: `backend/app/models/conversation.py`
- Create: `backend/app/models/__init__.py`
- Create: `backend/alembic.ini`
- Create: `backend/alembic/env.py`
- Create: `backend/alembic/versions/0001_create_account_workspace_chat_tables.py`
- Test: `backend/tests/test_models.py`

- [ ] **Step 1: 写出模型约束失败测试。**

```python
from backend.app.models import ChatMessage, Conversation, User, Workspace


def test_models_expose_required_relationships():
    assert Workspace.__table__.c.user_id.unique is True
    assert Conversation.__table__.c.user_id.nullable is False
    assert ChatMessage.__table__.c.conversation_id.nullable is False
    assert {"conversation_id", "sequence"} <= set(ChatMessage.__table__.c.keys())
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_models.py -q`

Expected: FAIL，因为模型尚不存在。

- [ ] **Step 3: 实现四张模型表与关系。**

实现 `User`、`Workspace`、`Conversation`、`ChatMessage`：主键均为 `String(36)` UUID；时间字段使用 `DateTime(timezone=True)` 和 UTC 默认值；`User.email` 唯一且索引；`Workspace.user_id` 唯一外键；`Conversation.user_id` 有索引；`ChatMessage` 设 `UniqueConstraint("conversation_id", "sequence")`，并以 `ondelete="CASCADE"` 删除会话消息。`Workspace.layers_data` 使用 SQLAlchemy `JSON`，摘要字段默认 `0`。`Conversation` 加入 `title`、`city`、`pinned`、`archived`、`route_count`、`message_count`、`last_preview`。

在 `models/__init__.py` 导入全部模型，让 Alembic 能收集 metadata。

- [ ] **Step 4: 配置 Alembic 并生成可执行迁移。**

`backend/alembic/env.py` 从 `backend.app.database` 导入 `Base`，从 `backend.app.models` 导入全部模型，并使用 `settings.database_url` 作为连接 URL。迁移 `upgrade()` 必须创建四张表、外键、唯一约束和查询索引；`downgrade()` 按依赖逆序删除表。

Run: `$env:PYTHONPATH=(Get-Location); alembic -c backend/alembic.ini upgrade head`

Expected: 创建 `backend/data/web_route_planning.db`，无错误。

- [ ] **Step 5: 运行模型测试并提交。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_models.py -q`

Expected: PASS。

```powershell
git add backend/app/models backend/alembic.ini backend/alembic backend/tests/test_models.py
git commit -m "feat: add account workspace and chat models"
```

### Task 3: 实现认证安全层、仓储和认证 API

**Files:**
- Create: `backend/app/auth_schemas.py`
- Create: `backend/app/repositories/users.py`
- Create: `backend/app/security.py`
- Create: `backend/app/dependencies/auth.py`
- Create: `backend/app/routers/auth.py`
- Modify: `backend/app/main.py`
- Modify: `backend/tests/conftest.py`
- Test: `backend/tests/test_auth_api.py`

- [ ] **Step 1: 写出注册、登录与 `/me` 的失败 API 测试。**

```python
def test_register_login_and_me(client):
    response = client.post("/api/auth/register", json={"email": "USER@example.com", "password": "correct-horse-42"})
    assert response.status_code == 201
    assert response.json()["email"] == "user@example.com"
    assert "password_hash" not in response.json()

    login = client.post("/api/auth/login", json={"email": "user@example.com", "password": "correct-horse-42"})
    token = login.json()["accessToken"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.json()["email"] == "user@example.com"
```

另加重复邮箱返回 409、错误密码返回统一 401 信息、缺失 Token 返回 401 的测试。

- [ ] **Step 2: 运行测试确认失败。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_auth_api.py -q`

Expected: FAIL，因为认证路由不存在。

- [ ] **Step 3: 实现认证契约与安全函数。**

`RegisterRequest` 使用 `EmailStr`，密码最少 12 字符、最大 128 字符；`LoginRequest` 使用相同邮箱规范化；响应定义 camelCase 别名的 `UserResponse` 和 `TokenResponse(accessToken, tokenType="bearer", user)`。

`security.py` 提供 `hash_password()`、`verify_password()`、`create_access_token(user_id)` 与 `decode_access_token(token)`；令牌只含 `sub`、`exp`、`iat`，使用 HS256 和 `settings.jwt_secret`。`get_current_user()` 使用 `HTTPBearer`，解码后通过用户仓储读取活跃用户。

`auth.py` 实现注册、登录、`/me`；邮箱始终 `strip().lower()`，登录对不存在邮箱、停用用户和错误密码均返回 `401 {"detail":"邮箱或密码错误"}`。

- [ ] **Step 4: 在应用注册路由并通过测试。**

在 `backend/app/main.py` 添加 `app.include_router(auth_router, prefix="/api/auth", tags=["auth"])`，不改现有地图/AI endpoint。认证 API 通过后，在 `backend/tests/conftest.py` 注册 `auth_client` fixture：为每个需要认证的测试注册唯一邮箱、登录，并向该 client 的默认请求头注入 Bearer token。

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_auth_api.py -q`

Expected: PASS。

- [ ] **Step 5: 提交认证能力。**

```powershell
git add backend/app/auth_schemas.py backend/app/repositories/__init__.py backend/app/repositories/users.py backend/app/security.py backend/app/dependencies/auth.py backend/app/routers/__init__.py backend/app/routers/auth.py backend/app/main.py backend/tests/conftest.py backend/tests/test_auth_api.py
git commit -m "feat: add email authentication API"
```

### Task 4: 实现工作区校验、保存和恢复 API

**Files:**
- Create: `backend/app/workspace_schemas.py`
- Create: `backend/app/repositories/workspaces.py`
- Create: `backend/app/routers/workspace.py`
- Test: `backend/tests/test_workspace_api.py`

- [ ] **Step 1: 写出空工作区、保存恢复、用户隔离和超限数据的失败测试。**

```python
def test_workspace_round_trip_preserves_layers(auth_client):
    empty = auth_client.get("/api/workspace")
    assert empty.status_code == 200
    assert empty.json()["layers"] == []

    payload = {"dataVersion": 1, "layers": [{"id": "layer-1", "name": "上海", "color": "#1687ff", "visible": True, "selectedRouteId": "route-1", "routes": [{"id": "route-1", "visible": True, "points": [{"name": "外滩", "lng": 121.49, "lat": 31.24}], "segmentModes": [], "segments": [], "stats": {"distance": 0, "duration": 0}, "meta": {"name": "第一天", "days": 1, "note": ""}}]}]}
    assert auth_client.put("/api/workspace", json=payload).status_code == 200
    assert auth_client.get("/api/workspace").json()["layers"] == payload["layers"]
```

补充第二用户只能读到空工作区、非法 `segments` 返回 422、过多图层返回 413、导入仅允许空工作区的测试。

- [ ] **Step 2: 运行测试确认失败。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_workspace_api.py -q`

Expected: FAIL，因为工作区路由不存在。

- [ ] **Step 3: 实现严格但兼容前端的工作区 schema。**

定义 `WorkspaceWrite(dataVersion: int = 1, layers: list[dict])`。在 schema 或服务函数中递归校验：请求体最大 5 MiB，最多 50 图层、每层最多 50 路线、每条路线最多 200 点；图层和路线必须有字符串 `id`，路线必须含 `points`、`segmentModes`、`segments`、`stats`、`meta`。保留未知字段以便前端结构演进，但拒绝非对象图层/路线和不含数值 `lng`/`lat` 的点。

仓储 `get_by_user_id()`、`upsert_for_user()` 和 `create_from_import_if_empty()` 均以 `user_id` 过滤。保存时在一个事务内计算 `layer_count`、`route_count`、`point_count`，写入 `layers_data` 和 UTC `updated_at`。

- [ ] **Step 4: 实现路由并通过工作区测试。**

`GET /api/workspace` 返回 `{id, name, dataVersion, layers, updatedAt}`；不存在时返回 `{id: null, name: "我的路线", dataVersion: 1, layers: [], updatedAt: null}`。`PUT` 调用 upsert。`POST /api/workspace/import-local` 只在无工作区或工作区 `layers_data` 为空时创建；否则返回 409，杜绝无提示覆盖。

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_workspace_api.py -q`

Expected: PASS。

- [ ] **Step 5: 提交工作区 API。**

```powershell
git add backend/app/workspace_schemas.py backend/app/repositories/workspaces.py backend/app/routers/workspace.py backend/app/main.py backend/tests/test_workspace_api.py
git commit -m "feat: persist user route workspaces"
```

### Task 5: 实现云端会话与消息 API

**Files:**
- Create: `backend/app/conversation_schemas.py`
- Create: `backend/app/repositories/conversations.py`
- Create: `backend/app/routers/conversations.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_conversations_api.py`

- [ ] **Step 1: 写出会话生命周期、排序和隔离的失败测试。**

```python
def test_conversation_lifecycle(auth_client):
    created = auth_client.post("/api/conversations", json={"title": "深圳周末", "city": "深圳"})
    conversation_id = created.json()["id"]
    assert auth_client.post(f"/api/conversations/{conversation_id}/messages", json={"role": "user", "content": "推荐海边路线"}).status_code == 201
    assert auth_client.post(f"/api/conversations/{conversation_id}/messages", json={"role": "assistant", "content": "可以先去深圳湾。"}).status_code == 201
    detail = auth_client.get(f"/api/conversations/{conversation_id}").json()
    assert [message["role"] for message in detail["messages"]] == ["user", "assistant"]
    assert auth_client.delete(f"/api/conversations/{conversation_id}").status_code == 204
```

补充置顶优先且随后按 `updatedAt` 排序、另一用户 GET/PATCH/POST message/DELETE 均为 404、删除后消息级联消失、超长消息 422 的测试。

- [ ] **Step 2: 运行测试确认失败。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_conversations_api.py -q`

Expected: FAIL，因为会话路由不存在。

- [ ] **Step 3: 实现 schema、仓储和事务化追加。**

`ConversationCreate` 限制标题 1–80 字符、城市最多 80 字符；`ConversationUpdate` 只允许 `title`、`city`、`pinned`、`archived`；`MessageCreate` 的 `role` 限制为 `user|assistant`，正文 1–8000 字符。

仓储必须只暴露带 `user_id` 参数的方法：`list_summaries`、`get_detail`、`create`、`update`、`append_message`、`delete`。`append_message` 在一个事务内锁定/读取会话、计算下一 `sequence`、插入消息、更新 `message_count`、`last_preview`（压缩空白后最多 80 字符）与 `updated_at`。若会话不属于用户，统一返回不存在。

- [ ] **Step 4: 实现路由并运行测试。**

注册 `/api/conversations` 路由。列表只返回摘要，详情返回按 `sequence` 升序的 `messages`。删除返回 204。每个 endpoint 使用 `get_current_user`，绝不从请求体取用户 ID。

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_conversations_api.py -q`

Expected: PASS。

- [ ] **Step 5: 提交会话 API。**

```powershell
git add backend/app/conversation_schemas.py backend/app/repositories/conversations.py backend/app/routers/conversations.py backend/app/main.py backend/tests/test_conversations_api.py
git commit -m "feat: sync user AI conversations"
```

### Task 6: 前端认证状态与带令牌 HTTP 客户端

**Files:**
- Create: `src/authStore.js`
- Create: `src/authApi.js`
- Modify: `src/apiClient.js`
- Modify: `src/main.js`
- Modify: `src/styles.css`
- Test: `backend/tests/test_frontend_auth_contract.py`

- [ ] **Step 1: 写出前端模块契约的失败静态测试。**

```python
def test_frontend_exposes_auth_api_and_authorized_request_client():
    assert "export function login" in (ROOT / "src/authApi.js").read_text(encoding="utf-8")
    source = (ROOT / "src/apiClient.js").read_text(encoding="utf-8")
    assert 'Authorization: `Bearer ${token}`' in source
    assert "setUnauthorizedHandler" in source
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_frontend_auth_contract.py -q`

Expected: FAIL，因为前端认证模块不存在。

- [ ] **Step 3: 实现内存认证状态和 API 客户端。**

`authStore.js` 导出 `getAuthState`、`setAuthSession`、`clearAuthSession`、`subscribeAuth`；令牌只保存内存，不写 localStorage。`authApi.js` 导出 `register`、`login`、`getCurrentUser`，调用通用 request。

将 `apiClient.js` 的私有 `request` 导出为 `apiRequest`，在存在 token 时加入 `Authorization: Bearer <token>`，在 401 时调用一个可注册的 `setUnauthorizedHandler(handler)`，再抛出原始错误。现有 AI、POI、规划和导出函数保持兼容。

在 `main.js` 加入最小登录/注册入口、登录用户显示和退出按钮；退出时调用 `clearAuthSession()`，不删除 localStorage/IndexedDB 历史数据。样式只添加认证弹层和状态提示所需规则。

- [ ] **Step 4: 运行静态测试和生产构建。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_frontend_auth_contract.py -q; npm run build`

Expected: pytest PASS，Vite build 成功。

- [ ] **Step 5: 提交认证 UI 与客户端。**

```powershell
git add src/authStore.js src/authApi.js src/apiClient.js src/main.js src/styles.css backend/tests/test_frontend_auth_contract.py
git commit -m "feat: add frontend authentication state"
```

### Task 7: 同步地图工作区并保持本地兜底

**Files:**
- Create: `src/routeWorkspaceApi.js`
- Create: `src/cloudSync.js`
- Modify: `src/main.js`
- Test: `backend/tests/test_frontend_workspace_sync.py`

- [ ] **Step 1: 写出工作区同步入口的失败静态测试。**

```python
def test_frontend_syncs_layers_only_after_login():
    source = (ROOT / "src/main.js").read_text(encoding="utf-8")
    assert "loadCloudWorkspace" in source
    assert "scheduleWorkspaceSave" in source
    assert "serializeLayersForStorage()" in source
    assert "importLocalWorkspace" in source
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_frontend_workspace_sync.py -q`

Expected: FAIL，因为云端工作区模块不存在。

- [ ] **Step 3: 实现工作区 API 与防抖同步器。**

`routeWorkspaceApi.js` 导出 `getWorkspace()`、`saveWorkspace(payload)`、`importLocalWorkspace(payload)`。`cloudSync.js` 导出 `createWorkspaceSync({getLayers, applyLayers, onStatus})`，其 `loadCloudWorkspace()` 在登录后读取、用已有 `normalizeLayers` 规范化并应用云端 layers；其 `scheduleWorkspaceSave()` 使用 800ms 防抖，提交 `{dataVersion: 1, layers: getLayers()}`；失败只报告 `unsynced`，不清空本地数据。

在 `main.js` 让现有 `persistLayersState()` 始终写本地存储，并在已认证时额外调用同步器。登录后如云端为空且本地 layers 非空，使用确认弹层；仅用户确认时调用导入接口。云端已有路线默认应用云端数据。

- [ ] **Step 4: 运行测试、后端全量测试和构建。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests -q; npm run build`

Expected: pytest PASS，Vite build 成功。

- [ ] **Step 5: 提交路线工作区同步。**

```powershell
git add src/routeWorkspaceApi.js src/cloudSync.js src/main.js backend/tests/test_frontend_workspace_sync.py
git commit -m "feat: sync route workspace to cloud"
```

### Task 8: 已登录时同步 AI 会话，未登录时保留 IndexedDB

**Files:**
- Create: `src/conversationApi.js`
- Modify: `src/aiChatStore.js`
- Modify: `src/main.js`
- Test: `backend/tests/test_frontend_conversation_sync.py`

- [ ] **Step 1: 写出云端会话切换的失败静态测试。**

```python
def test_logged_in_chat_uses_cloud_conversation_api():
    source = (ROOT / "src/main.js").read_text(encoding="utf-8")
    assert "listCloudConversations" in source
    assert "appendCloudMessage" in source
    assert "getAuthState().isAuthenticated" in source
    assert "initAIChatStore" in source
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests/test_frontend_conversation_sync.py -q`

Expected: FAIL，因为云端对话 API 不存在。

- [ ] **Step 3: 实现会话 API 封装与双存储选择器。**

`conversationApi.js` 导出 `listCloudConversations`、`createCloudConversation`、`getCloudConversation`、`updateCloudConversation`、`appendCloudMessage`、`deleteCloudConversation`，全部调用 `/api/conversations`。

保留 `aiChatStore.js` 的 IndexedDB 实现，不删除也不导入其既有数据。新增 `createConversationStore({isAuthenticated})` 或在 `main.js` 的小型适配层中选择：未登录调用现有 `listAIConversations` 等函数；已登录调用云端 API。两种路径输出相同的 conversation 形状（camelCase：`createdAt`、`updatedAt`、`routeCount`、`messageCount`、`lastPreview`、`messages`）。

在 `submitAIChat()` 中：先确保当前云端会话存在，再追加用户消息；调用 `/api/ai/chat` 成功后追加 assistant 的 `reply`，失败时不追加 assistant 错误文本。重命名、置顶、归档、删除和创建会话都走当前存储模式。登录后不读取、导入或合并 IndexedDB 的旧会话；登出后回到其原有本地会话。

- [ ] **Step 4: 运行测试、全量回归和构建。**

Run: `$env:PYTHONPATH=(Get-Location); pytest backend/tests -q; npm run build`

Expected: pytest PASS，Vite build 成功。

- [ ] **Step 5: 提交对话同步。**

```powershell
git add src/conversationApi.js src/aiChatStore.js src/main.js backend/tests/test_frontend_conversation_sync.py
git commit -m "feat: sync AI conversations for signed-in users"
```

### Task 9: 文档、迁移验证与最终验收

**Files:**
- Modify: `README.md`
- Modify: `PRD+UI/tech_doc.md`
- Test: `backend/tests/test_auth_api.py`
- Test: `backend/tests/test_workspace_api.py`
- Test: `backend/tests/test_conversations_api.py`

- [ ] **Step 1: 写出手工验收脚本。**

在 `README.md` 增加以下可重复验证流程：复制 `.env.example`，设置非空 `JWT_SECRET`，安装依赖，运行 `alembic -c backend/alembic.ini upgrade head`，启动后端和前端；注册用户 A/B；A 保存多图层路线并刷新恢复；B 无法看到 A 的路线/对话；A 新建 AI 会话、刷新后可见；首次登录旧浏览器不会上传 IndexedDB 对话。

- [ ] **Step 2: 更新技术文档。**

更新 `PRD+UI/tech_doc.md` 的目录说明、环境变量、API 契约和本地状态章节：说明 `workspaces.layers_data` 是登录用户的路线真相来源，AI 对话在登录后使用云端会话 API，旧 IndexedDB 对话不会自动上传。

- [ ] **Step 3: 从空数据库执行迁移和自动化验证。**

Run: `Remove-Item -LiteralPath backend/data/web_route_planning.db -ErrorAction SilentlyContinue; $env:PYTHONPATH=(Get-Location); alembic -c backend/alembic.ini upgrade head; pytest backend/tests -q; npm run build`

Expected: 迁移成功，pytest 全部 PASS，Vite build 成功。删除命令仅针对已忽略、可重建的本地开发数据库；执行前确认它不是需要保留的用户数据。

- [ ] **Step 4: 提交文档和最终验证。**

```powershell
git add README.md PRD+UI/tech_doc.md
git commit -m "docs: document cloud route and chat sync"
git status --short
```

Expected: 无未提交的目标文件。

## Plan self-review

- 规格覆盖：任务 1–2 覆盖 SQLite、SQLAlchemy、Alembic、四张表与外键；任务 3 覆盖注册、登录、JWT 与用户隔离；任务 4 覆盖完整图层工作区、首次本地路线导入和失败兜底；任务 5 与 8 覆盖 AI 会话/消息云同步、排序、删除和不导入旧 IndexedDB；任务 6–7 覆盖认证 UI、授权请求和前端地图恢复；任务 9 覆盖文档、迁移与端到端验收。
- 占位符：未使用 TBD、TODO 或“之后实现”作为任务内容；每项实现步骤给出目标文件、函数/接口边界、命令和验收结果。
- 一致性：后端 API 使用 `/api/auth`、`/api/workspace`、`/api/conversations`；前端封装与任务后续调用使用相同名称；数据库表为 `users`、`workspaces`、`conversations`、`chat_messages`。
