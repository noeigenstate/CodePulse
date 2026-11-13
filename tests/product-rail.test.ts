import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasOpenModal,
  isRailShortcut,
  railShortcutHint,
  railStorage,
  readRailCollapsed,
  writeRailCollapsed,
  type RailShortcutEvent,
} from '../apps/desktop/src/renderer/src/lib/railPreference.js'

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const unavailable = {
  getItem(): string | null {
    throw new Error('storage blocked')
  },
  setItem(): void {
    throw new Error('storage blocked')
  },
}

test('the sidebar starts expanded when nothing usable is stored', () => {
  assert.equal(readRailCollapsed(undefined), false)
  assert.equal(readRailCollapsed(new MemoryStorage()), false)
  for (const value of ['', 'true', 'false', '2', 'null', '{}', 'collapsed']) {
    const storage = new MemoryStorage()
    storage.setItem('codepulse.railCollapsed', value)
    assert.equal(readRailCollapsed(storage), false, `stored ${JSON.stringify(value)}`)
  }
})

test('the sidebar state round-trips through one storage key', () => {
  const storage = new MemoryStorage()
  writeRailCollapsed(storage, true)
  assert.deepEqual([...storage.values], [['codepulse.railCollapsed', '1']])
  assert.equal(readRailCollapsed(storage), true)
  writeRailCollapsed(storage, false)
  assert.deepEqual([...storage.values], [['codepulse.railCollapsed', '0']])
  assert.equal(readRailCollapsed(storage), false)
})

test('blocked or missing storage never breaks the sidebar', () => {
  assert.doesNotThrow(() => writeRailCollapsed(undefined, true))
  assert.doesNotThrow(() => writeRailCollapsed(unavailable, true))
  assert.equal(readRailCollapsed(unavailable), false)
})

test('the window storage lookup is absent outside a window and survives a blocked getter', () => {
  assert.equal(railStorage(), undefined)
  const storage = new MemoryStorage()
  try {
    Object.assign(globalThis, { window: { localStorage: storage } })
    assert.equal(railStorage(), storage)
    Reflect.deleteProperty(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    assert.equal(railStorage(), undefined)
  } finally {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

test('the shortcut is written ⌘B on macOS and Ctrl+B elsewhere', () => {
  assert.deepEqual(railShortcutHint('darwin'), { text: '⌘B', aria: 'Meta+B' })
  for (const platform of ['win32', 'linux', undefined]) {
    assert.deepEqual(railShortcutHint(platform), { text: 'Ctrl+B', aria: 'Control+B' })
  }
})

function key(patch: Partial<RailShortcutEvent> = {}): RailShortcutEvent {
  return {
    key: 'b',
    code: 'KeyB',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: { tagName: 'BODY' },
    ...patch,
  }
}

test('the sidebar shortcut accepts only the host platform modifier', () => {
  assert.equal(isRailShortcut(key()), true)
  const command = key({ ctrlKey: false, metaKey: true })
  assert.equal(isRailShortcut(command, 'darwin'), true)
  assert.equal(isRailShortcut(key(), 'darwin'), false)
  for (const platform of ['win32', 'linux', undefined]) {
    assert.equal(isRailShortcut(key(), platform), true)
    assert.equal(isRailShortcut(command, platform), false)
  }
  for (const platform of ['darwin', 'win32', 'linux', undefined]) {
    assert.equal(isRailShortcut(key({ metaKey: true }), platform), false, 'mixed modifiers')
  }
  assert.equal(isRailShortcut(key({ key: 'B' })), true, 'Caps Lock')
  assert.equal(isRailShortcut(key({ target: null })), true)
  assert.equal(isRailShortcut(key({ target: { tagName: 'BUTTON' } })), true)
})

test('the physical key decides, so other layouts work, and the typed key is the fallback', () => {
  assert.equal(isRailShortcut(key({ key: 'и' })), true, 'Russian layout')
  assert.equal(isRailShortcut(key({ key: 'b', code: 'KeyN' })), false, 'Dvorak N')
  assert.equal(isRailShortcut(key({ key: 'v', code: 'KeyV' })), false)
  assert.equal(isRailShortcut(key({ code: '' })), true, 'no code: the typed key')
  assert.equal(isRailShortcut(key({ code: '', key: 'B' })), true)
  assert.equal(isRailShortcut(key({ code: '', key: 'v' })), false)
})

test('other chords leave the sidebar alone', () => {
  assert.equal(isRailShortcut(key({ ctrlKey: false })), false, 'plain B')
  assert.equal(isRailShortcut(key({ shiftKey: true })), false)
  assert.equal(isRailShortcut(key({ altKey: true })), false)
  assert.equal(isRailShortcut(key({ metaKey: true, shiftKey: true })), false)
  assert.equal(isRailShortcut(key({ repeat: true })), false, 'holding the keys down')
})

test('typing fields keep the key; switches, buttons and drop-downs do not', () => {
  const typing = [
    { tagName: 'INPUT' },
    { tagName: 'INPUT', type: 'text' },
    ...['search', 'email', 'password', 'number', 'url', 'tel', 'date', 'time'].map((type) => ({
      tagName: 'INPUT',
      type,
    })),
    { tagName: 'textarea' },
    { tagName: 'DIV', isContentEditable: true },
  ]
  for (const target of typing) {
    assert.equal(isRailShortcut(key({ target })), false, JSON.stringify(target))
  }
  const notTyping = [
    ...['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].map((type) => ({
      tagName: 'INPUT',
      type,
    })),
    { tagName: 'SELECT' },
    { tagName: 'BUTTON' },
  ]
  for (const target of notTyping) {
    assert.equal(isRailShortcut(key({ target })), true, JSON.stringify(target))
  }
})

test('the shortcut yields to earlier handlers', () => {
  assert.equal(isRailShortcut(key({ defaultPrevented: true })), false)
})

test('a modal layer counts only while it is on screen', () => {
  const layer = (visible: boolean, visibility = 'visible') => ({
    getClientRects: () => (visible ? [{}] : []),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility }) } },
  })
  const root = (layers: ReturnType<typeof layer>[]) =>
    ({ querySelectorAll: () => layers }) as unknown as ParentNode
  assert.equal(hasOpenModal(root([])), false)
  assert.equal(hasOpenModal(root([layer(false)])), false, 'a closed drawer is display:none')
  assert.equal(hasOpenModal(root([layer(false), layer(true)])), true)
  assert.equal(
    hasOpenModal(root([layer(true, 'hidden')])),
    false,
    'visibility:hidden is not on screen',
  )
})

