import { createSingleFileAdapter } from './single-file-base.js'
import { CLAUDE_COMMANDS_DIR, legacyClaudeCommands } from '../command-namespace.js'

/**
 * Claude Code adapter.
 *
 * Generates CLAUDE.md (root instructions) and .claude/ structure.
 *
 *   copilot-instructions.md    → CLAUDE.md  (combined with instructions/)
 *   skills/<name>/SKILL.md     → .claude/skills/<name>/SKILL.md  (+ sibling resources, frontmatter preserved)
 *   agent-workflows/*.md       → .claude/commands/oc/workflow-<name>.md  (/oc:workflow-<name>)
 *   prompts/*.prompt.md        → .claude/commands/oc/<name>.md           (/oc:<name>)
 *   customizations/            → .claude/customizations/  (scaffolded once)
 *
 * Commands go under `oc/`, which Claude Code turns into the `oc:` namespace.
 * The rest of `.claude/commands/` belongs to whoever writes there; `sync` never
 * touches it, beyond removing what a release before 1.0 left at the top.
 *
 * Note: Claude Code has no "agents" concept. Agent definitions are embedded
 *       as reference sections within CLAUDE.md so Claude can adopt personas
 *       when asked.
 */

export const IDE_ID = 'claude-code'

const { install, update, getManagedPaths, getDoctorChecks, getLegacyOutputs } = createSingleFileAdapter({
  rootFile: 'CLAUDE.md',
  dotDir: '.claude',
  mcpConfigPath: '.mcp.json',
  mcpFormat: 'claude-code',
  promptsDir: CLAUDE_COMMANDS_DIR,
  workflowsDir: CLAUDE_COMMANDS_DIR,
  workflowPrefix: 'workflow-',
  frameworkDirs: ['agents', 'skills', CLAUDE_COMMANDS_DIR],
  legacyOutputs: (projectRoot) => legacyClaudeCommands(projectRoot),
})

export { install, update, getManagedPaths, getDoctorChecks, getLegacyOutputs }
