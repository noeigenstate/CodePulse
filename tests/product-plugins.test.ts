import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_AMBIENT,
  DEFAULT_INK_PLAN,
  normalizeShellPreferences,
  productDestination,
  type AmbientCard,
  type AmbientSnapshot,
} from '@codepulse/shared'
import {
  CATEGORIES,
  localPluginEnabled,
  localPluginItemLabel,
  localPluginRows,
  pluginInkPlan,
} from '../apps/desktop/src/renderer/src/lib/localPlugins.js'

function snapshot(): AmbientSnapshot {
  return {
    config: structuredClone(DEFAULT_AMBIENT),
    hasKey: false,
    collecting: false,
    lastCheckedAt: 0,
    nextCheckAt: 0,
    nextAutoAt: null,
    sourceStatus: { x: '离线可用', meme: '尚未检查' },
    cards: [],
    activeId: null,
    shownToday: 0,
    xRequestsToday: 0,
    pausedReason: '',
  }
}

test('surface navigation and legacy links resolve against the selected target', async () => {
  const { PRODUCT_NAV, TARGET_NAMES } =
    await import('../apps/desktop/src/renderer/src/lib/productNavigation.js')
  assert.deepEqual(
    PRODUCT_NAV.map(({ id, label, english, group }) => [id, label, english, group]),
    [
      ['window', '工作台', 'Workbench', 'workspace'],
      ['overlay', '悬浮窗', 'Overlay', 'workspace'],
      ['ink', '墨水屏设备', 'E-paper Device', 'devices'],
      ['plugins', '插件', 'Plugins', 'devices'],
      ['usage', '用量与费用', 'Usage & cost', 'analytics'],
    ],
  )
  assert.deepEqual(TARGET_NAMES.hud, ['悬浮窗', 'Overlay'])
  for (const [target, page] of [
    ['desktop', 'window'],
    ['hud', 'overlay'],
    ['ink', 'ink'],
  ] as const) {
    for (const view of ['control', 'work', 'overview', 'screen'] as const) {
      assert.deepEqual(productDestination(view, target), { page })
      const saved = normalizeShellPreferences({ view, target })
      assert.deepEqual(productDestination(saved.view, saved.target), { page })
      assert.equal(saved.target, target)
    }
  }
  assert.deepEqual(productDestination('control'), { page: 'window' })
  assert.deepEqual(productDestination('usage', 'hud'), { page: 'usage' })
  assert.deepEqual(productDestination('ambient'), { page: 'plugins' })
  assert.deepEqual(productDestination('assistant'), { page: 'plugins', pluginId: 'local:todo' })
  for (const page of ['window', 'overlay', 'ink', 'plugins', 'settings'] as const)
    assert.deepEqual(productDestination(page), { page })
})

test('local plugin categories exclude the old combined platform category and count their own cards', () => {
  assert.deepEqual(
    CATEGORIES.map((category) => category.id),
    [
      'concept',
      'prompt',
      'pet',
      'calendar',
      'news',
      'social',
      'local',
      'life',
      'tools',
      'holiday',
      'headlines',
    ],
  )
  const state = snapshot()
  state.cards = [
    { kind: 'pet' },
    { kind: 'pet' },
    { kind: 'x' },
    { kind: 'meme' },
    { kind: 'image' },
    { kind: 'note' },
    { kind: 'search', topic: 'tools' },
    { kind: 'search', topic: 'holiday' },
    { kind: 'search', topic: 'news' },
    { kind: 'plugin' },
  ] as AmbientCard[]
  const rows = localPluginRows(state, state.config)
  const row = (id: string) => rows.find((item) => item.id === `local:${id}`)!
  assert.equal(row('pet').count, 1)
  assert.equal(row('social').count, 2)
  assert.equal(row('local').count, 2)
  assert.equal(row('local').enabled, null)
  assert.equal(row('local').state, '仅手动')
  for (const id of ['tools', 'holiday', 'headlines']) assert.equal(row(id).count, 1)
  assert.equal(
    rows.reduce((total, item) => total + item.count, 0),
    8,
  )
})

