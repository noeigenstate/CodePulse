# 工作语音与状态 / Work voice and states

2026-11-02；实现位于本文件所在的根 Git 提交，基于产品 `main`。
音频固件尚未刷入，旧板音频仍关闭。

## 作为展示端的能力 / Per-output capability

在 **控制 → 桌面端 / 墨水屏 → 语音提醒** 分别控制。HUD 与桌面客户端共用
电脑扬声器这一路，避免两个窗口重复叫人。全局设置不再放工作语音开关。
语音偏好注明“单独保存，即时生效”，不依赖显示配置的“立即应用”。

桌面与设备独立默认关闭，均可选择“需要介入”和“异常”。设置文件
`userData/work-voice-settings.json` 升为 version 2；旧桌面语音选择只迁到 desktop，
不会自动开启 ink，不清理其他数据。

Both outputs observe the same canonical StatusHub. Their opt-ins, cancellation,
deduplication and cooldown are independent. HUD uses the desktop output, not a third speaker.

## 初版提醒规则 / Initial policy

- 等待授权或回答问题：需要介入；未读失败、超时、额度受限：异常。
- 稳定至少 2 秒；合并多任务；自动播报至少间隔 60 秒；同一等待过程一次；恢复工作后的新请求可再提醒。
- 启动前 10 秒只建立基线，不补播旧任务；开启开关也不补播已有任务。
- 播放前重新检查；解决、已读、隐藏或过期的提醒丢弃，不循环催促。
- 固定中英文短句，不朗读项目名、路径、正文或命令；无麦克风、AI 或云语音依赖。
- 试听属于明确操作；设备试听需音频固件接入。设备“取消待播”清除队列，
  不声称可立即打断已经传到设备并开始播放的音频。

## 主机合成、固件播放 / Host synthesis, firmware playback

当前合成器使用 Windows System.Speech；中文/英文需要相应本机语音包。
同一适配器可直接播放到电脑，或生成有上限的 PCM16LE / 16 kHz / mono 给设备。
主机为 CodePulse 自身，不新增云服务和生产端口。其他主机暂显示未支持，
以后可替换合成适配器，不改变任务策略或设备播放契约。

音频固件启用后，从现有认证 LAN 服务领取 `/api/v1/device/work/voice`；
只拿不含任务正文的短期 ID，再取 `/:id/audio`，成功播放才 `POST /:id/ack`。
过期/解决/关闭后的 ID 返回 410；每设备最多 3 次获取，ACK 重试不重复播放。
队列最多 4 批、每批 2 分钟、16 个设备；不在磁盘持久化文本、设备身份或 PCM。
所有路由沿用设备 token，日志和错误不输出私密任务。

独立于助手原有语音对话/待办提醒；无需打开助手的 voiceOutput 或配置 NLS 密钥。
没有改动状态 JSON、400×300 渲染、字体、Wasm 或刷新策略。旧固件不调用新路由。

**旧板音频保持关闭**。新 PCB 的功放、供电、GPIO 仍须核验；默认引脚 -1，
编译验证镜像禁止驱动引脚。软件链路、编译、实机接线与听感是不同验收项。

## 状态数量、来源与中英文

HUD 没有第二套状态机：与标准桌面、设备共用 11 个 TurnState。
另外有 5 个视觉层级 quiet / active / notice / action / fault，
7 个整体托盘状态；未读是独立标记，不是又一个轮次状态。

| 内部状态           | 中文统一名称 | English           | 意义 / 主要来源                      |
| ------------------ | ------------ | ----------------- | ------------------------------------ |
| IDLE               | 空闲         | Idle              | 无活动任务、会话初始化               |
| PROMPT_SUBMITTED   | 处理中       | Processing        | 用户提交；hook 或原生会话恢复        |
| THINKING           | 处理中       | Processing        | 模型生成、工具结束后继续             |
| TOOL_RUNNING       | 执行工具     | Using tools       | PreToolUse、原生工具活动             |
| WAITING_PERMISSION | 等待授权     | Awaiting approval | 需要批准操作；确认的授权事件         |
| WAITING_USER_INPUT | 等待输入     | Awaiting input    | 回答问题、澄清、表单填写             |
| DONE               | 已完成       | Done              | Stop 或原生终结记录，未读时另作强调  |
| ERROR              | 执行失败     | Failed            | 明确的轮次失败，不是一次普通工具失败 |
| TIMEOUT            | 疑似卡住     | Possibly stuck    | 本机 watchdog 推断，不等于确认失败   |
| USAGE_LIMITED      | 额度受限     | Usage limited     | 适配器识别的用量限制                 |
| CANCELLED          | 已取消       | Cancelled         | 取消事件或原生取消记录               |

