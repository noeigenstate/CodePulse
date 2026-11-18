# Board1 动态红色减闪：跨电脑继续开发

更新于 2026-11-18。临时远端分支 **`codex/epd-red-flicker-lab`**，产品仓库
<https://github.com/noeigenstate/CodePulse>。这是实验检查点，未申请合并 main。

## 2026 年 11 月 18 日主开发机实测收尾（.63–.67）与产品集成交接

本轮已完成 `.63`（A/B）至 `.67`（A/B）Board1 实机对照实测（每步至少间隔 180 秒冷却，原始串口日志留本地 `.tmpshots/` 不入库），并选定 **`.67 A`（`CRISP_860_A`）** 作为本阶段动态显红收尾波形，转入同步上游最新桌面端后的正式应用实测：

1. **`.63`（`FreqAB63` / `0.0.63-red-freq-ab`，提交 `70eae1e`）**
   - **A 组（`FREQ_100_A`，`100 Hz`，`300` 帧）**：`refresh=3076 ms`，`total=3504 ms`，`ESP_OK`。几乎无闪烁、渐变顺滑，但红色偏弱偏浅。
   - **B 组（`FREQ_200_B`，`200 Hz`，`590` 帧）**：`refresh=3016 ms`，`total=3424 ms`，`ESP_OK`。`R24` 擦净旧黑字，但 `5 ms` 窄 `VDL` + `30~35 ms` `VDHR` 未能拉起红颜料（呈灰粉浅底），显红失败，终止 `200 Hz` 路线。

2. **`.64`（`RichAB64` / `0.0.64-red-rich-ab`，提交 `ca17d2d`）**
   - **A 组（`RICH_STEP_A`，`100 Hz`，`300` 帧，`1:4`×12 → `1:5`×24 + `540 ms` `VDHR`）**：`refresh=3076 ms`，`total=3504 ms`，`ESP_OK`。颜色正红节奏稳，仅浮现中段（`16.7 Hz`）短暂闪烁感略重。
   - **B 组（`RICH_FADE_B`，`100 Hz`，`290` 帧，`1:4`×24 + `1280 ms` `VDHR`）**：`refresh=2976 ms`，`total=3404 ms`，`ESP_OK`。无中段闪烁缺点，但因 `1280 ms` 连续保持导致红底略偏黑。

3. **`.65`（`SmoothAB65` / `0.0.65-red-smooth-ab`，提交 `d6e3b4a`）**
   - **A 组（`SMOOTH_MIX_A`，`100 Hz`，`300` 帧，`1:4`×12 → `0xbb` `18.2 Hz`×12 对 + `660 ms` `VDHR`）**：`refresh=3076 ms`，`total=3504 ms`，`ESP_OK`。
   - **B 组（`SMOOTH_20HZ_B`，`100 Hz`，`290` 帧，`1:4`×34 + `780 ms` `VDHR`）**：`refresh=2976 ms`，`total=3404 ms`，`ESP_OK`。
   - **光学结论**：A/B 闪烁体感均达到可用水平，差别很小；但 `34~36` 次尾段 `VDL` 使红底较周围标定红略发白发浅。

4. **`.66`（`VividAB66` / `0.0.66-red-vivid-ab`，提交 `7124fdf`）**
   - **A 组（`VIVID_HOLD_A`，`100 Hz`，`300` 帧，`30` 尾段 `VDL` + `960 ms` `VDHR`）**：`refresh=3076 ms`，`total=3504 ms`，`ESP_OK`。
   - **B 组（`VIVID_VDH_B`，`100 Hz`，`290` 帧，`110 ms` 前缀 `VDH` + `28` 尾段 `VDL` + `960 ms` `VDHR`）**：`refresh=2976 ms`，`total=3404 ms`，`ESP_OK`。
   - **光学结论**：A/B 均消除发白发浅，保持低闪烁、速度与白字清晰度，仅 `960 ms` 末段保持略带微黑。

