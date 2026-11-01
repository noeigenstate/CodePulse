/** Adapted from LumaDesk reminders/timeparse.py. AI supplies calendar fields, not epoch arithmetic. */
export function resolveReminderTime(
  action: { secondsFromNow?: number; localDate?: string; localTime?: string },
  now: number,
): number | null {
  if (action.secondsFromNow !== undefined) {
    if (
      action.localDate ||
      action.localTime ||
      !Number.isInteger(action.secondsFromNow) ||
      action.secondsFromNow <= 0 ||
      action.secondsFromNow > 31_536_000
    )
      throw new Error('提醒时间表达无效')
    return now + action.secondsFromNow * 1000
  }
  if (!action.localDate && !action.localTime) return null
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(action.localDate ?? '') ||
    !/^\d{2}:\d{2}$/.test(action.localTime ?? '')
  )
    throw new Error('请提供完整提醒日期和时间')
  const [year, month, day] = action.localDate!.split('-').map(Number)
  const [hour, minute] = action.localTime!.split(':').map(Number)
  // Use the current machine's calendar timezone, matching the date/time shown in the desktop UI.
  const date = new Date(year, month - 1, day, hour, minute, 0, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getTime() <= now
  )
    throw new Error('提醒日期无效或已经过去，请重新确认')
  return date.getTime()
}
