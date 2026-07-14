import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Workspace packages are TypeScript source — must be bundled, not externalized.
// Pure JS deps (fastify, drizzle-orm, …) are also bundled so the installer only
// needs to ship the native better-sqlite3 addon (+ its JS glue).
const bundleIntoApp = [
  '@codepulse/shared',
  '@codepulse/core',
  '@codepulse/adapters',
  '@codepulse/storage',
  '@codepulse/local-server',
  'drizzle-orm',
  'fastify',
  '@fastify/websocket',
]

export default defineConfig({
  main: {
    plugins: [
      // Only keep better-sqlite3 (native) external; pack everything else into out/main.
      externalizeDepsPlugin({
        exclude: bundleIntoApp,
        include: ['better-sqlite3'],
      }),
    ],
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // Belt-and-suspenders: never try to bundle the native addon.
        external: ['better-sqlite3'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundleIntoApp })],
    build: {
      minify: 'esbuild',
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
      minify: 'esbuild',
      cssMinify: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
        output: {
          // Slightly smaller than default hashed multi-chunk for this small UI.
          manualChunks: undefined,
        },
      },
    },
  },
})