async function render() {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { ProductFrame } =
    await import('../apps/desktop/src/renderer/src/components/ProductFrame.js')
  type Navigation =
    import('../apps/desktop/src/renderer/src/components/ProductFrame.js').ProductNavigation
  type FrameProps = Omit<Parameters<typeof ProductFrame>[0], 'product' | 'children'>
  return (props: FrameProps) =>
    renderToStaticMarkup(
      createElement(ProductFrame, {
        ...props,
        product: {
          view: 'window',
          target: 'desktop',
          error: '',
        } as Navigation,
        children: null,
      }),
    )
}

const toggleOf = (html: string) => html.match(/<button[^>]*class="product-rail-toggle"[^>]*>/)?.[0]

test('off Windows the sidebar starts with the switch alone', async () => {
  const frame = await render()
  const zh = frame({ locale: 'zh', platform: 'linux' })
  assert.doesNotMatch(zh, /product-brand/)
  assert.doesNotMatch(zh, /ink-pill/)
  assert.doesNotMatch(zh, /window-titlebar|product-dragbar|has-window-controls/)
  assert.doesNotMatch(zh, /product-rail-logo|product-rail-name/, 'the native title bar says it')
  assert.match(zh, /<aside class="product-rail" data-tip-scope="true"/)
  assert.match(zh, /<div class="product-rail-top"><button/)
  assert.match(toggleOf(zh)!, /aria-label="收起侧边栏"/)
  assert.match(toggleOf(zh)!, /aria-expanded="true"/)
  assert.match(toggleOf(zh)!, /aria-keyshortcuts="Control\+B"/)
  assert.match(zh, />收起侧边栏 · Ctrl\+B<\/span>/)

  const en = frame({ locale: 'en', platform: 'darwin' })
  assert.match(toggleOf(en)!, /aria-label="Collapse sidebar"/)
  assert.match(toggleOf(en)!, /aria-keyshortcuts="Meta\+B"/, 'macOS writes the shortcut as ⌘B')
  assert.match(en, />Collapse sidebar · ⌘B<\/span>/)
  assert.doesNotMatch(frame({ locale: 'zh' }), /has-window-controls/)
})

