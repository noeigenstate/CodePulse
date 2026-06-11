import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// workspace 包以 TypeScript 源码形式被消费，因此必须让打包器把它们
// 打进产物，而不是 externalize。真正的运行时依赖（fastify、
// better-sqlite3、drizzle-orm）保持 external，在运行时从 node_modules
// 加载 —— 尤其 better-sqlite3 是原生扩展。
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