test('local plugin labels retain long content for two-line wrapping', () => {
  const text = '这是用于预览选择的完整卡片内容，'.repeat(8)
  const card: AmbientCard = {
    id: 'long-card',
    kind: 'concept',
    source: '概念卡',
    text: `${text}\n第二行`,
    url: '',
    publishedAt: 0,
    expiresAt: 0,
    score: 0,
  }
  assert.equal(localPluginItemLabel(card), `${text} 第二行`)
  assert.equal(
    localPluginItemLabel({ ...card, kind: 'news', source: '来源' }),
    `来源 · ${text} 第二行`,
  )
})

test('local plugin enablement uses independent flags and treats missing paid-source keys as setup', () => {
  const state = snapshot()
  const config = state.config
  config.conceptsEnabled = false
  config.promptsEnabled = true
  config.xEnabled = false
  config.memeEnabled = true
  config.yuanbao.weatherEnabled = false
  config.yuanbao.goldEnabled = true
  config.yuanbao.stocksEnabled = false
  config.yuanbao.toolsEnabled = false
  config.yuanbao.holidayEnabled = true
  config.yuanbao.newsEnabled = false
  assert.equal(localPluginEnabled('concept', config), false)
  assert.equal(localPluginEnabled('prompt', config), true)
  assert.equal(localPluginEnabled('social', config), true)
  assert.equal(localPluginEnabled('life', config), true)
  assert.equal(localPluginEnabled('tools', config), false)
  assert.equal(localPluginEnabled('holiday', config), true)
  assert.equal(localPluginEnabled('headlines', config), false)
  const life = localPluginRows(state, config).find((row) => row.id === 'local:life')!
  assert.equal(life.enabled, false)
  assert.equal(life.disabled, true)
  assert.equal(life.state, '需要设置')
  assert.match(life.reason, /密钥/)
  assert.ok(localPluginRows(undefined, config).every((row) => row.disabled))
})

test('disabled sources do not leak stale errors into the installed plugin list', () => {
  const state = snapshot()
  state.config.newsEnabled = false
  state.config.xEnabled = false
  state.config.memeEnabled = true
  state.sourceStatus = { x: '密钥错误', meme: '尚未检查', news: '访问失败' }
  let rows = localPluginRows(state, state.config)
  assert.equal(rows.find((row) => row.id === 'local:news')!.state, '已关闭')
  assert.equal(rows.find((row) => row.id === 'local:news')!.reason, '')
  assert.equal(rows.find((row) => row.id === 'local:social')!.state, '正常')
  state.config.newsEnabled = true
  state.sourceStatus.meme = '网络连接失败'
  rows = localPluginRows(state, state.config)
  assert.equal(rows.find((row) => row.id === 'local:news')!.reason, '访问失败')
  assert.equal(rows.find((row) => row.id === 'local:social')!.state, '生成失败')
  assert.equal(rows.find((row) => row.id === 'local:social')!.reason, '网络连接失败')
})

test('plugin display switches preserve work, the other slot, timing and their input plan', () => {
  const plan = { ...DEFAULT_INK_PLAN, items: ['work', 'ambient', 'todos'] as const }
  const original = { ...plan, items: [...plan.items] }
  const noAmbient = pluginInkPlan(original, 'ambient', false)
  assert.deepEqual(noAmbient.items, ['work', 'todos'])
  assert.equal(noAmbient.intervalMinutes, original.intervalMinutes)
  assert.deepEqual(pluginInkPlan(noAmbient, 'ambient', true).items, ['work', 'todos', 'ambient'])
  assert.deepEqual(pluginInkPlan(original, 'todos', false).items, ['work', 'ambient'])
  assert.deepEqual(original.items, ['work', 'ambient', 'todos'])
  assert.equal(pluginInkPlan({ ...original, mode: 'single' }, 'todos', true).mode, 'cycle')
  assert.deepEqual(pluginInkPlan(original, 'todos', true).items, ['work', 'ambient', 'todos'])
})

