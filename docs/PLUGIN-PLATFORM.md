# 插件平台

2026-11-08 第一轮：骨架与开发者上传。服务端说明和 webhook 开发指南见 [server/README.md](../server/README.md)。

## 是什么

桌边内容逐步改由插件提供。插件在平台上**云端生成卡片**；桌面端只拉取已安装插件的卡片，再用共享校验器检查一遍，放进桌边内容轮播，由现有生产渲染器画到墨水屏。插件代码不在电脑或设备上运行，墨水屏仍只和局域网里的电脑通信。

| 部分     | 位置                                          | 作用                                                                                                           |
| -------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 共享契约 | `packages/shared/src/types/plugin.ts`         | 插件、设置、卡片、拉取结果的类型；`normalizePluginCard` 在平台缓存前和桌面下载后各调用一次                     |
| 平台服务 | `server/`（`@codepulse/server`）              | 目录、匿名桌面客户端、安装、卡片生成与缓存、开发者账号、版本提交、管理员审核                                   |
| 商店网页 | `server/web/`（`@codepulse/store-web`）       | 发现、详情、已安装、开发者、审核五个页面；构建到 `server/dist/web` 由平台托管                                  |
| 桌面集成 | `apps/desktop/src/main/plugin-platform.ts` 等 | 首次打开“插件”页才注册客户端；凭据用系统加密存储；每 15 分钟拉取，失败 60 秒后重试；“插件”页用 iframe 嵌入商店 |

插件三种：内置（平台代码里的生成器，如 HN 摘要）、内容包（开发者上传 1–60 张卡片，平台按天轮换）、webhook（开发者的 HTTPS 接口，平台带签名和用户设置去调用）。

## 本机运行

```sh
pnpm --filter @codepulse/server build && pnpm --filter @codepulse/store-web build
CODEPULSE_PLATFORM_ADMINS=<admin-email> pnpm --filter @codepulse/server start   # http://127.0.0.1:18080
pnpm build && pnpm start                                                       # 桌面端，左侧“插件”
```

先构建服务端再构建网页（网页输出在 `server/dist/web`）。桌面端用 `CODEPULSE_PLATFORM_URL` 指定平台地址，默认 `http://127.0.0.1:18080`。这个地址同时写进渲染进程 CSP 的 `frame-src`，**改地址后要用同一个值重新构建桌面端**，否则“插件”页会提示地址与构建配置不一致。

## 约束

- 平台端口 18080，不能用 17888（桌面后台）和 17889（设备服务）。
- 服务端用独立的 better-sqlite3 11.x；仓库是 `node-linker=hoisted`，它不会被桌面端 `rebuild:electron` 改成 Electron ABI。
- token 只走 `Authorization: Bearer`，不用 cookie；数据库只存 SHA-256。商店网页里开发者提供的内容一律当文本渲染。
- 上线到公网前要改 README 里“不经过云端”的说法：插件是可选的云端功能，不打开“插件”页就不连平台。

## 下一步

- 第二轮：左侧导航只保留“看板”和“插件”。桌边内容的各项、待办与助手都作为插件出现在“已安装”里，各自有开关和设置；“插件市场”嵌入商店网页。
- 商店详情页的墨水屏预览改用生产 Wasm 渲染器（目前是 HTML 示意）。
- 部署到内网服务器，确定正式地址。
