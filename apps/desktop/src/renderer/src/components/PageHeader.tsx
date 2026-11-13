import type { ReactNode } from 'react'

/**
 * The single page-header pattern for every product page. The sidebar's selected row already names
 * the page, so the title is a screen-reader heading only; a visible row appears just when the page
 * has actions to put on its right (at most one solid primary per screen).
 */
export function PageHeader({
  title,
  actions,
}: {
  title: string
  actions?: ReactNode
}): JSX.Element {
  const heading = <h1 className="page-sr">{title}</h1>
  if (!actions) return heading
  return (
    <header className="page-header">
      {heading}
      <div className="page-header-actions">{actions}</div>
    </header>
  )
}
