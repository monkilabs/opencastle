import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSingleFileAdapter } from './single-file-base.js'

/**
 * OpenCode adapter.
 *
 * Generates AGENTS.md (root instructions), the cross-assistant skills
 * directory, and .opencode/ structure.
 *
 *   copilot-instructions.md    → AGENTS.md  (combined with instructions/)
 *   skills/<name>/SKILL.md     → .agents/skills/<name>/SKILL.md  (+ sibling resources, frontmatter preserved)
 *   agents/*.agent.md          → .opencode/agents/<name>.md
 *   agent-workflows/*.md       → .opencode/workflows/<name>.md
 *   prompts/*.prompt.md        → .opencode/prompts/<name>.md
 *   mcp.json                   → opencode.json  (OpenCode format: type local/remote)
 *
 * OpenCode reads skills from `.opencode/skills/`, `.claude/skills/` and
 * `.agents/skills/`. Writing them to `.agents/skills/` shares one copy with
 * Codex, Cursor, Windsurf and Antigravity; OpenCode keeps one copy of a name it
 * finds twice, unpredictably, so every extra directory was a chance of a stale
 * one winning. Releases before this one wrote `.opencode/skills/`; `sync`
 * removes it.
 */

export const IDE_ID = 'opencode'

const LEGACY_SKILLS = '.opencode/skills/'

const { install, update, getManagedPaths, getDoctorChecks, getLegacyOutputs } = createSingleFileAdapter({
  rootFile: 'AGENTS.md',
  dotDir: '.opencode',
  skillsDir: '.agents/skills',
  mcpConfigPath: 'opencode.json',
  mcpFormat: 'opencode',
  promptsDir: 'prompts',
  workflowsDir: 'workflows',
  workflowPrefix: '',
  frameworkDirs: ['agents', 'skills', 'prompts', 'workflows'],
  legacyOutputs: (projectRoot) => (existsSync(resolve(projectRoot, LEGACY_SKILLS)) ? [LEGACY_SKILLS] : []),
})

export { install, update, getManagedPaths, getDoctorChecks, getLegacyOutputs }