test('on Windows the sidebar carries the brand and the main area keeps a drag band', async () => {
  const frame = await render()
  const html = frame({ locale: 'zh', platform: 'win32', titleIcon: 'logo.svg' })
  assert.match(html, /<div class="product-frame has-window-controls">/)
  assert.doesNotMatch(html, /window-titlebar/, 'there is no strip across the window')
  assert.match(
    html,
    /<div class="product-rail-top"><img class="product-rail-logo" alt="" aria-hidden="true" src="logo.svg"\/><span class="product-rail-name">CodePulse<\/span><button/,
  )
  assert.match(toggleOf(html)!, /aria-label="收起侧边栏"/)
  assert.match(html, /<div class="product-main"><div class="product-dragbar"><\/div>/)
  assert.match(frame({ locale: 'en', platform: 'win32', titleIcon: 'x' }), />CodePulse<\/span>/)
})

test('a collapsed sidebar keeps the name for assistive technology and offers to expand', async () => {
  const frame = await render()
  const html = frame({ locale: 'zh', collapsed: true, titleIcon: 'logo.svg' })
  assert.match(html, /<aside class="product-rail is-collapsed"/)
  assert.match(toggleOf(html)!, /aria-label="展开侧边栏"/)
  assert.match(toggleOf(html)!, /aria-expanded="false"/)
  assert.match(html, />展开侧边栏 · Ctrl\+B<\/span>/)
  // Labels and the name stay in the DOM (the stylesheet clips them), so every row keeps its name.
  assert.match(html, /<span class="product-rail-name">CodePulse<\/span>/)
  assert.match(html, /<span class="product-nav-label">工作台<\/span>/)
  assert.match(html, /<span class="product-nav-label">设置<\/span>/)
  assert.match(
    html,
    /<span class="product-nav-label">墨水屏设备<\/span><span class="product-tip" aria-hidden="true">墨水屏设备<\/span>/,
  )
  // The language switch loses its native tooltip in favour of the rail's own.
  assert.doesNotMatch(html, /title="Switch to English/)
})

test('the saved sidebar state is read when the window opens', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { useRailCollapsed } =
    await import('../apps/desktop/src/renderer/src/lib/railPreference.js')
  const Probe = () => createElement('i', null, String(useRailCollapsed(true).collapsed))
  const storage = new MemoryStorage()
  assert.equal(renderToStaticMarkup(createElement(Probe)), '<i>false</i>')
  writeRailCollapsed(storage, true)
  try {
    Object.assign(globalThis, { window: { localStorage: storage } })
    assert.equal(renderToStaticMarkup(createElement(Probe)), '<i>true</i>')
  } finally {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

test('an independent screen mounts no sidebar listener and Ctrl+B cannot change its preference', async (t) => {
  const { default: React, createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { useRailCollapsed } =
    await import('../apps/desktop/src/renderer/src/lib/railPreference.js')
  // Flush the hook's effects after its server-rendered mount, without a browser dependency.
  const effects: (() => void | (() => void))[] = []
  t.mock.method(React, 'useEffect', (effect: () => void | (() => void)) => {
    effects.push(effect)
  })
  const storage = new MemoryStorage()
  writeRailCollapsed(storage, true)
  const writes = t.mock.method(storage, 'setItem')
  const keyboard = new EventTarget()
  const listen = t.mock.method(keyboard, 'addEventListener')
  const Probe = ({ enabled }: { enabled: boolean }) =>
    createElement('i', null, String(useRailCollapsed(enabled, 'win32').collapsed))
  const cleanups: (() => void)[] = []
  try {
    Object.assign(globalThis, { window: Object.assign(keyboard, { localStorage: storage }) })
    assert.equal(renderToStaticMarkup(createElement(Probe, { enabled: false })), '<i>true</i>')
    for (const effect of effects.splice(0)) {
      const cleanup = effect()
      if (cleanup) cleanups.push(cleanup)
    }
    assert.equal(listen.mock.callCount(), 0)
    const shortcut = Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'b',
      code: 'KeyB',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    })
    keyboard.dispatchEvent(shortcut)
    assert.equal(shortcut.defaultPrevented, false)
    assert.equal(readRailCollapsed(storage), true)
    assert.equal(writes.mock.callCount(), 0)

    // The same mount harness must observe the listener when the main client enables it.
    renderToStaticMarkup(createElement(Probe, { enabled: true }))
    for (const effect of effects.splice(0)) {
      const cleanup = effect()
      if (cleanup) cleanups.push(cleanup)
    }
    assert.equal(listen.mock.callCount(), 1)
    assert.equal(writes.mock.callCount(), 1)
  } finally {
    cleanups.forEach((cleanup) => cleanup())
    Reflect.deleteProperty(globalThis, 'window')
  }
})

test('page titles are screen-reader headings and only actions make a visible row', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { PageHeader } = await import('../apps/desktop/src/renderer/src/components/PageHeader.js')
  assert.equal(
    renderToStaticMarkup(createElement(PageHeader, { title: '插件' })),
    '<h1 class="page-sr">插件</h1>',
  )
  const withActions = renderToStaticMarkup(
    createElement(PageHeader, {
      title: '用量与费用',
      actions: createElement('button', null, '刷新'),
    }),
  )
  assert.equal(
    withActions,
    '<header class="page-header"><h1 class="page-sr">用量与费用</h1><div class="page-header-actions"><button>刷新</button></div></header>',
  )
})

test('local plugin rows drop the source line the group heading already gives', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { PluginList } = await import('../apps/desktop/src/renderer/src/components/PluginList.js')
  const props = {
    label: '本机插件',
    rows: [
      {
        id: 'local:concept',
        name: '概念卡',
        source: '本机 · 随应用自带',
        enabled: true,
        disabled: false,
        state: '正常',
        count: '24 张',
        reason: '',
      },
    ],
    logos: {},
    selected: undefined,
    busy: false,
    onOpen() {},
    onToggle() {},
  } as unknown as Parameters<typeof PluginList>[0]
  assert.match(renderToStaticMarkup(createElement(PluginList, props)), /本机 · 随应用自带/)
  const quiet = renderToStaticMarkup(createElement(PluginList, { ...props, showSource: false }))
  assert.doesNotMatch(quiet, /随应用自带/)
  assert.match(quiet, /<strong>概念卡<\/strong>/)
})

