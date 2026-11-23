# CodePulse 插件开发指南

插件给 CodePulse 墨水屏提供“桌边内容”：一张张小卡片，比如每日一句、天气、待办清单或一张图。插件**在平台上生成卡片**，用户电脑只下载结果，再交给墨水屏显示；你的代码不会在用户的电脑或设备上运行。

本文按开发顺序写：拿邀请码、注册、创建插件、做卡片、测试、提交审核、更新。完整的接口参考见 [server/README.md](../server/README.md)。

## 1. 获取邀请码并注册

开发者账号采用**邀请制**。向平台管理员索取邀请码，格式为 `CP-XXXX-XXXX-XXXX`：

- 一个邀请码只能注册一个账号，用过即失效；
- 邀请码有有效期，默认 14 天，过期或被撤销后不能再用；
- 输入时不区分大小写，可以省略短横线。

打开插件商店的「开发者」页，点「没有账号，去注册」，填写邀请码、邮箱、名称（最多 32 字）和密码（至少 8 位）。注册后自动登录，登录有效期为 7 天。

> 平台管理员：在商店的「审核」页生成和撤销邀请码。还没有管理员时，在服务器上运行 `node server/dist/main.js invite [--days=N] [备注]` 生成第一个邀请码，注册后再用 `node server/dist/main.js admin <邮箱>` 设为管理员。

## 2. 选择插件类型

| 类型       | 适合                       | 你需要提供                     | 平台怎么做                                       |
| ---------- | -------------------------- | ------------------------------ | ------------------------------------------------ |
| **内容包** | 固定内容：语录、单词、知识 | 1–60 张卡片的 JSON             | 按平台时区的日期每天轮换一张，当天结束时过期     |
| **接口**   | 需要实时数据或按设置生成   | 一个 HTTPS 接口地址（webhook） | 按刷新间隔带签名和用户设置调用你的接口，缓存结果 |

“内置”类型只供平台官方使用，开发者不能提交。

## 3. 创建插件

在「开发者」页的「我的插件」里新建插件，填写：

- **插件 ID**：全局唯一，创建后不能改。3–40 个字符，小写字母和数字，可以用 `.` 或 `-` 分隔，例如 `alice.word-a-day`。建议用自己的名字作前缀。`codepulse.` 前缀保留给官方。
- **名称**：最多 24 字，显示在商店和用户的插件列表里。
- **简介**：一行，最多 60 字。

创建成功后页面会显示一次 **Webhook 签名密钥**。接口插件要用它验证请求，**立即保存到你自己的安全配置里**；平台不会再显示，内容包插件可以忽略。

可以给插件上传图标：PNG、JPEG 或 WebP，正方形，64–1024 像素，不超过 200 KB，不接受 SVG。图标上传后立即生效，不需要审核。

## 4. 做卡片

每张卡片是一个 JSON 对象。墨水屏是 400×300 的黑白红屏，内容要短。

| 字段        | 必填 | 规则                                                                    |
| ----------- | ---- | ----------------------------------------------------------------------- |
| `id`        | 是   | 插件内唯一，1–64 个字符：字母、数字、`.` `_` `:` `-`。内容变了要换新 id |
| `source`    | 是   | 标题行，最多 40 字                                                      |
| `text`      | 是   | 正文，最多 400 字；旧固件只显示这一段                                   |
| `items`     | 否   | 清单，最多 6 行，每行 `{title, meta, overdue}`：标题 80 字、备注 24 字  |
| `life`      | 否   | 结构化版式（天气、股价、HN 等），须符合设备类型                         |
| `imageHex`  | 否   | 384×208 单色位图，19968 个十六进制字符，逐行、高位在前，1 为黑          |
| `red`       | 否   | 叠在 `imageHex` 上的红色区域，只能和 `imageHex` 一起用                  |
| `expiresAt` | 否   | 过期时间（Unix 毫秒）。省略时平台自动补；最长 24 小时                   |

`items`、`life`、`imageHex` 三选一，一张卡片只能有一种展示方式。所有文字不能含控制字符。

最简单的卡片：

```json
{ "id": "daily-1", "source": "每日一句", "text": "今天也留一点时间给自己。" }
```

清单卡片：

```json
{
  "id": "todo-2026-11-23",
  "source": "今日待办",
  "text": "今天有 2 件事",
  "items": [
    { "title": "提交周报", "meta": "18:00", "overdue": false },
    { "title": "回复邮件", "meta": "已逾期", "overdue": true }
  ]
}
```

`life` 版式的完整字段见 `packages/shared/src/types/life.ts`，目前有 `weather`、`gold`、`stock`、`tool`、`news`、`holiday`、`concept`、`prompt`、`hn` 几种。

## 5. 版本信息（manifest）与设置项

每次提交版本都要填版本信息。在开发者中心是表单；直接调用接口时对应下面的 JSON：

```json
{
  "id": "alice.word-a-day",
  "version": "1.0.0",
  "name": "每日一词",
  "summary": "每天一个英文单词",
  "description": "按你选的难度，每天推送一个单词和例句。",
  "kind": "webhook",
  "refreshMinutes": 60,
  "settings": [
    {
      "key": "level",
      "label": "难度",
      "type": "select",
      "default": "cet4",
      "options": [
        { "value": "cet4", "label": "四级" },
        { "value": "cet6", "label": "六级" }
      ]
    }
  ]
}
```

