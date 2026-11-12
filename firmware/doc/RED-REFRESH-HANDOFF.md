# Board1 动态红色减闪：跨电脑继续开发

更新于 2026-11-12。临时远端分支 **`codex/epd-red-flicker-lab`**，产品仓库
<https://github.com/noeigenstate/CodePulse>。这是实验检查点，未申请合并 main。

## 2026 年 11 月 12 日主开发机实测

`.57` 以冻结的 `.55` 画面和波形对比显红阶段的扫行范围。A 复现横纹，B 的横纹消失，现场闪烁无改善。B 的光学结果已记录，阶段计时缺失。 [扫行对照实测报告](RED-SCAN-AB-REPORT-2026-11-12.md)

## 2026 年 11 月 8 日家中实机交接

用户明确授权将这轮源码和脱敏结果提交推送到此临时分支。本次只交接，不调参、
不构建新候选，不打开串口或触发刷新，不合并main或创建release。

- **先读 [精确源码归档与复放入口](../experiments/red-lab-handoff/2026-11-08/README.md)。**
  `.47`直接定位已发布`3489a30`，`.48/.49/.50/.51`各有基于该基线的原留存补丁、
  原manifest副本及157项源码哈希；五版均已独立还原并逐项校验。
- [逐版实测与最后状态](RED-REFRESH-RESULTS-2026-11-08.md)区分写入、实际运行、
  首屏、阶段计时和四项光学结果；每版record另有全部开关、LUT、门限和产物摘要。
- [离线审计与未执行方案](RED-REFRESH-AUDIT-2026-11-08.md)定位清字延迟的代码原因，
  不将它等同于显红聚闪已解决。复放脚本及公开源码输入均随此交接提交。
- 用户已确认主开发机找回并验证原始4096字节OTP；本次不补采或上传该数据。
  家中离线审计未重新读取它，接手者用主开发机已有原始资料继续核对温区/波形。
- 最后确认版本仍为`.51-red-stagger`，完成一次DRAW_RED后held，用户反馈无改善。
  所有观察已结束。本次交接没有重新连接设备，具体最终比例/棋盘纹未独立补确认。

原包、manifest、flash回执、二进制、构建目录与长日志保持本地原样；不把历史
manifest构建阶段的false标志回填为true。以下旧阶段文字保留各自当时事实，
家中轮次的进度见本节、逐版汇总和归档记录。

## 家中轮次的目标与进度

目标是让红色标签真正出现、消失及改变，同时保持清楚文字、稳定周边和可接受的闪烁。
不能把“静态红色、只刷新黑白”当作此目标完成，也不能只验证软件状态或恢复正常固件后停止。

| 版本 / 构建配置 | 已知结论 | 接下来如何使用 |
| --- | --- | --- |
| `.33-status-region-pair150` / Production33 | 正常联网应用；保留现行生产刷新策略 | 需要恢复日常使用时单独构建 |
| `.43-red-black` / Erase43 | 退红后写黑字一次通过：清楚、周边正常、闪烁可接受；显红步骤呈黑，失败 | 保留有效退红路径，按需对照，不重复默认全套 |
| `.44` / `.45` | 显红呈黑或混色、白字偏弱，失败 | 保留源码追溯，不作为默认测试 |
| `.46-red-activate` / Color46 | 红色、白字、周边稳定一次通过；**闪烁严重，不可接受** | 已通过的色彩对照，仍不是合格产品波形 |
| `.47-red-fast` / Fast47 | 11 月 8 日实测：旧 READY 黑字残留、目标红底未出现；周边正常、未见闪烁；**显红失败** | 保留失败源码、镜像和实际计时，不默认重跑 |
| `.48-red-tail100` / Tail48 | 最终擦字、红底、白字、周边一次通过；擦字时短暂阴影、显红聚闪，**闪烁仍较严重，综合失败** | 保留有效颜色与实际计时，见 [100Hz 尾段记录](RED-TAIL100-LAB-2026-11-08.md) |
| `.49-red-split` / Split49 | 中心出现灰底及残留阴影、过渡卡顿感，周边正常、白字可见；**显红失败** | 保留三段实际计时，暂停 200Hz 显红路线，见 [记录](RED-SPLIT-LAB-2026-11-08.md) |
| `.50-red-neutral` / Neutral50 | 闪烁明显改善，但目标约九成黑、一成红，白字、周边正常，**显红失败** | 保留减反向的失败边界，见 [中性尾段记录](RED-NEUTRAL-LAB-2026-11-08.md) |
| `.51-red-stagger` / Stagger51 | 已写入、实读身份、基准正常；两段 4371/1860ms、total=6796ms，ESP_OK；用户反馈与前轮无区别、未改善 | 本轮未通过，停止硬件试验并复盘。见 [像素错峰记录](RED-STAGGER-LAB-2026-11-08.md)；不复制 .50 的比例估计作为 .51 实测 |