test('platform logos resolve against the configured origin and reject malformed or external URLs', async () => {
  const { platformLogo } =
    await import('../apps/desktop/src/renderer/src/lib/pluginPresentation.js')
  assert.equal(
    platformLogo('http://127.0.0.1:18080', '/api/v1/plugins/example.test/logo?v=abc'),
    'http://127.0.0.1:18080/api/v1/plugins/example.test/logo?v=abc',
  )
  assert.equal(platformLogo('invalid', '/logo'), null)
  assert.equal(platformLogo('http://127.0.0.1:18080', 'https://other.test/logo'), null)
  assert.equal(platformLogo('http://127.0.0.1:18080', 'data:image/png;base64,abc'), null)
  assert.equal(platformLogo('http://127.0.0.1:18080', null), null)
})

test('cloud plugin rows use per-plugin card counts and preserve withdrawn installations for uninstall', async () => {
  const { cloudPluginRows } =
    await import('../apps/desktop/src/renderer/src/lib/pluginPresentation.js')
  const rows = cloudPluginRows(
    [
      {
        pluginId: 'example.one',
        installedAt: 1,
        settings: {},
        enabled: true,
        status: { generatedAt: null, error: '' },
        plugin: null,
      },
      {
        pluginId: 'example.two',
        installedAt: 1,
        settings: {},
        enabled: false,
        status: { generatedAt: 1, error: '旧错误' },
        plugin: null,
      },
    ],
    'http://127.0.0.1:18080',
    [
      { kind: 'plugin', plugin: { id: 'example.one' } },
      { kind: 'plugin', plugin: { id: 'example.one' } },
      { kind: 'plugin', plugin: { id: 'example.two' } },
      { kind: 'note' },
    ] as AmbientCard[],
  )
  assert.equal(rows[0]!.name, 'example.one')
  assert.equal(rows[0]!.state, '需要设置')
  assert.equal(rows[0]!.count, '2 张')
  assert.match(rows[0]!.reason!, /已下架/)
  assert.equal(rows[1]!.state, '已关闭')
  assert.equal(rows[1]!.count, '1 张')
  assert.doesNotMatch(rows[1]!.reason!, /旧错误/)
  assert.equal(rows[0]!.install!.pluginId, 'example.one')
})

test('cloud lists keep the last successful installations offline and accept an authoritative empty list', async () => {
  const { retainCloudPlugins } =
    await import('../apps/desktop/src/renderer/src/lib/pluginPresentation.js')
  const previous = {
    state: 'ok' as const,
    platformOrigin: 'http://127.0.0.1:18080',
    plugins: [
      {
        pluginId: 'example.one',
        installedAt: 1,
        enabled: true,
        settings: {},
        plugin: null,
        status: { generatedAt: null, error: '' },
      },
    ],
  }
  const offline = retainCloudPlugins(previous, {
    state: 'offline',
    platformOrigin: '',
    plugins: [],
  })
  assert.equal(offline.state, 'offline')
  assert.deepEqual(offline.plugins, previous.plugins)
  assert.equal(offline.platformOrigin, previous.platformOrigin)
  const empty = { ...previous, plugins: [] }
  assert.deepEqual(retainCloudPlugins(offline, empty).plugins, [])
  assert.deepEqual(retainCloudPlugins(undefined, offline), offline)
})

test('missing X credentials request setup without disabling the social off switch', () => {
  const state = snapshot()
  state.config.xEnabled = true
  state.config.memeEnabled = false
  state.sourceStatus.x = '请先填写 API 密钥'
  const row = localPluginRows(state, state.config).find((item) => item.id === 'local:social')!
  assert.equal(row.state, '需要设置')
  assert.match(row.reason, /密钥/)
  assert.equal(row.enabled, true)
  assert.equal(row.disabled, false)
})

