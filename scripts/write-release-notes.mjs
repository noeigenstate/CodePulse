import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const tag = process.env.RELEASE_TAG ?? 'v0.1.5'
const notesPath = join(process.env.RUNNER_TEMP ?? tmpdir(), 'codepulse-release-notes.md')

export function buildReleaseNotes(releaseTag, changes) {
  const lines = normalizeChanges(changes)
  return [`## ${releaseTag}`, '', '### 更新内容', '', ...lines.map((line) => `- ${line}`), ''].join(
    '\n',
  )
}

export function normalizeChanges(changes) {
  const normalized = changes.map(formatCommitSubject).filter(Boolean)
  const unique = [...new Set(normalized)]
  return unique.length > 0 ? unique : ['包含最新稳定性修复和体验优化。']
}

export function formatCommitSubject(subject) {
  return subject
    .replace(/^[a-f0-9]{7,40}\s+/i, '')
    .replace(/^(feat|fix|docs|chore|refactor|test|style|perf|ci|build|temp)(\([^)]+\))?:\s*/i, '')
    .trim()
}

export function releaseChangesFromGit(releaseTag) {
  const previousTag = findPreviousTag(releaseTag)
  const rangeEnd = gitRefExists(releaseTag) ? releaseTag : 'HEAD'
  const range = previousTag ? `${previousTag}..${rangeEnd}` : rangeEnd
  const output = execFileSync('git', ['log', '--no-merges', '--format=%s', range], {
    encoding: 'utf8',
  })
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isReleaseChore(line))
}

function findPreviousTag(releaseTag) {
  const output = execFileSync('git', ['tag', '--sort=-version:refname'], { encoding: 'utf8' })
  const tags = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^v?\d+\.\d+\.\d+/.test(line))
  const currentIndex = tags.indexOf(releaseTag)
  return currentIndex >= 0
    ? tags[currentIndex + 1]
    : tags.find((candidate) => candidate !== releaseTag)
}

function gitRefExists(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function isReleaseChore(subject) {
  return /release notes|release v?\d+\.\d+\.\d+|bump version|版本号|readme/i.test(subject)
}

function envChanges() {
  const raw = process.env.RELEASE_NOTES?.trim()
  if (!raw) return undefined
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
}

const changes = envChanges() ?? releaseChangesFromGit(tag)
const notes = releaseNotesFromFile(tag) ?? buildReleaseNotes(tag, changes)

writeFileSync(notesPath, notes, 'utf8')

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `path=${notesPath}\n`, 'utf8')
}

console.log(`Release notes written to ${notesPath}`)

function releaseNotesFromFile(releaseTag) {
  const normalized = releaseTag.replace(/^v/i, '')
  const candidates = [
    join('docs', 'release-notes', `${releaseTag}.md`),
    join('docs', 'release-notes', `${normalized}.md`),
  ]
  const path = candidates.find((candidate) => existsSync(candidate))
  if (!path) return undefined
  return readFileSync(path, 'utf8').trimEnd() + '\n'
}