2026-11-08 `.47` 显红失败、`.48` 最终颜色通过但闪烁失败后，
`.49` 单次显红失败后，`.50` 黑色占优、颜色失败。现已只写 `.51` 并实读确认，
用户确认首屏正常，冷却后一次显红已完成，两段 ESP_OK；用户反馈无改善，要求停止试参并复盘。
被动观察已经结束，保持 .51 结果；当前不构建下一候选、不再操作设备。
不能据文档猜测新一轮连接的设备版本。

后续离线审计及有条件测试设计见 [RED-REFRESH-AUDIT-2026-11-08.md](RED-REFRESH-AUDIT-2026-11-08.md)。
家中审计时原始OTP只在主开发机；用户本次已确认主开发机找回并验证。
本次没有重新读取或校验原始数据，接手者使用已有数据继续出厂波形比对。
已核对三版冻结源码、数字选路和阶段时序；已定位 256 个旧黑→白像素延后处理、
`.50` 两字节改变的尾段预算，以及 `.51` 第二通道/相位网格的未验证前提。
方案为资料门槛后同一诊断包 A1/B/A2、仅交换红段/白段顺序；最多 6 次刷新含基准，
尚未构建、未执行、未请求刷写确认，不将方案文本视为设备操作授权。
`.46` 动态测试的串口观察已在用户操作前超时，实际耗时缺失；不能将名义 6060ms
当作测量值。新观察入口默认持续 2 小时，手动按键前确认它仍在运行。
公开结论见各 [RED-* 实验记录](RED-FAST-LAB-2026-11-06.md)；原始设备身份、OTP、
日志和旧镜像仅留原机器私有目录，本分支不上传这些内容，也不依赖它们构建。

基线来自根提交 `ca3efd7a8aa4516ebd0bd00a36ac7a0ca74d486f`，包含此前已提交的
桌面功能。检查点另外收录 `.33` 离线状态修复及对应双端生产预览，保证固件源码基础一致。
没有带入正在开发的电脑状态第四布局、市场服务或 Antigravity 桌面改动。
生产默认不开任何红色实验开关，双端生产预览仍为 `.33`；各红色候选是独立手动测试页。

## 驱动与硬件边界

- **Board1：ESP32-S3-WROOM-1-N16R8、WFT0420CZ15 400×300 黑白红**。
  控制器按 UC8176/IL0398 系列使用；`epd_ssd1683.c` 是历史文件名，不能据名字换驱动。
  引脚及供电见 [BOARD1.md](BOARD1.md)，不直接套新 PCB，也不启用音频。
- 保留 `.43` 的先退红、再仅写黑字流程。`.46` 仅对 1888 个新红像素进行完整阶段调理，
  最后清理 80×28 窗口内 352 个目标白字像素（含 96 个本来为白色的像素）。
- `.47` 只调整显红尾段：红阶段使用手册所列 200Hz / R30=39，854 帧；
  前 1220ms 的名义电平顺序及所有电平累计时间保留；再恢复 100Hz / 3A 清理白字 179 帧。
  原 170–200ms 的慢周期改为 25–30ms，合计名义驱动仍 6060ms。
  相同累计驱动不是物理等价证明，芯片支持 200Hz 也不是此批玻璃通过验证。
- `.48` 从 .46 出发，始终 100Hz / R30=3A，原前四组逐帧保留；仅尾段改为
  10/40ms×30 与 10/50ms×20，末 350ms 显红保持和白字清理不变。
  仍须同时验收颜色、旧字擦除、白字、周边与闪烁，不能预判通过。
- `.49` 将 .46/.48 的前四组放在 100Hz，.47 快速尾段单独使用 200Hz，最后恢复
  100Hz 清理白字。前两段累计 5200ms 门限保留，任一失败不进入后段。
  新增段间上传停顿，名义电平顺序一致不证明实际物理等价，过渡阴影仍待解决。
- `.50` 回到 .48 的两阶段 100Hz，尾段两组 B0 改为 30，只把原 500ms 反向
  驱动换成中性停顿，正向显红与其他时序不变。净驱动已改变，不宣称电荷平衡。
