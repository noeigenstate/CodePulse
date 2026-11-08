# CodePulse 插件平台

插件在云端生成卡片，桌面端负责下载、校验和展示。开发者上传内容包或提供 HTTPS 接口；版本经管理员审核后才进入公开目录。现有桌边内置内容不迁移。

## 运行

在仓库根目录执行，使用现有 pnpm 工作区依赖：

```sh
pnpm --filter @codepulse/server typecheck
pnpm --filter @codepulse/server test
pnpm --filter @codepulse/server build
pnpm --filter @codepulse/server start
```

开发时运行 `pnpm --filter @codepulse/server dev`，源码重新构建后会停止并重启该脚本自己的服务进程。默认地址为 `http://127.0.0.1:18080`。不要使用桌面后台端口 17888 或设备端口 17889；启动器会拒绝这两个端口。

服务端构建不包含商店网页。商店网页构建到 `server/dist/web` 后，服务会在 `/` 托管它，并对非 API 的未知 GET 路径返回 `index.html`。没有网页产物时，API 仍可使用。

启动时读取 `server/.env`（不进 Git，模板见 `server/.env.example`）；命令行或系统里已经设置的同名变量优先。

| 环境变量                                | 默认值                         | 用途                                                               |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `CODEPULSE_PLATFORM_HOST`               | `127.0.0.1`                    | 监听地址                                                           |
| `CODEPULSE_PLATFORM_TZ`                 | `Asia/Shanghai`                | 内容包日期轮换及 HN 更新时间使用的 IANA 时区                       |
| `CODEPULSE_PLATFORM_PORT`               | `18080`                        | 平台端口                                                           |
| `CODEPULSE_PLATFORM_DB`                 | `server/.data/platform.sqlite` | SQLite 路径，自动创建父目录，相对路径按进程工作目录解析            |
| `CODEPULSE_PLATFORM_ALLOW_HTTP_WEBHOOK` | 关闭                           | 设为 `1` 仅允许开发时使用 `http://127.0.0.1` 或 `http://localhost` |

首次启动会写入“CodePulse 官方”系统账号及 HN 摘要、每日古诗两个已审核插件；重复启动不会覆盖已有数据。系统账号不能登录。HN 使用 Algolia 的公开首页接口，每 15 分钟更新；每日古诗按**平台配置时区的日期**轮换，不受宿主机时区影响。

better-sqlite3 使用独立的 11.x 副本，桌面端使用 12.x。不要用桌面端的 Electron 原生模块替换服务端模块。测试产物写到仓库 `.tmpshots/server-tests/`，测试使用内存或 `.tmpshots` 下的隔离数据库及网络替身。

## 管理员授权

注册不会赋予管理员权限，权限读取数据库中的 `developers.admin`。已有数据库首次打开时会自动迁移到 schema 版本 2，所有已有开发者默认 `admin=0`。服务器维护者核实账号归属后，使用与平台相同的 `CODEPULSE_PLATFORM_DB` 设置运行：

```sh
node server/dist/main.js admin developer@example.com
```

命令只提升**已经注册**的开发者，邮箱不区分大小写；不存在的账号会报错。它执行完即退出，不启动 HTTP 服务。现有会话下一次请求即能读取新权限。

工作区 `admin` 脚本接入后，也可运行 `pnpm --filter @codepulse/server admin developer@example.com`。

## 认证和开发流程

API 前缀为 `/api/v1`，请求和响应均为 JSON。认证使用 `Authorization: Bearer <token>`，不设置 cookie；数据库只保存 token 的 SHA-256。错误统一为 `{ "error": "中文原因" }`，使用 401、403、404、409、422、429 或 5xx 状态。

1. `POST /dev/register` 提交 `{email,password,name}`，密码至少 8 位；或通过 `POST /dev/login` 登录。响应包含 `{token,developer:{email,name,admin}}`，开发者会话有效期为 7 天。`GET /dev/me` 查看身份，`POST /dev/logout` 注销当前会话。
2. `POST /dev/plugins` 提交 `{id,name,summary}`。插件 id 全局唯一，长度 3–40，使用小写字母、数字以及分隔用的点或短横线；`codepulse.` 前缀仅供官方种子使用。响应为 `{plugin,webhookSecret}`，**密钥只在这次响应中提供**，请保存到开发者自己的安全配置中。
3. `POST /dev/plugins/:id/versions` 提交 `{manifest,cards}`（内容包）或 `{manifest,endpoint}`（接口插件），进入 `pending`。版本号只接受 `MAJOR.MINOR.PATCH`，必须高于最近提交版本。开发者不能提交 `builtin`。
4. `POST /dev/plugins/:id/test` 使用同样的提交内容，可增加 `settings`，返回 `{cards,error}`，不写缓存。`GET /dev/plugins` 查看自己插件的各版本审核状态。
5. 经服务器 CLI 提升权限的开发者登录后，请求 `GET /admin/reviews`，使用 `POST /admin/reviews/:versionId` 提交 `{decision:"approved"|"rejected",note?}`。审核通过只会把公开版本推进到更高版本；更旧的待审版本自动拒绝，备注为“已有更新版本”。历史旧版获批会记录审核结果，但不会降级公开版本。

