import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSingleFileAdapter } from './single-file-base.js'

/**
 * Codex CLI adapter.
 *
 * Generates AGENTS.md (root instructions), the cross-assistant skills
 * directory, and .codex/ structure.
 *
 *   copilot-instructions.md    -> AGENTS.md  (combined with instructions/)
 *   skills/<name>/SKILL.md     -> .agents/skills/<name>/SKILL.md  (+ sibling resources, frontmatter preserved)
 *   agents/*.agent.md          -> .codex/agents/<name>.md
 *   agent-workflows/*.md       -> .codex/workflows/<name>.md
 *   prompts/*.prompt.md        -> .codex/prompts/<name>.md
 *   MCP servers                -> .codex/config.toml  ([mcp_servers.<name>] tables)
 *
 * Codex reads a repository's skills only from `.agents/skills/` and its
 * project MCP servers only from `.codex/config.toml`, in a project the user has
 * trusted. Releases before this one wrote `.codex/skills/` and `.codex/mcp.json`,
 * neither of which Codex reads; `sync` removes the first and takes our servers
 * back out of the second.
 *
 * `.agents/skills/` is also where the Antigravity adapter writes skills. Both
 * compile the same skills from the same source, so with both selected each
 * one's output is the other's, and neither sweep removes anything of the other.
 */

export const IDE_ID = 'codex'

/** What releases before `.agents/skills/` wrote, relative to the project root. */
export const LEGACY_CODEX_SKILLS = '.codex/skills/'
export const LEGACY_CODEX_MCP = '.codex/mcp.json'

const { install, update, getManagedPaths, getDoctorChecks, getLegacyOutputs } = createSingleFileAdapter({
  rootFile: 'AGENTS.md',
  dotDir: '.codex',
  skillsDir: '.agents/skills',
  mcpConfigPath: '.codex/config.toml',
  mcpFormat: 'codex',
  promptsDir: 'prompts',
  workflowsDir: 'workflows',
  workflowPrefix: '',
  frameworkDirs: ['agents', 'skills', 'prompts', 'workflows'],
  legacyOutputs: (projectRoot) => (existsSync(resolve(projectRoot, LEGACY_CODEX_SKILLS)) ? [LEGACY_CODEX_SKILLS] : []),
})

export { install, update, getManagedPaths, getDoctorChecks, getLegacyOutputs }
