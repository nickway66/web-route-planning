# WEBMAP_VS

前后端分离的旅行地图路线规划应用。匿名使用时，路线和 AI 对话保留在当前浏览器；登录后，路线工作区与 AI 对话会同步到服务端 SQLite 数据库。

## 启动

### 前端

```powershell
npm install
npm run dev
```

如果终端没有 `npm`，可用已安装的 Node 直接启动 Vite：

```powershell
& 'C:\Users\wade\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js --host
```

### 后端

```powershell
pip install -r requirements.txt
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

也可以使用已有 Conda 环境：

```powershell
conda run -n map uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

## 配置

复制 `.env.example` 为 `.env`，按需填写地图和 AI 服务密钥，并且在启用登录前设置随机且保密的 `JWT_SECRET`：

```dotenv
VITE_AMAP_KEY=
VITE_AMAP_SECURITY_CODE=
VITE_BACKEND_BASE_URL=http://127.0.0.1:8000

AMAP_WEB_SERVICE_KEY=
ZHIPU_API_KEY=
ZHIPU_API_ID=
ZHIPU_MODEL=glm-4-flash

DATABASE_URL=sqlite:///./backend/data/web_route_planning.db
JWT_SECRET=请替换为足够长的随机密钥
ACCESS_TOKEN_EXPIRE_MINUTES=30
```

- `JWT_SECRET` 用于签发和校验登录令牌；注册账户不依赖它，但登录和访问云端数据必须配置。
- `DATABASE_URL` 默认为项目内的 SQLite 文件。生产环境应改为受控的持久化路径，并妥善备份数据库。
- `ACCESS_TOKEN_EXPIRE_MINUTES` 为登录令牌有效期（分钟）。
- 不要提交真实 `.env`、AI Key 或 JWT 密钥。

## 数据库与迁移

首次启动前执行迁移，创建用户、路线工作区、AI 会话和消息表：

```powershell
$env:PYTHONPATH = (Get-Location).Path
alembic -c backend/alembic.ini upgrade head
```

数据库结构由 Alembic 管理，迁移文件位于 `backend/alembic/versions/`。升级已有数据库同样使用 `upgrade head`；不要手工修改已在使用的 SQLite 表结构。

## 登录和同步行为

- 注册或登录后，前端使用 Bearer Token 调用云端 API；令牌只保存在浏览器内存，刷新页面后需重新登录。
- 每个账户拥有一个路线工作区，保存完整的 `layers` 结构（图层、路线、点位、分段和路线元数据）。登录时会加载云端工作区；路线修改会先保存在本地，再以 800ms 防抖同步到云端。
- 若云端工作区为空且匿名本地有路线，界面会征求确认后仅导入一次本地路线；不会自动覆盖已有云端路线。同步失败时本地数据仍保留，界面显示未同步状态，可在网络恢复后继续修改并重试。
- 登录状态下，AI 会话及其用户/助手消息保存在云端，并在跨设备登录时可见。AI 服务调用成功后才写入助手消息，避免把失败提示当作会话内容。
- 未登录时继续使用本地模式：路线存于 `localStorage`，AI 会话存于 IndexedDB（不可用时降级内存）。本地 AI 对话不会自动上传或与云端合并；退出登录后会回到本地会话。

## 人工验收

1. 配置 `.env` 中的 `JWT_SECRET`，执行 Alembic 迁移，并分别启动后端和前端。
2. 注册账户并登录；新建或编辑路线，等待约一秒，刷新页面后确认路线仍显示。
3. 在另一浏览器或无痕窗口登录同一账户，确认路线工作区被加载。
4. 未登录状态下创建一条本地路线，再登录一个没有云端路线的新账户；确认导入提示出现，选择导入后刷新页面确认路线存在。
5. 登录后发起 AI 对话，刷新或换浏览器登录同一账户，确认会话和消息仍可打开；退出登录后确认显示原有本地会话而非自动合并的云端会话。
6. 临时断开后端后编辑路线，确认界面提示未同步且本地路线仍可见；恢复后端并再次修改，确认状态恢复为已同步。

## 验证

```powershell
$env:PYTHONPATH = (Get-Location).Path
pytest backend/tests
npm run build
```

后端主要代码在 `backend/app/`，前端入口在 `src/main.js`；路线同步模块为 `src/cloudSync.js`，云端会话 API 客户端为 `src/conversationApi.js`。