- `.51` 保留 .48 每像素的名义电平预算，目标红按棋盘分为 R22/R24 两组，
  两组尾段反向时刻错开，其余窗口外走 R23 HOLD；五表时序同步。R24 显红尚未
  在本屏验证，主机电平计数不能证明物理输出相同，需单独观察棋盘纹/色差。
- 电压、VCOM_DC、OTP、GPIO、配网和 NVS 不改。五表完整加载；分阶段超时、BUSY
  异常或失败后停止，不自动重试。外部未变区域仍作同排、上下的红黑对照。
- 各候选尚未证明温度适应性、长期循环、电荷平衡或产品寿命；软件测试不模拟这些。

关键文件：

| 文件 | 内容 |
| --- | --- |
| `firmware/CMakeLists.txt` / `main/CMakeLists.txt` | 默认关闭的实验入口、依赖关系和运行版本 |
| `firmware/experiments/epd-red-mask-probe/red_mask_plan.c` | 各版 LUT、帧率、像素掩码及名义时长 |
| `firmware/experiments/epd-red-mask-probe/driver_red_black.inc` | 两阶段加载、帧率恢复、BUSY 和失败停止 |
| `red_mask_probe.c` / `red_mask_pattern.c`（同目录） | 人工状态机、冷却间隔、400×300 对照画面 |
| 同目录 `tests/` / `test.ps1` | 真实驱动调用的事务、像素和故障路径主机测试 |
| `firmware/scripts/build-red-lab.ps1` | 跨电脑构建八种配置，不刷机、不启动客户端 |
| `firmware/scripts/red-lab-artifact.py` | 源码、配置、版本、分区、镜像哈希检查及独立本地包 |
| `firmware/scripts/observe-red-lab.py` | 只读日志观察，不发命令、不复位，不保存普通 Wi-Fi/CP1 日志 |

## 新电脑取代码与环境

新目录克隆（已有工作区先保留未提交改动，不 reset/clean）：

```powershell
git clone --branch codex/epd-red-flicker-lab https://github.com/noeigenstate/CodePulse.git CodePulse-RedLab
cd CodePulse-RedLab
git status --short
git remote -v
git log -1 --oneline
```

如果此前已克隆产品仓库，核对远端完整地址后 fetch，再切到对应跟踪分支。
远端在新克隆中通常叫 origin；不要照搬旧机器曾用 upstream 的名字。
后续获授权推送仍只推此临时分支，不修改 main 保护、不强推、不发 release。

需要 Windows、Python 3.10+、ESP-IDF **6.0.1** / esp32s3；主机测试另需 MSVC C 工具。
预览哈希检查只需 Node，不需要安装或运行 Electron，也不需要搬用户账号和 AI 密钥。
首次安装 SDK：

```powershell
.\firmware\scripts\setup.ps1 -Python python
```

已有相同 SDK 时，可设置 `CODEPULSE_IDF_PATH`、`CODEPULSE_IDF_TOOLS_PATH`、
`CODEPULSE_IDF_PYTHON_ENV_PATH` 后复用；不复制旧机器的整个 toolchain、构建缓存或 `.tmpshots`。
`dependencies.lock`、字体与第三方许可保持现有版本。

## 构建与软件检查

所有命令从仓库根运行：

```powershell
node scripts/check-firmware-preview.mjs
.\firmware\experiments\epd-red-mask-probe\test.ps1 -NeutralStage -Output .tmpshots/red-neutral-host
.\firmware\experiments\epd-red-mask-probe\test.ps1 -StaggerStage -Output .tmpshots/red-stagger-host
.\firmware\experiments\epd-red-mask-probe\test.ps1 -SplitStage -Output .tmpshots/red-split-host
.\firmware\experiments\epd-red-mask-probe\test.ps1 -Tail100Stage -Output .tmpshots/red-tail100-host
.\firmware\experiments\epd-red-mask-probe\test.ps1 -FastStage -Output .tmpshots/red-fast-host
.\firmware\experiments\epd-red-mask-probe\test.ps1 -ActivateStage -Output .tmpshots/red-color-host
.\firmware\experiments\epd-red-mask-probe\test.ps1 -BlackStage -Output .tmpshots/red-erase-host
python -m unittest discover -s firmware/tests/red-lab -p "test_*.py"
.\firmware\scripts\build-red-lab.ps1 -Profile Stagger51
```