test('the spending page carries no repeated heading or subtitle', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { uiCopy } = await import('../apps/desktop/src/renderer/src/lib/i18n.js')
  const { UsageDashboard } =
    await import('../apps/desktop/src/renderer/src/components/UsageDashboard.js')
  for (const locale of ['zh', 'en'] as const) {
    const usage = renderToStaticMarkup(
      createElement(UsageDashboard, { locale, copy: uiCopy(locale).usageBoard, active: false }),
    )
    assert.match(usage, /<header class="page-header"><h1 class="page-sr">/)
    assert.doesNotMatch(usage, /<p>|Token、API|API-equivalent/)
  }
})

test('sidebar groups name their rows in the approved order in both languages', async () => {
  const frame = await render()
  for (const [locale, labels, pages] of [
    [
      'zh',
      ['工作空间', '设备与扩展', '数据分析'],
      ['工作台', '悬浮窗', '墨水屏设备', '插件', '用量与费用'],
    ],
    [
      'en',
      ['Workspace', 'Devices &amp; extensions', 'Analytics'],
      ['Workbench', 'Overlay', 'E-paper Device', 'Plugins', 'Usage &amp; cost'],
    ],
  ] as const) {
    const html = frame({ locale })
    assert.deepEqual(
      Array.from(
        html.matchAll(/class="product-nav-group-label">([^<]+)<\/div>/g),
        ([, label]) => label,
      ),
      labels,
    )
    assert.deepEqual(
      Array.from(
        html.matchAll(/class="product-nav-label">([^<]+)<\/span>/g),
        ([, label]) => label,
      ).slice(0, 5),
      pages,
    )
    for (const id of ['workspace', 'devices', 'analytics']) {
      assert.match(html, new RegExp(`role="group" aria-labelledby="product-nav-group-${id}"`))
      assert.match(html, new RegExp(`id="product-nav-group-${id}" class="product-nav-group-label"`))
    }
    assert.doesNotMatch(html, /data-parent|data-section-active|product-nav-child|is-child/)
  }
})

