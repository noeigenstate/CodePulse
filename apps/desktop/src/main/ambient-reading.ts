/**
 * Built-in reading cards: original short explanations with reading links, and one-minute prompts.
 * No quotation and no live AI call. The large 32px lines (`term`, `question`) may only use the
 * characters in firmware/fonts/sources/card-hero-charset.txt; tests/ambient-reading.test.ts checks
 * that, and every limit the device protocol sets (docs/device-api-v1.md, "Reading cards").
 */
export interface Concept {
  id: string
  /** Subject shown in the label row, at most 6 characters. */
  subject: string
  /** Hero term, at most 6 characters. */
  term: string
  /** English term, at most 24 ASCII characters; the device drops it when it would not fit. */
  english: string
  /** One-sentence definition, at most 44 characters (two lines). */
  definition: string
  /** A concrete everyday example, at most 44 characters (two lines). */
  example: string
  /** A question to take away, at most 20 characters (one line). */
  question: string
  url: string
}
export interface Prompt {
  id: string
  /** Short name of the technique, at most 6 characters. */
  tag: string
  /** Lead-in line in red, at most 22 characters. */
  lead: string
  /** The question in one or two 32px lines of at most 11 characters each. */
  question: [string] | [string, string]
  /** Follow-up line, at most 23 characters. */
  follow: string
}

const econ =
  'https://openstax.org/books/principles-economics-3e/pages/2-1-how-individuals-make-choices-based-on-their-budget-constraint'
const popper = 'https://plato.stanford.edu/entries/popper/'
const entropy = 'https://openstax.org/books/university-physics-volume-2/pages/4-6-entropy'
const computing = 'https://openstax.org/details/books/introduction-computer-science'
const statistics = 'https://openstax.org/details/books/introductory-statistics-2e'
const psychology = 'https://openstax.org/details/books/psychology-2e'