test('cloud cards select the active card of that plugin, fall back to its first card and handle empty feeds', async () => {
  const { pluginPreviewCard } =
    await import('../apps/desktop/src/renderer/src/lib/pluginPresentation.js')
  const cards = [
    { id: 'note', kind: 'note', plugin: { id: 'example.one' } },
    { id: 'other', kind: 'plugin', plugin: { id: 'example.two' } },
    { id: 'first', kind: 'plugin', plugin: { id: 'example.one' } },
    { id: 'active', kind: 'plugin', plugin: { id: 'example.one' } },
  ] as AmbientCard[]
  assert.equal(pluginPreviewCard(cards, 'example.one', 'active')?.id, 'active')
  assert.equal(pluginPreviewCard(cards, 'example.one', 'other')?.id, 'first')
  assert.equal(pluginPreviewCard([], 'example.one'), undefined)
})

test('cloud rows and detail logos share the HN glyph and actionable credential status', async () => {
  const { cloudPluginRows } =
    await import('../apps/desktop/src/renderer/src/lib/pluginPresentation.js')
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { PluginLogo } = await import('../apps/desktop/src/renderer/src/components/PluginList.js')
  const [row] = cloudPluginRows(
    [
      {
        pluginId: 'example.hn',
        installedAt: 1,
        enabled: true,
        settings: {},
        status: { generatedAt: null, error: '请配置 API key' },
        plugin: {
          id: 'example.hn',
          name: 'Hacker News',
          summary: '',
          description: '',
          kind: 'builtin',
          version: '1.0.0',
          developer: 'Example',
          installs: 1,
          settings: [],
          updatedAt: 1,
          logoUrl: null,
        },
      },
    ],
    '',
    [],
  )
  assert.equal(row!.glyph, 'HN')
  assert.equal(row!.state, '需要设置')
  assert.match(
    renderToStaticMarkup(
      createElement(PluginLogo, { name: row!.name, glyph: row!.glyph, sources: [] }),
    ),
    />HN<\/span>/,
  )
  assert.match(
    renderToStaticMarkup(createElement(PluginLogo, { name: '概念卡', sources: [] })),
    />概<\/span>/,
  )
})

test('all plugin statuses render a mark alongside the status word', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { PluginStatus } =
    await import('../apps/desktop/src/renderer/src/components/PluginStatus.js')
  for (const [state, mark] of [
    ['正常', 'filled'],
    ['已关闭', 'ring'],
    ['仅手动', 'ring'],
    ['生成失败', 'square'],
    ['需要设置', 'ring'],
  ] as const) {
    const html = renderToStaticMarkup(createElement(PluginStatus, { state, reason: '原因' }))
    assert.ok(html.includes(`data-mark="${mark}"`))
    assert.ok(html.includes(state!))
    assert.ok(html.includes('原因'))
  }
})

test('store theme rewrites preserve route and embed mode without reusing a login code', async () => {
  const { pluginStoreThemeUrl } =
    await import('../apps/desktop/src/renderer/src/lib/pluginStoreTheme.js')
  const initial =
    'https://platform.example/?theme=dark&code=once&embed=desktop#/plugin/example.test'
  const light = new URL(pluginStoreThemeUrl(initial, 'light'))
  assert.equal(light.searchParams.get('theme'), 'light')
  assert.equal(light.searchParams.has('code'), false)
  assert.equal(light.searchParams.get('embed'), 'desktop')
  assert.equal(light.hash, '#/plugin/example.test')
  const dark = new URL(pluginStoreThemeUrl(light.href, 'dark'))
  assert.equal(dark.searchParams.get('theme'), 'dark')
  assert.equal(dark.hash, light.hash)
  assert.equal(dark.searchParams.has('code'), false)
})

test('plugins and the device are peers and only the current page is selected', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { ProductFrame } =
    await import('../apps/desktop/src/renderer/src/components/ProductFrame.js')
  type Navigation =
    import('../apps/desktop/src/renderer/src/components/ProductFrame.js').ProductNavigation
  const html = renderToStaticMarkup(
    createElement(ProductFrame, {
      product: { view: 'plugins', target: 'ink', error: '' } as Navigation,
      locale: 'zh',
      children: null,
    }),
  )
  const device = html.match(/<button[^>]*data-view="ink"[^>]*>/)![0]
  const plugins = html.match(/<button[^>]*data-view="plugins"[^>]*>/)![0]
  assert.doesNotMatch(device, /aria-current/)
  assert.doesNotMatch(html, /data-section-active|product-nav-child|data-parent|is-child/)
  assert.doesNotMatch(html, /待查看|product-nav-count/)
  assert.match(plugins, /aria-current="page"/)
  assert.match(html, /<span class="product-nav-label">插件<\/span>/)
  assert.doesNotMatch(plugins, /aria-label="墨水屏设备/)
  assert.equal((html.match(/data-view="(?:window|overlay|ink|plugins|usage)"/g) ?? []).length, 5)
})

