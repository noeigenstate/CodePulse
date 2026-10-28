import { createHash } from 'node:crypto'
import type { AmbientCard } from '@codepulse/shared'
import { cleanText } from './ambient-rules.js'

// Original short explanations, with reading links. No quotation or live AI call.
const lessons = [
  [
    'economics-cost',
    '经济学 · 机会成本',
    '机会成本：选择一件事时，放弃的最佳替代方案的价值。今晚多写一小时代码，成本也包括少掉的一小时休息。你放弃的最好选项是什么？',
    'https://openstax.org/books/principles-economics-3e/pages/2-1-how-individuals-make-choices-based-on-their-budget-constraint',
  ],
  [
    'economics-margin',
    '经济学 · 边际思考',
    '边际思考：比较“再多做一点”的新增收益与新增成本。不是问项目总共值不值，而是问下一个小时最值得花在哪里。',
    'https://openstax.org/books/principles-economics-3e/pages/2-1-how-individuals-make-choices-based-on-their-budget-constraint',
  ],
  [
    'economics-utility',
    '经济学 · 边际效用',
    '边际效用递减：其他条件不变时，继续消费同一种东西，每增加一单位带来的满足感通常下降。第一杯水和第五杯水，价值未必相同。',
    'https://openstax.org/books/principles-economics-3e/pages/2-1-how-individuals-make-choices-based-on-their-budget-constraint',
  ],
  [
    'philosophy-falsify',
    '哲学 · 可证伪性',
    '可证伪性：一种说法若要接受经验检验，就必须允许某些可能观察与它冲突。问问自己：看到什么证据，我才愿意承认这个想法错了？',
    'https://plato.stanford.edu/entries/popper/',
  ],
  [
    'philosophy-test',
    '哲学 · 严格检验',
    '支持一个猜想的例子，并不自动使它成为真理。尝试设计一个最可能暴露它弱点的检验。今天哪个“肯定没问题”，值得再检查一次？',
    'https://plato.stanford.edu/entries/popper/',
  ],
  [
    'philosophy-limits',
    '哲学 · 暂时接受',
    '在批判理性主义中，经受住检验的理论仍可被修正。承认知识暂时可靠，不等于所有说法都一样可靠。留下一条可以改变判断的路径。',
    'https://plato.stanford.edu/entries/popper/',
  ],
  [
    'physics-entropy',
    '物理学 · 熵',
    '熵是状态函数。孤立系统中的自发过程不会让总熵减少；局部熵减少可以由环境中更大的熵增补偿。“桌面变乱”只是比喻，并不是这条定律的证明。',
    'https://openstax.org/books/university-physics-volume-2/pages/4-6-entropy',
  ],
  [
    'physics-path',
    '物理学 · 状态函数',
    '状态函数只由系统当前状态决定。从相同起点到相同终点，熵变相同，即使途径不同。热量和功却与过程有关。结果与过程，哪些信息能互相替代？',
    'https://openstax.org/books/university-physics-volume-2/pages/4-6-entropy',
  ],
  [
    'physics-heat',
    '物理学 · 热与熵',
    '在可逆、恒温的传热过程中，熵变等于传入热量除以绝对温度。同样的热量，在较低温度下对应更大的熵变。这里的温度必须使用开尔文。',
    'https://openstax.org/books/university-physics-volume-2/pages/4-6-entropy',
  ],
] as const
const prompts = [
  [
    'reverse',
    '换个方向想：如果你要让当前项目变得难用，会加哪三个设计？再看看其中有没有一个已经存在。',
  ],
  [
    'subtract',
    '今天只允许删掉一件事：一个按钮、一条规则、一个例会，或者一个不再需要的目标。你会删掉什么？',
  ],
  [
    'explain',
    '把今天正在解决的问题讲给昨天的自己。只能写三句话：发生了什么、为什么值得做、下一步怎么验证。',
  ],
  [
    'counterexample',
    '为你最确信的判断寻找一个反例。找到后，先修改判断的适用范围，再决定要不要推翻它。',
  ],
  ['notice', '离开屏幕看一眼周围：找到一个平时从未留意的小细节。用一句话描述它，不评价好坏。'],
  [
    'small',
    '如果今天只能完成一件小事，哪件事能让明天开始工作时更轻松？把它写成一个十分钟内能完成的动作。',
  ],
] as const
export function builtinCards(now: number): AmbientCard[] {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  const make = (
    id: string,
    kind: AmbientCard['kind'],
    source: string,
    text: string,
    url = '',
  ): AmbientCard => ({
    id,
    kind,
    source,
    text,
    url,
    publishedAt: date.getTime(),
    expiresAt: now + 86400000,
    score: 0,
  })
  // A daily deterministic rotation, without polling or paid generation.
  const offset = Math.floor(date.getTime() / 86400000) % lessons.length
  return [
    ...lessons
      .map((_, i) => lessons[(i + offset) % lessons.length]!)
      .map(([id, source, text, url]) => make('concept:' + id, 'concept', source, text, url)),
    ...prompts.map(([id, text]) => make('prompt:' + id, 'prompt', '一分钟 · 思考实验', text)),
  ]
}
export function personalCard(
  kind: 'note' | 'image',
  input: unknown,
  now: number,
  imageHex?: string,
): AmbientCard {
  if (typeof input !== 'string' || !input.trim() || [...input.trim()].length > 120)
    throw new Error('请填写 1–120 字的内容')
  if (kind === 'image' && (!imageHex || !/^[a-f0-9]{19968}$/.test(imageHex)))
    throw new Error('图片转换失败')
  const text = cleanText(input, 500)
  return {
    id:
      kind +
      ':' +
      createHash('sha256')
        .update(text + (imageHex ?? ''))
        .digest('hex')
        .slice(0, 24),
    kind,
    source: kind === 'image' ? '我的图片' : '我的便签',
    text,
    url: '',
    publishedAt: now,
    expiresAt: now + 365 * 86400000,
    score: 0,
    ...(imageHex ? { imageHex } : {}),
  }
}
export function restorePersonalCards(input: unknown, now: number): AmbientCard[] {
  if (!Array.isArray(input)) return []
  return input.slice(0, 8).flatMap((c) => {
    try {
      if (
        !c ||
        !['note', 'image'].includes(c.kind) ||
        !Number.isFinite(c.publishedAt) ||
        c.publishedAt > now
      )
        return []
      const card = personalCard(c.kind, c.text, c.publishedAt, c.imageHex)
      return card.expiresAt > now ? [card] : []
    } catch {
      return []
    }
  })
}
