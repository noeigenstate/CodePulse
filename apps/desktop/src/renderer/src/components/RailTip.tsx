/**
 * Name tooltip for a sidebar control. The control keeps its own accessible name, so this is
 * decoration; the stylesheet decides when it shows (collapsed rail, or the device status mark).
 */
export function RailTip({ children }: { children: string }): JSX.Element {
  return (
    <span className="product-tip" aria-hidden="true">
      {children}
    </span>
  )
}
