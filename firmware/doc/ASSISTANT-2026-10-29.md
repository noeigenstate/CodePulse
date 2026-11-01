> 历史技术记录；版本与已验证范围以当时正文为准。当前构建、仓库入口和实机状态见 [firmware README](../README.md)。

# 本地助手、待办列表与新板音频候选

基线：产品 `7a41eae`（`codex/unified-product`），独立固件 `7e3d9e6`。
本轮新增代码在独立固件仓库管理。2026-10-30 已按用户授权，只刷应用升级到
`0.0.27-todos-region-pair150`，保留原分区及配网数据；初始构建阶段旧版本为
`0.0.26-region-pair150`，下文构建记录保留当时的验证范围。
本文记录软件检查，不表示新 PCB、麦克风、扬声器或光学效果已经验收。

## 发布前整合：0.0.28-desk（未刷写）

产品远端 `c0af0c8` 已包含像素宠物，配套 C 源码来自 `work/pet-fw` 的 `f5e21fd`。
与本轮 `f25e604` 的待办列表/可选音频整合后，将组合候选命名为 `0.0.28-desk`
及 `0.0.28-audio[-check]`。保留两支提交历史，使用同一 C 渲染器重新生成两套预览，
没有另写 HTML 版设备画面。

82 个 native/Wasm 黑白/红色像素帧一致，400 黑白及 400 双平面重复渲染通过；
0.0.26 的旧 65 帧和本轮 0/1/6 项待办画面不变。组合旧板 region/pair150 编译通过，
app `0x1710a0`，原分区余 `0x5f60`。host、quiet、pacing 及红色兼容回归通过。
宠物的红色全刷、冷却和反色处理沿用配套分支；红色仍需明确位图请求，没有新增
定时刷新。涉及红色的物理时序、光学和功耗没有在本机验证。

该组合候选尚未刷入，当前实机仍是下节已验证的 `0.0.27-todos-region-pair150`，
音频关闭。不得用 0.0.27 的写入回执证明 0.0.28 或红色实机通过。产品助手来源提交
为 `f1bbdaf`，组合预览 SHA256 为
`39b766afd283fc9ae07219041ce913a1d7ec8017bcd8ebaa4097d697d2a9922c`。

组合音频的禁止驱动检查构建通过，app `0x177210`，独立 2 MiB 分区余 27%；
产品类型检查、723 项回归和独立桌面/HUD 构建通过。Windows 隔离界面测试使用
合成数据和独立输出，对测试进程关闭 NetworkServiceSandbox 后完成；未改产品
安全设置。两端完整的发布提交号与上述预览哈希另存本机发布回执。

## 2026-10-30 刷写和正常开机

用户重新确认持续按住供电键后，核对芯片身份、实际分区表和旧 app 描述符，确认旧版为
`0.0.26-region-pair150`。只在 `0x10000` 写入 app，未写分区表、bootloader 或 NVS，
未自动刷后复位。用户松手并正常开机后，USB hello 返回目标版本；设备状态为 ready，
Wi-Fi、provisioned 和 desktopReachable 均为 true。音频构建标志继续为 OFF。

镜像 1510496 字节，SHA256
`0697ca21efb93892edbd3b81a7907f78a09f487907ff18390c9e8d7d0e74e171`。
应用写入及哈希通过；该设备镜像构建自产品基线 `7a41eae`、固件基线 `7e3d9e6`
及此轮待办/音频整合修改。物理待办画面和光学观感待用户确认，本次短时观察未捕获
clean-baseline 完成事件，因此不宣称启动清洁或残影验收通过。私有回执位于忽略的
`build-assistant-evidence/`，不含 NVS 或账户密钥。

## 目标与边界

桌面唯一宿主运行 SQLite 待办、提醒、AI/语音适配和助手接口。屏幕消费同一设备
服务中的可选 `ambient.items`；音频使用同一配对 token，不在固件存供应商密钥。
标准桌面与 HUD 预览来自本仓库生产 C/Wasm 资产。安卓、小程序、云端管理、
OTA、常开采音、唤醒词和 AEC/VAD 模型不在本轮候选中。明确按键采音和播报路径
已经实现；未确认的硬件保持关闭。

参考 LumaDesk `043efa33` 的提醒规则及 Xiaozhi Simplex PDM/I2S 设计；保留原 MIT
许可于 `../THIRD-PARTY-NOTICES-AUDIO.txt`。未复制身份、录音、数据库、账号或密钥。

验收：旧 work/usage 目标像素不变，待办 0/1/6 行及反色一致；未启用音频的旧板不
初始化额外 GPIO/I2S，不触发新音频请求；新板需经接线、供电、采音、PCM 和联网验收。

## 协议和画面

v1 增加可选 `ambient.items`，最多六行 `{title,meta,overdue}`；保留 `ambient.text`
供旧固件回退，不与 `imageHex` 混用。标题/时间缓冲区为 160/48 字节，UTF-8 边界
由宿主截断，固件拒绝超限字段；结构错误拒绝整帧。旧 API、默认配置、黑白翻转与紧急工作优先级不变。

