import { createSingleFileAdapter } from './single-file-base.js'

/**
 * Codex CLI adapter.
 *
 * Generates AGENTS.md (root instructions) and .codex/ structure.
 *
 *   copilot-instructions.md    -> AGENTS.md  (combined with instructions/)
 *   skills/*\/SKILL.md          -> .codex/skills/<name>.md
 *   agents/*.agent.md          -> .codex/agents/<name>.md
 *   agent-workflows/*.md       -> .codex/workflows/<name>.md
 *   prompts/*.prompt.md        -> .codex/prompts/<name>.md
 *   customizations/            -> .codex/customizations/  (scaffolded once)
 *   mcp.json                   -> .codex/mcp.json  (mcpServers format)
 */

export const IDE_ID = 'codex'

const { install, update, getManagedPaths, getDoctorChecks } = createSingleFileAdapter({
  rootFile: 'AGENTS.md',
  dotDir: '.codex',
  mcpConfigPath: '.codex/mcp.json',
  mcpFormat: 'codex',
  promptsDir: 'prompts',
  workflowsDir: 'workflows',
  workflowPrefix: '',
  frameworkDirs: ['agents', 'skills', 'prompts', 'workflows'],
})

export { install, update, getManagedPaths, getDoctorChecks }
