# One CodePulse repository

更新：2026-11-01。桌面、HUD、设备协议和嵌入式代码现在都由
`https://github.com/noeigenstate/CodePulse.git` 托管。
此次是源码和管理入口合并，不做运行架构或文件树的系统重构。

| 目录 | 内容与归属 | 基本检查 |
| --- | --- | --- |
| `apps/desktop` | 唯一 Electron 后台、标准客户端、屏幕控制、助手 | 原有 pnpm 检查 |
| `apps/hud` | 同一后台的 HUD renderer/preload | 同上；不能另起后台 |
| `packages` | 任务语义、协议类型、采集、存储与本地服务 | 原有类型/回归检查 |
| `firmware` | ESP-IDF 固件、驱动、物理渲染、字体、刷新和工具 | host/quiet/audio/fonts、目标构建 |
| `hardware` | 硬件贡献者按板型/修订上传的源设计和导出物 | 板级审查、许可及实机验证 |
| `docs` | 产品、协议、跨端说明 | 与实现和版本一致、链接有效 |

## 日常协作

只使用根 Git 仓库、根远端和共同分支。`firmware` 不是 submodule，没有自己的
`.git` 或第二个推送目标，也不再同步回旧 GitLab。旧独立仓库仅留本机历史，不
要修改后整目录覆盖回来。本次来源和排除范围见[FIRMWARE-IMPORT](FIRMWARE-IMPORT.md)。

当前实验目标仍是 `codex/unified-product`，稳定 `main` 不因固件入库自动合并。
原“固件可直接推旧库 main”的约定已结束，不能套用为公开产品 main 的授权。
工作前检查分支、未提交内容和远端完整 URL；已有本机 `origin` 名称可能仍指向
旧 HUD，产品推送以核对后的根远端为准，不为方便改写共享远端。

多人/多 agent 同时工作时，从共同最新基线建立各自 `codex/*` 分支或 worktree，
在任务中写出负责目录。硬件贡献者提交 `hardware/<board>/<revision>`，不改写
固件的默认 GPIO；固件贡献者负责把已核对的板级配置接入。不要同时编辑同一文件，
不用 stash/reset/clean 消除别人的工作，不强推。提交前先取回远端变化，保留其
日历、字体、助手等已合入功能；冲突要按语义解决，不选整侧覆盖。

## 跨端变化

协议以 `docs/device-api-v1.md` 为主，USB 以固件 CP1 文档为准。新增可选字段
保持旧端兼容，说明缺省值、未知值和容量；HUD/设备共享任务语义。改动生产
C 渲染器或字体时，一位负责人生成两套 Wasm/base64/manifest/许可文件；这些
生成文件不手工拼合冲突。检查后把源码、契约和对应预览放在同一 PR。

根目录 `node scripts/check-firmware-preview.mjs` 逐个核对仓内源码哈希及两套
预览；`--require-components` 要求额外配置 cJSON 后严格检查依赖。普通桌面
`pnpm build` 仍只需已提交资产，不能把 ESP-IDF 变成每个桌面开发者的强制依赖。
固件 CI 只编译/校验，桌面 CI 仍独立；不自动启动、配网或刷机。

## 版本、硬件与发布

一个根提交标识整套源码，桌面 package 版本、固件 `PROJECT_VER` 和 PCB revision
继续独立。固件产物注明根提交、固件版本、板型/PCB revision、引脚配置、分区
和 SHA256。未来固件用 `firmware-v*` tag，与桌面安装包 `v*` 区分；硬件发布
同样带明确板型和 revision。此次不发安装包、不改分区、不升级 SDK、不刷设备。

开源源码、允许再分发的字体源与合成测试可入库；密钥、Wi-Fi、token、NVS、
账户库、真实任务、设备身份、家庭交接包和光学原始反馈保留本机。构建产物通过
显式的 release/CI artifact 管理。原创软件沿用 MIT，第三方字体/组件保留许可；
硬件贡献者另行明确设计许可。硬件入库要求见[hardware](../hardware/README.md)。

预览像素一致、目标编译成功、应用写入、正常开机/联网、肉眼残影与声学验收
是独立结论，不能相互代替。所有运行测试遵守唯一 CodePulse 后台和实体板供电约定。
