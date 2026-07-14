/**
 * Strip optional Electron binaries this dashboard does not need.
 *
 * IMPORTANT: Do NOT remove ffmpeg — Electron/Chromium links against it at
 * process start on Windows (missing ffmpeg.dll = hard launch failure).
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  const fs = require('node:fs')
  const path = require('node:path')

  const appOutDir = context.appOutDir
  const platform = context.electronPlatformName

  /** @type {string[]} */
  const candidates = []

  if (platform === 'win32') {
    // Software Vulkan fallback only — ffmpeg.dll must stay.
    candidates.push('vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll')
  } else if (platform === 'darwin') {
    // Frameworks live under CodePulse.app/Contents/Frameworks/Electron Framework.framework/...
    const framework = path.join(
      appOutDir,
      'CodePulse.app',
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Libraries',
    )
    // Keep libffmpeg.dylib; only drop soft-Vulkan extras when present.
    candidates.push(
      path.join(framework, 'libvk_swiftshader.dylib'),
      path.join(framework, 'vk_swiftshader_icd.json'),
    )
  } else if (platform === 'linux') {
    candidates.push('libvk_swiftshader.so', 'vk_swiftshader_icd.json')
  }

  let removedBytes = 0
  for (const rel of candidates) {
    const full = path.isAbsolute(rel) ? rel : path.join(appOutDir, rel)
    try {
      const stat = fs.statSync(full)
      if (!stat.isFile()) continue
      fs.unlinkSync(full)
      removedBytes += stat.size
      console.log(`[after-pack] removed ${full} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`)
    } catch {
      // File may not exist on this arch / Electron version — ignore.
    }
  }

  if (removedBytes > 0) {
    console.log(`[after-pack] stripped ${(removedBytes / 1024 / 1024).toFixed(2)} MB total`)
  }
}
