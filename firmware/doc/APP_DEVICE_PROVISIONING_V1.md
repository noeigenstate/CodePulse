# CodePulse App 设备配网协议 v1

本文档是 Desktop App 与水墨屏固件之间的实现契约。目标是让用户在 App
中完成设备发现、Wi-Fi 配置和配对，不再运行 `provision.sh`，也不需要手动输入
电脑的局域网 IP。

## 1. 完整数据流

1. App 的设备 API 监听 `0.0.0.0:17889`。
2. App 创建并持久化一个固定 `serverId`，同时通过 mDNS 广播自己。
3. 用户用 USB 连接水墨屏并正常长按 3 秒开机。
4. App 枚举串口，通过 `hello` 握手确认这是 CodePulse 水墨屏。
5. App 通过 USB 发送 Wi-Fi、`serverId` 和设备 API token。
6. 固件校验并写入 NVS，在运行时连接 Wi-Fi，无需重启。
7. 固件通过 mDNS 找到与 `serverId` 匹配的 App，然后拉取状态接口。
8. 固件广播自己的水墨屏服务；App 可据此确认设备已进入局域网。

USB 是唯一允许修改配置的入口。局域网只开放匿名、只读的设备 health 接口。

## 2. App 端必须实现的模块

建议都放在 Electron main process，renderer 只通过受限 IPC 调用：

- `device-server-id`：首次运行生成 UUID，持久化到
  `~/.codepulse/device-server-id`；后续启动必须保持不变。
- `device-mdns-publisher`：设备 API 开始监听后发布 Desktop mDNS 服务，退出前撤销。
- `device-usb-scanner`：枚举串口、执行 `hello` 握手并维护已连接设备列表。
- `device-provisioner`：发送 `provision`，随后轮询 `getStatus`。
- `display-mdns-browser`：浏览已联网的水墨屏并验证其 health 接口。

按照当前 CodePulse 目录，建议落在这些位置：

- `packages/local-server/src/device-server-id.ts`：生成和读取固定 `serverId`；
- `packages/local-server/src/device-discovery.ts`：Desktop mDNS 发布器；
- `packages/local-server/src/device-server.ts`：监听成功后启动发布器，`close()` 时一并停止；
- `packages/local-server/src/index.ts`：导出新增能力；
- `apps/desktop/src/main/device-usb.ts`：串口枚举、协议帧解析和配网状态机；
- `apps/desktop/src/main/device-browser.ts`：浏览 display mDNS 并请求 health；
- `apps/desktop/src/main/index.ts`：注册生命周期与受限 IPC handler；
- `apps/desktop/src/preload/index.ts`：只暴露扫描、配网、取消和设备状态 API；
- `packages/shared/src/types/device.ts`：补充 App UI 需要的配网类型；
- `tests/device-provisioning.test.ts`：使用假串口覆盖分帧、超时、重连和敏感字段脱敏；
- `tests/device-discovery.test.ts`：覆盖 serverId 持久化、mDNS TXT 和服务关闭清理。

串口库属于 Electron native dependency，必须纳入现有
`electron-builder install-app-deps`/打包流程；mDNS 库必须同时验证 macOS、Windows
和 Linux 的服务发布及撤销行为。

`serverId` 不是密码，但它是配对标识。允许 1–64 个 ASCII 字符，字符集仅限：

```text
A-Z a-z 0-9 . _ -
```

## 3. USB 传输与设备发现

- 传输：ESP32-S3 原生 USB Serial/JTAG CDC。
- 串口设置：`115200 8N1`；USB CDC 实际不依赖波特率，但两端固定使用该值。
- macOS 常见端口：`/dev/cu.usbmodem*`。
- Linux 常见端口：`/dev/ttyACM*`。
- Windows 常见端口：`COM*`。
- Espressif 常见 VID/PID 为 `303A:1001`，只能用于筛选候选端口，不能代替握手。
- App 不应切换 DTR/RTS，也不应发送复位或进入下载模式的控制序列。
- 固件日志和协议帧共用一个串口。App 只解析以 `CP1 ` 开头的完整行，忽略其他行。
- 每个请求和响应都是一行 UTF-8 JSON，以 `\n` 结束；固件同时接受 `\r\n`。
- 整行最大 1024 字节，包含 `CP1 ` 前缀。
- 同一串口一次只允许一个进程打开；配网完成后 App 应关闭串口。

