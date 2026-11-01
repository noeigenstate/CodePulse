import type { AmbientCard, DeviceAmbientCard } from '@codepulse/shared'
type DeskCard = AmbientCard & Pick<DeviceAmbientCard, 'manual'>
/** Explicit images/notes override the configured automatic page. IPC clears the previous manual owner. */
export function selectDeskContent(
  todos: DeskCard | undefined,
  ambient: DeskCard | undefined,
): DeskCard | undefined {
  return ambient?.manual ? ambient : (todos ?? ambient)
}
