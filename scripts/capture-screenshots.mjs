/**
 * Capture README screenshots from static HTML mocks via headless Chrome/Edge.
 *
 * Usage: node scripts/capture-screenshots.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mockDir = resolve(root, 'scripts/screenshot-mock')
const outDir = resolve(root, 'docs/screenshots')
mkdirSync(outDir, { recursive: true })

const chromeCandidates = [
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
].filter(Boolean)

const chrome = chromeCandidates.find((p) => existsSync(p))
if (!chrome) {
  console.error('Chrome/Edge not found. Set CHROME_PATH and retry.')
  process.exit(1)
}

const shots = [
  { html: 'dashboard.html', query: 'lang=zh', out: 'dashboard-zh.png', w: 1440, h: 900 },
  { html: 'dashboard.html', query: 'lang=en', out: 'dashboard.png', w: 1440, h: 900 },
  { html: 'stats.html', query: 'lang=zh', out: 'stats-zh.png', w: 1440, h: 1100 },
  { html: 'stats.html', query: 'lang=en', out: 'stats.png', w: 1440, h: 1100 },
]

for (const shot of shots) {
  const fileUrl = `${pathToFileURL(resolve(mockDir, shot.html)).href}?${shot.query}`
  const outPath = resolve(outDir, shot.out)
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${shot.w},${shot.h}`,
    `--screenshot=${outPath}`,
    fileUrl,
  ]
  console.log(`Capturing ${shot.out} …`)
  const result = spawnSync(chrome, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`Failed to capture ${shot.out}`)
    process.exit(result.status ?? 1)
  }
}

console.log(`Done. Screenshots written to ${outDir}`)
