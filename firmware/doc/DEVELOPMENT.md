# 固件开发与验证

2026-11-01 起以 CodePulse 根仓库的 `firmware/` 为唯一固件源码入口。
根目录 `AGENTS.md` 与 `docs/REPOSITORY.md` 定义分支和文件归属；不再对旧固件
仓库直接提交 main。2026-11-02 用户确认保留根产品 main 的 PR 保护：
固件与产品共用分支，经所需检查/审查后由 PR 合入；不直接推 main 或绕过保护。
代码推送不授权发布固件镜像或自动刷机。旧机器目录、家庭包与 GitLab 操作说明仅保留本机溯源。

## 环境和构建

SDK 固定 ESP-IDF 6.0.1 / esp32s3，依赖由 `dependencies.lock` 锁定。
Windows 先用 `scripts/setup.ps1` 或显式设置三个 `CODEPULSE_IDF_*` 路径。
所有命令在 `firmware/` 运行，除非另有说明。

```powershell
.\scripts\build.ps1
.\scripts\test-host.ps1
.\scripts\test-quiet.ps1
.\scripts\test-audio.ps1
python tests/test_bitmap_fonts.py
python -m unittest discover -s tools/home-station -p "test_*.py"
```

测试脚本会在本进程初始化 MSVC，不操作实体设备。默认构建在 `build/`，
host/preview 测试使用各自忽略的 `build-*`；依赖在 `managed_components/`。
不将编译结果、toolchain、NVS、个人 Wi-Fi 或设备身份入库。

PAIR150/region 是明确的可选配置，不能通过文件夹旧名字判断镜像版本：

```powershell
. .\scripts\idf-env.ps1
& $IdfPython "$env:IDF_PATH/tools/idf.py" -C $FirmwareRoot -B "$FirmwareRoot/build-region-pair150" `
  -D CODEPULSE_QUIET_PAIR150_TRIAL=ON -D CODEPULSE_QUIET_RECT_TRIAL=ON build
```

可选音频仅做非驱动编译：`.\scripts\build-audio-check.ps1`。它使用独立 SDKCONFIG
和 2 MiB 应用分区，禁止初始化音频 GPIO；**不要刷到现有 Board1**。正式新板必须
核对功放、麦克风、供电及所有 GPIO，再另建明确硬件配置。

## 同源桌面预览

在仓库根目录运行 `node scripts/check-firmware-preview.mjs`，核对所有仓内
manifest 源文件及两套资产。此检查无需 pnpm install、ESP-IDF 或串口。
`--require-components` 额外严格检查已配置的锁定 cJSON，缺少依赖会清楚报错。

```powershell
# firmware/ 内；Node + Zig 0.13.0 + MSVC + 已配置的锁定 cJSON
.\scripts\test-preview.ps1 -Zig <Zig路径> -Python <python路径>
# 仓库根目录；仅当渲染器确有改动时更新已提交资产
.\scripts\sync-device-preview.ps1 -Zig <Zig路径> -Python <python路径>
```

native/Wasm 检查包含日历与旧卡片像素基线；不要用 `-UpdateBaseline` 掩盖意外
差异。字体生成需要时再进行，正常构建直接使用已提交 atlas；源字形生成与许可
见 `fonts/README.md`。字体日历词表从仓库根目录只读校验：

```sh
node --experimental-strip-types firmware/scripts/generate-calendar-font-charset.mjs --module apps/desktop/src/main/calendar --check
```

上一命令使用支持 `node:module registerHooks` 的 Node 22.15+。根桌面构建仍只
使用已提交 Wasm，不要求固件 SDK。预览目标像素不能证明残影或物理刷屏完成。

## 探测和刷写

`scripts/probe.ps1 -List` 只枚举；`scripts/probe.ps1 -Port COMx` 只发 hello/getStatus，
不配网、不复位。避免客户端 USB 扫描与串口观察同时打开同一个端口。
正常配网由 CodePulse 的设备连接界面完成，token 和密码不得进 URL 或日志。

刷写需单独授权，并在操作当次确认持续按住功能/电源键；不按 BOOT。
核对 ESP32-S3 芯片身份、应用版本、真实分区、镜像 SHA256 和目标偏移。
已有设备升级优先只写 `0x10000` 应用区，保留 NVS、bootloader 和分区；不要盲用
`scripts/flash.ps1`，该脚本是**完整初次部署**入口，会写 bootloader/分区/应用。
旧 `flash-quiet.ps1` 依赖私人 0.0.9 包，已禁用，不能用于新版。

使用本机 ESP-IDF 环境的 esptool，保持 115200、刷前 usb-reset、刷后 no-reset；
应用写入边界必须符合实读分区。复位时 GPIO9 可能失去保持，所以全程按住供电键。
写入校验后完全松开掉电，再按约 3 秒正常开机。禁止 USB 与 H2 3V3 同时供电。

分别记录：构建通过、写入/哈希通过、实时固件身份、正常开机、Wi-Fi/桌面连接、
首刷完成、肉眼观感。CI 不连接硬件；2026-10-30 的 0.0.28 只确认到联网，未捕获
clean-baseline 完成事件，0.0.29 本次不刷写。不得把不同版本的回执混用。

## 发布与版本

提交属于根 Git 历史。当前产品目标为 `codex/unified-product`；没有新的明确
授权不合并 `main`。固件版本留在 `CMakeLists.txt`，桌面版本留在 package.json。
如以后发布固件使用 `firmware-v*` tag，避免触发桌面 `v*` 安装包发布工作流。
产物清单写根提交、固件版本、板型/PCB revision、分区、配置和 SHA256，
构建产物作为明确审核过的附件发布，不把 build 目录提交到源码。
