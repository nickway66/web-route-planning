# WEBMAP_VS

前后端分离的旅行地图路线规划应用。登录是访问和编辑地图的前提；登录后，路线工作区与 AI 对话会同步到服务端 SQLite 数据库。浏览器中的本地缓存不会在未登录状态下开放访问或编辑。

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

在 Windows 上，如果 `python` 或 `uvicorn` 不在终端路径中，可用已安装的 Python 3.12 运行：

```powershell
& 'C:\Users\wade\AppData\Local\Programs\Python\Python312\python.exe' -m pip install -r requirements.txt
& 'C:\Users\wade\AppData\Local\Programs\Python\Python312\python.exe' -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
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
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

- `JWT_SECRET` 必须设置为非空、足够长且保密的随机值。它用于签发和校验登录令牌；注册账户不依赖它，但注册后的自动登录、后续登录和访问云端数据都需要它。
- `VITE_BACKEND_BASE_URL` 必须指向正在运行的 FastAPI 服务；本地默认值是 `http://127.0.0.1:8000`。修改此变量后需重启 Vite。
- `CORS_ORIGINS` 必须包含前端页面的完整源（协议、主机和端口）。使用默认 Vite 地址时保留上述两个值；若使用其他地址，例如 `http://localhost:4173`，将它追加到逗号分隔的列表中。
- `DATABASE_URL` 默认为项目内的 SQLite 文件 `backend/data/web_route_planning.db`。生产环境应改为受控的持久化路径，并妥善备份数据库。
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
- 路线仍保存在浏览器的 `localStorage`，AI 会话仍保存在 IndexedDB（不可用时降级内存）；但未登录时强制登录卡片会阻止访问和编辑地图。登录后按云端模式使用，退出后必须再次登录，且既有本地 AI 对话不会自动上传或与云端合并。

## 人工验收

1. 复制 `.env.example` 为 `.env`，将 `JWT_SECRET` 改为非空随机值，确认 `VITE_BACKEND_BASE_URL` 指向已启动的 FastAPI，且 `CORS_ORIGINS` 包含 Vite 的页面源。
2. 在项目根目录执行 Alembic 迁移，然后分别在两个 PowerShell 窗口中启动后端和前端：

   ```powershell
   $env:PYTHONPATH = (Get-Location).Path
   & 'C:\Users\wade\AppData\Local\Programs\Python\Python312\python.exe' -m alembic -c backend/alembic.ini upgrade head
   & 'C:\Users\wade\AppData\Local\Programs\Python\Python312\python.exe' -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
   ```

   ```powershell
   & 'C:\Users\wade\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js --host
   ```

3. 打开 Vite 输出的页面地址。未登录时确认登录卡片立即显示、没有关闭按钮，且无法操作地图。
4. 切换到注册，用格式正确的邮箱（例如 `new@example.com`）和 8 位密码 `12345678` 注册；确认自动登录成功，随后在 `backend/data/web_route_planning.db` 中存在该用户记录。
5. 退出登录，确认不可关闭的登录卡片再次出现；用同一账户重新登录，确认能够进入地图。
6. 尝试 7 位密码 `1234567`，确认界面拒绝提交并提示至少 8 位；尝试错误邮箱格式，确认也被拒绝。
7. 新建或编辑路线，等待约一秒，刷新页面后确认路线仍显示；在另一个浏览器或无痕窗口登录同一账户，确认路线工作区被加载。
8. 登录后发起 AI 对话，刷新或换浏览器登录同一账户，确认会话和消息仍可打开；退出登录后确认显示原有本地会话而非自动合并的云端会话。
9. 临时断开后端后编辑路线，确认界面提示未同步且本地路线仍可见；恢复后端并再次修改，确认状态恢复为已同步。

## 验证

```powershell
$env:PYTHONPATH = (Get-Location).Path
pytest backend/tests
npm run build
```

后端主要代码在 `backend/app/`，前端入口在 `src/main.js`；路线同步模块为 `src/cloudSync.js`，云端会话 API 客户端为 `src/conversationApi.js`。
