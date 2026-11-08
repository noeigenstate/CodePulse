import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      '@codepulse/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { port: 5181, proxy: { '/api': 'http://127.0.0.1:18080' } },
})