export const CONCEPTS: Concept[] = [
  {
    id: 'economics-cost',
    subject: '经济学',
    term: '机会成本',
    english: 'Opportunity cost',
    definition: '选择一件事时，放弃的最佳替代方案的价值。',
    example: '今晚多写一小时代码，成本也包括少掉的一小时休息。',
    question: '你放弃的最好选项是什么？',
    url: econ,
  },
  {
    id: 'economics-margin',
    subject: '经济学',
    term: '边际思考',
    english: 'Thinking at the margin',
    definition: '比较“再多做一点”带来的新增收益和新增成本。',
    example: '不问项目总共值不值，而问下一个小时花在哪里最值。',
    question: '下一个小时最值得做什么？',
    url: econ,
  },
  {
    id: 'economics-utility',
    subject: '经济学',
    term: '边际效用',
    english: 'Marginal utility',
    definition: '其他条件不变时，每多消费一单位，带来的满足感通常下降。',
    example: '第一杯水解渴，第五杯水可能只是负担。',
    question: '什么东西你其实已经够了？',
    url: econ,
  },
  {
    id: 'economics-sunk',
    subject: '经济学',
    term: '沉没成本',
    english: 'Sunk cost',
    definition: '已经付出、无论怎么选都收不回的成本，不该左右今后的决定。',
    example: '写了三周的方案不好用，三周本身不是继续的理由。',
    question: '哪件事只因投入太多才继续？',
    url: 'https://openstax.org/details/books/principles-economics-3e',
  },
  {
    id: 'philosophy-falsify',
    subject: '哲学',
    term: '可证伪性',
    english: 'Falsifiability',
    definition: '一个说法要接受经验检验，就必须允许某些观察与它冲突。',
    example: '“这个改动肯定没问题”：什么测试结果会证明它有问题？',
    question: '看到什么证据，你才承认想错了？',
    url: popper,
  },
  {
    id: 'philosophy-test',
    subject: '哲学',
    term: '严格检验',
    english: 'Severe testing',
    definition: '支持的例子再多也不等于真理，要设计最可能暴露弱点的检验。',
    example: '不要只跑会通过的用例，去写你最担心失败的那个测试。',
    question: '哪个“肯定没问题”值得再查？',
    url: popper,
  },
  {
    id: 'philosophy-fallible',
    subject: '哲学',
    term: '可错论',
    english: 'Fallibilism',
    definition: '经受住检验的知识仍可能被修正，暂时可靠不等于绝对正确。',
    example: '线上跑了一年的代码也可能有错，只是还没遇到触发条件。',
    question: '你最确信的判断，留了改口的余地吗？',
    url: popper,
  },
  {
    id: 'philosophy-razor',
    subject: '哲学',
    term: '奥卡姆剃刀',
    english: "Occam's razor",
    definition: '解释力相同的几个假说中，优先选择假设更少的那一个。',
    example: '服务变慢，先查最近的改动，再怀疑编译器出了错。',
    question: '你的解释里有多余的假设吗？',
    url: 'https://plato.stanford.edu/entries/simplicity/',
  },
  {
    id: 'physics-entropy',
    subject: '物理学',
    term: '熵',
    english: 'Entropy',
    definition: '孤立系统中自发过程不会让总熵减少，局部减少要靠环境更大的熵增。',
    example: '冰箱让内部保持低温，代价是向房间排出更多热量。',
    question: '你维持的秩序，代价排到了哪里？',
    url: entropy,
  },
  {
    id: 'physics-path',
    subject: '物理学',
    term: '状态函数',
    english: 'State function',
    definition: '只由系统当前状态决定的量，与经过的路径无关；热和功却与过程有关。',
    example: '从山脚到山顶，海拔差是固定的，走过的路程却取决于路线。',
    question: '你在意的是结果还是过程？',
    url: entropy,
  },
  {
    id: 'physics-inertia',
    subject: '物理学',
    term: '惯性',
    english: 'Inertia',
    definition: '不受外力时，物体保持静止或匀速直线运动的状态。',
    example: '急刹车时身体前倾，是因为身体还要保持原来的速度。',
    question: '哪个习惯在靠惯性前进？',
    url: 'https://openstax.org/books/university-physics-volume-1/pages/5-2-newtons-first-law',
  },
  {
    id: 'computing-cache',
    subject: '计算机',
    term: '缓存',
    english: 'Cache',
    definition: '把常用的数据放在更快的地方，用空间换时间。',
    example: '浏览器记住下载过的图片，再次打开页面就快多了。',
    question: '反复在找的东西，能放近一点吗？',
    url: computing,
  },
  {
    id: 'computing-abstraction',
    subject: '计算机',
    term: '抽象',
    english: 'Abstraction',
    definition: '隐藏细节，只暴露需要的部分，让人能在更高的层次上思考。',
    example: '调用排序函数时，不需要知道它内部用的是哪种算法。',
    question: '哪段代码该藏起它的细节？',
    url: computing,
  },
  {
    id: 'computing-complexity',
    subject: '计算机',
    term: '时间复杂度',
    english: 'Time complexity',
    definition: '描述输入规模变大时，算法的运行时间如何增长。',
    example: '在一百万条有序数据里逐条查找，比二分查找慢几万倍。',
    question: '数据翻十倍，程序会怎样？',
    url: computing,
  },
  {
    id: 'statistics-regression',
    subject: '统计学',
    term: '均值回归',
    english: 'Regression to the mean',
    definition: '一次极端的结果之后，下一次往往更接近平均水平。',
    example: '状态奇差的一周后自然好转，未必是新方法起了作用。',
    question: '哪次自然回落被当成了功劳？',
    url: statistics,
  },
  {
    id: 'statistics-survivor',
    subject: '统计学',
    term: '幸存者偏差',
    english: 'Survivorship bias',
    definition: '只看到经过筛选留下来的样本，误以为它们代表了全部。',
    example: '只研究成功的创业公司，会高估冒险的回报。',
    question: '哪些失败的样本你没看到？',
    url: statistics,
  },
  {
    id: 'statistics-causation',
    subject: '统计学',
    term: '相关与因果',
    english: 'Correlation, causation',
    definition: '两个量一起变化，不代表一个导致另一个，可能另有共同原因。',
    example: '冷饮销量和溺水人数一起上升，背后是天气变热。',
    question: '这个关联背后还有谁？',
    url: statistics,
  },
  {
    id: 'psychology-confirmation',
    subject: '心理学',
    term: '确认偏误',
    english: 'Confirmation bias',
    definition: '倾向于寻找和记住支持自己已有看法的信息。',
    example: '认定某个库很慢以后，只会留意到它慢的时候。',
    question: '你主动找过反对的证据吗？',
    url: psychology,
  },
  {
    id: 'psychology-flow',
    subject: '心理学',
    term: '心流',
    english: 'Flow',
    definition: '挑战与能力相当、目标清晰、反馈及时时，人会完全投入其中。',
    example: '调试到忘了时间，往往是因为问题的难度刚好够得着。',
    question: '什么任务最容易让你投入？',
    url: psychology,
  },
  {
    id: 'psychology-planning',
    subject: '心理学',
    term: '计划谬误',
    english: 'Planning fallacy',
    definition: '预估自己的任务时，常常低估所需时间，即使以前多次超时。',
    example: '“这个功能半天就能做完”，上次也是这么说的。',
    question: '上次的估计实际花了几倍？',
    url: psychology,
  },
  {
    id: 'math-exponential',
    subject: '数学',
    term: '指数增长',
    english: 'Exponential growth',
    definition: '每段时间按固定比例增长，增长量本身也越来越大。',
    example: '每天进步百分之一，一年后大约是原来的三十七倍。',
    question: '什么值得每天复利一点点？',
    url: 'https://openstax.org/details/books/college-algebra-2e',
  },
  {
    id: 'math-expected',
    subject: '数学',
    term: '期望值',
    english: 'Expected value',
    definition: '每种结果乘以它的概率再相加，衡量长期平均的收益。',
    example: '一成概率赚一千，比稳赚五十的期望更高，风险也更大。',
    question: '这件事的期望值算过吗？',
    url: statistics,
  },
  {
    id: 'math-contradiction',
    subject: '数学',
    term: '反证法',
    english: 'Proof by contradiction',
    definition: '先假设结论不成立，推出矛盾，从而证明结论成立。',
    example: '假设根号二能写成最简分数，会推出分子分母都是偶数。',
    question: '如果你错了，会推出什么？',
    url: 'https://openstax.org/details/books/contemporary-mathematics',
  },
  {
    id: 'biology-feedback',
    subject: '生物学',
    term: '反馈回路',
    english: 'Feedback loop',
    definition: '结果反过来影响原因：正反馈放大变化，负反馈让系统稳定。',
    example: '体温升高时出汗散热，体温回落后停止，这是负反馈。',
    question: '工作里有哪个放大的回路？',
    url: 'https://openstax.org/details/books/biology-2e',
  },
]

