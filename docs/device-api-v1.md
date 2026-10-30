# CodePulse 局域网设备协议 v1

## 设备显示投影

统一宿主为桌面配置预览和 LAN API 提供同一个 projector。每个原生用户任务有
稳定编号；标题优先用会话名称，回退到工作区。明确识别的内部建议／审核会话
不进入任务生命周期；普通用户任务、用户 fork 和同项目的多个任务仍独立保留。

顺序沿用 HUD：Claude → Codex → Kimi → Grok；设备目前支持
Claude、Codex 及 Grok，尚不支持 Kimi。项目相邻，组内 provider 优先、同级先到
先得。version 2 顺序记录以哈希绑定会话首次确定的项目组；瞬时 cwd、标题、
状态和活动时间不触发重排。该规则只影响设备投影，不修改 StatusHub 的工作目录。

显示配置包含 HUD／用量模式、账号筛选、剩余／已用、环境与额度显示、页码。
设置中的草稿先预览，应用配置后原子保存并唤醒等待请求。预览是最新目标画面，
不是物理屏幕当前画面的回执。设备遥测不回传；未知环境信息不得伪造。
3／6／9 任务样例只在 renderer 使用，不能写入共享状态或应用到设备。

三行及 1／2／3 列规则、两行长标题省略和独立待确认区域由共用 C/Wasm 渲染器
实现。密集卡片优先标题，隐藏状态细节，底部持续显示账号额度。
当前运行时是黑白差分路径，未实现静态红色或三色低闪的受支持配置。

## 1. 启用服务

局域网服务默认关闭，避免 CodePulse 未经用户同意监听外部网卡。启用后默认监听
`0.0.0.0:17889`，原有 Hook API 仍只监听 `127.0.0.1:17888`。

| 环境变量                          | 默认值    | 说明                              |
| --------------------------------- | --------- | --------------------------------- |
| `CODEPULSE_DEVICE_SERVER_ENABLED` | `false`   | `1`、`true`、`yes` 或 `on` 时启用 |
| `CODEPULSE_DEVICE_SERVER_HOST`    | `0.0.0.0` | 监听地址                          |
| `CODEPULSE_DEVICE_SERVER_PORT`    | `17889`   | TCP 端口，范围 1–65535            |
| `CODEPULSE_DEVICE_TOKEN`          | 自动生成  | 可选的设备密钥，至少 16 个字符    |

未显式设置 token 时，桌面端首次启动服务会生成 32 字节随机密钥，保存到：

- macOS / Linux：`~/.codepulse/device-auth`
- Windows：`%USERPROFILE%\.codepulse\device-auth`

开发环境可以这样启动：

```bash
CODEPULSE_DEVICE_SERVER_ENABLED=1 pnpm dev
```

macOS 安装版从 Finder 启动时不会读取 shell 配置，可先完全退出托盘中的 CodePulse，
然后执行：

```bash
launchctl setenv CODEPULSE_DEVICE_SERVER_ENABLED 1
open -a CodePulse
```

如需恢复默认关闭状态：

```bash
launchctl unsetenv CODEPULSE_DEVICE_SERVER_ENABLED
```

启用后还会创建固定配对身份：

- `~/.codepulse/device-server-id`：首次生成 UUID，后续启动保持不变；
- `~/.codepulse/device-auth`：独立设备 token，不复用 `17888` Hook API 的鉴权；
- `_codepulse._tcp.local`：端口为实际设备 API 端口，TXT 仅包含
  `pv=1`、`id=<serverId>`、`path=/api/v1/device/status`。

mDNS 发布失败不会关闭 HTTP 服务，固件仍可使用 USB 配入的后备 IP 和端口。

### 1.1 App 内 USB 配网

打开“设置 → 水墨屏配网”后，Electron main process 每 2 秒枚举一次 USB CDC 串口，
并用 `CP1 hello` 确认设备身份。选择设备、输入 Wi-Fi 后，main process 会读取设备
token，发送 `provision`，再以 750 ms 间隔轮询 `getStatus`（总超时 60 秒）。只有固件
返回 `ready`，且 `provisioned`、`wifiConnected`、`desktopReachable` 均为真时，界面
才显示配网成功。

固件联网后，App 浏览 `_codepulse-dsp._tcp.local`，请求
`http://<display-ip>:17890/api/v1/device/health`，并核对 TXT `id` 与响应中的
`deviceId`。串口只在 Electron main process 打开；Wi-Fi 密码和设备 token 不进入
renderer 快照、持久化存储或日志。