Windows 输出目录完整路径需不超过 80 个字符；入口在 SDK 启动前检查，避免深目录在
第三方组件编译时触发路径限制。若仓库位置较深，显式指定短输出目录，例如
`-BuildDirectory C:/cp-red-build/fast47`，并把后文 `$b` 改为该目录。

默认最多 2 个编译任务。该入口先显式关闭其他探测和音频开关，再开启所选链条；
`-PlanOnly` 只显示配置，不初始化 SDK 或接触硬件。生成配置写在 build 目录，
不改已提交的 `firmware/sdkconfig`。选择 `Neutral50` / `Split49` / `Tail48` / `Fast47` / `Color46` / `Erase43` / `Production33` 可分别构建对照或正常应用。
每种配置的缓存和本地包互不混用。已有 `package/manifest.json` 的目录不覆盖；
修改波形后用新的 `-BuildDirectory build-red-lab-fast47-b`，并记录新版本/源码差异。
增加新候选运行版本时，同时更新 CMake、构建脚本和产物工具中的版本映射，保留必要对照；
不要只覆盖旧包或在日志里把不同波形当成同一已验收版本。

包位于 `firmware/build-red-lab-stagger51/package/`，包括应用、待对照分区和 manifest。
manifest 标注根提交、源码/配置哈希、运行版本、分区、应用大小和 SHA256，光学验收仍为 false。
不同电脑、路径、编译时间的镜像哈希可能不同；只将同一包的 manifest 与其镜像核对。
原机器 `.47` 镜像哈希见 [实验记录](RED-FAST-LAB-2026-11-06.md)，是历史定位值，不是跨电脑构建承诺。

已知主机检查：Split49 每模式 1258，Stagger51 / Neutral50 / Tail48 / Color46 为 1117，Fast47 为 1121，Erase43 为 893 个故障点，
均已通过 Debug/NDEBUG；两套生产预览的 75 项源哈希已通过。
完整 quiet 套件仍有旧基线失败 `test_dashboard.c:180`、`test_pacing.c:74`，
不把整套 quiet 测试宣称通过，也不修改预期去掩盖它们。

## 升级已有 Board1：只写应用

下列是操作说明，**构建不会执行这些动作**。先核对 [固件 AGENTS](../AGENTS.md)
和板型。不要用通用 `scripts/flash.ps1`：它是首次部署入口，会写 bootloader 和分区。
此轮不改分区，不擦 flash，不写 NVS，不升级 SDK。

先准备环境和包；`$port` 必须按本次 USB 枚举选择，不沿用旧 COM 号：

```powershell
. .\firmware\scripts\idf-env.ps1
$b = Join-Path $FirmwareRoot 'build-red-lab-stagger51'
& $IdfPython .\firmware\scripts\red-lab-artifact.py check --build $b --profile Stagger51
if ($LASTEXITCODE -ne 0) { throw 'Package check failed; stop.' }
.\firmware\scripts\probe.ps1 -List
$port = Read-Host 'Board1 native USB COM port'
```

关闭客户端的 USB 扫描及占用端口的观察程序。**每次刷写重新取得持续按键确认**：
接好 USB，持续按住功能/电源键，按下后即可开始，不用等灯熄灭；不按 BOOT，先不松手。
自动代理必须先让用户确认本次已按住；前一次确认不能沿用。禁止 USB 与 H2 3V3 同时供电。

以下小函数只为保证每条 esptool 失败立即停止，且刷后不复位：

```powershell
function Invoke-RedLabEsp {
    param([string]$Before = 'no-reset', [string[]]$EspArguments)
    & $IdfPython -m esptool --chip esp32s3 --port $port --baud 115200 --before $Before --after no-reset @EspArguments
    if ($LASTEXITCODE -ne 0) { throw 'esptool failed; stop without retrying.' }
}
# 仅在本次持续按键已确认后执行。
Invoke-RedLabEsp -Before usb-reset -EspArguments @('read-mac')
# 核对 ESP32-S3、N16R8 设备身份，与本次选中的原生 USB 序列号相符。
# 若不符，停止，不进入写入步骤。
Invoke-RedLabEsp -EspArguments @('read-flash', '0x8000', '0xc00', "$b/actual-partition.bin")
if ((Get-FileHash -LiteralPath "$b/actual-partition.bin").Hash -ne
    (Get-FileHash -LiteralPath "$b/package/partition-table.bin").Hash) { throw 'Actual partition differs; stop.' }
Invoke-RedLabEsp -EspArguments @('read-flash', '0x10020', '0x100', "$b/previous-app-descriptor.bin")
& $IdfPython -c 'import sys; from pathlib import Path; d=Path(sys.argv[1]).read_bytes(); assert int.from_bytes(d[:4],"little")==0xabcd5432; assert d[48:80].split(b"\0")[0]==b"codepulse_bringup"; print("Previous firmware:",d[16:48].split(b"\0")[0].decode())' "$b/previous-app-descriptor.bin"
if ($LASTEXITCODE -ne 0) { throw 'Existing app identity differs; stop.' }
Invoke-RedLabEsp -EspArguments @('write-flash', '--flash-mode', 'dio', '--flash-freq', '80m', '--flash-size', '16MB', '0x10000', "$b/package/codepulse_bringup.bin")
```