“手动操作”一般就是上表两个 WAITING 状态。高频批准命令仍是等待授权；
回答“你要选 A 还是 B”才是等待输入。二者都在等人，不该混成执行失败。
保留细分状态便于正确恢复、统计和处理错误；产品展示可以按工作中、等你处理、
完成、异常、空闲这五组理解，不要求用户学习 11 个编码。

### 采集能力与限制

- Codex：默认接入 PermissionRequest；确认 auto_review 的已知工具走既有抑制路由，
  手动审核保持等待授权。新增已知 request_user_input 提问工具的 PreToolUse / PermissionRequest
  映射；前提是该客户端版本确实发出相应 hook，不保证所有提问弹窗都有信号。
  Error 载荷有适配映射，但当前默认 hooks 未注册 Error，不能据此宣称失败采集完整。
- Claude：此次补订阅 PermissionRequest 与 StopFailure；AskUserQuestion 识别为等待输入；
  Notification 优先使用 notification_type，elicitation 是输入，idle_prompt / auth_success 静默。
  无结构字段的旧通知仍保留关键字后备，准确性有限。问题工具后的泛化 permission_prompt
  不再覆盖更准确的等待输入，明确的新工具授权仍可切换。
- 普通工具失败可能被 Agent 自行修复，不能直接当作整轮 ERROR。StopFailure 才是轮次失败。
- hook 不是所有状态的唯一来源：原生会话只读同步补足活动、完成、取消等；
  TIMEOUT 是本机推断。普通生成 5 分钟、工具执行 10 分钟、等待人 30 分钟无进展后
  约每 30 秒的 watchdog 检查可转超时。
- 新 hook 配置只在下一次正常启动/显式配置时接入；本次未修改运行中 Codex/Claude 配置。

Claude 的事件区分参考其[官方 hooks 文档](https://code.claude.com/docs/en/hooks)。
Codex 自动审批的具体证据及保守回退见 [审批路由](CODEX-APPROVAL-ROUTING.md)。

## 墨水屏反应 / E-paper behavior

等待授权显示“待授权”，等待输入显示“待补充”，均为 action 黑底白字。
未读完成是“待查看” notice；已读是“已完成” quiet。未读失败“异常”、
超时“超时”、额度“受限”为 fault 黑底白字，另加徽章上方横线；已读取消强调。
黑白翻转会反转最终像素，不改变语义。
新可见状态按既有低闪策略更新，正在刷新的面板先完成当前操作；语音不触发额外刷屏。
action / fault 会让临时内容让位；自动内容也让位未读完成，手动内容可继续覆盖未读完成。
旧板没有这些状态专属的语音、蜂鸣或 LED 模式。

## 英文覆盖现状 / English coverage

状态名称已集中到 `packages/shared/src/presentation/workStateCopy.ts`，桌面/HUD 共用；
Control 提供可展开的中英文对照，语音及两端配置均有英文。
这不等于整个产品已完成英文：多媒体页面、待办助手、部分设备连接/预览说明和
旧引导/错误消息仍有中文常量，内容源及模型返回也不能冒充自动翻译。
后续应沿现有 zh/en 语言切换补齐资源与英文界面检查，不默认让所有页面中英并排。

## 验证范围

定向 Node 回归不依赖 SQLite/Electron/串口或原生重建，检查偏好迁移、独立开关、
新状态去重与取消、过期/ACK/重试、LAN 鉴权、提问/授权映射、11 项中英文一致性。
类型、隔离构建/界面、预览 55 项哈希、音频引脚/no-op 与扬声器非驱动编译已通过；
最近一轮定向回归共 189 项，包含被动浏览会话不产生任务的修复；
独立源码和复制依赖中的完整 792 项回归、类型检查、桌面/HUD 构建及隔离窗口检查通过；
运行中的客户端输出和原生依赖哈希保持不变。
硬件尚无扬声器验收，不声称新功能已刷入或已听感通过。
