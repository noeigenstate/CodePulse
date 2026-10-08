import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { embedUpdateInfo, readUpdateInfo } from '../scripts/appimage-update-info.mjs'

/** Minimal little-endian ELF64 with an empty 1024-byte `.upd_info` section. */
function fakeRuntime(): Buffer {
  const names = Buffer.from('\0.shstrtab\0.upd_info\0', 'latin1')
  const namesOffset = 64
  const updOffset = namesOffset + names.length
  const updSize = 1024
  const shoff = updOffset + updSize
  const file = Buffer.alloc(shoff + 3 * 64)
  file.writeUInt32BE(0x7f454c46, 0)
  file[4] = 2 // ELFCLASS64
  file[5] = 1 // little endian
  file.writeBigUInt64LE(BigInt(shoff), 0x28)
  file.writeUInt16LE(64, 0x3a) // e_shentsize
  file.writeUInt16LE(3, 0x3c) // e_shnum
  file.writeUInt16LE(1, 0x3e) // e_shstrndx
  names.copy(file, namesOffset)
  const section = (index: number, nameOffset: number, offset: number, size: number): void => {
    const base = shoff + index * 64
    file.writeUInt32LE(nameOffset, base)
    file.writeBigUInt64LE(BigInt(offset), base + 0x18)
    file.writeBigUInt64LE(BigInt(size), base + 0x20)
  }
  section(1, 1, namesOffset, names.length) // .shstrtab
  section(2, 11, updOffset, updSize) // .upd_info
  return file
}

test('update information is written into .upd_info and nowhere else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codepulse-updinfo-'))
  try {
    const path = join(dir, 'App.AppImage')
    const original = fakeRuntime()
    await writeFile(path, original)
    assert.equal(readUpdateInfo(path), '')

    const info = 'gh-releases-zsync|noeigenstate|CodePulse|latest|CodePulse_*_x86_64.AppImage.zsync'
    embedUpdateInfo(path, info)
    assert.equal(readUpdateInfo(path), info)

    const updated = await readFile(path)
    const changed = [...updated.keys()].filter((i) => updated[i] !== original[i])
    const updStart = 64 + 21
    assert.ok(changed.every((i) => i >= updStart && i < updStart + 1024))

    // A shorter string must not leave the tail of the previous one behind.
    embedUpdateInfo(path, 'zsync|https://example.test/App.zsync')
    assert.equal(readUpdateInfo(path), 'zsync|https://example.test/App.zsync')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('update information that does not fit, or a non-ELF file, is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codepulse-updinfo-'))
  try {
    const path = join(dir, 'App.AppImage')
    await writeFile(path, fakeRuntime())
    assert.throws(() => embedUpdateInfo(path, 'x'.repeat(1024)), /holds 1023/)
    assert.equal(readUpdateInfo(path), '')

    const text = join(dir, 'notes.txt')
    await writeFile(text, 'not an AppImage'.padEnd(80, '.'))
    assert.throws(() => embedUpdateInfo(text, 'x'), /not an ELF/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
