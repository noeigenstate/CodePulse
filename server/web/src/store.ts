import type { PluginListing } from '@codepulse/shared'
import type { InstallRow } from './api'

export const SIGN_IN_HINT = '在 CodePulse 桌面端打开以安装'

/** Catalog and install state every page works from, loaded once by the shell. */
export interface Store {
  plugins: PluginListing[]
  installs: InstallRow[]
  /** True when the page was opened from the desktop and so may change installs. */
  signedIn: boolean
  /** Runs an install change, refreshes the list, tells the desktop and shows `message`. */
  change(action: () => Promise<unknown>, message: string): Promise<void>
}
