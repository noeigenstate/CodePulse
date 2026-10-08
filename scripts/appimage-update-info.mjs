/**
 * Embeds AppImage update information in place, as `appimagetool -u` does.
 *
 * Type 2 AppImage runtimes reserve an ELF section named `.upd_info` for the
 * update information string (https://github.com/AppImage/AppImageSpec). The
 * electron-builder runtime ships it empty; writing the string there (instead of
 * repacking with another tool) keeps the gzip SquashFS payload that AppImageHub
 * can mount untouched.
 *
 * Usage: node scripts/appimage-update-info.mjs <file.AppImage> "<update information>"
 */
import { openSync, closeSync, readSync, writeSync, fstatSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SECTION = '.upd_info'

/**
 * Finds a section of a little-endian ELF64 file.
 *
 * @param {number} fd Open file descriptor.
 * @param {string} name Section name.
 * @returns {{ offset: number, size: number }}
 */
function findSection(fd, name) {
  const header = Buffer.alloc(64)
  readSync(fd, header, 0, 64, 0)
  if (header.readUInt32BE(0) !== 0x7f454c46) throw new Error('not an ELF file')
  if (header[4] !== 2 || header[5] !== 1) throw new Error('expected a little-endian ELF64 runtime')
  const shoff = Number(header.readBigUInt64LE(0x28))
  const shentsize = header.readUInt16LE(0x3a)
  const shnum = header.readUInt16LE(0x3c)
  const shstrndx = header.readUInt16LE(0x3e)

  const table = Buffer.alloc(shentsize * shnum)
  readSync(fd, table, 0, table.length, shoff)
  const entry = (i) => ({
    name: table.readUInt32LE(i * shentsize),
    offset: Number(table.readBigUInt64LE(i * shentsize + 0x18)),
    size: Number(table.readBigUInt64LE(i * shentsize + 0x20)),
  })
  const strtab = entry(shstrndx)
  const names = Buffer.alloc(strtab.size)
  readSync(fd, names, 0, strtab.size, strtab.offset)

  for (let i = 0; i < shnum; i++) {
    const section = entry(i)
    const end = names.indexOf(0, section.name)
    if (names.toString('latin1', section.name, end) === name) {
      return { offset: section.offset, size: section.size }
    }
  }
  throw new Error(`section ${name} not found; is this a type 2 AppImage?`)
}

/**
 * Reads the update information embedded in an AppImage.
 *
 * @param {string} path AppImage path.
 * @returns {string} The string, empty when none is embedded.
 */
export function readUpdateInfo(path) {
  const fd = openSync(path, 'r')
  try {
    const { offset, size } = findSection(fd, SECTION)
    const data = Buffer.alloc(size)
    readSync(fd, data, 0, size, offset)
    const end = data.indexOf(0)
    return data.toString('utf8', 0, end < 0 ? size : end)
  } finally {
    closeSync(fd)
  }
}

/**
 * Writes update information into the AppImage's `.upd_info` section.
 *
 * @param {string} path AppImage path (modified in place).
 * @param {string} info Update information, e.g. `gh-releases-zsync|owner|repo|latest|*.zsync`.
 */
export function embedUpdateInfo(path, info) {
  const bytes = Buffer.from(info, 'utf8')
  const fd = openSync(path, 'r+')
  try {
    const { offset, size } = findSection(fd, SECTION)
    if (bytes.length >= size) {
      throw new Error(`update information is ${bytes.length} bytes; ${SECTION} holds ${size - 1}`)
    }
    if (offset + size > fstatSync(fd).size) throw new Error(`${SECTION} lies outside the file`)
    const data = Buffer.alloc(size)
    bytes.copy(data)
    writeSync(fd, data, 0, size, offset)
  } finally {
    closeSync(fd)
  }
}

// Run as a CLI only when this file itself is the entry point (not when bundled
// into another module, e.g. a test, whose own path is then process.argv[1]).
const isCli =
  basename(fileURLToPath(import.meta.url)) === 'appimage-update-info.mjs' &&
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isCli) {
  const [path, info] = process.argv.slice(2)
  if (!path || !info) {
    console.error('Usage: node scripts/appimage-update-info.mjs <file.AppImage> "<update information>"')
    process.exit(2)
  }
  embedUpdateInfo(path, info)
  const written = readUpdateInfo(path)
  if (written !== info) {
    console.error(`Embedded update information does not read back: ${written}`)
    process.exit(1)
  }
  console.log(`Embedded update information: ${written}`)
}
