/**
 * Privacy helpers for the usage page. First prompts can carry paths and credentials, so the page
 * hides them by default and masks anything that looks like a secret even after the user reveals it.
 */
export const MASK = '••••••'

const SECRET_WORDS =
  'password|passwd|passphrase|pwd|token|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|key'
/** Quoted values are capped so an unclosed quote cannot make every match scan to the end of the text. */
const VALUE = `(?:"[^"\\n]{0,200}"|'[^'\\n]{0,200}'|[^\\s,;"'}\\])]+)`
/** Everything up to the next whitespace or punctuation, including non-ASCII text. */
const LOOSE = `[^\\s,;:，。；、！？!?"'“”‘’()（）\\[\\]【】<>《》]+`

/*
 * Every pattern is anchored on a literal word and uses bounded repeats, so matching stays linear
 * in the text length (a 20,000-character run of "key." takes a few milliseconds at most).
 */
const RULES: [RegExp, string][] = [
  // Authorization: Bearer abc / Authorization=Basic abc / authorization: abc
  [
    new RegExp(
      `\\b(authorization)(["']?\\s*[:=]\\s*)(?:(?:bearer|basic|token)\\s+)?${VALUE}`,
      'gi',
    ),
    `$1$2${MASK}`,
  ],
  // https://user:pass@host
  [/(:\/\/[^\s:/@]{1,100}:)[^\s@/]{1,200}(@)/g, `$1${MASK}$2`],
  // curl -u admin:hunter2 / --user admin:hunter2
  [/(^|\s)(-u\s+|--user[\s=]+)(["']?)([^\s:'"]{1,100}):[^\s'"]{1,200}/g, `$1$2$3$4:${MASK}`],
  // password: "x", token=abc, api_key: 'abc', DB_PASSWORD=abc, "secret": "abc"; the word may sit inside a longer name
  [
    new RegExp(`((?:${SECRET_WORDS})[A-Za-z0-9_.-]{0,32})(["']?\\s*[:=]\\s*)${VALUE}`, 'gi'),
    `$1$2${MASK}`,
  ],
  // pass=abc / pw: abc (short words need a word boundary, or "bypass: true" would be masked)
  [new RegExp(`\\b(pass|pw)(["']?\\s*[:=]\\s*)${VALUE}`, 'gi'), `$1$2${MASK}`],
  // --password hunter2 / --token abc
  [
    /(--?(?:password|passwd|passphrase|pass|pwd|pw|token|secret|api-?key|apikey|access-?key)\s+)(?!-)\S{1,200}/gi,
    `$1${MASK}`,
  ],
  // "password is hunter2"
  [/\b(password|passcode|token|secret)(\s+is\s+)\S{1,200}/gi, `$1$2${MASK}`],
  // 密码是xxx / 密码：xxx / 口令=xxx / 密码 xxx / 我的密码xxx; the value runs to the next space or punctuation
  [new RegExp(`(密码|口令|密钥|令牌)(\\s*(?:是|为|:|：|=)?\\s*)${LOOSE}`, 'g'), `$1$2${MASK}`],
  // Bearer eyJ...
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1${MASK}`],
  // Well-known key shapes.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
  [
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{16,}/g,
    MASK,
  ],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  // Any other long mixed letter+digit run with no separators reads as a key. Starting only at the
  // beginning of a run (and bounding the look-aheads) keeps this linear on long dashed runs.
  [
    /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]{0,80}\d)(?=[A-Za-z0-9_-]{0,80}[A-Za-z])[A-Za-z0-9_-]{32,}/g,
    MASK,
  ],
]

/** Replace anything that looks like a credential with a mask, leaving the surrounding words. */
export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}

/** Longest title we show after reveal, so one pasted prompt cannot stretch a row. */
const MAX_TITLE = 160

/**
 * Label for one conversation in the rounds list. Hidden by default: the project name plus a
 * marker; revealed: the masked, trimmed first prompt.
 */
export function sessionTitle(
  project: string,
  title: string | undefined,
  revealed: boolean,
  copy: { hidden: string; untitled: string },
): string {
  const text = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return `${project} · ${copy.untitled}`
  if (!revealed) return `${project} · ${copy.hidden}`
  // Cut first, then mask: the work is bounded by the display limit, and a cut inside a word is
  // pulled back to the previous space so half a key never survives as an unmasked prefix.
  let shown = text
  if (text.length > MAX_TITLE) {
    shown = text.slice(0, MAX_TITLE)
    if (!/\s/.test(text.charAt(MAX_TITLE))) {
      const space = shown.lastIndexOf(' ')
      if (space > MAX_TITLE - 48) shown = shown.slice(0, space)
    }
  }
  return `${project} · ${redactSecrets(shown)}${text.length > MAX_TITLE ? '…' : ''}`
}

/**
 * Display names for a project list. Projects that share a folder name get the shortest path tail
 * that tells them apart, e.g. `wt-a · scratchpad/wt-a` and `wt-a · tmp/wt-a`.
 */
export function projectLabels(projects: { name: string; path: string }[]): string[] {
  const segments = (path: string) => path.split(/[\\/]+/).filter(Boolean)
  const byName = new Map<string, number[]>()
  projects.forEach((project, index) => {
    const group = byName.get(project.name)
    if (group) group.push(index)
    else byName.set(project.name, [index])
  })
  const labels = projects.map((project) => project.name)
  for (const group of byName.values()) {
    if (group.length < 2) continue
    const parts = group.map((index) => segments(projects[index]!.path))
    const longest = Math.max(...parts.map((p) => p.length), 2)
    for (let depth = 2; depth <= longest; depth++) {
      const tails = parts.map((p) => p.slice(-depth).join('/'))
      if (new Set(tails).size === tails.length || depth === longest) {
        group.forEach((index, i) => {
          if (tails[i]) labels[index] = `${projects[index]!.name} · ${tails[i]}`
        })
        break
      }
    }
  }
  return labels
}
