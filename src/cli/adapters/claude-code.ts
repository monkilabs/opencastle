import { createSingleFileAdapter } from './single-file-base.js'

/**
 * Claude Code adapter.
 *
 * Generates CLAUDE.md (root instructions) and .claude/ structure.
 *
 *   copilot-instructions.md    → CLAUDE.md  (combined with instructions/)
 *   skills/\*\/SKILL.md         → .claude/skills/<name>.md
 *   agent-workflows/*.md       → .claude/commands/workflow-<name>.md
 *   prompts/*.prompt.md        → .claude/commands/<name>.md
 *   customizations/            → .claude/customizations/  (scaffolded once)
 *
 * Note: Claude Code has no "agents" concept. Agent definitions are embedded
 *       as reference sections within CLAUDE.md so Claude can adopt personas
 *       when asked.
 */

export const IDE_ID = 'claude-code'

const { install, update, getManagedPaths, getDoctorChecks } = createSingleFileAdapter({
  rootFile: 'CLAUDE.md',
  dotDir: '.claude',
  mcpConfigPath: '.mcp.json',
  mcpFormat: 'claude-code',
  promptsDir: 'commands',
  workflowsDir: 'commands',
  workflowPrefix: 'workflow-',
  frameworkDirs: ['agents', 'skills', 'commands'],
})

export { install, update, getManagedPaths, getDoctorChecks }
