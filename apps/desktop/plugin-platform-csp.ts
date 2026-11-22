import type { Plugin } from 'vite'
import { pluginPlatformUrl, type PluginPlatformUrlOptions } from './src/plugin-platform-config.js'

export function pluginPlatformCsp(value: string, options?: PluginPlatformUrlOptions): Plugin {
  const origin = new URL(pluginPlatformUrl(value, options)).origin
  return {
    name: 'plugin-platform-csp',
    transformIndexHtml(html) {
      return html
        .replace('frame-src __PLUGIN_PLATFORM_ORIGIN__', `frame-src ${origin}`)
        .replace(
          /img-src ([^;"\n]*)/,
          (_directive, sources: string) => `img-src ${sources} ${origin}`,
        )
    },
  }
}