export const PROMPTS: Prompt[] = [
  {
    id: 'reverse',
    tag: '反向思考',
    lead: '换个方向想：',
    question: ['想让项目变得难用，', '你会加哪三个设计？'],
    follow: '再看看：其中有没有一个已经存在？',
  },
  {
    id: 'subtract',
    tag: '做减法',
    lead: '今天只允许删掉一件事：',
    question: ['按钮、规则、例会里，', '你会删掉哪一个？'],
    follow: '写下删掉之后，谁会第一个发现。',
  },
  {
    id: 'explain',
    tag: '三句话',
    lead: '把今天的问题讲给昨天的自己：',
    question: ['发生了什么？', '为什么值得做？'],
    follow: '再加一句：下一步怎么验证。',
  },
  {
    id: 'counterexample',
    tag: '找反例',
    lead: '为你最确信的判断找一个反例：',
    question: ['什么情况下，', '它会是错的？'],
    follow: '先缩小适用范围，再决定要不要推翻。',
  },
  {
    id: 'notice',
    tag: '观察',
    lead: '离开屏幕，看一眼周围：',
    question: ['身边有什么', '你从没注意过？'],
    follow: '用一句话描述它，不评价好坏。',
  },
  {
    id: 'small',
    tag: '十分钟',
    lead: '如果今天只能完成一件小事：',
    question: ['哪件事能让明天', '开始得更轻松？'],
    follow: '把它写成十分钟内能做完的动作。',
  },
  {
    id: 'premortem',
    tag: '事前验尸',
    lead: '假设三个月后项目失败了：',
    question: ['最可能的原因', '是什么？'],
    follow: '现在能做哪一件事来避免它？',
  },
  {
    id: 'whys',
    tag: '五个为什么',
    lead: '挑一个最近遇到的问题：',
    question: ['连续问五次', '“为什么”。'],
    follow: '最后一个答案，往往才是根因。',
  },
  {
    id: 'newcomer',
    tag: '换位',
    lead: '想一位会用你产品的人：',
    question: ['对方第一次打开，', '会卡在哪里？'],
    follow: '把那一步改到不用解释也能懂。',
  },
  {
    id: 'half',
    tag: '极限',
    lead: '如果时间只剩一半：',
    question: ['你会砍掉', '哪一半功能？'],
    follow: '被砍掉的部分，真的必要吗？',
  },
  {
    id: 'tenfold',
    tag: '十倍',
    lead: '把目标放大十倍：',
    question: ['现在的做法', '还行得通吗？'],
    follow: '行不通的话，什么需要彻底换掉？',
  },
  {
    id: 'teach',
    tag: '教给别人',
    lead: '把正在学的东西讲给新人听：',
    question: ['哪一步你自己', '也说不清楚？'],
    follow: '说不清的地方，就是下一步要学的。',
  },
  {
    id: 'defaults',
    tag: '默认值',
    lead: '看看你每天自动做的事情：',
    question: ['哪个默认选择', '值得重新想想？'],
    follow: '比如打开的第一个应用、会议的时长。',
  },
  {
    id: 'first-step',
    tag: '最小一步',
    lead: '面对一件一直拖着的事：',
    question: ['最小的第一步', '是什么？'],
    follow: '小到两分钟内就能开始。',
  },
  {
    id: 'bystander',
    tag: '旁观者',
    lead: '如果朋友遇到你现在的处境：',
    question: ['你会给对方', '什么建议？'],
    follow: '这条建议，你自己愿意采纳吗？',
  },
  {
    id: 'thanks',
    tag: '感谢',
    lead: '回想这一周：',
    question: ['谁帮了你，', '却没被感谢？'],
    follow: '今天找个机会，跟对方说一声。',
  },
]

/** Characters the large 32px lines use; the firmware strike must contain each of them. */
export function heroCharacters(): string[] {
  const text =
    CONCEPTS.map((c) => c.term).join('') + PROMPTS.map((p) => p.question.join('')).join('')
  return [...new Set(Array.from(text))].sort()
}
