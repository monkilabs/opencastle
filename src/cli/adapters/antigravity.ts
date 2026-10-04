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
 *   mcp.json                   -> .agents/mcp_config.json  (mcpServers format)
 *
 * MCP: Antigravity — the IDE, the CLI and 2.0 alike — reads a workspace's
 * servers from .agents/mcp_config.json and the user's from
 * ~/.gemini/config/mcp_config.json (antigravity.google/docs/mcp). It expands
 * no variables there, so a `${NAME}` in a header is sent as written; doctor
 * flags one.
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
  // Antigravity reads AGENTS.md as well as GEMINI.md, cumulatively.
  alsoReads: { rootFile: 'AGENTS.md', writtenBy: ['codex', 'opencode'] },
})

export { install, update, getManagedPaths, getDoctorChecks }
