import type { ReactNode } from 'react'

/**
 * The single page-header pattern for every product page: 24px/600 title, 13px muted subtitle,
 * optional actions on the right (at most one solid primary per screen). No eyebrow text.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  /** Optional extra line under the subtitle (e.g. a link back to the playlist). */
  children?: ReactNode
}): JSX.Element {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  )
}
