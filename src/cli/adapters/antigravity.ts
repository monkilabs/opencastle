import { createSingleFileAdapter } from './single-file-base.js'

/**
 * Antigravity adapter (Google).
 *
 * Generates GEMINI.md (workspace rules) and .agents/ structure. Antigravity
 * natively recognizes the .agents/ directory at the workspace root.
 *
 *   copilot-instructions.md    -> GEMINI.md  (combined with instructions/)
 *   skills/<name>/SKILL.md     -> .agents/skills/<name>/SKILL.md  (+ sibling resources, frontmatter preserved)
 *   agents/*.agent.md          -> .agents/agents/<name>.md
 *   agent-workflows/*.md       -> .agents/workflows/<name>.md
 *   prompts/*.prompt.md        -> .agents/prompts/<name>.md
 *   customizations/            -> .agents/customizations/  (scaffolded once)
 *   mcp.json                   -> .agents/mcp_config.json  (mcpServers format)
 *
 * Note: Antigravity's MCP integration officially reads ~/.gemini/antigravity/mcp_config.json
 * (global only); per-workspace MCP support is a known gap. The workspace
 * mcp_config.json is scaffolded for parity with other adapters and so users
 * can copy/symlink it globally if desired.
 */

export const IDE_ID = 'antigravity'

const { install, update, getManagedPaths, getDoctorChecks } = createSingleFileAdapter({
  rootFile: 'GEMINI.md',
  dotDir: '.agents',
  mcpConfigPath: '.agents/mcp_config.json',
  mcpFormat: 'antigravity',
  promptsDir: 'prompts',
  workflowsDir: 'workflows',
  workflowPrefix: '',
  frameworkDirs: ['agents', 'skills', 'prompts', 'workflows'],
})

export { install, update, getManagedPaths, getDoctorChecks }
