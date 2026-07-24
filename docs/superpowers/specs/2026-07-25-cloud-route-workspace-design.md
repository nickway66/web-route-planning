# 云端路线工作区设计

## 目标

为 WEBMAP_VS 增加邮箱注册、登录和跨设备路线保存能力。用户登录后，系统保存并恢复其在地图中添加的全部图层和路线；未登录用户继续使用浏览器本地存储。

第一版仅支持本地开发环境，使用 SQLite，不实现邮箱验证、密码找回、公开分享、AI 对话云同步或多用户协作。

## 设计结论

以“路线工作区”而非“单条路线”作为云端持久化单位。每位用户拥有一个默认工作区，工作区保存当前前端 `webmap_layers_v2` 对应的完整图层数据。这样可无损恢复地图中已有的图层、路线、点位、绘制路径、颜色、可见状态和路线元数据。

不将当前 `webmap_routes_v1` 的历史路线快照作为第一版云端数据源。它是单条路线的归档副本，与工作区内路线重复。未来如需版本回溯，再独立引入路线快照模型。

## 架构与数据模型

技术栈为 SQLite、SQLAlchemy 2.0、Alembic、`pwdlib[argon2]`、PyJWT 和 `email-validator`。

核心表：

### `users`

- `id`：UUID 字符串主键。
- `email`：小写且去除首尾空格后的邮箱，唯一约束。
- `password_hash`：Argon2 哈希，绝不返回给客户端。
- `display_name`：可空昵称。
- `is_active`：是否允许登录，默认真。
- `created_at`、`updated_at`：UTC 时间。

### `workspaces`

- `id`：UUID 字符串主键。
- `user_id`：外键关联 `users.id`，带唯一约束；第一版每个用户仅有一个工作区。
- `name`：默认“我的路线”。
- `data_version`：整数，第一版为 `1`，用于未来前端 JSON 结构兼容。
- `layers_data`：完整图层 JSON。
- `layer_count`、`route_count`、`point_count`：由后端从 `layers_data` 计算的摘要字段。
- `created_at`、`updated_at`：UTC 时间。

`layers_data` 的结构以当前前端 `serializeLayersForStorage()` 输出为准。每个图层至少保存 `id`、`name`、`color`、`visible`、`selectedRouteId` 和 `routes`；每条路线至少保存 `id`、`visible`、`points`、`segmentModes`、`segments`、`stats`、`meta` 与可选的 `historyId`。其中 `points` 和 `segments` 用于重新绘制地图，不能在云端保存时裁剪。

SQLite 每个连接启用 `PRAGMA foreign_keys=ON`，并配置 WAL 与合理连接超时。数据库文件置于 `backend/data/`，且不提交至 Git。

## API 与权限边界

- `POST /api/auth/register`：验证邮箱和密码，创建用户。
- `POST /api/auth/login`：验证账户，返回短期 Access Token。
- `GET /api/auth/me`：返回当前用户公开资料。
- `GET /api/workspace`：返回当前用户工作区；不存在时返回空工作区。
- `PUT /api/workspace`：整体校验并原子保存当前用户工作区。
- `POST /api/workspace/import-local`：首次登录时将本地工作区导入空的云端工作区。

用户身份只能从 Access Token 解析；接口不接收或信任客户端传入的 `user_id`。所有工作区读写都以认证用户的 `user_id` 过滤。

第一版使用 Access Token。刷新令牌和 `refresh_sessions` 表不提前引入；若后续需要刷新页面后保持登录，则成套加入 HttpOnly Cookie、CSRF 防护、刷新令牌轮换、撤销会话及对应数据表。

## 前端同步流程

1. 未登录时，沿用 `localStorage` 保存图层工作区和本地历史快照。
2. 登录后，前端读取 `GET /api/workspace` 的工作区，规范化后渲染地图。
3. 用户新增、编辑、重算或删除路线/图层后，前端将完整 `layers` 经过短暂防抖提交给 `PUT /api/workspace`。
4. 登录时如果本地有路线而云端为空，前端询问用户是否导入本地路线；确认后调用导入接口。
5. 如果云端已有工作区，默认以云端为准，避免静默覆盖远端数据。
6. 云端同步失败时保留本地副本，显示“尚未同步”状态，并在后续有效操作时重试。

第一版不做双端并发合并。多个浏览器同时修改同一工作区时，后保存者覆盖先保存者；返回的 `updated_at` 为将来引入乐观并发控制预留基础。

## 校验与错误处理

- 注册失败时不泄露密码哈希；登录失败统一返回“邮箱或密码错误”。
- 对工作区请求体大小、图层数量、路线数量、每条路线点位数与 `segments` 数据结构设置上限和校验。
- 非法 JSON、结构不完整数据、过大请求和未认证请求分别返回清晰且一致的 4xx 错误。
- 后端事务失败不得部分更新工作区；前端失败不得清除本地路线。
- CORS 保持明确本地来源。第一版不使用 Cookie，因此维持 `allow_credentials=False`。

## 验收与测试

- 用户可注册、登录并取得自身资料；重复邮箱、非法邮箱、弱密码与错误密码均被正确处理。
- 未认证请求不能读取或写入工作区；用户 A 不能访问用户 B 的工作区。
- 新用户可获得空工作区；保存后重启后端仍可读回。
- 含多个图层和多条路线的工作区恢复后，点位、路径、颜色、图层/路线可见状态、选中路线及元数据保持一致。
- 非法或超限工作区数据被拒绝，且原有云端与本地数据不丢失。
- 本地路线仅在用户确认时导入；云端已有数据时不会被静默覆盖。

## 非目标

- 邮箱验证、密码找回、第三方登录。
- 路线公开、分享、协作和角色权限。
- AI 对话历史云同步。
- 工作区版本历史和双端冲突合并。
- PostgreSQL、Redis、异步数据库驱动与公网部署。
