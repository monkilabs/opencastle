import { createSingleFileAdapter } from './single-file-base.js'

/**
 * Antigravity adapter (Google).
 *
 * Generates GEMINI.md (root instructions) and .gemini/ structure.
 *
 *   copilot-instructions.md    -> GEMINI.md  (combined with instructions/)
 *   skills/*\/SKILL.md          -> .gemini/skills/<name>.md
 *   agents/*.agent.md          -> .gemini/agents/<name>.md
 *   agent-workflows/*.md       -> .gemini/workflows/<name>.md
 *   prompts/*.prompt.md        -> .gemini/prompts/<name>.md
 *   customizations/            -> .gemini/customizations/  (scaffolded once)
 *   mcp.json                   -> .gemini/mcp.json  (mcpServers format)
 */

export const IDE_ID = 'antigravity'

const { install, update, getManagedPaths, getDoctorChecks } = createSingleFileAdapter({
  rootFile: 'GEMINI.md',
  dotDir: '.gemini',
  mcpConfigPath: '.gemini/mcp.json',
  mcpFormat: 'antigravity',
  promptsDir: 'prompts',
  workflowsDir: 'workflows',
  workflowPrefix: '',
  frameworkDirs: ['agents', 'skills', 'prompts', 'workflows'],
})

export { install, update, getManagedPaths, getDoctorChecks }