## 2. HTTP 接口

| 方法  | 路径                    | 认证 | 说明               |
| ----- | ----------------------- | ---- | ------------------ |
| `GET` | `/api/v1/device/health` | 否   | 服务与协议版本探针 |
| `GET` | `/api/v1/device/status` | 是   | 当前展示数据       |

状态请求必须使用以下任一请求头；不接受 query string 中的 token：

```http
X-CodePulse-Device-Token: <device-token>
```

或：

```http
Authorization: Bearer <device-token>
```

验证示例（把主机地址换成电脑的局域网 IPv4）：

```bash
TOKEN="$(tr -d '\r\n' < ~/.codepulse/device-auth)"
curl http://192.168.1.20:17889/api/v1/device/health
curl -H "X-CodePulse-Device-Token: $TOKEN" \
  http://192.168.1.20:17889/api/v1/device/status
```

电脑防火墙必须允许 CodePulse 接收入站连接，且电脑与 ESP32 需要位于可互访的同一局域网。

## 3. 状态响应

响应编码为 UTF-8 JSON。字段始终存在；无数据使用 `null` 或空数组，不要求 ESP32
推断缺失字段。

```json
{
  "protocolVersion": 1,
  "mainState": "running",
  "activeAgent": "codex",
  "message": "运行 pnpm test",
  "agents": [
    {
      "type": "codex",
      "state": "tool_running",
      "project": "desktop",
      "model": "gpt-5.4",
      "activity": "运行 pnpm test",
      "needsAttention": false,
      "tokens": {
        "input": 1200,
        "cachedInput": 800,
        "output": 240,
        "reasoningOutput": null,
        "total": 1440,
        "contextUsedPercent": 38.5,
        "contextWindow": 258400,
        "contextStale": false,
        "contextCompressed": false,
        "accuracy": "exact"
      },
      "quotas": [
        {
          "id": "codex",
          "name": "Codex",
          "fiveHour": {
            "usedPercent": 23,
            "resetsAt": 1784066400,
            "windowMinutes": 300
          },
          "weekly": {
            "usedPercent": 41,
            "resetsAt": 1784498400,
            "windowMinutes": 10080
          }
        }
      ],
      "updatedAt": 1784062200123
    }
  ],
  "updatedAt": 1784062200123,
  "revision": "v1-5db1f203"
}
```

### 顶层字段

| 字段              | 说明                                                        |
| ----------------- | ----------------------------------------------------------- |
| `protocolVersion` | 当前固定为 `1`                                              |
| `revision`        | 展示相关内容的稳定指纹；只有时间戳变化时保持不变            |
| `mainState`       | 整体状态，见下方枚举                                        |
| `activeAgent`     | `codex`、`claude_code`、`grok` 或 `null`                    |
| `message`         | 最值得展示的短消息，最多 96 个 Unicode 字符                 |
| `agents`          | 每种 CLI 最多一条记录，固定按 Codex、Claude Code、Grok 排序 |
| `updatedAt`       | 最近事件时间，Unix epoch 毫秒；无事件时为 `0`               |

`mainState` 的合法值：

```text
idle | running | waiting_permission | done | error | stuck | usage_limited
```

`agents[].state` 的合法值：

```text
idle | prompt_submitted | thinking | tool_running |
waiting_permission | waiting_user_input | done | error |
timeout | usage_limited | cancelled
```

`project` 只包含目录末级名称，不会传输电脑上的绝对路径。token 数量与
`contextWindow` 单位为 token；百分比范围为 0–100。`quotas[].*.resetsAt`
统一为 Unix epoch **秒**，而两个 `updatedAt` 为 Unix epoch **毫秒**。
每个 Agent 最多返回 8 个额度桶。

## 4. 条件请求与水墨屏刷新

### 0.0.18：即时状态读取（2026-10-23）

`GET /api/v1/device/status` 新增可选请求头 `X-CodePulse-Wait-Ms: 1000`。
仅当 If-None-Match 仍匹配时挂起，最长 1000 ms；StatusHub 状态变化或桌面
保存设备配置时，立即重新投影，有新 revision 就提前返回 200。保持不变则到期
返回 304。该时间是空闲请求的最长保持时间，不是收到变化后的等待时间。
旧客户端不传此头时行为不变；认证、只读边界、v1 JSON 字段和 ETag 语义不变。
不回传设备传感器、屏幕状态或显示回执。非法等待值返回 400，同时最多 32 个
挂起读取，超出返回 503；断开与关闭服务会清理监听器／定时器。

