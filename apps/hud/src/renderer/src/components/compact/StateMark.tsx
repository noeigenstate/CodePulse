import type { HudStateLevel } from '../../lib/hudState.js'

/** Every level has its own shape, so state never depends on colour alone. */
export function StateMark({ level }: { level: HudStateLevel }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className={`hud-c-mark is-${level}${level === 'active' ? ' hud-c-spin' : ''}`}
      fill="none"
      viewBox="0 0 16 16"
    >
      {level === 'fault' ? (
        <>
          <path d="M8 2 15 14H1Z" fill="currentColor" />
          <path
            d="M8 6.5v3.2M8 11.6v.4"
            stroke="var(--c-cutout)"
            strokeLinecap="round"
            strokeWidth="1.6"
          />
        </>
      ) : level === 'action' ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M8 4v5M8 11.4v.4"
            stroke="var(--c-cutout)"
            strokeLinecap="round"
            strokeWidth="1.8"
          />
        </>
      ) : level === 'notice' ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M4.8 8.2 7 10.4l4.2-4.6"
            stroke="var(--c-cutout)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </>
      ) : level === 'active' ? (
        <>
          <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
          <path
            d="M8 1.8a6.2 6.2 0 0 1 6.2 6.2"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="2"
          />
        </>
      ) : (
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="2" />
      )}
    </svg>
  )
}
