import { appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tag = process.env.RELEASE_TAG ?? 'v0.1.5'
const releaseDir = process.env.RELEASE_DIR ?? join('apps', 'desktop', 'release')
const notesPath = join(process.env.RUNNER_TEMP ?? tmpdir(), 'codepulse-release-notes.md')

const installerNames = readdirSync(releaseDir)
  .filter((name) => name.toLowerCase().endsWith('.exe'))
  .sort()

if (installerNames.length === 0) {
  throw new Error(`No Windows installer found in ${releaseDir}.`)
}

const downloadLines = installerNames.map((name) => `- Windows x64: \`${name}\``).join('\n')

const notes = `## ${tag}

### 本版重点

- Claude Code / Codex 左右分栏展示，任务卡片只保留当前相关项目，信息更集中。
- 5 小时额度和每周额度常驻在各自 agent 板块中；任务卡片自动清理后，额度条仍会保留。
- 已完成、空闲项目 5 分钟后从任务列表移除；疑似卡住项目 10 分钟后移除。
- Claude Code 命中 session limit / usage limit 时会显示“已达用量上限，任务暂时停止”，不再误显示为处理中。
- 只保留项目完成提醒，通知更精简，并使用 CodePulse 应用名和图标。

### 同步与准确性

- 优先使用 Claude / Codex CLI 提供的精确上下文数据。
- Codex 额度按 limit id 分桶保存，避免不同模型或额度桶互相覆盖。
- 额度重置时会跳过未更新的旧 rollout 数据，避免把过期额度重新写回界面。
- 会话结束后保留上一份上下文和额度快照，下一波 CLI 数据到来前不清空面板。

### 配置与权限

- 首次打开时说明 CodePulse 会写入的本地配置位置。
- 启动时检查 Claude / Codex CLI、hook 配置和 Codex hook 信任状态。
- Codex /hooks 教程只展示用户需要操作的步骤，并说明需要信任的 SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、Stop 权限。
- 卸载时只删除 CodePulse 管理的 Claude / Codex hook 和 statusLine 配置，保留用户原有设置。

### Windows 安装包

${downloadLines}

下载下方 Assets 中的 \`.exe\` 安装包后直接运行安装。

### 使用提示

- 首次运行后，如果弹出配置与权限检查，请按提示在 Codex 中输入 \`/hooks\` 并信任 CodePulse hook。
- Claude Code / Codex 至少需要运行一轮任务，CodePulse 才能收到实时状态和额度数据。
`

writeFileSync(notesPath, notes, 'utf8')

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `path=${notesPath}\n`, 'utf8')
}

console.log(`Release notes written to ${notesPath}`)