确认写入输出的 **Hash of data verified**。此时及时告知用户完全松开功能键断电，
再按约 3 秒正常开机，灯亮后松开。记录实读版本、分区与写入结果在忽略目录；
未获取写入校验、开机身份或光学结论时分别标为未确认。

## 已完成 .51 的历史手动步骤（当前不再执行）

在正常开机前启动被动日志观察，端口断开后它会等同一 COM 号重连：

```powershell
& $IdfPython .\firmware\scripts\observe-red-lab.py --port $port --seconds 7200
```

它不发送串口命令、不配网、不复位、不触发刷新；记录保存到忽略的 `.tmpshots/red-lab/`。
它是被动日志，未捕获到版本或某次测试就不能推断设备身份/时序；需要时用正常启动日志
或只读 CP1 探测核对身份，避免两个程序争用端口。

1. `.51` 首刷应显示 **RED STAGGER LAB**：中间白底黑字 READY，左右及上下固定红黑文字。
   先确认启动日志版本与基准清楚完整。
2. 从首次刷新完成起至少等 180 秒，再**短按一次**。等待像素错峰显红与白字清理两阶段都结束。
   目标是红底白字 ERROR，周边保持不变。判断颜色、白字和闪烁，不能只问“是否更新”。
   首次完成时间未捕获时，从确认首屏稳定后保守等满 180 秒，不猜测历史时间。
3. 记录：实际 `pass=1/2`、`pass=2/2`、`refresh` / `total` / `result`，以及
   红色是否均匀、有无棋盘纹/两组色差、字是否清楚、残影、周围是否变化、闪烁能否接受。缺失项写未捕获。
4. 不连续按键、不自动重试。颜色正确但闪烁仍不可接受就记录为失败，继续改具体波形。
   冷却后下一次短按会返回正常联网应用并进行恢复首刷；需要永久退出实验则构建 Production33 后另行升级。

`.51` 只验证红色出现；退红继续保留 `.43` 的已通过路径。进入下一版前说明
本次失败的是哪个指标、改哪个阶段、预期影响及验收，不重新让用户跑完所有失败历史。
诊断期间无需桌面客户端或局域网服务；恢复正常应用后，换办公室可能需要重新配网/绑定新宿主，
用正常客户端入口处理，不把旧机器凭据放进 Git。

## 继续开发的记录约定

每次候选记录分支提交或提交加未提交源码指纹、固件运行版本、Board1/面板、配置、
应用/分区 SHA256、180 秒间隔、基准与手动步骤、实测时间、四项光学结论和下一假设。
细节日志留忽略目录，公开文档只放去身份的结论，不上传 Wi-Fi、token、MAC、NVS、OTP 或 flash dump。
软件检查、目标构建、刷入校验、开机身份和光学通过各自独立；此分支及现有用户授权均不自动授权合并 main。


## 本检查点的独立目录验证

2026-11-07 在隔离工作树完成 Fast47 全量目标构建，
ESP-IDF6.0.1 / esp32s3、最多两个编译任务；包版本、源码/配置快照、分区和应用边界
校验通过。应用 1399936 字节，分区余量 136064 字节。
每模式 1121 / 1117 / 893 故障点及人工控制回归通过，新增打包/被动日志工具的五项
主机检查通过，两套生产预览严格检查 75 项来源哈希通过。

首次迁移检查发现自定义 partitions.csv 是可选文件，已修正快照收集并加入真实目录
回归后重跑。隔离目录过深还触发了 SDK 的 Windows 对象路径限制，入口已增加提前检查；
本次通过临时短盘符访问同一缓存继续编译，编译输入未变，结束移除映射。
新电脑直接选择短输出目录即可，不依赖本机映射。未通过改动 GPIO、分区或警告级别绕过问题。
本次只准备源码分支，未启动客户端、访问实体串口或刷机；`.47` 仍无光学结论。