5. **`.67`（`CrispAB67` / `0.0.67-red-crisp-ab`，提交 `61e456e`）**
   - **A 组（`CRISP_860_A`，`100 Hz`，`300` 帧，`32` 尾段 `VDL` + `860 ms` `VDHR`，`7.06:1`）**：`refresh=3076 ms`，`total=3504 ms`，`ESP_OK`。黑色掺杂进一步减轻、低闪体感稳定、白字与窗外保持干净，仅受低闪单遍预算限制饱和度略弱于 16 秒 OTP 全刷红；**选定为本阶段收尾方案**。
   - **B 组（`CRISP_830_B`，`100 Hz`，`290` 帧，`30` 尾段 `VDL` + `830 ms` `VDHR`）**：`refresh=2976 ms`，`total=3404 ms`，`ESP_OK`。体感与 A 接近。
   - **收尾去向**：提交本实验分支检查点后，于独立工作树同步上游 `main`，在正常应用流程接入 `.67 A` 显红与 `.43` 退红策略并配合 CodePulse 红色界面元素实测。

## 2026 年 11 月 16–17 日主开发机实测（.59–.62）与 .63 待测交接

本轮已在主开发机完成 `.59`（A/B）、`.60`（A）、`.61`（A）与 `.62`（A/B）实机观察，验证了 **`.62 B` 高频浅脉冲**正确方向，并将 `.60`–`.63` 源码、主机测试及本交接提交至本分支；原始串口日志与私有读出数据留在本地 `.tmpshots/`，不入库。**当前板端运行固件为 `0.0.62-red-wave-ab`。**

1. **`.59`–`.61` 实测收敛结论**
   - **`.59`（`GlideAB59`）**：A 组（`GLIDE_SOFT_A`，280 帧 `refresh=2876 ms`，`total=3304 ms`，`ESP_OK`）节拍尚可但仍有显红轻闪与轻微黑底掺杂；B 组（`GLIDE_ZERO_B`，230 帧 `refresh=2376 ms`，`total=2804 ms`，`ESP_OK`）速度更快但红底偏黑更明显。
   - **`.60` A（`PureAB60` / `PURE_BALANCED_A`）**：290 帧 `refresh=2976 ms`，`total=3404 ms`，`ESP_OK`。颜色较 `.59 A` 略好，但因 `0x8c` 含 `10 ms` `0V` 缓冲延迟白字刹车，显红闪烁略有加重；未再续测 B。
   - **`.61` A（`BrakeAB61` / `BRAKE_BALANCED_A`）**：280 帧 `refresh=2876 ms`，`total=3304 ms`，`ESP_OK`。红黑底与闪烁感与前两版无明显区别；结合出厂 4096 字节 OTP 解码可见，`10~13 Hz`（`1:7~1:9`）正落在人眼闪烁敏感峰，且浅脉冲 + 长纯 `VDHR` 易残留偏黑杂底。

2. **`.62`（`WaveAB62` / `0.0.62-red-wave-ab`）实测突破**
   - 保持 `100 Hz` 单遍 `R22+R24` + `PT_SCAN=1`，两组均保留 42 帧起手预处理：
   - **A 组（`WAVE_OTP_A`，300 帧）**：`refresh=3076 ms`，`total=3504 ms`，`ESP_OK`。接近出厂大宽脉冲结构（`~4 Hz`，10 轮），红底掺黑明显好转、白字周边清晰、整体时间短，但 `4 Hz` 低频周期闪烁感非常强，不够柔和。
   - **B 组（`WAVE_DENSE_B`，290 帧）**：`refresh=2976 ms`，`total=3404 ms`，`ESP_OK`。转为 `36` 轮 `1:5`/`1:6` 密脉冲（`14.3~16.7 Hz`）+ 末段 `180 ms` `VDHR`。用户实机确认方向正确：响应速度满意，高频下闪烁变得明显柔和且红字表现显著好转。

3. **`.63`（`FreqAB63` / `0.0.63-red-freq-ab`，已编译校验通过，尚未刷机）**
   - 沿着 `.62 B` 的高频浅脉冲方向继续推高频率并对照两种实现：
     - **A 组（`FREQ_100_A`）**：`100 Hz`（`R30=0x3a`），`300` 帧（标称 `3000 ms`），`48` 轮 `1:4`（`20.0 Hz`，`10 ms` `VDL` / `40 ms` `VDHR`）+ `180 ms` 末段 `VDHR`。
     - **B 组（`FREQ_200_B`）**：`200 Hz`（`R30=0x39`，`5 ms`/帧），`590` 帧（标称 `2950 ms`），将负脉冲缩窄至 `5 ms` 半宽配 `30~35 ms` `VDHR`（`1:6` ×40 + `1:7` ×25，`25.0~28.6 Hz`）+ `170 ms` 末段 `VDHR`。
   - **验证与构建状态**：`check-firmware-preview.mjs`（75 个源码哈希）、`firmware/tests/red-lab`（19 项单测）以及主机 `-FreqAbStage` / `-WaveAbStage` 回归（`Debug`/`NDEBUG`）均通过；ESP-IDF v6.0.1 目标包已于基于提交 `70eae1e` 的短路径工作区编译并校验通过（`appBytes=1400704`，`appSha256=21c95530b58f36fc1d1ee876a0c51b6dbaa22651f567cd6a90e0aac93ad28568`，`packageVerified=true`，`hardwareFlashed=false`）。
   - **下次继续步骤**：仅刷写 `0x10000` 前核对分区表 SHA-256（`5295e8c4...`）与上一版应用描述符 `0.0.62-red-wave-ab`，待重新取得物理“已按住”确认后写入 `.63` 实测 A/B。

