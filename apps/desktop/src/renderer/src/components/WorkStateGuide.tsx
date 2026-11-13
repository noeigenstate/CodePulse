import { useId, useState } from 'react'
import { WORK_STATE_CODES, WORK_STATE_LABELS, type UiLocale } from '@codepulse/shared'

export function WorkStateGuide({ locale }: { locale: UiLocale }): JSX.Element {
  const [open, setOpen] = useState(false)
  const tableId = useId()
  const labels = WORK_STATE_CODES.filter(
    (state, index, all) =>
      all.findIndex((other) => WORK_STATE_LABELS.zh[other] === WORK_STATE_LABELS.zh[state]) ===
      index,
  )
  return (
    <section className="page-card product-state-guide">
      <h2>
        <button
          className="product-state-guide-toggle"
          type="button"
          aria-expanded={open}
          aria-controls={tableId}
          onClick={() => setOpen((current) => !current)}
        >
          {locale === 'zh' ? '状态中英文对照' : 'State guide · English / 中文'}
        </button>
      </h2>
      <table id={tableId} hidden={!open} className="text-sm">
        <thead>
          <tr>
            <th>中文</th>
            <th>English</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((state) => (
            <tr key={state}>
              <td>{WORK_STATE_LABELS.zh[state]}</td>
              <td>{WORK_STATE_LABELS.en[state]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