manifest 示例：

```json
{
  "id": "example.daily",
  "version": "1.0.0",
  "name": "每日一句",
  "summary": "每天一句简短文字",
  "description": "按用户设置生成桌边内容。",
  "kind": "webhook",
  "refreshMinutes": 60,
  "settings": [
    { "key": "topic", "label": "主题", "type": "text", "default": "生活", "maxLength": 20 }
  ]
}
```

名称最多 24 字、简介 60 字、说明 600 字，刷新间隔为 15–1440 分钟。设置最多 8 项，支持 `text`、`number`、`boolean`、`select`，默认值必须符合各自范围。安装时会按 schema 补默认值并丢弃未知或越界值。

内容包提交 `cards` 数组，1–60 张。每张必须有 `id`、`source`、`text`，可带一项展示字段：`life`、`items` 或 `imageHex`。卡片提交时即按共享契约校验，`expiresAt` 可以省略；每天按日期序号选择一张并赋予当天结束的有效期。示例：

```json
{ "id": "daily-1", "source": "每日一句", "text": "今天也留一点时间给自己。" }
```

## Webhook 开发

平台向提交的 HTTPS 地址 POST 下列 JSON，`now` 为 Unix 毫秒。平台不会跟随重定向；每次请求总超时 5 秒（含 DNS、连接和读取），响应最多 64 KiB、12 张卡片，可返回空数组。接口地址在提交时和每次生成时解析，拒绝内网、回环、链路本地、CGNAT、组播和保留地址；实际连接固定为已校验的地址，TLS 仍校验原域名。

```json
{
  "v": 1,
  "pluginId": "example.daily",
  "version": "1.0.0",
  "settings": { "topic": "生活" },
  "locale": "zh-CN",
  "now": 1794110400000
}
```

响应：

```json
{
  "cards": [{ "id": "daily-1", "source": "每日一句", "text": "慢下来，看看身边。" }]
}
```

省略 `expiresAt` 时，平台补为生成时间加两倍刷新间隔；共享校验会把有效期上限限制在 24 小时。内容包和接口卡片均受同一共享契约约束：标题最多 40 字、正文最多 400 字，清单最多 6 行，life 版式须符合设备类型，位图为 384×208 单色十六进制数据。

签名请求头：

- `X-CodePulse-Timestamp`：生成时刻的 Unix 毫秒字符串。
- `X-CodePulse-Signature`：`sha256=<hex>`，计算内容为时间戳、英文句点、**原始请求体**。

Node 验签示例（先限制请求体大小，保留原始字节，不要重新序列化 JSON）：

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verifyWebhook(headers, rawBody, secret) {
  const timestamp = headers['x-codepulse-timestamp']
  const signature = headers['x-codepulse-signature']
  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false
  const expected = createHmac('sha256', secret)
    .update(timestamp + '.')
    .update(rawBody)
    .digest()
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))
}
```

## 商店和客户端 API

- `POST /clients` → `{clientId,token}`；`POST /clients/store-code` 使用客户端 token → `{code,expiresAt}`，60 秒且仅用一次。
- `POST /store/session` 提交 `{code}` → `{token,expiresAt}`，商店会话有效期 12 小时，只能管理绑定客户端。
- `GET /plugins?q=&kind=` → `{plugins}`；`GET /plugins/:id` → `{plugin}`；仅显示审核通过的公开版本。
- `GET /plugins/:id/preview` → `{cards,error}`，无需登录，按默认设置生成并走缓存。
- `GET /installs` → `{installs}`，包含安装设置及 `{generatedAt,error}` 状态；`PUT /installs/:id` 使用 `{enabled?,settings?}` 安装或修改，`DELETE /installs/:id` 卸载。这三项均使用商店会话。
- `GET /client/cards` 使用客户端 token → `PluginFeed`，仅包含启用的安装。并行生成、合并相同缓存键的请求；缓存键包含公开版本和归一化设置，过期时间取刷新间隔与卡片最早有效期的较小值。失败会记录错误并短暂退避，保留尚未过期的上次成功卡片，不延长它们的有效期。每次再生成会清除该插件废弃版本和设置的缓存，并清除全表中已过期超过一天的缓存；其他安装仍使用的设置及默认预览缓存会保留。

注册和登录各每 IP 每分钟 10 次，注册客户端 5 次，生成商店码 20 次；卡片拉取每客户端每分钟 12 次。创建插件与提交版本分别每开发者每小时 10 次，试生成每开发者每分钟 6 次，跨插件累计。限流状态只在当前进程内保存。当前版本不提供部署、自动发布或外部插件代码执行能力。