test('the run-status pill reports running tasks or idle in both languages', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { RailStatus, railStatusText } =
    await import('../apps/desktop/src/renderer/src/components/RailStatus.js')
  for (const [locale, tasks, text, state] of [
    ['zh', 0, '运行正常 · 空闲', 'idle'],
    ['zh', 2, '运行正常 · 2 个任务执行中', 'busy'],
    ['zh', 12, '运行正常 · 12 个任务执行中', 'busy'],
    ['en', 0, 'Running · idle', 'idle'],
    ['en', 1, 'Running · 1 task active', 'busy'],
    ['en', 2, 'Running · 2 tasks active', 'busy'],
    ['en', 12, 'Running · 12 tasks active', 'busy'],
  ] as const) {
    assert.equal(railStatusText(tasks, locale), text)
    const html = renderToStaticMarkup(createElement(RailStatus, { tasks, locale }))
    assert.match(html, new RegExp(`class="product-rail-status is-${state}" role="status"`))
    assert.match(html, /class="product-rail-status-dot" aria-hidden="true"/)
    assert.ok(html.includes(`<span class="product-rail-status-text">${text}</span>`))
    const region = html.match(
      /<div class="product-rail-status [^"]+" role="status"[^>]*>(.*?)<\/div>/,
    )![1]!
    assert.doesNotMatch(
      region,
      /product-tip/,
      'off-rail tooltips must not contribute to the pill scroll area',
    )
    assert.match(
      html,
      /<\/div><span class="product-tip"/,
      'the tooltip is a sibling in its positioned wrapper',
    )
    assert.doesNotMatch(html, /tabindex/, 'the expanded pill needs no extra keyboard stop')
  }
})

