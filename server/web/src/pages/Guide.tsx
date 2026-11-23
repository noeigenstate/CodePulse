const FULL_GUIDE =
  'https://github.com/noeigenstate/CodePulse/blob/main/docs/PLUGIN-DEVELOPER-GUIDE.md'

const steps: [string, string][] = [
  [
    '获取邀请码',
    '开发者账号采用邀请制。向平台管理员索取邀请码（CP-XXXX-XXXX-XXXX），一码一号，过期或撤销后失效。',
  ],
  ['注册', '在「开发者」页注册：邀请码、邮箱、名称（最多 32 字）和至少 8 位的密码。'],
  [
    '创建插件',
    '填写插件 ID（3–40 位小写字母、数字，可用 . 或 - 分隔，创建后不能改）、名称和简介。接口插件的签名密钥只在这时显示一次，请立即保存。',
  ],
  ['做卡片', '内容包直接上传 1–60 张卡片；接口插件提供 HTTPS 地址，由平台按刷新间隔调用。'],
  ['测试生成', '在「提交新版本」里点「测试生成」，看实际生成的卡片或错误，不影响线上版本。'],
  [
    '提交审核',
    '审核通过后上架，已安装的用户自动更新；退回时能看到原因，改好后用更高的版本号重新提交。',
  ],
]

const cardFields: [string, string][] = [
  ['id', '必填。插件内唯一，1–64 位字母、数字或 . _ : -；内容变了要换新 id'],
  ['source', '必填。标题行，最多 40 字'],
  ['text', '必填。正文，最多 400 字'],
  ['items', '可选。清单，最多 6 行 {title, meta, overdue}'],
  ['life', '可选。天气、股价、HN 等结构化版式'],
  ['imageHex', '可选。384×208 单色位图，19968 个十六进制字符'],
  ['expiresAt', '可选。过期时间（Unix 毫秒），最长 24 小时'],
]

const CARD = `{ "id": "daily-1", "source": "每日一句", "text": "今天也留一点时间给自己。" }`

const REQUEST = `POST <你的接口>
X-CodePulse-Timestamp: 1794110400000
X-CodePulse-Signature: sha256=<HMAC-SHA256(密钥, 时间戳 + "." + 原始请求体)>

{ "v": 1, "pluginId": "alice.word-a-day", "version": "1.0.0",
  "settings": { "level": "cet4" }, "locale": "zh-CN", "now": 1794110400000 }

→ 200 { "cards": [ { "id": "word-2026-11-23", "source": "每日一词", "text": "abandon：放弃" } ] }`

/** A short, always-available version of docs/PLUGIN-DEVELOPER-GUIDE.md. */
export function Guide() {
  return (
    <article className="guide">
      <p className="hint">
        插件在平台上生成卡片，用户的电脑只下载结果交给墨水屏显示，你的代码不会在用户设备上运行。完整说明和示例代码见{' '}
        <a href={FULL_GUIDE} target="_blank" rel="noreferrer">
          完整开发指南
        </a>
        。
      </p>

      <section className="panel">
        <h2>开发流程</h2>
        <ol className="guide-steps">
          {steps.map(([title, body]) => (
            <li key={title}>
              <strong>{title}</strong>
              <span>{body}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel">
        <h2>两种插件</h2>
        <dl className="guide-terms">
          <div>
            <dt>内容包</dt>
            <dd>适合语录、单词、知识这类固定内容。上传 1–60 张卡片，平台按日期每天轮换一张。</dd>
          </div>
          <div>
            <dt>接口插件</dt>
            <dd>
              适合实时数据或按用户设置生成的内容。提供 HTTPS 地址，平台带签名和设置调用，5
              秒内返回， 最多 12 张、64 KiB，不跟随重定向，只能是公网地址。
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>卡片格式</h2>
        <p className="hint">墨水屏是 400×300 黑白红屏，内容要短。items、life、imageHex 三选一。</p>
        <dl className="guide-terms is-code">
          {cardFields.map(([field, rule]) => (
            <div key={field}>
              <dt>
                <code>{field}</code>
              </dt>
              <dd>{rule}</dd>
            </div>
          ))}
        </dl>
        <pre className="guide-code">
          <code>{CARD}</code>
        </pre>
      </section>

      <section className="panel">
        <h2>接口插件的请求和响应</h2>
        <pre className="guide-code">
          <code>{REQUEST}</code>
        </pre>
        <p className="hint">
          用收到的原始请求体字节验签，不要重新序列化 JSON；拒绝时间戳与当前相差超过 5 分钟的请求。
        </p>
      </section>

      <section className="panel">
        <h2>设置项与版本</h2>
        <ul className="guide-list">
          <li>版本号用 主.次.修订，每次提交须比上一次高；刷新间隔 15–1440 分钟。</li>
          <li>
            设置项最多 8 个，类型为
            text、number、boolean、select。平台会补默认值并丢弃越界的值，接口收到的设置总是合法的。
          </li>
          <li>图标：PNG、JPEG 或 WebP，正方形 64–1024 像素，不超过 200 KB，上传后立即生效。</li>
        </ul>
      </section>
    </article>
  )
}