## 2026 年 11 月 15 日家中实测（.57 A / .58）与 .59 待测交接

本轮已将 `.57`（`ScanAB57`）、`.58`（`SingleAB58`）与下一待测候选 `.59`（`GlideAB59`）的完整源码、主机测试及交接说明提交至本分支；原始录像、串口日志及实读 flash 切片留在本地 `.tmpshots/red-lab/`，不入库。

1. **`.57`（`ScanAB57` / `0.0.57-red-scan-ab`，源码已合入本分支）**
   - 2026-11-15 同块 Board1 复测 A 组（`red_PT_SCAN=0 white_PT_SCAN=0`）完整串口日志：开机基准 `16,249 ms`；`SHIFT_RED_TAIL` `refresh=4576 ms`（447 帧）、`WHITE_GLYPHS` `refresh=1855 ms`（179 帧）、`total=7005 ms`（`refresh=6431 ms`，`ESP_OK`）。
   - 本轮 `.57` A 画面未出现横纹（按提示停在 A 未切至 B），但过渡总耗时约 7s、前段黑闪与显红闪烁仍明显。主机 `-ScanAbStage` Debug/NDEBUG 确认 `122,877` SPI 字节且唯一差异位于 `60849` 偏移 `R90` `PT_SCAN`（`00→01`），`1,127` 个故障点通过。

2. **`.58`（`SingleAB58` / `0.0.58-red-single-ab`，已在 Board1 完成实测）**
   - 架构由“显红 + 白字清屏”两遍精简为 **`PT_SCAN=1` 单遍并发 `R22+R24`**（`pass_count=1`），取消整轮 `WHITE_GLYPHS` 及约 30 KB SPI 传输。主机 `-SingleAbStage` 验证 `A=91,872` / `B=91,740` 字节（`polls=234/201`，`PT_SCAN=1` 位于偏移 `60849`，仅 `88` 字节 LUT 差异，`900` 故障点 Debug/NDEBUG 通过）。
   - 仅刷写 `0x10000` 应用分区（`1,400,672` 字节，保留分区表 `5295e8c42d6fb5f95e4e8a185932c6191d27cfc5078322475347e40e71af815a` 与 NVS）。**当前板端运行固件仍为 `0.0.58-red-single-ab`。**
   - 满 180 秒冷却实测结果（`ESP_OK`）：
     - **A 组（`SINGLE_SYNC_A`，447 帧 / 标称 `4.47s`）**：`refresh=4576 ms`，`total=5005 ms`。
     - **B 组（`SINGLE_FAST_B`，380 帧 / 标称 `3.80s`）**：`refresh=3896 ms`，`total=4325 ms`。
   - **光学结论**：A/B 均无横纹、红底均匀、白字清楚、窗外稳定，整体质量明显好于以往版本且 B 优于 A；但总过程（`4.325s`）仍偏长、不够丝滑且存在闪烁。定位主因是 B 前缀仍有两段 `VDH`（`8+6=14` 帧黑脉冲导致起手黑闪）以及尾段长达 `2.80s` 的低占空比抖动平台（`36` 次 `VDL` 反拉 + `36` 帧 `0V`）。

