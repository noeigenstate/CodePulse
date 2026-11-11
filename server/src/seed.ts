import type Database from 'better-sqlite3'
import type { PluginManifest } from '@codepulse/shared'
import { randomToken } from './auth.js'

const poems = [
  ['静夜思', '李白', '床前明月光，疑是地上霜。举头望明月，低头思故乡。'],
  ['春晓', '孟浩然', '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。'],
  ['登鹳雀楼', '王之涣', '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。'],
  ['鹿柴', '王维', '空山不见人，但闻人语响。返景入深林，复照青苔上。'],
  ['相思', '王维', '红豆生南国，春来发几枝。愿君多采撷，此物最相思。'],
  ['江雪', '柳宗元', '千山鸟飞绝，万径人踪灭。孤舟蓑笠翁，独钓寒江雪。'],
  ['寻隐者不遇', '贾岛', '松下问童子，言师采药去。只在此山中，云深不知处。'],
  ['悯农', '李绅', '锄禾日当午，汗滴禾下土。谁知盘中餐，粒粒皆辛苦。'],
  ['鸟鸣涧', '王维', '人闲桂花落，夜静春山空。月出惊山鸟，时鸣春涧中。'],
  ['竹里馆', '王维', '独坐幽篁里，弹琴复长啸。深林人不知，明月来相照。'],
  ['夏日绝句', '李清照', '生当作人杰，死亦为鬼雄。至今思项羽，不肯过江东。'],
  ['梅花', '王安石', '墙角数枝梅，凌寒独自开。遥知不是雪，为有暗香来。'],
]

export function seed(db: Database.Database, now: number): void {
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO developers (id, email, name, password_hash, created_at)
      VALUES ('codepulse-official', 'official@codepulse.invalid', 'CodePulse 官方', NULL, ?)`,
    ).run(now)
    const manifests: PluginManifest[] = [
      {
        id: 'codepulse.hn-digest',
        version: '1.0.0',
        name: 'Hacker News 摘要',
        summary: '精选 Hacker News 热门技术故事',
        description: '按最低热度筛选首页故事，显示标题、热度和讨论数。',
        kind: 'builtin',
        refreshMinutes: 15,
        settings: [
          {
            key: 'count',
            label: '故事数量',
            type: 'select',
            default: '4',
            options: [
              { value: '2', label: '2 条' },
              { value: '3', label: '3 条' },
              { value: '4', label: '4 条' },
            ],
          },
          { key: 'minPoints', label: '最低热度', type: 'number', default: 100, min: 0, max: 2000 },
        ],
      },
      {
        id: 'codepulse.daily-poem',
        version: '1.0.0',
        name: '每日古诗',
        summary: '每天一首经典短诗',
        description: '十二首公版古诗，按平台时区每日轮换。',
        kind: 'pack',
        refreshMinutes: 1440,
        settings: [],
      },
    ]
    for (const manifest of manifests) {
      const exists = db.prepare('SELECT id FROM plugins WHERE id = ?').get(manifest.id)
      if (exists) continue
      const versionId = `${manifest.id}:1.0.0`
      const payload =
        manifest.kind === 'pack'
          ? {
              cards: poems.map(([title, author, verse], i) => ({
                id: `poem-${i + 1}`,
                source: `每日古诗 · ${author}`,
                text: `${title}｜${verse}`,
              })),
            }
          : {}
      db.prepare(
        `INSERT INTO plugins (id, developer_id, name, summary, webhook_secret, created_at)
        VALUES (?, 'codepulse-official', ?, ?, ?, ?)`,
      ).run(manifest.id, manifest.name, manifest.summary, randomToken(), now)
      db.prepare(
        `INSERT INTO versions (id, plugin_id, version, manifest_json, payload_json, state, submitted_at, reviewed_at)
        VALUES (?, ?, ?, ?, ?, 'approved', ?, ?)`,
      ).run(
        versionId,
        manifest.id,
        manifest.version,
        JSON.stringify(manifest),
        JSON.stringify(payload),
        now,
        now,
      )
      db.prepare('UPDATE plugins SET live_version_id = ? WHERE id = ?').run(versionId, manifest.id)
    }
  })()
}
