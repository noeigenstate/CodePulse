import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('desktop installer uses maximum compression without unpacking native package sources', () => {
  const config = readFileSync('apps/desktop/electron-builder.yml', 'utf8')
  const desktopPackage = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  assert.match(config, /^compression: maximum$/m)
  assert.match(config, /^electronLanguages:\n\s+- en-US\n\s+- zh-CN$/m)
  assert.match(config, /^afterPack: scripts\/after-pack\.cjs$/m)
  assert.match(config, /^\s+- '\*\*\/\*\.node'$/m)
  assert.match(config, /^\s+- '!\*\*\/\*\.map'$/m)
  assert.match(config, /^\s+- '!\*\*\/\*\.d\.ts'$/m)
  assert.match(config, /^\s+- '!\*\*\/node_modules\/better-sqlite3\/deps\/\*\*'$/m)
  assert.match(config, /^\s+- '!\*\*\/node_modules\/better-sqlite3\/src\/\*\*'$/m)
  assert.doesNotMatch(config, /^\s+- '\*\*\/better-sqlite3\/\*\*'$/m)
  // Pure JS server/ORM deps are bundled; only the native addon is a runtime dependency.
  assert.equal(
    Object.keys(desktopPackage.dependencies ?? {})
      .sort()
      .join(','),
    'better-sqlite3',
  )
  assert.ok(desktopPackage.devDependencies?.fastify)
  assert.ok(desktopPackage.devDependencies?.['drizzle-orm'])
})

test('desktop package scripts and builder config include Windows and macOS targets', () => {
  const desktopPackage = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8')) as {
    scripts?: Record<string, string>
  }
  const rootPackage = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>
  }
  const config = readFileSync('apps/desktop/electron-builder.yml', 'utf8')
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8')

  assert.match(String(desktopPackage.scripts?.['dist:win'] ?? ''), /electron-builder --win/)
  assert.match(
    String(desktopPackage.scripts?.['dist:mac'] ?? ''),
    /electron-builder --mac --arm64 --x64/,
  )
  assert.match(
    String(desktopPackage.scripts?.['dist:mac:arm64'] ?? ''),
    /electron-builder --mac --arm64/,
  )
  assert.match(
    String(desktopPackage.scripts?.['dist:mac:x64'] ?? ''),
    /electron-builder --mac --x64/,
  )
  assert.equal(rootPackage.scripts?.['dist:win'], 'pnpm --filter @codepulse/desktop dist:win')
  assert.equal(rootPackage.scripts?.['dist:mac'], 'pnpm --filter @codepulse/desktop dist:mac')
  assert.match(config, /^\s+- target: dmg$/m)
  assert.match(config, /^\s+- arm64$/m)
  assert.match(config, /^\s+- x64$/m)
  assert.match(config, /CodePulse_\$\{version\}_mac-\$\{arch\}\.\$\{ext\}/)
  // Must not build a single universal binary target.
  assert.doesNotMatch(config, /^\s+- universal\s*$/m)
  assert.doesNotMatch(config, /target:\s*universal/)
  assert.match(workflow, /runs-on: macos-latest/)
  assert.match(workflow, /pnpm dist:mac/)
  assert.match(workflow, /pnpm dist:win/)
  assert.match(workflow, /mac-arm64\.dmg/)
  assert.match(workflow, /mac-x64\.dmg/)
})