3. **`.59`（`GlideAB59` / `0.0.59-red-glide-ab`，源码与目标包校验通过，尚未刷机）**
   - 保留单遍 `R22+R24`、`PT_SCAN=1` 和 `80×28` 窗口，跳过低效 `1:5` 平台、大幅减少反向抽回并在末尾改用长段无中断 `VDHR` 顺滑推红：
     - **A 组（`GLIDE_SOFT_A`，280 帧 / 标称 `2.80s`）**：36 帧去黑闪前缀（仅单次 4 帧 / `40 ms` `VDH` 微扰，配 `29` `VDL` / `3` `0V`）+ 20 轮递推尾段（`1:1:6`×6、`1:7`×7、`1:9`×4、`1:11`×3）+ 64 帧（`640 ms`）纯 `VDHR` 收尾；`R22` 累计 `218` `VDHR`、`49` `VDL`、`4` `VDH`、`9` `0V`；`R24` 为 `39` 早擦 + `140` 末段连续白字抛光（`179` `VDL`）。
     - **B 组（`GLIDE_ZERO_B`，230 帧 / 标称 `2.30s`）**：26 帧零黑闪白底前缀（`24` `VDL` + `2` `0V`，`0` `VDH`）+ 15 轮高占空比递推（`1:1:5`×5、`1:7`×4、`1:9`×3、`1:11`×2、`1:14`×1）+ 68 帧（`680 ms`）纯 `VDHR` 收尾；`R22` 累计 `184` `VDHR`、`39` `VDL`、`0` `VDH`、`7` `0V`；`R24` 为 `54` 早擦 + `137` 末段连续白字抛光（`191` `VDL`）。
   - 主机检查：`-GlideAbStage` Debug/NDEBUG 通过（`A=91,540` / `B=91,440` 字节，`polls=151/126`，`PT_SCAN=1` 位于 `60849`，仅 `80` 字节 LUT 差异，`817` 故障点）；`-SingleAbStage` 回归及 15 项 Python 单测通过。ESP-IDF v6.0.1 目标包本地编译校验通过（`appBytes=1,400,672`，`appSha256=4640726be2f241de0e7e090e8204cfff7abaa9cd8e4dfff618519809fe4d6c8f`，未刷入）。
   - **主开发机继续测试命令**（短路径构建并只刷 `0x10000`）：
     1. 拉取分支后跑主机测试：`.\firmware\experiments\epd-red-mask-probe\test.ps1 -GlideAbStage -Output .tmpshots/glide59-host`
     2. 构建并校验目标包：`.\firmware\scripts\build-red-lab.ps1 -Profile GlideAB59 -BuildDirectory C:/cp-build/glide59 -Jobs 2` 及 `red-lab-artifact.py check --build C:/cp-build/glide59 --profile GlideAB59`
     3. 按下方仅写应用流程核对旧应用版本确认为 `0.0.58-red-single-ab`（分区表 SHA-256 `5295e8c4...`）并再次取得物理持续按键确认「已按住」后写入 `0x10000`。

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
| `.58-red-single-ab` / SingleAB58 | 单遍 `R22+R24` + `PT_SCAN=1` 验证成功；无横纹、红底均匀、白字清楚；过程偏长且仍有闪烁 | 已并入后续波形基线 |
| `.59`–`.62 B` | `.59`–`.61` 验证 `10~13 Hz` 仍闪/偏黑；`.62 B` 验证 `14.3~16.7 Hz` 高频浅脉冲方向有效（`2976 ms`） | 作为 `.63`–`.67` 调优跳板 |
| `.63-red-freq-ab` / FreqAB63 | A（`100 Hz`）几乎无闪烁但红弱浅；B（`200 Hz` `5 ms VDL`）擦净黑字但未拉起红颜料，失败 | 终止 `200 Hz` 路线 |
| `.64-red-rich-ab` / RichAB64 | A 正红、仅中段略闪；B 无中段闪烁、末段 `1280 ms` 保持略偏黑 | 确认 `100 Hz` 纯红保持方向 |
| `.65-red-smooth-ab` / SmoothAB65 | A/B 均达到低闪烁可用体感；`34~36` 次尾段 `VDL` 使红底略发白发浅 | 减浅尾段反拉进入 `.66` |
| `.66-red-vivid-ab` / VividAB66 | 消除发白发浅，保留低闪、清晰与稳定性；`960 ms` 保持略带微黑 | 中点微调进入 `.67` |
| **`.67-red-crisp-ab` / CrispAB67** | **A（`CRISP_860_A`：`3076 ms`，`32 VDL` + `860 ms`）轻黑、低闪、白字窗外干净；B（`2976 ms`）相近** | **本阶段选定收尾波形，转入正常 CodePulse 实测** |

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
