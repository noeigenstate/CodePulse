// Builds scripts/smoke.ts (resolving the workspace TS packages from source) and
// runs it. Lets `pnpm smoke` exercise the backend pipeline without Electron.
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = resolve('scripts/smoke.generated.mjs')

await build({
  entryPoints: ['scripts/smoke.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['fastify', '@fastify/websocket', 'better-sqlite3', 'bonjour-service'],
  alias: {
    '@codepulse/shared': './packages/shared/src/index.ts',
    '@codepulse/core': './packages/core/src/index.ts',
    '@codepulse/adapters': './packages/adapters/src/index.ts',
    '@codepulse/local-server': './packages/local-server/src/index.ts',
    '@codepulse/storage': './packages/storage/src/index.ts',
  },
  outfile: out,
})

await import(pathToFileURL(out).href)
