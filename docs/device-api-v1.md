# CodePulse 局域网设备协议 v1

本文档定义桌面端与 ESP32 水墨屏之间的第一版协议。设备通过局域网主动拉取，
桌面端不向设备开放 Hook 写入、确认任务、静音或 WebSocket 接口。

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