test('collapsed run status keeps its words for speech and a focusable tooltip above Settings', async () => {
  const frame = await render()
  const html = frame({ locale: 'zh', collapsed: true, runningTasks: 2 })
  assert.match(html, /class="product-rail-status is-busy" role="status" tabindex="0"/)
  assert.match(html, /class="product-rail-status-text">运行正常 · 2 个任务执行中<\/span>/)
  assert.match(html, /class="product-tip" aria-hidden="true">运行正常 · 2 个任务执行中<\/span>/)
  assert.ok(html.indexOf('product-rail-status') < html.indexOf('product-settings-row'))
  assert.doesNotMatch(frame({ locale: 'zh' }), /class="product-rail-status /)
})

test('the overlay page has no repeated h2 and plugins have no page subtitle', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { normalizeShellPreferences } = await import('@codepulse/shared')
  const { ProductControl } =
    await import('../apps/desktop/src/renderer/src/components/ProductControl.js')
  const { PluginManager } =
    await import('../apps/desktop/src/renderer/src/components/PluginManager.js')
  const { uiCopy } = await import('../apps/desktop/src/renderer/src/lib/i18n.js')
  type Navigation =
    import('../apps/desktop/src/renderer/src/components/ProductFrame.js').ProductNavigation
  const product = {
    view: 'overlay',
    target: 'hud',
    shell: { ...normalizeShellPreferences(null), hudAvailable: true, hudVisible: false },
    ready: true,
  } as Navigation
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: new MemoryStorage() },
  })
  try {
    for (const locale of ['zh', 'en'] as const) {
      const overlay = renderToStaticMarkup(
        createElement(ProductControl, {
          product,
          locale,
          active: false,
          desktopPreview: null,
          deviceCopy: uiCopy(locale).settings.deviceProvisioning,
        }),
      )
      assert.doesNotMatch(overlay, /<h2\b/)
      assert.match(overlay, /<h1 class="page-sr">/)
      assert.doesNotMatch(overlay, /class="page-header"/)
      const plugins = renderToStaticMarkup(
        createElement(PluginManager, { product, locale, active: false }),
      )
      assert.match(plugins, /<h1 class="page-sr">插件<\/h1>/)
      assert.doesNotMatch(
        plugins,
        /管理已安装的插件，或从市场添加|class="page-header"|class="page-header-subtitle"/,
      )
      assert.equal(uiCopy(locale).usageBoard.title, locale === 'zh' ? '用量与费用' : 'Usage & cost')
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('settings owns the two independent voice targets and the collapsible bilingual guide', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { SettingsDialog } =
    await import('../apps/desktop/src/renderer/src/components/SettingsDialog.js')
  const { ProductControl } =
    await import('../apps/desktop/src/renderer/src/components/ProductControl.js')
  const { normalizeShellPreferences } = await import('@codepulse/shared')
  const { DEFAULT_DASHBOARD_SETTINGS } =
    await import('../apps/desktop/src/renderer/src/lib/dashboardSettings.js')
  const { uiCopy } = await import('../apps/desktop/src/renderer/src/lib/i18n.js')
  type Navigation =
    import('../apps/desktop/src/renderer/src/components/ProductFrame.js').ProductNavigation
  for (const locale of ['zh', 'en'] as const) {
    const settings = renderToStaticMarkup(
      createElement(SettingsDialog, {
        embedded: true,
        active: false,
        locale,
        copy: uiCopy(locale).settings,
        theme: 'light',
        visibleTools: DEFAULT_DASHBOARD_SETTINGS.visibleTools,
        onClose() {},
        onThemeChange() {},
        onToolVisibilityChange() {},
      }),
    )
    const titles =
      locale === 'zh'
        ? ['语音提醒', '工作台语音提醒', '墨水屏设备语音提醒', '状态中英文对照']
        : [
            'Voice alerts',
            'Workbench voice alerts',
            'E-paper device voice alerts',
            'State guide · English / 中文',
          ]
    assert.ok(settings.includes(`<h2>${titles[0]}</h2>`))
    for (const title of titles.slice(1, 3)) assert.ok(settings.includes(`aria-label="${title}"`))
    assert.equal((settings.match(/class="work-voice-options"/g) ?? []).length, 2)
    for (const note of locale === 'zh'
      ? ['单独保存，即时生效。', '每次等待过程提醒一次；']
      : ['Saved immediately.', 'Each waiting episode alerts once.']) {
      assert.equal(
        settings.split(note).length - 1,
        1,
        'voice guidance is shared by the two outputs',
      )
      assert.ok(settings.indexOf(note) > settings.lastIndexOf('class="work-voice-options"'))
    }
    assert.match(settings, /<section class="page-card product-state-guide"><h2><button/)
    assert.ok(settings.includes(`aria-expanded="false"`))
    assert.ok(settings.includes(`>${titles[3]}</button></h2><table`))
    const guide = settings.slice(
      settings.indexOf('<section class="page-card product-state-guide">'),
    )
    const tableId = /aria-controls="([^"]+)"/.exec(guide)?.[1]
    assert.ok(tableId)
    assert.ok(guide.includes(`<table id="${tableId}" hidden=""`))
    assert.doesNotMatch(settings, /<summary><h2>/)
    for (const label of locale === 'zh'
      ? ['工作台', '墨水屏设备']
      : ['Workbench', 'E-paper Device']) {
      assert.ok(settings.includes(`<summary><span>${label}</span>`))
    }
    assert.ok(
      settings.indexOf('settings-work-voice-targets') < settings.indexOf('product-state-guide'),
    )
    for (const target of ['desktop', 'ink'] as const) {
      const product = {
        target,
        ready: true,
        shell: { ...normalizeShellPreferences(null), hudAvailable: true, hudVisible: false },
      } as Navigation
      const control = renderToStaticMarkup(
        createElement(ProductControl, {
          product,
          locale,
          active: false,
          desktopPreview: createElement('div', { 'data-workbench': true }, 'workbench fixture'),
          deviceCopy: uiCopy(locale).settings.deviceProvisioning,
        }),
      )
      assert.doesNotMatch(control, /work-voice-options|product-state-guide|product-desktop-options/)
      assert.match(control, /<h1 class="page-sr">/)
      assert.doesNotMatch(control, /class="page-header"/)
      if (target === 'desktop') assert.match(control, /data-workbench="true"/)
    }
  }
})