设备需要运行应用固件才能响应握手。App 可提示用户正常长按功能键 3 秒开机，
不需要按 BOOT。

## 4. USB 请求与响应

所有请求都必须包含：

```json
{
  "id": "app-1",
  "protocolVersion": 1,
  "operation": "hello"
}
```

发送到串口时必须加前缀和换行：

```text
CP1 {"id":"app-1","protocolVersion":1,"operation":"hello"}\n
```

`id` 必须是 1–64 个不含空格的可打印 ASCII 字符；响应原样返回该 `id`，App
可以用它关联并发请求。

### 4.1 `hello`

请求：

```text
CP1 {"id":"app-1","protocolVersion":1,"operation":"hello"}
```

成功响应示例：

```text
CP1 {"id":"app-1","ok":true,"result":{"protocolVersion":1,"deviceId":"codepulse-a4cb8fc3a698","firmwareVersion":"0.0.1-bringup","hardwareRevision":1,"provisioned":false,"capabilities":["usb-provisioning-v1","mdns-codepulse-v1","mdns-display-v1"]}}
```

`deviceId` 由 Wi-Fi Station MAC 派生，刷机后保持不变。只有收到合法 `hello`
响应的候选串口才能被标记为 CodePulse 设备。

### 4.2 `getConfig`

该操作只返回非敏感字段，永远不返回 Wi-Fi 密码或设备 token。

```text
CP1 {"id":"app-2","protocolVersion":1,"operation":"getConfig"}
```

已配置时 `result` 额外包含：

```json
{
  "provisioned": true,
  "wifiSsid": "MyWiFi",
  "serverId": "550e8400-e29b-41d4-a716-446655440000",
  "fallbackHost": "192.168.1.20",
  "fallbackPort": 17889
}
```

### 4.3 `provision`

```text
CP1 {"id":"app-3","protocolVersion":1,"operation":"provision","params":{"wifiSsid":"MyWiFi","wifiPassword":"example-password","serverId":"550e8400-e29b-41d4-a716-446655440000","deviceToken":"<device-auth-token>","fallbackHost":"192.168.1.20","fallbackPort":17889}}
```

字段约束：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `wifiSsid` | 是 | 1–32 个 UTF-8 字节 |
| `wifiPassword` | 是 | 开放网络为空；否则 8–63 字节，或 64 位十六进制 PSK |
| `serverId` | 是 | 1–64 个字符，使用上文限定字符集 |
| `deviceToken` | 是 | 16–128 个无空白可打印 ASCII 字符 |
| `fallbackHost` | 否 | IPv4 或普通 hostname，最多 63 字节；建议由 App 自动填入当前 LAN IPv4 |
| `fallbackPort` | 否 | 1–65535，默认 `17889` |

成功响应只表示 NVS 已提交，不能立即显示“联网成功”：

```text
CP1 {"id":"app-3","ok":true,"result":{"saved":true,"applyQueued":true}}
```

App 不得把完整请求、Wi-Fi 密码或 token 写入日志、崩溃报告或 renderer 状态持久化。

### 4.4 `getStatus`

`provision` 成功后，每 500–1000 ms 轮询一次，建议总超时 60 秒：

```text
CP1 {"id":"app-4","protocolVersion":1,"operation":"getStatus"}
```

响应示例：

```text
CP1 {"id":"app-4","ok":true,"result":{"protocolVersion":1,"deviceId":"codepulse-a4cb8fc3a698","provisioned":true,"state":"ready","wifiConnected":true,"desktopReachable":true,"configurationGeneration":1}}
```

状态含义：

| `state` | App 展示 |
| --- | --- |
| `unprovisioned` | 尚未配置 |
| `applying` | 正在应用配置，请等待 |
| `wifi_error` | Wi-Fi 名称、密码或信号异常，可让用户重新输入 |
| `desktop_unreachable` | Wi-Fi 已连接，但未发现/无法鉴权访问 CodePulse App |
| `ready` | 已连接 Wi-Fi 且完成一次鉴权状态请求 |

只有 `ready` 才算配网完成。初次水墨屏刷新较慢，`applying` 持续几十秒是允许的。

### 4.5 错误响应

```text
CP1 {"id":"app-3","ok":false,"error":{"code":"invalid_params","message":"One or more provisioning fields are invalid"}}
```

可能的错误码：

