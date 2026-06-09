import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Workspace packages are written in TypeScript and consumed from source, so we
// must let the bundler include them rather than externalize them. Real runtime
// dependencies (fastify, better-sqlite3, drizzle-orm) stay external and load
// from node_modules at runtime — better-sqlite3 in particular is a native addon.
const bundledWorkspacePackages = [
  '@codepulse/shared',
  '@codepulse/core',
  '@codepulse/adapters',
  '@codepulse/storage',
  '@codepulse/local-server',
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: { '@renderer': resolve(__dirname, 'src/renderer/src') },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
})
