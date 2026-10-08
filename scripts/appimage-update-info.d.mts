/** Reads the update information embedded in an AppImage (empty when none). */
export function readUpdateInfo(path: string): string
/** Writes update information into the AppImage's `.upd_info` section in place. */
export function embedUpdateInfo(path: string, info: string): void
