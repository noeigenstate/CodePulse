# 元宝生活卡：0.0.30-life 软件验证

基线 `5de32dc`，采用用户批准的 yb-life-v1 变体 B。本记录只描述工作树中的
软件结果；没有 ESP32 编译/链接、设备访问、刷机、物理显色或残影验收。
没有启动桌面应用，没有读取密钥、`.env`、NVS 或私人配置，也没有发送腾讯请求。

## 实现与契约

- `packages/shared/src/types/life.ts` 定义六种 `life.v=1` 载荷和严格容量校验。
  `normalizeAmbient` 没有新增设置或放宽现有规则。
- `apps/desktop/src/main/ambient-yuanbao.ts` 从真实解析值建立 weather、gold、stock、
  tool、news、holiday 数据；没有实际命令或价格/区间时留空，不补造数据。
  `device-life.ts` 在投影前对所有嵌套字符串执行设备字符集过滤。
- `ambient-rules.ts` 保留原 `text`，把 life JSON 纳入投影 ID/revision；超过
  32,000 字节时先移除整个 life/layout 对，保留可供旧固件显示的文字和纯文本 ID。
- 固件在 `codepulse_protocol.c` 校验版本、类型、UTF-8、字符串/数组容量、数字和日期。
  `life_dashboard.c` 先检查字形覆盖和主数字宽度，再落第一点墨；失败原子回退文本卡。
  未知 layout 的旧路径仍保持 legacy，位图本身的非法数据仍严格拒绝。
- 假日卡统一按中国日期（Asia/Shanghai）计算下一固定公历节日（元旦、劳动节、国庆节）距离，
  不推测国务院放假日期。2026-11-03 到 2027-01-01 为 59 天；午夜更新 ID/天数，
  待发布和已发布卡均在展示时重算，不额外搜索、不延长缓存到期时间。只有官方公告中尚未结束的有效本年度区间才显示放假条，
  元旦允许从上一年 12 月跨到公告年 1 月；往年日期引用不采用。

