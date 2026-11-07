# Board1 动态红色减闪：跨电脑继续开发

更新：2026-11-07。临时远端分支 **`codex/epd-red-flicker-lab`**，产品仓库
<https://github.com/noeigenstate/CodePulse>。这是实验检查点，未申请合并 main。

## 当前目标与准确进度

目标是让红色标签真正出现、消失及改变，同时保持清楚文字、稳定周边和可接受的闪烁。
不能把“静态红色、只刷新黑白”当作此目标完成，也不能只验证软件状态或恢复正常固件后停止。

| 版本 / 构建配置 | 已知结论 | 接下来如何使用 |
| --- | --- | --- |
| `.33-status-region-pair150` / Production33 | 正常联网应用；保留现行生产刷新策略 | 需要恢复日常使用时单独构建 |
| `.43-red-black` / Erase43 | 退红后写黑字一次通过：清楚、周边正常、闪烁可接受；显红步骤呈黑，失败 | 保留有效退红路径，按需对照，不重复默认全套 |
| `.44` / `.45` | 显红呈黑或混色、白字偏弱，失败 | 保留源码追溯，不作为默认测试 |
| `.46-red-activate` / Color46 | 红色、白字、周边稳定一次通过；**闪烁严重，不可接受** | 已通过的色彩对照，仍不是合格产品波形 |
| `.47-red-fast` / Fast47 | 主机测试、目标编译及镜像检查通过；**尚未刷入，尚无光学结果** | 周末首先测此候选的减闪效果 |

最后一次实机身份确认是 `.46`，不能据文档猜测新一轮连接的设备版本。
`.46` 动态测试的串口观察已在用户操作前超时，实际耗时缺失；不能将名义 6060ms
当作测量值。新观察入口默认持续 2 小时，手动按键前确认它仍在运行。
公开结论见各 [RED-* 实验记录](RED-FAST-LAB-2026-11-06.md)；原始设备身份、OTP、
日志和旧镜像仅留原机器私有目录，本分支不上传这些内容，也不依赖它们构建。

基线来自根提交 `ca3efd7a8aa4516ebd0bd00a36ac7a0ca74d486f`，包含此前已提交的
桌面功能。检查点另外收录 `.33` 离线状态修复及对应双端生产预览，保证固件源码基础一致。
没有带入正在开发的电脑状态第四布局、市场服务或 Antigravity 桌面改动。
生产默认不开任何红色实验开关，双端生产预览仍为 `.33`；`.47` 是独立手动测试页。

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
- 电压、VCOM_DC、OTP、GPIO、配网和 NVS 不改。五表完整加载；分阶段超时、BUSY
  异常或失败后停止，不自动重试。外部未变区域仍作同排、上下的红黑对照。
- `.47` 尚未证明温度适应性、长期循环、电荷平衡或产品寿命；软件测试不模拟这些。

关键文件：

