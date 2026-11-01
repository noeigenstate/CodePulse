# CodePulse firmware / 墨水屏固件

ESP32-S3 firmware for the CodePulse desk terminal. This is a normal directory
in [CodePulse](https://github.com/noeigenstate/CodePulse), not a submodule or
a separately published repository. No old GitLab account is needed to build it.

当前源码 **0.0.29-calendar** 包含工作状态、额度、图片/便签、待办、像素宠物、
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
| 默认构建 | `0.0.29-calendar`，PAIR125、窄窗口关闭、音频关闭 |
| 已有板的可选配置 | `CODEPULSE_QUIET_PAIR150_TRIAL=ON` 与 `CODEPULSE_QUIET_RECT_TRIAL=ON` |
| 音频 | 新板参数未定，默认关闭；禁止驱动的单独编译入口见 `scripts/build-audio-check.ps1` |
| 真实板最新记录 | 2026-10-30 已刷 **0.0.28-desk-region-pair150**，写入校验、开机、Wi-Fi、桌面连接通过 |

0.0.29 尚未在本次迁移中刷入；不能用 0.0.28 的回执证明新字体/日历实机通过。
残影、红色全刷效果和新板音频仍需各自实测。默认构建不等于每块旧板正在使用的
PAIR150/region 配置；更新已有设备时先核对版本、分区和实物板型。

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
