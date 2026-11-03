import { DEVICE_CHARACTERS } from './device-charset.generated.js'

const characters = new Set(DEVICE_CHARACTERS)

/** Normalize presentation variants; unsupported characters remain for the caller to reject. */
export function deviceText(value: unknown): string {
  return (typeof value === 'string' ? value : '')
    .normalize('NFC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\uFF64/g, '、')
    .replace(/\uFF61/g, '。')
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Checks the actual code points. Apply deviceText first to normalize variants. */
export function deviceSupports(value: string): boolean {
  for (const char of value) if (!characters.has(char)) return false
  return true
}