test('device row status is a decorative mark; the full state is in the name and one word is announced', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { InkNavAnnouncer, InkNavStatus } =
    await import('../apps/desktop/src/renderer/src/components/InkStatusBar.js')
  const { inkNavText } = await import('../apps/desktop/src/renderer/src/lib/inkStatusText.js')
  type InkStatus = import('@codepulse/shared').InkScreenStatus
  const now = 1_800_000_000_000
  const base: InkStatus = {
    connection: 'disconnected',
    lastSeenAt: null,
    showing: { kind: 'work' },
    temporary: null,
    mode: 'cycle',
    current: 'work',
    next: null,
    slotNote: '',
    updatedAt: now,
  }
  const cases: { status: InkStatus; mark: string; word: string; name: string }[] = [
    { status: base, mark: 'hollow', word: '未连接', name: '墨水屏设备，未连接' },
    {
      status: { ...base, connection: 'server-off' },
      mark: 'hollow',
      word: '服务未开启',
      name: '墨水屏设备，服务未开启 · 启动时设置 CODEPULSE_DEVICE_SERVER_ENABLED=1',
    },
    {
      status: { ...base, connection: 'connected' },
      mark: 'filled',
      word: '已连接',
      name: '墨水屏设备，已连接 · 仅工作画面 · 正在显示：工作画面 · 节目单里只有工作画面',
    },
    {
      status: {
        ...base,
        connection: 'connected',
        showing: { kind: 'todos', title: '待办' },
        temporary: { kind: 'todos', title: '待办', until: now + 8 * 60_000 },
        slotNote: '14:30 提醒',
      },
      mark: 'filled',
      word: '已连接',
      name: '墨水屏设备，已连接 · 临时展示：待办 · 剩 8 分钟 · 14:30 提醒',
    },
  ]
  for (const { status, mark, word, name } of cases) {
    const text = inkNavText(status, now, 'zh')
    assert.deepEqual([text.dot, text.word, text.name], [mark, word, name])
    // The mark is decoration only: the row's own button carries the name and the click.
    const html = renderToStaticMarkup(createElement(InkNavStatus, { text }))
    assert.ok(html.includes(`class="product-nav-status is-${mark}"`), html)
    assert.ok(html.includes('aria-hidden="true"'))
    assert.doesNotMatch(html, /<button|<a\b|tabindex|role=|aria-pressed|onclick|ⓘ|✕|打开墨水屏/)
    // The live region repeats the connection only, never the countdown or the note.
    assert.equal(
      renderToStaticMarkup(createElement(InkNavAnnouncer, { word: text.word })),
      `<span role="status" class="page-sr">${word}</span>`,
    )
  }
  const offlineTemporary = inkNavText(
    { ...cases[3]!.status, connection: 'disconnected' },
    now,
    'zh',
  )
  assert.equal(offlineTemporary.dot, 'hollow')
  assert.equal(offlineTemporary.word, '未连接')
  assert.match(offlineTemporary.name, /^墨水屏设备，未连接 · 临时展示：待办/)
  assert.equal(
    renderToStaticMarkup(createElement(InkNavAnnouncer, {})),
    '<span role="status" class="page-sr"></span>',
    'present from the start, so later changes are announced',
  )
  const english = inkNavText(base, now, 'en')
  assert.deepEqual([english.word, english.name], ['not connected', 'E-paper Device, not connected'])
  assert.equal(inkNavText({ ...base, connection: 'connected' }, now, 'en').word, 'connected')
})
