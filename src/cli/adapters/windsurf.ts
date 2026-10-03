import { createRulesDirAdapter } from './rules-dir-base.js'

/**
 * Windsurf adapter — Windsurf is now Devin Desktop. A rules-directory IDE
 * writing `.md` files, with skills as Agent Skills.
 *
 * Windsurf replaces Cursor's boolean with a single `trigger` enum, so the glob
 * case and the always-on case are mutually exclusive rather than combinable.
 *
 * Both of Devin Desktop's agents read skills from `.agents/skills/`, so skills
 * go there, shared with every other target that reads it. MCP servers go to
 * `.devin/mcp_config.json`, the project file the default Devin Local agent
 * reads; the legacy Cascade agent reads only its global config. Releases
 * before this one wrote `.windsurf/mcp.json`, which nothing reads — `sync`
 * takes our servers back out of it.
 */
const adapter = createRulesDirAdapter({
  ideId: 'windsurf',
  ideLabel: 'Windsurf',
  rootRulesFile: '.windsurfrules',
  configDir: '.windsurf',
  ruleExt: '.md',
  skillsDir: '.agents/skills',
  mcpConfigPath: '.devin/mcp_config.json',
  renderFrontmatter({ description, applyTo, alwaysApply, tier }) {
    let trigger: 'always_on' | 'model_decision' | 'glob'
    let globs: string[] | undefined

    if (applyTo === '**') {
      trigger = 'always_on'
    } else if (applyTo) {
      trigger = 'glob'
      globs = [applyTo]
    } else {
      trigger = alwaysApply ? 'always_on' : 'model_decision'
    }

    const lines = [`trigger: ${trigger}`]
    if (description) lines.push(`description: "${description}"`)
    if (globs) lines.push(`globs: ${JSON.stringify(globs)}`)
    if (tier) lines.push(`tier: ${tier}`)
    return lines
  },
})

export const IDE_ID = adapter.IDE_ID
export const IDE_LABEL = adapter.IDE_LABEL
export const { install, update, getManagedPaths, getDoctorChecks } = adapter
