/**
 * Demo frames for the README GIF. Inactive unless the URL has `frame=N`, so the
 * static screenshots captured from dashboard.html are unaffected.
 *
 * Story: agents working → a Claude Code turn finishes (toast + green tray) →
 * another session asks for permission (yellow tray, no toast).
 */
;(() => {
  const params = new URLSearchParams(location.search)
  if (!params.has('frame')) return
  const frame = Number(params.get('frame'))
  const zh = params.get('lang') !== 'en'

  const t = zh
    ? {
        usingTools: '执行工具',
        processing: '处理中',
        done: '已完成',
        waiting: '等待授权',
        now: '刚刚',
        toastTitle: '✅ web-dashboard 已完成',
        toastBody: '给设置页加暗色模式开关',
        tipDone: 'CodePulse · 1 个任务完成未读',
        tipWaiting: 'CodePulse · mobile-app 等你授权',
        tipRunning: 'CodePulse · 3 个任务运行中',
        elapsed: [
          '2 分 31 秒',
          '2 分 44 秒',
          '2 分 58 秒',
          '2 分 58 秒',
          '2 分 58 秒',
          '2 分 58 秒',
        ],
        elapsed2: [
          '1 分 36 秒',
          '1 分 49 秒',
          '2 分 03 秒',
          '2 分 10 秒',
          '2 分 17 秒',
          '2 分 17 秒',
        ],
      }
    : {
        usingTools: 'Using tools',
        processing: 'Processing',
        done: 'Done',
        waiting: 'Needs permission',
        now: 'just now',
        toastTitle: '✅ web-dashboard done',
        toastBody: 'Add a dark mode toggle to settings',
        tipDone: 'CodePulse · 1 finished turn unread',
        tipWaiting: 'CodePulse · mobile-app needs you',
        tipRunning: 'CodePulse · 3 tasks running',
        elapsed: ['2m 31s', '2m 44s', '2m 58s', '2m 58s', '2m 58s', '2m 58s'],
        elapsed2: ['1m 36s', '1m 49s', '2m 03s', '2m 10s', '2m 17s', '2m 17s'],
      }

  const colors = { blue: '#3b82f6', green: '#10b981', amber: '#f59e0b' }
  const claude = document.querySelector('.panel.claude')
  const [webTile, mobileTile] = claude.querySelectorAll('.tile')

  function setState(tile, color, label) {
    tile.querySelector('.pd').className = `pd bg-${color}`
    const badge = tile.querySelector('.tile-actions .badge')
    badge.className = `badge ${color}`
    badge.textContent = label
  }
  function setPanel(color, label) {
    claude.querySelector('.panel-head .status-dot').className = `status-dot bg-${color}`
    const badge = claude.querySelector('.panel-title .badge')
    badge.className = `badge ${color}`
    badge.textContent = label
  }
  function setText(el, text) {
    el.removeAttribute('data-i18n')
    el.textContent = text
  }

  const webDone = frame >= 2
  const mobileWaiting = frame >= 4
  setState(webTile, webDone ? 'green' : 'blue', webDone ? t.done : t.usingTools)
  setState(mobileTile, mobileWaiting ? 'amber' : 'blue', mobileWaiting ? t.waiting : t.processing)
  setText(webTile.querySelectorAll('.fields strong')[1], t.elapsed[frame] ?? t.elapsed.at(-1))
  setText(mobileTile.querySelectorAll('.fields strong')[1], t.elapsed2[frame] ?? t.elapsed2.at(-1))
  setText(claude.querySelectorAll('.metrics strong')[1], t.now)
  if (mobileWaiting) setPanel('amber', t.waiting)
  else if (webDone) setPanel('green', t.done)
  else setPanel('blue', t.usingTools)

  // Tray color follows the README: yellow (needs you) > green (unread done) > blue (running).
  const trayColor = mobileWaiting ? 'amber' : webDone ? 'green' : 'blue'
  const tip = mobileWaiting ? t.tipWaiting : webDone ? t.tipDone : t.tipRunning

  const style = document.createElement('style')
  style.textContent = `
    body { padding-bottom: 48px; }
    .demo-taskbar { position: fixed; left: 0; right: 0; bottom: 0; height: 48px; z-index: 10;
      background: rgba(32, 32, 38, 0.94); display: flex; align-items: center; justify-content: flex-end;
      gap: 14px; padding: 0 18px; color: #e5e7eb; font-size: 12px; }
    .demo-tray { position: relative; width: 26px; height: 26px; }
    .demo-tray img { width: 26px; height: 26px; border-radius: 6px; }
    .demo-tray i { position: absolute; right: -3px; bottom: -3px; width: 12px; height: 12px;
      border-radius: 999px; border: 2px solid #202026; background: ${colors[trayColor]}; }
    .demo-tip { position: fixed; right: 64px; bottom: 56px; z-index: 11; padding: 6px 10px;
      border-radius: 6px; background: #2b2b33; color: #f3f4f6; font-size: 12px;
      box-shadow: 0 6px 18px rgba(0,0,0,.25); }
    .demo-toast { position: fixed; right: 18px; bottom: 64px; z-index: 12; width: 360px;
      padding: 14px 16px; border-radius: 10px; background: #2b2b33; color: #f3f4f6;
      box-shadow: 0 12px 32px rgba(0,0,0,.3); display: flex; gap: 12px; align-items: flex-start;
      transform: translateX(${frame === 2 ? '24px' : '0'}); opacity: ${frame === 2 ? 0.85 : 1}; }
    .demo-toast img { width: 32px; height: 32px; border-radius: 8px; }
    .demo-toast small { display: block; color: #9ca3af; font-size: 11px; margin-bottom: 2px; }
    .demo-toast b { display: block; font-size: 14px; margin-bottom: 3px; }
    .demo-toast span { font-size: 13px; color: #d1d5db; }
  `
  document.head.append(style)

  const bar = document.createElement('div')
  bar.className = 'demo-taskbar'
  bar.innerHTML = `<div class="demo-tray"><img src="./icon.svg" alt="" /><i></i></div><span>14:32</span>`
  document.body.append(bar)

  if (webDone && !mobileWaiting) {
    const toast = document.createElement('div')
    toast.className = 'demo-toast'
    toast.innerHTML = `<img src="./icon.svg" alt="" /><div><small>CodePulse</small><b>${t.toastTitle}</b><span>${t.toastBody}</span></div>`
    document.body.append(toast)
  } else {
    const tipEl = document.createElement('div')
    tipEl.className = 'demo-tip'
    tipEl.textContent = tip
    document.body.append(tipEl)
  }
})()
