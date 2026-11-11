/** A theme reload reuses the iframe's session instead of consuming another store login code. */
export function pluginStoreThemeUrl(source: string, theme: 'light' | 'dark'): string {
  const url = new URL(source)
  url.searchParams.set('theme', theme)
  url.searchParams.delete('code')
  return url.href
}