- `version` 用 `主.次.修订` 三段数字，每次提交必须比上一次提交的高。
- `description` 最多 600 字；`refreshMinutes` 为 15–1440 分钟。
- `settings` 是用户安装后能改的选项，最多 8 项。`key` 以字母开头，只含字母、数字和下划线；`label` 最多 24 字。四种类型：

| `type`    | 额外字段                                        | 说明                           |
| --------- | ----------------------------------------------- | ------------------------------ |
| `text`    | `maxLength`（1–400）、`default`                 | 默认值不能超过长度             |
| `number`  | `min`、`max`、`default`                         | 默认值在范围内                 |
| `boolean` | `default`                                       | 开关                           |
| `select`  | `options`（1–20 项 `{value,label}`）、`default` | 默认值必须是其中一项的 `value` |

用户保存设置时，平台会补上缺省值，丢弃未知或越界的值，你的接口拿到的设置总是合法的。

## 6. 接口插件：请求、签名和响应

平台用 POST 调用你的接口，请求体：

```json
{
  "v": 1,
  "pluginId": "alice.word-a-day",
  "version": "1.0.0",
  "settings": { "level": "cet4" },
  "locale": "zh-CN",
  "now": 1794110400000
}
```

请求头带签名：

- `X-CodePulse-Timestamp`：生成时刻的 Unix 毫秒；
- `X-CodePulse-Signature`：`sha256=<hex>`，用签名密钥对“时间戳 + 英文句点 + **原始请求体**”做 HMAC-SHA256。

响应 `{"cards": [...]}`，最多 12 张，可以是空数组（这一轮没有内容）。

平台对接口的要求：

- 必须是 HTTPS 公网地址。内网、回环、链路本地等地址会被拒绝，提交时和每次调用时都会检查。
- 不跟随重定向。
- 5 秒内返回，包含 DNS、连接和读取的时间。
- 响应不超过 64 KiB。

下面是一个不依赖第三方库的 Node.js 示例：验证签名，按设置返回一张卡片。部署到任意支持 HTTPS 的主机即可。

```js
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'

const SECRET = process.env.CODEPULSE_WEBHOOK_SECRET // 创建插件时显示的签名密钥
const WORDS = { cet4: ['abandon', '放弃'], cet6: ['meticulous', '一丝不苟的'] }

function verify(headers, rawBody) {
  const timestamp = headers['x-codepulse-timestamp']
  const signature = headers['x-codepulse-signature']
  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false
  const expected = createHmac('sha256', SECRET).update(`${timestamp}.`).update(rawBody).digest()
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))
}

createServer((req, res) => {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > 16 * 1024)
      req.destroy() // 平台的请求体很小，过大的直接拒绝
    else chunks.push(chunk)
  })
  req.on('end', () => {
    const raw = Buffer.concat(chunks) // 用原始字节验签，不要重新序列化 JSON
    if (req.method !== 'POST' || !verify(req.headers, raw)) {
      res.writeHead(401).end()
      return
    }
    const { settings } = JSON.parse(raw.toString('utf8'))
    const [word, meaning] = WORDS[settings.level] ?? WORDS.cet4
    const day = new Date().toISOString().slice(0, 10)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        cards: [{ id: `word-${day}`, source: '每日一词', text: `${word}：${meaning}` }],
      }),
    )
  })
}).listen(8080)
```

省略 `expiresAt` 时，平台按“生成时间 + 两倍刷新间隔”补上。同一张卡片内容变了要换 `id`，否则用户的设备可能继续显示旧内容。

## 7. 测试、提交和审核

1. 在开发者中心「提交新版本」里填好版本信息和卡片（或接口地址），先点 **测试生成**。平台按你填的内容实际生成一次并显示结果或错误，不写缓存，也不影响已上架的版本。测试每分钟最多 6 次。
2. 没问题后点 **提交审核**，版本进入“待审核”。
3. 管理员审核：
   - 通过：该版本上架，已安装的用户自动用上新版本；
   - 退回：版本列表里能看到退回原因，修改后用更高的版本号重新提交。
4. 提交新版本时旧版本继续在线，新版本通过审核后才替换。如果一个更高的版本先通过了审核，比它旧的待审版本会被自动退回，原因为“已有更新版本”。

额度：每个开发者每小时最多创建 10 个插件、提交 10 个版本、上传或删除 20 次图标。

## 8. 常见问题

- **卡片没出现在设备上？** 先在商店的「已安装」里看这个插件有没有报错。卡片要通过平台和桌面端两次校验，任何字段超限的卡片都会被丢弃。
- **接口超时或被拒绝？** 检查是不是 HTTPS、有没有重定向、能不能在 5 秒内响应、域名是否解析到公网地址。
- **签名总是对不上？** 一定要用收到的原始请求体字节计算，不能先 `JSON.parse` 再 `JSON.stringify`；时间戳要原样拼接，后面跟一个英文句点。
- **签名密钥丢了？** 目前只在创建插件时显示一次，请联系平台管理员处理。
- **想改插件 ID？** 不能改，只能新建一个插件。
