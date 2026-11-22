# 家中动态红色实验交接：2026-11-08

仓库 `https://github.com/noeigenstate/CodePulse.git`，临时分支
`codex/epd-red-flicker-lab`。已发布基线为完整提交
`3489a30d1076273845f7c6a2f09a3bb781316b7c`。
家中实机阶段结束，本次只整理、校验与上传，不新建候选或操作设备。

## 从哪里开始

1. 本页：历史源码还原与复放命令。
2. [逐版汇总](../../../doc/RED-REFRESH-RESULTS-2026-11-08.md)：操作、耗时、光学反馈和最后状态。
3. [离线审计及条件方案](../../../doc/RED-REFRESH-AUDIT-2026-11-08.md)：确认的代码问题、物理假设及未执行的对照设计。
4. [总交接](../../../doc/RED-REFRESH-HANDOFF.md)：当前边界和后续入口。
5. [机器可读索引](index.json)，每版的 `record.json`、`original-build-manifest.json`、
   `source.patch`、`source-sha256.txt`。

## 精确源码的定位方式

| 配置 | 实际源码定位 | 已验证 |
| --- | --- | --- |
| [Fast47](Fast47/record.json) | 直接使用已发布基线；`source.patch` 为空 | 原 manifest 157 项与该提交逐字节一致 |
| [Tail48](Tail48/record.json) | 基线 + [原留存文本补丁](Tail48/source.patch) | 独立还原后 157 项匹配原 manifest |
| [Split49](Split49/record.json) | 基线 + [原留存文本补丁](Split49/source.patch) | 同上 |
| [Neutral50](Neutral50/record.json) | 基线 + [原留存文本补丁](Neutral50/source.patch) | 同上 |
| [Stagger51](Stagger51/record.json) | 基线 + [原留存文本补丁](Stagger51/source.patch) | 同上 |

四份补丁是本轮此前保存的工作区 diff，逐字节保留，不是根据最终代码或报告
倒推历史版本。补丁包含当时已跟踪的测试入口和历史文档；当时新建、未跟踪的
实验文档不一定在补丁中，本次最终交接文档单独提交。历史补丁中的“待测试”等
文字描述其当时状态，最终实测结论看 `record.json` 和逐版汇总。

`original-build-manifest.json` 是原 package manifest 的原样副本，摘要见
`record.json`。它是构建阶段记录，`hardwareFlashed=false`、`opticalValidation=false`
保持原值；后续写入、开机和视觉结论在 `record.json` 的独立 `trial` 中。
没有覆盖或回填本地原 package、manifest、flash 回执。

每份 `source-sha256.txt` 均列出原 manifest 的 157 项输入。还原工具逐项核对；
构建目录 sdkconfig 与被记录的 `firmware/sdkconfig` 字节一致。原 SDK、原编译
路径及编译时间仍会影响镜像，源码还原不承诺在另一电脑构建出相同应用哈希。

## 不构建固件的源码还原

需要 Git 与 Python 3.10+。下面只创建新的 detached worktree、应用补丁并验哈希，
不调用 ESP-IDF、esptool、串口、GPIO 或刷新接口。不能将当前分支的最终代码
当成每个历史版本；输出目录必须不存在，工具不会覆盖现有工作。

在当前产品仓库根目录运行：

```powershell
$labSourcesRoot = Join-Path (Get-Location) '.tmpshots/red-handoff-sources'
foreach ($profileName in @('Fast47','Tail48','Split49','Neutral50','Stagger51')) {
    python firmware/scripts/red-lab-handoff.py restore --profile $profileName --output (Join-Path $labSourcesRoot $profileName)
    if ($LASTEXITCODE -ne 0) { throw 'Historical source restore failed.' }
}
python firmware/scripts/red-lab-handoff.py verify --profile Tail48 --source (Join-Path $labSourcesRoot 'Tail48')
```

还原工具使用 `record.json` 中明确的基线，校验补丁和原 manifest 副本摘要，
再验证所有源码。它不会 fetch、添加远端、切换现有分支、reset/clean、提交或推送。
创建 worktree 时仅禁用该操作的 checkout hook，避免无关自动动作，不修改仓库全局配置。

## 复放像素矩阵、掩码与 LUT

还原后，Windows 主机另需 MSVC C 编译器。此处编译的是纯主机审计程序，
不构建或执行 ESP32 固件；其输入是上述恢复后、通过原指纹校验的实际 C 源码。

```powershell
$labReplayRoot = Join-Path (Get-Location) '.tmpshots/red-handoff-replay'
.\firmware\scripts\replay-red-lab.ps1 -SourcesRoot $labSourcesRoot -OutputDirectory $labReplayRoot -Python python -Profiles Fast47,Tail48,Split49,Neutral50,Stagger51
python firmware/scripts/analyze-red-lab.py --replays $labReplayRoot --sources $labSourcesRoot
python -m unittest discover -s firmware/tests/red-lab -p 'test_*.py'
node scripts/check-firmware-preview.mjs --require-components
```

审计程序在 [scripts/red-lab-replay/audit_plan.c](../../../scripts/red-lab-replay/audit_plan.c)。
复放调用各版自己的画布、掩码和 LUT 函数；DDX 选表按原厂映射独立展开。
本轮已在五版还原目录验证成功，分析脚本已独立复现 `.48/.50/.51` 比较。
新增工具完整性/拒绝覆盖/路径逃逸/哈希篡改检查与已有工具检查共 13 项通过；
两套生产预览 75 项来源哈希通过。

输出保存在新的忽略目录：每版 `replay.json`、编译日志、主机执行文件，以及
`summary.json`、`nominal-phase-timeline.csv`。这些是本机派生物，不入 Git。
提交中的必要摘要与 LUT 技术值在各版 `record.json`，不是原始 OTP 或串口长日志。

可验证：

- 三版测试窗均为白→白96、白→红1816、黑→白256、黑→红72。
- `.48/.50` 首段仅1888目标红像素走R22；`.51` 为R22/R24各944；窗口外非HOLD数为0。
- 三版352个目标白像素在后段处理；首段256个黑→白仍选HOLD。
- `.48 → .50` R22偏移24/30仅 B0→30；其他表与选路一致。
- `.51` A组展开的名义码相同，但原始字节与相位边界不同；第二显红通道未验证。

不能验证：实际电压、源极与VCOM差分、真实相位输出、颜料运动、光学闪烁频率、
温度适应性或寿命。代码的HOLD意图和一次周边稳定反馈，不等于长期电气场强为零。

## 仍缺失和已经在主开发机恢复的资料

- 用户在本次交接指令中确认：主开发机已找回并验证原始4096字节OTP。
  本次不再补采、不复制或上传它；家中这份审计没有重新对原始数据校验。
  接手者使用主开发机已有文件继续核对温区、出厂表和电平语义。
- 本轮面板温度、环境温度、源极/VCOM测量、阶段视频、精确光学曲线均未记录；
  不用环境或AHT20值代替面板温度，也不为补项重跑设备。
- `.51` 只有与前轮无区别的整体反馈，颜色比例、棋盘纹、白字及周边未单独补确认。
- `.46` 旧动态耗时仍未采集；名义6060ms不补成实测。
- 各版未形成同轮A/B/A重复对照，不能宣称具体物理根因或低闪动态红已解决。

原包、二进制、构建目录、长日志、视频及未脱敏回执继续留在本地忽略目录。
本目录不含OTP、NVS、flash dump、设备身份、凭据、账号数据或真实任务内容。
