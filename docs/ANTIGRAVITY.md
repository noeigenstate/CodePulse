# Antigravity 状态接入

接入依据：[Google 官方 Hooks 文档](https://antigravity.google/docs/hooks)。实现为实验支持；需要宿主实际支持该文档中的 Hooks，并收到真实回调才能确认可用。

CodePulse 下次正常启动时，对已有 ~/.gemini/antigravity、antigravity-ide 或 antigravity-cli 配置目录安装命名为 codepulse-status 的独立 Hook，位置为 ~/.gemini/config/hooks.json。其它命名 Hook 保留；同名非 CodePulse Hook 报错并保持原文；用户将 enabled 改为 false 后不自动重启用。没有 Antigravity 配置目录时不创建配置。安装器支持原文恢复与用户后续改动后的定向清理。

桌面和 HUD 的 Agent 显示选项增加 Antigravity。SessionStart 建立会话，PreInvocation 表示模型工作，Pre/PostToolUse 表示工具阶段，ask_question 表示待用户输入；只有 Stop 的 fullyIdle=true 才结束任务。PostInvocation 不等于任务结束，后台任务未完成时不假报完成。

观察 Hook 返回 allow（沿用原审批策略/允许正常停止）或空对象，不 auto_approve、不阻断停止、不注入指令。不读取凭证或会话正文，不转发工具参数，只向本机 CodePulse 上报会话、工作区、模型和阶段。服务离线时最多等待 500ms 即放行。

当前不支持额度、上下文占用、断线期间历史回填或可靠的审批等待检测；缺失值保持未知。旧墨水屏暂不添加此 provider，避免固件解析失败。本机只核对到安装版本 1.20.6；没有把“写入配置”当成“本机回调验证通过”。重启 CodePulse 后用一个新 Antigravity 会话依次测试模型工作、工具、提问、完成和后台任务，再验证界面状态。
