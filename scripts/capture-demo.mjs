/**
 * Render the README demo GIF from the dashboard mock (see screenshot-mock/demo.js)
 * via headless Chrome/Edge + ffmpeg.
 *
 * Usage: node scripts/capture-demo.mjs   (needs ffmpeg on PATH or FFMPEG_PATH)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mock = resolve(root, 'scripts/screenshot-mock/dashboard.html')
const outDir = resolve(root, 'docs/screenshots')
mkdirSync(outDir, { recursive: true })

const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]
  .filter(Boolean)
  .find((p) => existsSync(p))
if (!chrome) {
  console.error('Chrome/Edge not found. Set CHROME_PATH and retry.')
  process.exit(1)
}
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg'

// Seconds each frame stays on screen; frame numbers match demo.js.
const durations = [1.2, 1.2, 0.25, 2.6, 2.4, 1.2]
const width = 1440
const height = 948 // 900 dashboard + 48 taskbar
const gifWidth = 960

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${cmd} exited with ${result.status}`)
}

for (const lang of ['en', 'zh']) {
  const work = mkdtempSync(join(tmpdir(), 'codepulse-demo-'))
  try {
    const list = []
    durations.forEach((duration, frame) => {
      const png = join(work, `f${frame}.png`)
      run(chrome, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${width},${height}`,
        `--screenshot=${png}`,
        `${pathToFileURL(mock).href}?lang=${lang}&frame=${frame}`,
      ])
      list.push(`file '${png.replaceAll('\\', '/')}'`, `duration ${duration}`)
    })
    // The concat demuxer ignores the last duration unless the file is repeated.
    list.push(list.at(-2))
    const listPath = join(work, 'frames.txt')
    writeFileSync(listPath, `${list.join('\n')}\n`)

    const out = resolve(outDir, lang === 'en' ? 'demo.gif' : 'demo-zh.gif')
    console.log(`Encoding ${out} …`)
    run(ffmpeg, [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-vf',
      `fps=10,scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none`,
      '-loop',
      '0',
      out,
    ])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

console.log(`Done. Demo GIFs written to ${outDir}`)