400×300 合成示例：[空待办](assistant-v027/todos-0.png)、
[单项](assistant-v027/todos-1.png)、[六项](assistant-v027/todos-6.png)。
列表无秒级倒计时，仅数据、到期里程碑及配置变化改变画面。不增加清洁频率、不改
波形、保留现有静态内容锁定和 PAIR150/窄窗口选项。预览不模拟残影或证明实屏同步。

助手端点挂在现有 17889 服务 `/api/v1/device/assistant/`，包括 info/text/voice/
speech/announcement/announcement/ack。使用 token 请求头和有界 device-id；详见产品
`docs/device-api-v1.md`。音频格式 16 kHz、mono、signed PCM16 LE，明确按住独立讲话键
录制，松开后上传，最长 25 秒；回复经桌面合成为 PCM，设备流式送 I2S。建议确认
后才写待办。到期播报有回执和重试，重复 ID 只重试回执，避免重复发声。

## 硬件核对

LumaDesk Ding 与当前板均为 ESP32-S3-WROOM-1-N16R8，内存基础相同；保持当前
ESP-IDF **6.0.1**，不搬运旧 5.5.2 SDK 或整张烧录表。

LumaDesk 的 MAX98357A 接 BCLK4/WS5/DIN7/AMP_EN16，PDM 接 CLK17/DATA6。
这六根 GPIO 全与 CodePulse 的 EPD BUSY4/RST5/DC6/CS7/SCLK16/MOSI17 冲突。
旧板只有蜂鸣器，新板增加扬声器不代表具备麦克风和对应功放。旧 LumaDesk 记录
验证过采音/唤醒，但功放仍未正常发声，不能当作本产品扬声器成功证据。

GPIO9 供电保持优先，电源键10不可用作讲话键，USB19/20、电池 GPIO42→8、I2C11/12、
LED15、蜂鸣器18、PSRAM 和 EPD 引脚全部受 pin policy 保护。新音频引脚默认 -1。
输入模式要求 PDM 麦克风和独立讲话键；仅扬声器构建不要求它们。功放使能极性可配。

新 PCB 原理图/GPIO 表尚未获得。待核实：MCU/PSRAM料号、功放型号/使能/供电/电流、
喇叭功率与阻抗、麦克风 PDM/I2S 类型/左右声道、独立按键和走线噪声。若实际为
I2S 麦克风或不同 codec，需适配驱动，不能把当前 PDM 实现直接启用。

## 构建与安全默认

普通构建：`CODEPULSE_AUDIO_ENABLED=OFF`（默认），版本 `0.0.27-todos`，可叠加既有
region/pair150。分区不变。音频开启须显式确认 pin map；编译检查例外仅允许不驱动：

```powershell
.\scripts\test-audio.ps1
.\scripts\build-audio-check.ps1 -BuildDirectory build-audio-check
# 只编译输出路径：添加 -SpeakerOnly
```

脚本使用独立 sdkconfig，合并 `sdkconfig.defaults.audio` 的 **2 MiB factory 分区**。
NVS、phy 和应用起始地址 0x10000 不变；这里不是旧板刷机指令，不能将新分区表直接
用于现有设备。`0.0.27-audio-check` 始终在 GPIO 初始化前返回 NOT_SUPPORTED。
真实 `0.0.27-audio` 必须 PINS_CONFIRMED=ON、COMPILE_TEST=OFF 并提供核验后的引脚。
保持旧供电约定，不引入 esp_restart 或自动刷后复位。

## 已完成与待实测

- 71 个 native/Wasm 帧逐像素一致、400 次重复渲染通过；旧 65 帧逐字节不变。
- host 协议、quiet driver/panel lifecycle、dashboard 和 pacing 回归通过。
- pin policy 和音频关闭 no-op 检查通过。
- 旧板关闭音频、region/pair150 编译通过，app `0x170c60`，原 1500 KiB 分区余 `0x63a0`。
- 完整 PDM+I2S 代码编译通过但禁止硬件初始化：app `0x176df0`；旧分区仅余 528 字节，
  独立 2 MiB 分区余 `0x89210`（27%），因此新音频默认使用较大分区。
- 产品完整回归 700 项及构建已通过；隔离界面验证待办创建、建议确认和生产列表配置通过。

初始软件验证阶段未做真实 AI/ASR/TTS 调用、录音、功放驱动、设备连接或刷写；
后续旧板刷写见上方 2026-10-30 记录，文字 AI 联调见产品文档。下一步在新 PCB 核验后
依次检查本地短 PCM、增益/静音、麦克风幅度、按键采集、LAN 往返、到期播报与安静
时段、屏幕刷新并行时的电源/USB/Wi-Fi稳定性。音频完成回执不等于扬声器实际发声。
