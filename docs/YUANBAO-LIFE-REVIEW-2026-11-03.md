# yb-life 审查修复与复验

基于 `5de32dc` 上原有的 74 个未提交变更继续修复，保留原实现。以下命令均在同一
`codex/yb-core` 工作树执行；日志和中间产物位于 `.tmpshots/life-review/`。
未做 ESP32 编译/链接，未连接设备、烧录或启动桌面应用，也未提交 Git。

## 十项审查结果

| 项  | 修复                                                                                                                            | 验证                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | 新增 C 的条件/循环使用花括号，控制体及后续语句分行；扫描 life 渲染器、新结构、协议/字形新增区域和 host/quiet 测试               | 七个翻译单元经 Zig Clang `-std=c11 -Wall -Wextra -Werror -Wmisleading-indentation -c` 通过；host/quiet/preview 全通过 |
| 2   | `present()` 对已发布卡片也重新计算倒计时；更新已有文字中的倒计时，保留公告区间、原缓存和到期时间；life 变化进入设备 ID/revision | 新增 `review 2` 两项：跨中国午夜天数/文字和 ID/revision 更新，跨元旦切换下一固定节日                                  |
| 3   | 低/高价直接绘制经过校验的原字符串，仅游标位置用浮点计算                                                                         | C `gauge_precision` 对 `0.385`、`375.200` 的文字区域逐像素比较                                                        |
| 4   | 公告依原顺序选取结束日期不早于中国当天的首个有效区间；全过期则省略 range                                                        | `review 4` 覆盖元旦结束当日、次日跳到春节、再跳劳动节和全部过期                                                       |
| 5   | 监测年份、倒计时、待发布卡 ID 统一使用既有 Asia/Shanghai 日期来源                                                               | `review 5` 覆盖中国午夜与监测截止，在 UTC、上海、纽约、檀香山宿主时区下结果相同；原倒计时子进程测试同步更新           |
| 6   | 盘前/盘后映射 `unknown`，保留原文字状态，不显示休市徽章                                                                         | `review 6` 检查两种真实 fixture 的状态替换                                                                            |
| 7   | 工具 source/title 先实体解码和字形过滤，再按码点限长，截断带 `…`；不支持的来源仅清空该字段                                      | `review 7` 检查 HTML、实体、全角字符、长字段、emoji 来源及 structured card 保留                                       |
| 8   | 湿度数值规范化后移除一个末尾 `%`，文字只追加一次百分号                                                                          | 两项 `review 8` 覆盖 `32%` 与 `３２％`；life 保持有效，旧文字无 `%%`                                                  |
| 9   | 省略号预留完整 3 字节和 NUL，前缀在 UTF-8 码点边界截断，小容量不输出半个省略号                                                  | C `ellipsis_tests` 遍历 0–385 共 386 个容量，检查界限、UTF-8、完整后缀及 NUL；普通和 NDEBUG 均通过                    |
| 10  | 七格按 352px 净宽分配余量，宽度为 50/50/50/51/50/50/51，保持 4px 间隙，最后到 x387                                              | C `holiday_bar` 检查各边界及右侧 66 行；独立批准图变换精确验证格宽和文字居中；仅更新 holiday-yes 基线项               |

新增 Node 测试位于 `tests/yuanbao-life-review.test.ts`，8 项；与原 life 测试合跑
25/25。新 C 测试位于 `firmware/tests/quiet/test_life_text.c`，接入既有 quiet 脚本，
普通及 NDEBUG 各跑一遍。

## 本次修改文件

- 桌面核心：`apps/desktop/src/main/ambient-yuanbao.ts`、`ambient-yuanbao-service.ts`。
- 固件：`firmware/main/life_dashboard.c`、`codepulse_life.h`、`codepulse_protocol.c`、
  `display_text.c`、`quiet_dashboard.c`；后四处仅涉及原轮新增的 life 区域或结构。
- 测试与基线：`tests/yuanbao-life-review.test.ts`、`tests/yuanbao-life.test.ts`、
  `firmware/tests/host/test_life.c`、`firmware/tests/quiet/test_life.c`、
  `firmware/tests/quiet/test_life_text.c`、`firmware/scripts/test-quiet.ps1`、
  `firmware/preview/check-life.py`、`firmware/preview/baselines/0.0.30-life.json`。
- 生成资产：desktop 和 HUD 各自的 `src/renderer/src/device-preview/` 下
  `renderer.wasm`、`renderer.b64`、`manifest.json`，两套逐字节相同。
- 文档：`docs/device-api-v1.md`、`docs/YUANBAO-LIFE-2026-11-03.md`、本报告。
- 临时检查脚本、编译对象、日志和报告均在 `.tmpshots/life-review/`；完整哈希审计见 `audit.json`。

## 命令及结果

`<zig>` 为用户指定的 Zig 0.13.0 路径；未调用 ESP-IDF 或 GCC。

