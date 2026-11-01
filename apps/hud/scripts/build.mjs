// Presentation only. The sole Electron main process lives in apps/desktop.
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as bundle } from 'esbuild'
import { build as viteBuild } from 'vite'
import react from '@vitejs/plugin-react'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(app, '../desktop/out/hud')
await bundle({
  entryPoints: [resolve(app, 'src/preload/index.ts')],
  outfile: resolve(output, 'preload/index.js'),
  platform: 'node', format: 'cjs', bundle: true, minify: true,
  external: ['electron'],
})
await viteBuild({
  configFile: false, root: resolve(app, 'src/renderer'), base: './',
  resolve: { alias: { '@renderer': resolve(app, 'src/renderer/src') } },
  css: { postcss: app }, plugins: [react()],
  build: { outDir: resolve(output, 'renderer'), emptyOutDir: true },
})