0.0.18 设备连续读取，正常请求间只让出 100 ms 给系统与按键；不再每 30 秒
取数。已验证可用的备用地址也会缓存，避免重复 mDNS 查询的 3 秒开销；请求
失败、Wi-Fi 重连、USB 重新配网会使地址缓存失效。网络请求仍有 7 秒超时，
失败后 3 秒重试；无网络时无法承诺即时到达。主任务单独拥有网络及屏幕，
不启动第二个并发刷屏者。

收到数据后，待确认／待查看／异常／限额优先分类；普通状态、任务增删、标题、
可见额度和配置变化也立即符合刷新条件，取消原 60 秒状态稳定和 180 秒显示
间隔。正在刷屏时完成当前一轮，再取最新快照，不排队回放中间态。相同画面
不驱动屏幕；同状态下的工具详情变化不单独刷新，也不扩大额度更新范围。
短按同样取消 3 分钟等待。重要状态随同一张最新画面更新，不重新排列卡片。

温湿度仍每 30 秒采样；小于 1°C／5 个湿度百分点的变化不触发或扩大刷新。
大变化仍沿用 15 分钟辅助更新门槛，电量阈值仍为 10 个百分点；手动刷新可
带入当前读数。PAIR125、一次变更区域局刷、故障锁止和启动一次清洁全刷不变。
配置预览仍是目标画面，不是设备实时显示回执；旧固件仍遵守旧刷新节奏。


`200` 响应会带弱 ETag，例如：

```http
ETag: W/"v1-5db1f203"
```

ESP32 保存该值，并在下次请求发送：

```http
If-None-Match: W/"v1-5db1f203"
```

- `200`：解析 JSON；仅当 `revision` 改变时更新显示。
- `304`：展示内容未变化，不刷新水墨屏。
- `401`：设备 token 错误，保留旧画面并进入重新配置状态。
- 网络错误或 `5xx`：保留最后一次成功画面，稍后重试。

推荐在开机、功能键短按以及低频后台同步时请求。三色水墨屏刷新慢且有寿命限制，
不要因为单纯的时间戳变化触发刷新。

## 5. 兼容性规则

- 固件只接受自己支持的 `protocolVersion`；未知主版本应保留旧画面并提示升级。
- v1 后续只会新增可忽略字段，不会改变现有字段含义或单位。
- 破坏兼容性的字段、枚举或单位变更必须发布新的 `/api/v2/device/status`。
- token 不应写入日志、URL、崩溃报告或屏幕；建议保存在 ESP32 NVS 中。

## Shared HUD work presentation (additive v1 extension)

The unified host uses the retained HUD projection for both preview and LAN status. Optional thread level/unread/groupId and agent quotaSummary fields carry shared display semantics; legacy fields remain compatible. See [the implementation and firmware acceptance contract](WORK-PRESENTATION-HANDOFF.md). Old firmware ignores these fields; displaying their semantics requires an updated production renderer.


### Optional BW inversion (firmware 0.0.24+)

`display.inverted` is an optional boolean, default false. Old devices ignore it;
new devices reject non-boolean values. It complements the final 400×300 black
plane after rendering all work, quota and ambient content. The red plane and
refresh waveforms are unchanged. Both desktop previews use the same C renderer.
Concept cards, prompts, personal notes and imported images use the existing
`ambient` extension; images remain 384×208 MSB-first packed black bits (19,968
hex characters). No new image format or network access is required on the MCU.

### Explicit content display (firmware 0.0.25+)

`ambient.manual` is an optional boolean, default false. True denotes an explicit
user display action; it permits covering passive `notice` tasks without changing
any work/read state. `action` and `fault` still preempt it. Automatic content
continues to yield to notice/action/fault. The flag is transient, never stored in
the content library, and participates in the response revision. Non-booleans are
rejected by new firmware. Older firmware ignores it and still suppresses content
while review notices exist; update firmware to enable the new behavior.

### Red ink for ambient images (firmware 0.0.27+)

`ambient.red` is an optional object that adds red to an ambient bitmap. The first
user is the pixel pet card (`pet:<pet>:<mood>:<YYYY-MM-DD>`); any bitmap card may use it.

```json
"red": { "x": 128, "y": 40, "w": 128, "h": 128, "hex": "…" }
```

- Coordinates are in the multimedia picture area (384×208, origin top left); on the
  device that is screen pixel (8+x, 60+y), the same as `imageHex` (32+y with the pet layout below).