| 命令                                                                                                                 | 结果                                                                                                    | 日志                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `powershell -File scripts/sync-device-preview.ps1 -Zig <zig> -Python python`                                         | 通过；Wasm 440,295 字节，两套预览同步                                                                   | `sync.log`                     |
| `node scripts/check-firmware-preview.mjs` 和 `--require-components`                                                  | 通过；63 个源码哈希、组件哈希、预览二进制/许可一致                                                      | `integrity.log`                |
| `python firmware/tests/test_bitmap_fonts.py`                                                                         | 通过；14×7752 码点原生字形/掩码/metrics 与许可                                                          | `fonts.log`                    |
| `python firmware/tests/test_bitmap_fonts.py .tmpshots/life-review/quiet/display-font-cells.pgm`                      | 通过；九行 C 字形标本逐像素一致                                                                         | `font-specimen.log`            |
| `python firmware/scripts/generate-life-assets.py --check`                                                            | 通过；固定 BDF、97 字形、37 图标无漂移                                                                  | 标准输出                       |
| `node firmware/preview/make-life-fixtures.mjs --check`                                                               | 通过；十份样例保持原值                                                                                  | 标准输出                       |
| `python firmware/tests/test_life_assets.py`                                                                          | 3/3 通过；独立字形、图标与确定性生成检查                                                                | `assets-tests.log`             |
| `powershell -File firmware/scripts/test-host.ps1 -Output .tmpshots/life-review/host`                                 | 通过；旧 36 layout、68 red、199 calendar；life 116（105 回退）                                          | `host.log`                     |
| `powershell -File firmware/scripts/test-quiet.ps1 -Output .tmpshots/life-review/quiet`                               | 通过；驱动/生命周期/字形/日历/红色/pacing，life 及新增测试的普通和 NDEBUG 两种构建                      | `quiet.log`                    |
| `powershell -File firmware/scripts/test-audio.ps1 -Output .tmpshots/life-review/audio`                               | 通过；host 引脚与 audio-disabled 检查                                                                   | `audio.log`                    |
| `powershell -File firmware/scripts/test-preview.ps1 -Zig <zig> -Python python -Output .tmpshots/life-review/preview` | 通过；132 native/Wasm、400+400 重复；旧 65 黑白+11 红色基线不变；life 236（215 回退）及十卡双平面一致   | `preview.log`                  |
| `python firmware/preview/check-life.py .tmpshots/life-review/pixels --update-holiday-bar`                            | 通过；严格限制只更新 holiday-yes，其他九项不变                                                          | `pixels.log`                   |
| `python firmware/preview/check-life.py .tmpshots/life-review/preview/life`                                           | 通过；精确参考变换与冻结基线双重检查                                                                    | `preview.log` 中由测试脚本调用 |
| Zig `cc -target wasm32-wasi -std=c11 -Wall -Wextra -Werror -Wmisleading-indentation -c`，七个生产/测试翻译单元       | 全部通过；真实对象编译，不只是语法解析                                                                  | `clang.log`                    |
| `pnpm typecheck`                                                                                                     | 全 workspace 及测试通过                                                                                 | `types.log`                    |
| `pnpm lint`                                                                                                          | 全量 Prettier 检查通过                                                                                  | `lint.log`                     |
| `node tests/run-tests.mjs`                                                                                           | **1009/1009**，0 失败、0 跳过                                                                           | `node-tests.log`               |
| `pnpm build`                                                                                                         | packages、HUD、desktop 生产构建通过；仍有既有 Vite 500kB 分块提示                                       | `build.log`                    |
| `node .tmpshots/life-review/audit.mjs`                                                                               | 原 74 文件保留、变更均在允许目录、双份资产一致；Node ABI 137 和原 SQLite SHA-256 不变，内存数据库可打开 | `audit.json`                   |

## 原批准 PNG 的逐卡差异

主体为 y31–262，共 92,800 像素；下表是对原批准 PNG 的原始差异，没有将其置零。
所有卡片的未解释主体差异、页眉页脚差异均为 0，黑红平面没有同时落墨。

| 卡片         | 原 PNG 差异像素 |    红像素 |    红占主体 |
| ------------ | --------------: | --------: | ----------: |
| weather      |               0 |      3782 |      4.075% |
| gold         |               0 |      3784 |      4.078% |
| stock-down   |              89 |         0 |          0% |
| stock-up     |               0 |      3331 |      3.589% |
| stock-closed |              42 |         0 |          0% |
| tool-codex   |               0 |      1210 |      1.304% |
| tool-claude  |               0 |      1210 |      1.304% |
| news         |               0 |      2291 |      2.469% |
| holiday-yes  |        **1888** | **10917** | **11.764%** |
| holiday-none |            4798 |      3794 |      4.088% |

holiday-yes 的 1888 像素来自七格宽度/位置及文字居中调整，参考变换只移动原图中的
字形像素并重建格框，不放宽整个矩形的比较。下跌/休市股票改黑，以及未发布假日
改为倒计时是原轮已经批准的差异。原批准 PNG、十份 fixture、旧 0.0.29 基线均未修改。

图标和字形常量仍为 16,440 字节，`codepulse_life_t` 仍为 788 字节，本轮未增加结构字段。
缺少 ESP-IDF，故没有 ESP32 编译/链接、目标 map、栈/RAM 峰值或真机显示验证；
Clang 严格编译与 host/Wasm 结果不能替代这些目标验证。
