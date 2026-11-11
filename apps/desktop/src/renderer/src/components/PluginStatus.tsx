export function PluginStatus({ state, reason }: { state: string; reason?: string }): JSX.Element {
  const mark = state === '正常' ? 'filled' : state === '生成失败' ? 'square' : 'ring'
  return (
    <div className="plugin-state" data-state={state}>
      <span className="plugin-state-label">
        <i className="plugin-state-mark" data-mark={mark} aria-hidden="true" />
        {state}
      </span>
      {reason && <p className="page-muted">{reason}</p>}
    </div>
  )
}
