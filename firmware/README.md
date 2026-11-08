> **减闪临时分支**：开始前读 [跨电脑交接](doc/RED-REFRESH-HANDOFF.md)。
> `.50` 减闪但黑色占优；`.51` 用户反馈无改善，见[实验记录](doc/RED-STAGGER-LAB-2026-11-08.md)。当前停止硬件试验，只复核已有证据，不继续构建下一候选。
> 使用 `scripts/build-red-lab.ps1` 明确选择 Stagger51 / Neutral50 / Split49 / Tail48 / Fast47 / Color46 / Erase43 / Production33。
> 本分支保留默认关闭的实验入口；构建、实机刷写和光学验收互不等价。

家中本轮交接入口：[精确源码与复放](experiments/red-lab-handoff/2026-11-08/README.md)、[逐版实测](doc/RED-REFRESH-RESULTS-2026-11-08.md)、[审计与条件方案](doc/RED-REFRESH-AUDIT-2026-11-08.md)。后续方案尚未进入构建或实机阶段；主开发机已有已验证OTP，本次不补采或上传。

# CodePulse firmware / 墨水屏固件

ESP32-S3 firmware for the CodePulse desk terminal. This is a normal directory
in [CodePulse](https://github.com/noeigenstate/CodePulse), not a submodule or
a separately published repository. No old GitLab account is needed to build it.

当前源码 **0.0.33-status** 使用原生正格/Fusion/Terminus 像素字形及原生大数字，包含结构化元宝生活卡、概念卡/思考实验/科技热议排版（原生 32px 中文大字）、三色任务列表、工作状态、额度、图片/便签、待办、像素宠物、
日历与原生单色字体。首次入库完整保留驱动、生产 C 渲染器、字体源、实验和测试的
目录结构，不改变 GPIO、协议语义或刷新策略。[迁移来源](../docs/FIRMWARE-IMPORT.md)。

## 快速开始

从仓库根目录进入 `firmware`。桌面端仍在根目录执行 `pnpm build` / `pnpm start`，
不需要安装 ESP-IDF；固件构建不需要安装桌面 Node 依赖。

Windows / PowerShell（Python 3.10+，ESP-IDF **6.0.1**）：

```powershell
cd firmware
.\scripts\setup.ps1 -Python python
.\scripts\build.ps1
.\scripts\test-host.ps1
.\scripts\test-quiet.ps1
.\scripts\test-audio.ps1
python tests/test_bitmap_fonts.py
```

`setup.ps1` 将工具放在仓库根目录忽略的 `.toolchains/`。已有 SDK 可通过
`CODEPULSE_IDF_PATH`、`CODEPULSE_IDF_TOOLS_PATH`、`CODEPULSE_IDF_PYTHON_ENV_PATH`
显式指定，脚本校验 6.0.1，不会切换或升级系统中其他 ESP-IDF。

Linux / macOS：先按 ESP-IDF 的安装方式激活 **6.0.1**，然后：

```sh
cd firmware
idf.py build
python tests/test_bitmap_fonts.py
```

现有 `scripts/build.sh`、`monitor.sh`、`flash.sh` 等入口保留。设备连接、供电和
刷写前置条件见[开发说明](doc/DEVELOPMENT.md)，CI 和源码检查从不自动刷机。

## 构建版本与硬件

| 项目 | 当前约定 |
| --- | --- |
| 已有板 | Board1，ESP32-S3-WROOM-1-N16R8，16 MiB flash / 8 MiB octal PSRAM |
| 屏幕 | legacy WFT0420CZ15，400×300 黑/白/红 |
| 默认构建 | `0.0.33-status`，PAIR125、窄窗口关闭、音频关闭 |
| 已有板的可选配置 | `CODEPULSE_QUIET_PAIR150_TRIAL=ON` 与 `CODEPULSE_QUIET_RECT_TRIAL=ON` |
| 音频 | 新板参数未定，默认关闭；禁止驱动的单独编译入口见 `scripts/build-audio-check.ps1` |
| 真实板最新记录 | 2026-11-05 **0.0.33-status-region-pair150** 已仅刷应用并校验；正常开机、USB/LAN 身份、Wi-Fi 与桌面连接通过；光学状态切换和红色性能另行验收 |

0.0.33-status 新增本地连接新鲜度提示：断线持续超过 3 秒，工作卡显示“离线”，
保留任务名称；同一份状态重连也会恢复实时标签。此提示不修改主机任务状态、
清理周期或注意力优先级。未知传感器的桌面预览仍显示目标任务状态。
2026-11-05 已完成 ESP-IDF 6.0.1 编译/分区尺寸检查、协议与离线恢复检查、
native/Wasm 像素一致性；随后已刷写并核对实际运行身份，光学残影和状态切换仍待目视验收。
原生字体、完整回退清单与预算见 [fonts README](fonts/README.md)。
[life 布局与逐卡软件验证记录](../docs/YUANBAO-LIFE-2026-11-03.md)包含协议、像素差异、许可及内存估算。
残影、红色全刷效果和新板音频仍需各自实测。默认构建不等于每块旧板正在使用的
PAIR150/region 配置；更新已有设备时先核对版本、分区和实物板型。

## 红色局部刷新实验

当前默认关闭的 [0.0.42 逐像素候选](doc/RED-MASK-LAB-2026-11-06.md)改为由前后帧
生成驱动掩码：保持未变化像素，分别执行擦白、写黑或显红，取消共同反向循环。
0.0.41 实测仍残红且闪烁严重，已停止第二步；新方案尚无实机结论。


此前测试的默认关闭 [0.0.41 长脉冲候选](doc/RED-HOLD-LAB-2026-11-06.md)：
保留小窗口和少翻转，恢复此前清晰版本的累计驱动时长。
0.0.40 第一步闪烁已被用户接受，但擦除及黑字失败，第二步停止；
不能将局部减闪作为完整功能通过。0.0.41 同样未通过。


前一减闪候选为默认关闭的 [0.0.40 小红色标签实验](doc/RED-BADGE-LAB-2026-11-06.md)：
减少共同翻转轮次，缩小驱动窗口；仍测试实际红色擦除与出现。
此前 [0.0.39 五表实验](doc/RED-LUT5-LAB-2026-11-05.md)颜色/带外单次表现通过，
但用户判定闪烁严重，未达到低闪目标。各版本结果以对应记录为准，
不能把下列历史的 0.0.33 正常应用记录当作当前设备正在运行的实验版本。


默认关闭的[红色诊断](experiments/epd-red-region-probe/README.md)中，0.0.34 与
0.0.36 均在第二次红色擦除后出现带外褪色，未通过实机验收。0.0.36 的保留状态和
完整双层 RAM 未解决问题，实验已停止；见[完整记录](doc/RED-CHANGE-LAB-2026-11-05.md)。
0.0.35 固定红色的黑白对照仅为诊断证据，不作为红色变化功能交付。正式 0.0.33
策略和两套预览保持原样。已只写应用恢复日常 0.0.33，写后校验通过且用户
确认正常画面；遵照用户要求，恢复后未再次进行联网检查。

继续开发的 [0.0.37 寄存器三色候选](doc/RED-LUT-LAB-2026-11-05.md)直接修改
红色波形加载路径：保留面板校准，明确颜色编码与时钟，比较完整表和减少重复
的表，均实际改变红色。默认关闭，离线检查通过；目标构建/实物结论见该记录。

## 工作语音候选 / Work voice candidate

音频构建已加入共享工作状态的播报接收通道，桌面与墨水屏可独立控制。
主机在本地合成 PCM，固件领取短期 ID、播放并确认，不需要麦克风或助手云语音密钥。
新板音频仍需核对 GPIO；Board1 默认关闭，禁止将非驱动编译验证包当成可刷的升级包。
本次未增加运行版本号、未刷机；见[两端语音与状态](../docs/WORK-VOICE-AND-STATES.md)
及[交接记录](../docs/WORK-VOICE-DEVICE-HANDOFF.md)。

## 目录

- `main/`：板级驱动、设备客户端、USB、生产渲染器和刷新策略。
- `fonts/`：固定字体源、栅格掩码、生成来源和逐份许可证。
- `preview/`：同一 C 渲染器的 Wasm/native 入口、合成样例和像素基线。
- `tests/`：协议、渲染、刷新、音频引脚和字体回归。
- `scripts/`：构建、生成、探测和显式刷写入口。
- `experiments/`：独立面板实验，不能与日常固件配置混用。
- `tools/home-station/`：通用的受控刷机/诊断工具源码；不包含私人家庭交接包。
- `doc/`：当前开发/板级说明，以及明确标注日期的技术记录。

## 预览、协议与贡献

根目录执行 `node scripts/check-firmware-preview.mjs` 可离线核对仓内源码与两套
已提交的 400×300 预览。需要更新预览时，先配置锁定依赖，再执行：

```powershell
.\scripts\sync-device-preview.ps1 -Zig <Zig-0.13.0路径> -Python <python路径>
```

上述命令从**仓库根目录**运行，默认读取本目录，同时更新桌面/HUD 与字体许可。
更完整的 native/Wasm 检查见[开发说明](doc/DEVELOPMENT.md)。

同一改动中的协议、固件和生成预览可以在同一个 PR 中审查；共享任务逻辑仍在
桌面 packages，不在固件另造一套。见[仓库协作](../docs/REPOSITORY.md)和
[设备 API](../docs/device-api-v1.md)。PCB、BOM 和结构件由硬件贡献者另行上传至
[hardware](../hardware/README.md)，本次不导入旧硬件附件。

## 许可

项目原创固件代码沿用根目录 [MIT](../LICENSE)。字体保留其独立 OFL 等许可证，
不因合仓改成 MIT。miniz、ESP-IDF/组件和 Xiaozhi/LumaDesk 音频来源分别见
[第三方说明](THIRD-PARTY-NOTICES.md)。历史技术文档不等于当前硬件验收结论。

0.0.43 默认关闭的退红后写黑字实验及验收边界见 [RED-BLACK-LAB](doc/RED-BLACK-LAB-2026-11-06.md)；不改变生产默认，未取得实机通过结论。

0.0.44 默认关闭的单步显红候选见 [RED-COLOR-LAB](doc/RED-COLOR-LAB-2026-11-06.md)；从 READY 开始，不要求重复已通过的退红测试，未取得实机显红通过结论。
