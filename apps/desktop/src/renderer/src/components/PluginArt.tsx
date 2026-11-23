import type { ReactNode } from 'react'

/** A built-in plugin's default picture: a colour illustration drawn on a tint of `hue`. */
export interface PluginArt {
  hue: string
  art: ReactNode
}

const round = { strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const

/**
 * Default pictures for the plugins that ship with the app, keyed by plugin id. A picture the user
 * picked, or one the platform supplies, always wins over these.
 */
export const PLUGIN_ART: Record<string, PluginArt> = {
  'local:concept': {
    hue: '#f5b731',
    art: (
      <>
        <path
          d="M24 8a11 11 0 0 0-6.6 19.8c1.1.9 1.6 2 1.6 3.2h10c0-1.2.5-2.3 1.6-3.2A11 11 0 0 0 24 8z"
          fill="#f5b731"
        />
        <path d="M18.6 17.5a6 6 0 0 1 5-4.6" stroke="#fff" strokeWidth="2.4" {...round} />
        <rect x="19" y="33" width="10" height="3" rx="1.5" fill="#6b7280" />
        <rect x="20.5" y="37.5" width="7" height="3" rx="1.5" fill="#6b7280" />
      </>
    ),
  },
  'local:prompt': {
    hue: '#7c5cff',
    art: (
      <>
        <path
          d="M20 10h8v9.5l8.4 14.6a3 3 0 0 1-2.6 4.5H14.2a3 3 0 0 1-2.6-4.5L20 19.5z"
          fill="#fff"
          stroke="#7c5cff"
          strokeWidth="2"
        />
        <path
          d="M14.4 30h19.2l3 5.1a1.6 1.6 0 0 1-1.4 2.4H12.8a1.6 1.6 0 0 1-1.4-2.4z"
          fill="#7c5cff"
        />
        <rect x="18" y="8" width="12" height="3.2" rx="1.6" fill="#7c5cff" />
        <circle cx="21.5" cy="25" r="1.7" fill="#b9a8ff" />
        <circle cx="26.5" cy="21.5" r="1.2" fill="#b9a8ff" />
      </>
    ),
  },
  'local:pet': {
    hue: '#ff8a65',
    art: (
      <g shapeRendering="crispEdges">
        <path d="M12 8h4v4h4v4h8v-4h4V8h4v28H12z" fill="#ff8a65" />
        <rect x="16" y="20" width="4" height="4" fill="#3a2e2a" />
        <rect x="28" y="20" width="4" height="4" fill="#3a2e2a" />
        <rect x="22" y="26" width="4" height="3" fill="#d9472a" />
        <rect x="14" y="27" width="4" height="2" fill="#ffc2ad" />
        <rect x="30" y="27" width="4" height="2" fill="#ffc2ad" />
        <rect x="12" y="36" width="24" height="4" fill="#e9734f" />
      </g>
    ),
  },
  'local:calendar': {
    hue: '#e5484d',
    art: (
      <>
        <rect
          x="9"
          y="12"
          width="30"
          height="27"
          rx="4"
          fill="#fff"
          stroke="#e5484d"
          strokeWidth="2"
        />
        <path d="M9 16a4 4 0 0 1 4-4h22a4 4 0 0 1 4 4v4H9z" fill="#e5484d" />
        <rect x="16" y="8" width="3" height="8" rx="1.5" fill="#8a9099" />
        <rect x="29" y="8" width="3" height="8" rx="1.5" fill="#8a9099" />
        <g fill="#c9cdd3">
          <rect x="14" y="24" width="4" height="4" rx="1" />
          <rect x="22" y="24" width="4" height="4" rx="1" />
          <rect x="14" y="31" width="4" height="4" rx="1" />
          <rect x="22" y="31" width="4" height="4" rx="1" />
          <rect x="30" y="31" width="4" height="4" rx="1" />
        </g>
        <rect x="30" y="24" width="4" height="4" rx="1" fill="#e5484d" />
      </>
    ),
  },
  'local:news': {
    hue: '#ff7a1a',
    art: (
      <>
        <path
          d="M19 21h18a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4h-2v5l-6-5h-10a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4z"
          fill="#ffc59a"
        />
        <path
          d="M11 8h20a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H17l-7 6v-6.2A4 4 0 0 1 7 22V12a4 4 0 0 1 4-4z"
          fill="#ff7a1a"
        />
        <circle cx="15" cy="17" r="2" fill="#fff" />
        <circle cx="21" cy="17" r="2" fill="#fff" />
        <circle cx="27" cy="17" r="2" fill="#fff" />
      </>
    ),
  },
  'local:social': {
    hue: '#ffc83d',
    art: (
      <>
        <circle cx="24" cy="25" r="15" fill="#ffc83d" />
        <ellipse cx="18.5" cy="21" rx="2.2" ry="3" fill="#3a2e2a" />
        <path d="M27 21.5c1.4-1.6 3.6-1.6 5 0" stroke="#3a2e2a" strokeWidth="2.4" {...round} />
        <path d="M16 28c2.2 5.4 13.8 5.4 16 0z" fill="#3a2e2a" />
        <path d="M21 31.4c1.8-1.6 4.2-1.6 6 0-1.8 1.4-4.2 1.4-6 0z" fill="#ff6b81" />
      </>
    ),
  },
  'local:local': {
    hue: '#3b82f6',
    art: (
      <>
        <rect
          x="7"
          y="10"
          width="28"
          height="24"
          rx="3"
          fill="#fff"
          stroke="#3b82f6"
          strokeWidth="2"
        />
        <circle cx="15" cy="18" r="3" fill="#f5b731" />
        <path d="M9 32l8-9 6 6 4-4 6 7z" fill="#3b82f6" />
        <g transform="rotate(8 34 32)">
          <rect x="26" y="24" width="15" height="15" rx="2" fill="#ffd84d" />
          <path d="M29 29h9M29 33h6" stroke="#b8860b" strokeWidth="1.8" {...round} />
        </g>
      </>
    ),
  },
  'local:life': {
    hue: '#3fb4ff',
    art: (
      <>
        <path
          d="M19 6v3M9.5 9.5l2.1 2.1M6 19h3M28.5 9.5l-2.1 2.1"
          stroke="#ffb020"
          strokeWidth="2.4"
          {...round}
        />
        <circle cx="19" cy="19" r="7" fill="#ffb020" />
        <path
          d="M17 38h18a6.5 6.5 0 0 0 .6-13 9 9 0 0 0-17.2 2.4A5.4 5.4 0 0 0 17 38z"
          fill="#fff"
          stroke="#7ab8f5"
          strokeWidth="2"
        />
      </>
    ),
  },
  'local:tools': {
    hue: '#14a38b',
    art: (
      <>
        <path
          d="M27.5 9.5a8 8 0 0 0-10.8 10.8L7.4 29.6a3.5 3.5 0 0 0 5 5l9.3-9.3a8 8 0 0 0 10.8-10.8l-5 5-4.4-1.1-1.1-4.4z"
          fill="#14a38b"
        />
        <circle cx="35" cy="35" r="8" fill="#22c55e" />
        <path d="M35 39.5v-9M31 34.5l4-4 4 4" stroke="#fff" strokeWidth="2.4" {...round} />
      </>
    ),
  },
  'local:holiday': {
    hue: '#e5484d',
    art: (
      <>
        <rect x="22" y="5" width="4" height="4" fill="#8a6b2e" />
        <rect x="17" y="9" width="14" height="4" rx="2" fill="#f5b731" />
        <ellipse cx="24" cy="24" rx="13" ry="12" fill="#e5484d" />
        <path
          d="M24 12v24M17.5 13.5c-3 6-3 15 0 21M30.5 13.5c3 6 3 15 0 21"
          stroke="#c2353a"
          strokeWidth="1.8"
          fill="none"
        />
        <rect x="17" y="35" width="14" height="4" rx="2" fill="#f5b731" />
        <path d="M24 39v4" stroke="#f5b731" strokeWidth="2" />
        <path d="M21.5 43h5l-1 3h-3z" fill="#f5b731" />
      </>
    ),
  },
  'local:headlines': {
    hue: '#4f6bed',
    art: (
      <>
        <path d="M34 16h5v19a4 4 0 0 1-4 4" fill="#c7d2fe" stroke="#4f6bed" strokeWidth="2" />
        <path
          d="M9 11a2 2 0 0 1 2-2h21a2 2 0 0 1 2 2v24a4 4 0 0 0 4 4H13a4 4 0 0 1-4-4z"
          fill="#fff"
          stroke="#4f6bed"
          strokeWidth="2"
        />
        <rect x="13" y="14" width="17" height="4" rx="1.5" fill="#4f6bed" />
        <rect x="13" y="22" width="7" height="7" rx="1.5" fill="#9fb3ff" />
        <path d="M23 23h7M23 27h7M13 33h17" stroke="#9aa3b2" strokeWidth="2" {...round} />
      </>
    ),
  },
  'local:todo': {
    hue: '#22a06b',
    art: (
      <>
        <rect
          x="10"
          y="9"
          width="28"
          height="32"
          rx="4"
          fill="#fff"
          stroke="#22a06b"
          strokeWidth="2"
        />
        <rect x="18" y="6" width="12" height="6" rx="2" fill="#22a06b" />
        <path
          d="M15 20l2.4 2.4 4.2-4.6M15 29l2.4 2.4 4.2-4.6"
          stroke="#22a06b"
          strokeWidth="2.4"
          {...round}
        />
        <path d="M25 21h8M25 30h8M15 36h11" stroke="#9aa3b2" strokeWidth="2" {...round} />
      </>
    ),
  },
}

/** The tint behind a platform plugin's initials when it has no picture of its own. */
export const PLATFORM_PLUGIN_HUE = '#6366f1'
