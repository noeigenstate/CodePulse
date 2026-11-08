import type { Plugin } from 'vite'
import { pluginPlatformUrl } from './src/plugin-platform-config.js'

export function pluginPlatformCsp(value: string): Plugin {
  const origin = new URL(pluginPlatformUrl(value)).origin
  return {
    name: 'plugin-platform-csp',
    transformIndexHtml(html) {
      return html.replace('frame-src __PLUGIN_PLATFORM_ORIGIN__', `frame-src ${origin}`)
    },
  }
}