| 文件 | 内容 |
| --- | --- |
| `firmware/CMakeLists.txt` / `main/CMakeLists.txt` | 默认关闭的实验入口、依赖关系和运行版本 |
| `firmware/experiments/epd-red-mask-probe/red_mask_plan.c` | 各版 LUT、帧率、像素掩码及名义时长 |
| `firmware/experiments/epd-red-mask-probe/driver_red_black.inc` | 两阶段加载、帧率恢复、BUSY 和失败停止 |
| `red_mask_probe.c` / `red_mask_pattern.c`（同目录） | 人工状态机、冷却间隔、400×300 对照画面 |
| 同目录 `tests/` / `test.ps1` | 真实驱动调用的事务、像素和故障路径主机测试 |
| `firmware/scripts/build-red-lab.ps1` | 跨电脑构建四种配置，不刷机、不启动客户端 |
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
.\firmware\experiments\epd-red-mask-probe\test.ps1 -FastStage -Output .tmpshots/red-fast-host
.\firmware\experiments\epd-red-mask-probe\test.ps1 -ActivateStage -Output .tmpshots/red-color-host
.\firmware\experiments\epd-red-mask-probe\test.ps1 -BlackStage -Output .tmpshots/red-erase-host
python -m unittest discover -s firmware/tests/red-lab -p "test_*.py"
.\firmware\scripts\build-red-lab.ps1 -Profile Fast47
```

Windows 输出目录完整路径需不超过 80 个字符；入口在 SDK 启动前检查，避免深目录在
第三方组件编译时触发路径限制。若仓库位置较深，显式指定短输出目录，例如
`-BuildDirectory C:/cp-red-build/fast47`，并把后文 `$b` 改为该目录。

默认最多 2 个编译任务。该入口先显式关闭其他探测和音频开关，再开启所选链条；
`-PlanOnly` 只显示配置，不初始化 SDK 或接触硬件。生成配置写在 build 目录，
不改已提交的 `firmware/sdkconfig`。选择 `Color46` / `Erase43` / `Production33` 可分别构建对照或正常应用。
每种配置的缓存和本地包互不混用。已有 `package/manifest.json` 的目录不覆盖；
修改波形后用新的 `-BuildDirectory build-red-lab-fast47-b`，并记录新版本/源码差异。
增加新候选运行版本时，同时更新 CMake、构建脚本和产物工具中的版本映射，保留必要对照；
不要只覆盖旧包或在日志里把不同波形当成同一已验收版本。

包位于 `firmware/build-red-lab-fast47/package/`，包括应用、待对照分区和 manifest。
manifest 标注根提交、源码/配置哈希、运行版本、分区、应用大小和 SHA256，光学验收仍为 false。
不同电脑、路径、编译时间的镜像哈希可能不同；只将同一包的 manifest 与其镜像核对。
原机器 `.47` 镜像哈希见 [实验记录](RED-FAST-LAB-2026-11-06.md)，是历史定位值，不是跨电脑构建承诺。

已知主机检查：Fast47 每模式 1121 个故障点，Color46 为 1117，Erase43 为 893，
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
$b = Join-Path $FirmwareRoot 'build-red-lab-fast47'
& $IdfPython .\firmware\scripts\red-lab-artifact.py check --build $b --profile Fast47
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

## 周末第一步：只测 .47 的显红

在正常开机前启动被动日志观察，端口断开后它会等同一 COM 号重连：

```powershell
& $IdfPython .\firmware\scripts\observe-red-lab.py --port $port --seconds 7200
```

它不发送串口命令、不配网、不复位、不触发刷新；记录保存到忽略的 `.tmpshots/red-lab/`。
它是被动日志，未捕获到版本或某次测试就不能推断设备身份/时序；需要时用正常启动日志
或只读 CP1 探测核对身份，避免两个程序争用端口。

1. `.47` 首刷应显示 **RED FAST LAB**：中间白底黑字 READY，左右及上下固定红黑文字。
   先确认启动日志版本与基准清楚完整。
2. 从首次刷新完成起至少等 180 秒，再**短按一次**。等待显红与白字清理两阶段都结束。
   目标是红底白字 ERROR，周边保持不变。判断颜色、白字和闪烁，不能只问“是否更新”。
   首次完成时间未捕获时，从确认首屏稳定后保守等满 180 秒，不猜测历史时间。
3. 记录：实际 `pass=1/2`、`pass=2/2`、`refresh` / `total` / `result`，以及
   红色是否均匀、字是否清楚、残影、周围是否变化、闪烁能否接受。缺失项写未捕获。
4. 不连续按键、不自动重试。颜色正确但闪烁仍不可接受就记录为失败，继续改具体波形。
   冷却后下一次短按会返回正常联网应用并进行恢复首刷；需要永久退出实验则构建 Production33 后另行升级。

`.47` 只验证红色出现；退红继续保留 `.43` 的已通过路径。进入下一版前说明
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