- `x` and `w` are multiples of 8, `w ≥ 8`, `h ≥ 1`, `x + w ≤ 384`, `y + h ≤ 208`.
- `w * h / 8 ≤ 3072` bytes (a 128×128 rectangle is 2048 bytes).
- `hex` has exactly `w * h / 4` characters, row-major, MSB first, upper or lower
  case. A set bit is red pigment (as in `imageHex`, 1 means ink).
- Only a card that also carries `imageHex` may carry `red`.
- Where black and red are both 1 the pixel is black. The desktop never produces
  overlap; firmware still gives black priority.
- An invalid `red` (out of bounds, wrong length, no `imageHex`, wrong type) makes the
  firmware drop only `red` and show the card in black and white. The status must not
  fail to parse because of it, so a new optional field can never take a device offline.
  This is deliberately unlike `imageHex`, which still fails strictly.
- Older firmware ignores the unknown `red` field and shows the black part only.

Firmware behaviour. The ambient renderer draws the black image first, then paints red
where the red bit is 1 and the black bit is 0. With `display.inverted` only the
black/white pixels invert; red stays red and never produces a black-and-red-both-clear
encoding. A frame that has red, or follows a frame that had red, and whose picture
changed is shown with a full three-colour refresh (`epd_ssd1683_refresh`, real red
plane, about 16 s with visible flashing); log tag `red_full`, distinct from the boot
`clean_baseline`. Other changes keep the low-flicker PAIR partial refresh, which needs
the red plane to be all 0xFF. Cooldown: when less than 120 s have passed since the last
runtime full refresh, *entering* a red frame (previous frame had no red) draws red pixels
as black through the partial refresh; *leaving or replacing* a red frame always does a full
refresh regardless of the cooldown, because partial refresh cannot clear red. A refresh
failure follows the existing policy (mark faulted, power down safely). PAIR waveforms,
LUTs, boot clear, keys and power flow are unchanged.

Desktop side. `withAmbient` keeps the whole status within the MCU's 32,000 byte limit by
dropping `red` first (black-only still shows the picture) and only then the bitmap. A pet
card keeps a fixed id while shown, so a showing costs one full refresh in and one out; pets
follow the existing automatic-push pacing (interval, daily cap, quiet hours, idle only) and
manual display, and add no timed refreshes. The mood (sleepy, hungry, working, happy, idle)
is chosen from live status and local time when the card is built.

### Pet layout (firmware 0.0.28+)

`ambient.layout` is an optional string; the only value is `"pet"`. The desktop sets it on pixel
pet cards, and only sends it when the card also carries `imageHex`. It is part of the card
projection, so a change of layout changes the response revision.

- A `"pet"` card with a bitmap is laid out as: picture 384×208 at screen pixel (8, 32) (`red`
  keeps picture-area coordinates and follows the same origin), a 1 px divider at y=243, `text`
  in 20px bold on one line (14px if it does not fit in 376 px), then `source` in 12px semibold.
- A missing, `null`, other-string or non-string `layout`, or a card without `imageHex`, keeps
  the original layout (picture at (8, 60)). An invalid `layout` never fails the status, like `red`.
- Older firmware ignores the field and shows the original layout, so no version negotiation is
  needed.

### 0.0.26：设备展示减频与局部窗口候选

仍读取同一 v1 快照，不改变桌面/HUD 的任务、已读、保留或顺序语义。
设备上的活动子阶段使用稳定的“工作中”和中性说明，原始 thinking/tool_running
切换不独立驱动。新任务、完成未读、授权/补充输入/异常和解除提醒仍及时显示。
已知额度采用 120 秒的设备展示节奏；未知转已知和达到限额例外。
温湿度/电量继续阈值与 15 分钟限制，并避免在工作变化时将辅助区一起带入刷新。
相同 ambient ID 的有效停留期间冻结页眉和额度；宿主移除 ambient 后正常恢复工作。
预览仍表示目标像素，不模拟物理延迟或残影。

默认关闭的 `CODEPULSE_QUIET_RECT_TRIAL` 窄窗口实验只改变传输区域，保持所选
PAIR125/PAIR150 波形及单次驱动。配套固件 `7e3d9e6` 已合入独立固件主线；
原型已刷入 `0.0.26-region-pair150` 并确认开机联网，实际残影改善仍待实物验收。
两套桌面预览均为 `0.0.26-paced`，仅表示目标像素；版本对应、软件检查和实测范围见
[日常低干扰显示记录](QUIET-DISPLAY-2026-10-28.md)。