完整字段、限制、兼容规则见 [设备协议](device-api-v1.md#life-cards-firmware-0030-life)。
固件默认版本和 PAIR150/region 变体已更新，音频/历史实验分支未改。
旧 `0.0.29-calendar` 像素基线和历史技术记录保留，日历的最低支持版本仍为 0.0.29。

## 字体、图标与许可

`firmware/scripts/generate-life-assets.py` 从固定的
`terminus-ter-u32b.bdf.gz` 生成 97 个字形：95 个可打印 ASCII（覆盖受限命令/工具名），
加 degree 和数学减号。没有手填字模、系统字体、灰度阈值或抖动。
原始压缩源 SHA-256：
`9bf7c8feb04601ed162e81f8e73dfccde946374f5dfa85395aaa7bab0cb714b0`。
次级数字原生 32px，主数字仅对该子集做精确整数 2×；中文仍为原生 Noto SC14/16。
现有 14 个语义字库及其 7,752 码点、原生掩码、旧布局像素均保持不变。

37 个图标（14 个 48×48、21 个 16×16、2 个 24×24）逐点复制批准稿 ICONS 对象，
`life-icons.json` 是可读源，头文件采用 2bpp（透明/黑/红/白挖空）。没有黑色描边开关。
Terminus 的版权、源哈希和完整 OFL 随 desktop/HUD 两套 renderer 及 public 许可资源分发；
原 Noto、Unifont、miniz、cJSON 通知保留。

## 与批准 B PNG 的逐像素比较

参考 PNG 位于 `firmware/preview/baselines/life-approved/`，新像素哈希冻结在
`0.0.30-life.json`。比较器同时检查两平面无重叠及十张图的页眉/页脚。
下表红占比的分母为主体 y=31..262，共 92,800 像素。

| 卡片         | 主体不同像素 | 说明                                                | 红像素 | 红占主体 |
| ------------ | -----------: | --------------------------------------------------- | -----: | -------: |
| weather      |            0 | 完全一致                                            |   3782 |   4.075% |
| gold         |            0 | 完全一致                                            |   3784 |   4.078% |
| stock-down   |           89 | 按最终决策：红色图标/交易点改黑                     |      0 |       0% |
| stock-up     |            0 | 完全一致                                            |   3331 |   3.589% |
| stock-closed |           42 | 按最终决策：红色标题图标改黑                        |      0 |       0% |
| tool-codex   |            0 | 完全一致                                            |   1210 |   1.304% |
| tool-claude  |            0 | 完全一致                                            |   1210 |   1.304% |
| news         |            0 | 完全一致；例文明确标为示例                          |   2291 |   2.469% |
| holiday-yes  |         1888 | 审查修复：七格分配余量，右边界到 x387；文字随格居中 |  10917 |  11.764% |
| holiday-none |         4798 | 按最终决策：月份空框换为倒计时和公布提示            |   3794 |   4.088% |

全部未解释主体差异为 **0**；十张图页眉/页脚差异为 **0**。
红色全部在固件绘制，不占桌面传入红位图的 3,072 字节额度。
普通/反色两平面没有黑红同时落墨；进入红色的 120 秒冷却及现有刷新/关断策略未改。
本轮审查成品、差异图和 JSON 位于 `.tmpshots/life-review/pixels/`；原轮资料位于 `.tmpshots/life/preview/life/`、
`.tmpshots/life/sheet.png`。

## ROM/RAM 估算

| 数据                      |      字节 |
| ------------------------- | --------: |
| 2bpp 图标像素             |      9696 |
| 图标描述表（含对齐）      |       148 |
| Terminus 原始位图行       |      6208 |
| Terminus 码点索引         |       388 |
| **新增图标/字形常量合计** | **16440** |

常量直接读取，不为这些资产增加展开堆缓存；共享 Noto atlas 的 578,597 字节不变。
MSVC x64 和 wasm32 都测得 `sizeof(codepulse_life_t)=788`，每份已有 remote snapshot
增加 788 字节；单个运行时快照加解析临时快照的额外状态峰值约 1,576 字节。
UI model 继续借用 ambient，不复制像素或 life 数据；wasm32 model 仍为 2,776 字节。
wasm32 ambient/remote 为 16,580/19,456 字节，x64 为 16,584/19,464 字节。

这些数值不是 ESP32 map：没有计入新增 C 指令、cJSON 临时节点/字符串、分配器和
目标栈高水位。最终 ESP32 flash、分区余量、RAM/PSRAM 峰值需要 ESP-IDF 构建与实测。
同步的 Wasm 为 440,295 字节；它的大小不能当作 ESP32 镜像大小。

## 执行的检查命令与结果

以下从仓库根运行，`<zig>` 为用户指定的 Zig 0.13.0；原轮日志在 `.tmpshots/life/`，
审查修复后的复验日志在 `.tmpshots/life-review/`，逐项记录见
[审查修复报告](YUANBAO-LIFE-REVIEW-2026-11-03.md)。
`-Output` 将既有 host/preview 脚本的所有中间文件也放入对应目录。

| 命令                                                                                                          | 结果                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `python firmware/scripts/generate-life-assets.py` / `--check`                                                 | 固定 BDF、97 字形及 37 图标通过                                                                                      |
| `node firmware/preview/make-life-fixtures.mjs --write` / `--check`                                            | 十份合成样例通过                                                                                                     |
| `powershell -File scripts/sync-device-preview.ps1 -Zig <zig> -Python python`                                  | 两套 Wasm/base64/manifest/许可同步；未启动应用                                                                       |
| `node scripts/check-firmware-preview.mjs` / `--require-components`                                            | 63 个源码哈希、二进制、两套资产及 public 通知通过                                                                    |
| `python firmware/tests/test_bitmap_fonts.py`                                                                  | 14×7752 原字形、掩码/metrics、delta24、原许可通过                                                                    |
| `python firmware/tests/test_bitmap_fonts.py .tmpshots/life/quiet/display-font-cells.pgm`                      | 另验证九行 native C 字形标本逐像素一致                                                                               |
| `python firmware/tests/test_life_assets.py`                                                                   | 3 项独立 BDF 行、图标像素、确定性生成测试通过                                                                        |
| `powershell -File firmware/scripts/test-host.ps1 -Output .tmpshots/life/host`                                 | 旧 36 layout、68 red、199 calendar 用例通过；life 116（105 文本回退）通过                                            |
| `powershell -File firmware/scripts/test-quiet.ps1 -Output .tmpshots/life/quiet`                               | 四组驱动/生命周期模型，字体、红色、宠物、日历、pacing，以及普通/NDEBUG life 渲染通过                                 |
| `powershell -File firmware/scripts/test-audio.ps1 -Output .tmpshots/life/audio`                               | 纯 host 引脚冲突检查及 audio-disabled 无驱动依赖检查通过                                                             |
| `powershell -File firmware/scripts/test-preview.ps1 -Zig <zig> -Python python -Output .tmpshots/life/preview` | 132 native/Wasm 用例、400+400 重复渲染通过；旧 65 BW+11 red 双平面基线不变；life 236（215 回退）及十图双平面对照通过 |
| `node firmware/preview/test-life.mjs <wasm> <native> <output>`（上一脚本调用）                                | 畸形/缺字/超宽、反色、交替有效/无效数据、位图验证不被绕过通过                                                        |
| `node firmware/preview/render-life.mjs <wasm> <output> <native>`（上一脚本调用）                              | 十图真实 native/Wasm 双平面一致、无颜料重叠                                                                          |
| `python firmware/preview/check-life.py <output>`                                                              | 批准 B PNG 与冻结像素基线通过；初次曾用 `--record` 建立新基线，没有更新旧基线                                        |
| Zig `cc -target wasm32-wasi -S -emit-llvm` 类型大小探针                                                       | 仅 wasm32 ABI 常量测量，上述结构/常量表尺寸通过；不是 ESP32 构建                                                     |
| `pnpm typecheck`                                                                                              | workspace 与测试类型检查通过                                                                                         |
| `pnpm lint`                                                                                                   | Prettier 全量检查通过                                                                                                |
| `node tests/run-tests.mjs`                                                                                    | **1009/1009**，含原轮 17 项 life 测试和本次新增 8 项审查回归；倒计时统一中国日期                                     |
| `pnpm build`                                                                                                  | packages、HUD 和 desktop 生产构建通过                                                                                |

首次同步发现 Windows PowerShell 参数默认值阶段 `$PSScriptRoot` 为空，已把默认
firmware 路径解析移到脚本体；manifest 输出也固定 LF，使同步后直接通过 lint。
首次类型检查的测试未用 import 和同步 JSON 的 CRLF 格式问题均已修正并重跑通过。
生产构建仍有 renderer 分块大于 500 kB 的 Vite 提示，退出码为 0。

Node SQLite ABI 137 的原二进制 SHA-256 在检查前后完全一致；未运行 `pnpm test`
或 Electron 重建。没有 ESP-IDF、ESP32 编译/链接、分区 map、烧录、设备访问、
光学/残影/真实刷新时间验收，也没有 git 提交或发布。
