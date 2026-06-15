import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('desktop installer uses maximum compression without unpacking native package sources', () => {
  const config = readFileSync('apps/desktop/electron-builder.yml', 'utf8')

  assert.match(config, /^compression: maximum$/m)
  assert.match(config, /^electronLanguages:\n\s+- en-US\n\s+- zh-CN$/m)
  assert.match(config, /^\s+- '\*\*\/\*\.node'$/m)
  assert.match(config, /^\s+- '!\*\*\/\*\.map'$/m)
  assert.match(config, /^\s+- '!\*\*\/\*\.d\.ts'$/m)
  assert.match(config, /^\s+- '!\*\*\/node_modules\/better-sqlite3\/deps\/\*\*'$/m)
  assert.match(config, /^\s+- '!\*\*\/node_modules\/better-sqlite3\/src\/\*\*'$/m)
  assert.doesNotMatch(config, /^\s+- '\*\*\/better-sqlite3\/\*\*'$/m)
})
