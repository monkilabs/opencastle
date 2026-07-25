import { createRulesDirAdapter } from './rules-dir-base.js'

/**
 * Windsurf adapter — a rules-directory IDE writing `.md` files.
 *
 * Windsurf replaces Cursor's boolean with a single `trigger` enum, so the glob
 * case and the always-on case are mutually exclusive rather than combinable.
 */
const adapter = createRulesDirAdapter({
  ideId: 'windsurf',
  ideLabel: 'Windsurf',
  rootRulesFile: '.windsurfrules',
  configDir: '.windsurf',
  ruleExt: '.md',
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
