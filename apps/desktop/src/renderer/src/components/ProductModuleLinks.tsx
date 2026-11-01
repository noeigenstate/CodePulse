import { useState } from 'react'
export function ProductModuleLinks({ onOpen }: { onOpen?: () => void }): JSX.Element {
  const [error, setError] = useState('')
  const open = (surface: 'standard' | 'screen') =>
    void window.codepulse
      .openSurface(surface, surface === 'standard' ? 'ambient' : undefined)
      .then(() => onOpen?.())
      .catch(() => setError('请重新启动统一桌面应用。'))
  return (
    <section className="border-t border-line pt-5">
      <h3 className="text-sm font-semibold text-ink">内容与屏幕</h3>
      <p className="mt-2 text-xs leading-5 text-ink-500">在多媒体玩法中管理 X 与 meme，在控制中选择展示端。屏幕工作台也可以独立打开。</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="control-btn px-3 py-2" onClick={() => open('standard')}>
          多媒体玩法（X 与 meme）
        </button>
        <button type="button" className="control-btn px-3 py-2" onClick={() => open('screen')}>
          屏幕工作台 ↗
        </button>
      </div>
      {error && <p role="status">{error}</p>}
    </section>
  )
}
