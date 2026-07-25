# 强制登录入口与真实注册 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 未登录用户必须完成登录或注册才能使用地图；注册按邮箱格式和至少 8 位密码真实写入 SQLite，并显示可操作的连接错误。

**Architecture:** 复用现有 `authStore`、认证 API 和登录卡片，不新增登录页。前端初始化将未认证态固定为登录模态，后端 Pydantic 规则与表单规则统一为 8 位；API 客户端把浏览器网络错误转成中文连接错误，运行文档明确前后端与 CORS 配置。

**Tech Stack:** Vite 原生 JavaScript、FastAPI、Pydantic、SQLAlchemy/SQLite、pytest。

---

### Task 1: 将密码最小长度统一为 8 位

**Files:**
- Modify: `backend/app/auth_schemas.py:20-24`
- Modify: `src/main.js:2979-2987`
- Modify: `backend/tests/test_auth_api.py:37-43`
- Test: `backend/tests/test_auth_api.py`

- [ ] **Step 1: 写出失败的 8 位密码测试**

```python
def test_register_accepts_eight_character_password(client):
    response = client.post("/api/auth/register", json={"email": "eight@example.com", "password": "12345678"})
    assert response.status_code == 201

def test_register_rejects_seven_character_password(client):
    response = client.post("/api/auth/register", json={"email": "short@example.com", "password": "1234567"})
    assert response.status_code == 422
```

- [ ] **Step 2: 运行失败测试**

Run: `python -m pytest backend/tests/test_auth_api.py -q`

Expected: 8 位密码注册测试因当前最小长度 12 而失败。

- [ ] **Step 3: 最小化实现统一规则**

```python
class RegisterRequest(EmailRequest):
    password: str = Field(min_length=8, max_length=128)

class LoginRequest(EmailRequest):
    password: str = Field(min_length=8, max_length=128)
```

将认证表单密码输入改为 `minlength="8"`，并在标签或帮助文案显示“至少 8 位”。

- [ ] **Step 4: 运行认证测试**

Run: `python -m pytest backend/tests/test_auth_api.py -q`

Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add backend/app/auth_schemas.py backend/tests/test_auth_api.py src/main.js
git commit -m "feat: allow eight character authentication passwords"
```

### Task 2: 强制未认证用户先登录

**Files:**
- Modify: `src/main.js:1203-1204, 2967-3018, 5176-5182, 5273-5295`
- Modify: `src/styles.css:1349-1397`
- Create: `backend/tests/test_frontend_forced_auth_contract.py`

- [ ] **Step 1: 写出前端契约测试**

```python
def test_unauthenticated_boot_opens_non_dismissible_login():
    source = Path("src/main.js").read_text(encoding="utf-8")
    assert 'openAuthDialog("login", { required: true })' in source
    assert 'state.authRequired' in source
    assert 'data-auth-action="close"' not in required_dialog_markup(source)
```

测试辅助函数从 `renderAuthDialog` 的必需登录分支提取模板，明确断言必需登录状态不输出关闭按钮。

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest backend/tests/test_frontend_forced_auth_contract.py -q`

Expected: FAIL，因为当前未认证态不会自动打开登录卡片且可关闭。

- [ ] **Step 3: 实现认证门控状态**

在 `state` 增加 `authRequired`。将 `openAuthDialog(mode, { required = false } = {})` 设为唯一打开入口；必需模式固定 `login`，不渲染关闭按钮，关闭和 Escape 处理器在 `authRequired` 时直接返回。认证订阅检测到未认证且初始化完成后调用：

```js
openAuthDialog("login", { required: true });
```

登录/注册并登录成功后清除 `authRequired` 和 `authDialogMode`；注销也重新打开必需登录卡片。为遮罩添加阻止背景交互的样式，并保留当前截图的卡片视觉。

- [ ] **Step 4: 运行前端认证契约测试**

Run: `python -m pytest backend/tests/test_frontend_auth_contract.py backend/tests/test_frontend_forced_auth_contract.py -q`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main.js src/styles.css backend/tests/test_frontend_forced_auth_contract.py
git commit -m "feat: require authentication before map access"
```

### Task 3: 将网络不可达错误改为可操作提示

**Files:**
- Modify: `src/apiClient.js:8-35`
- Modify: `backend/tests/test_frontend_auth_contract.py`

- [ ] **Step 1: 添加失败契约测试**

```python
def test_api_client_wraps_fetch_network_errors_for_auth_ui():
    source = Path("src/apiClient.js").read_text(encoding="utf-8")
    assert "无法连接认证服务，请确认后端已启动" in source
    assert "catch (error)" in source
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest backend/tests/test_frontend_auth_contract.py -q`

Expected: FAIL，因为 `fetch` 抛出的 `TypeError` 当前直接显示为 `Failed to fetch`。

- [ ] **Step 3: 在 API 边界包装网络错误**

```js
try {
  response = await fetch(`${BACKEND_BASE_URL}${path}`, requestOptions);
} catch (error) {
  throw new Error("无法连接认证服务，请确认后端已启动");
}
```

保持非 2xx 响应通过 `throwRequestError` 读取后端 `detail`，不掩盖 409 重复邮箱、422 格式/长度错误和 500 的 JWT 配置错误。

- [ ] **Step 4: 运行认证前端测试**

Run: `python -m pytest backend/tests/test_frontend_auth_contract.py backend/tests/test_frontend_forced_auth_contract.py -q`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/apiClient.js backend/tests/test_frontend_auth_contract.py
git commit -m "fix: explain unavailable authentication service"
```

### Task 4: 核实真实注册的运行配置与文档

**Files:**
- Modify: `.env.example:1-16`
- Modify: `README.md`
- Test: `backend/tests/test_auth_api.py`

- [ ] **Step 1: 写明启动配置断言或手工验收清单**

在 README 的认证章节列出：`JWT_SECRET` 必须是非空随机值；前端 `VITE_BACKEND_BASE_URL` 必须指向运行中的 FastAPI；若前端非默认 Vite 地址，`CORS_ORIGINS` 包含其源。

- [ ] **Step 2: 补充 `.env.example`**

```dotenv
VITE_BACKEND_BASE_URL=http://127.0.0.1:8000
JWT_SECRET=replace-with-a-long-random-secret
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

- [ ] **Step 3: 运行完整后端测试与生产构建**

Run: `python -m pytest backend/tests --basetemp backend/pytest-forced-auth -p no:cacheprovider`

Expected: 全部通过。

Run: `node node_modules/vite/bin/vite.js build`

Expected: build succeeds（现有大 chunk 警告可保留）。

- [ ] **Step 4: 手工验收**

启动 FastAPI 与 Vite；未登录访问页面，确认登录卡片不可关闭且地图不可操作。使用 `new@example.com` 和 `12345678` 注册，确认自动登录与数据库记录。退出后确认登录卡片再次强制出现；用 7 位密码和错误邮箱确认得到对应提示。

- [ ] **Step 5: 提交**

```bash
git add .env.example README.md
git commit -m "docs: explain authentication service setup"
```
