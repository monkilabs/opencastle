import { createSingleFileAdapter } from './single-file-base.js'
import { compileTeamMemory } from '../memory-hooks.js'
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
 *
 * Commands go under `oc/`, which Claude Code turns into the `oc:` namespace.
 * The rest of `.claude/commands/` belongs to whoever writes there; `sync` never
 * touches it, beyond removing what a release before the namespace left at the top.
 *
 *   agents/*.agent.md          → .claude/agents/<name>.agent.md            (subagents)
 *
 * Each command keeps one line of frontmatter, its description, which is what
 * Claude Code lists beside it in the `/` menu. Each agent keeps a name and a
 * description, which is what makes it a subagent Claude Code can delegate to.
 */

export const IDE_ID = 'claude-code'

const base = createSingleFileAdapter({
  rootFile: 'CLAUDE.md',
  dotDir: '.claude',
  mcpConfigPath: '.mcp.json',
  mcpFormat: 'claude-code',
  promptsDir: CLAUDE_COMMANDS_DIR,
  workflowsDir: CLAUDE_COMMANDS_DIR,
  workflowPrefix: 'workflow-',
  frameworkDirs: ['agents', 'skills', CLAUDE_COMMANDS_DIR],
  legacyOutputs: (projectRoot) => legacyClaudeCommands(projectRoot),
  commandDescriptions: true,
  agentFrontmatter: true,
  listsSkillsAndAgents: true,
})

export const { getManagedPaths, getDoctorChecks, getLegacyOutputs } = base

export async function install(...args: Parameters<typeof base.install>): ReturnType<typeof base.install> {
  const results = await base.install(...args)
  compileTeamMemory(args[0], args[1], IDE_ID)
  return results
}

export async function update(...args: Parameters<typeof base.update>): ReturnType<typeof base.update> {
  const results = await base.update(...args)
  compileTeamMemory(args[0], args[1], IDE_ID)
  return results
}
