import { WORK_STATE_CODES, WORK_STATE_LABELS, type UiLocale } from '@codepulse/shared'

export function WorkStateGuide({ locale }: { locale: UiLocale }): JSX.Element {
  const labels = WORK_STATE_CODES.filter(
    (state, index, all) =>
      all.findIndex((other) => WORK_STATE_LABELS.zh[other] === WORK_STATE_LABELS.zh[state]) ===
      index,
  )
  return (
    <details className="product-state-guide">
      <summary>{locale === 'zh' ? '状态中英文对照' : 'State guide · English / 中文'}</summary>
      <table className="text-sm">
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
    </details>
  )
}