- `invalid_json`
- `invalid_request`
- `unsupported_protocol`
- `unknown_operation`
- `invalid_params`
- `line_too_long`
- `storage_error`
- `identity_error`
- `internal_error`

App 应根据 `code` 决定 UI，不能解析或依赖英文 `message`。

## 5. Desktop App 的 mDNS 广播

App 必须先成功监听设备 API，再发布：

```text
service type: _codepulse._tcp.local
port:         实际绑定的设备 API 端口，默认 17889
instance:     任意可读且唯一的名称，不作为身份依据
TXT pv:       1
TXT id:       <持久化 serverId>
TXT path:     /api/v1/device/status
```

多数 Node Bonjour 库会自动补下划线和 `.local`，此时传入的 type/protocol 应分别为
`codepulse` 和 `tcp`，不要产生 `__codepulse`。

发布生命周期必须与 `0.0.0.0:17889` 服务一致：

- API 监听成功后再发布；
- 端口动态分配时广播实际端口；
- API 关闭、App 退出或 serverId 改变前先撤销广播；
- TXT 中不得放置设备 token、用户名、绝对路径或其他隐私信息。

固件只接受 `pv=1` 且 `id` 与 USB 配入的 `serverId` 完全一致的记录。mDNS
不可用时，固件使用 `fallbackHost:fallbackPort`。

## 6. App 发现已联网水墨屏

固件连接 Wi-Fi 后发布：

```text
service type: _codepulse-dsp._tcp.local
port:         17890
TXT pv:       1
TXT id:       codepulse-<12位MAC十六进制>
TXT fw:       固件版本
TXT hw:       硬件版本
TXT path:     /api/v1/device/health
```

App 浏览该服务后，应访问广播地址上的：

```http
GET http://<display-ip>:17890/api/v1/device/health
```

示例响应：

```json
{
  "ok": true,
  "service": "codepulse-display",
  "protocolVersion": 1,
  "deviceId": "codepulse-a4cb8fc3a698",
  "firmwareVersion": "0.0.1-bringup",
  "hardwareRevision": 1,
  "provisioned": true
}
```

App 必须验证 mDNS TXT `id` 与 health `deviceId` 一致，再把设备标记为局域网在线。
该 health 接口匿名且只读，不提供配置、token、传感器数据或控制功能。

## 7. App 配网流程建议

1. 确保设备 API 和 Desktop mDNS 广播已启动。
2. 每 2 秒枚举一次新串口；对候选端口发送 `hello`，单次等待 1.5 秒。
3. 用户选中设备；App 显示 `deviceId` 和当前 `getConfig` 的非敏感内容。
4. App 预填当前 SSID 和 LAN IPv4，只让用户输入 Wi-Fi 密码。
5. App 在 main process 中读取/创建 `device-auth` token，组装 `provision`。
6. 收到 `saved=true` 后轮询 `getStatus`，显示明确的阶段和错误。
7. 收到 `ready` 后关闭串口，并等待同一 `deviceId` 的 display mDNS 服务。
8. health 验证成功后把设备保存到 App 的设备列表。

串口扫描必须有互斥锁，避免同时打开同一端口。退出配网页面、设备断开或 App
退出时必须取消定时器、移除监听器并关闭串口，防止 Electron 进程无法退出。

## 8. 验收条件

- 未连接设备时，扫描不会产生持续报错或占用普通串口设备。
- 不按 BOOT，正常开机后 App 能通过 `hello` 自动识别水墨屏。
- 错误 Wi-Fi 密码最终显示 `wifi_error`。
- 正确配置最终显示 `ready`，且 App 能通过 mDNS 和 health 找到同一 `deviceId`。
- 电脑 DHCP 地址变化后，固件仍能通过 `serverId` 重新发现 App。
- 禁用 mDNS 时，自动填入的 `fallbackHost` 可以继续同步。
- App、固件串口日志和崩溃报告中均不存在 Wi-Fi 密码或设备 token。
- 未通过 USB 的局域网客户端无法修改设备配置。

## 2026-10-23 补充：运行时状态读取

0.0.18 使用桌面状态 API 的 `X-CodePulse-Wait-Ms: 1000` 条件等待扩展；
USB CP1 配网、token、NVS 与设备只读 health 不变，不回传环境读数或显示回执。
已验证的桌面备用地址在正常连接期间复用，失败／重配时失效。详见
[LIVE-SYNC](LIVE-SYNC-2026-10-23.md) 和桌面设备 API 文档。
