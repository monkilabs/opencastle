import { createRulesDirAdapter } from './rules-dir-base.js'

/**
 * Cursor adapter — a rules-directory IDE writing `.mdc` files.
 *
 * Cursor expresses scoping with an `alwaysApply` boolean plus an optional
 * `globs` array; a rule with neither is matched on its description.
 */
const adapter = createRulesDirAdapter({
  ideId: 'cursor',
  ideLabel: 'Cursor',
  rootRulesFile: '.cursorrules',
  configDir: '.cursor',
  ruleExt: '.mdc',
  renderFrontmatter({ description, applyTo, alwaysApply }) {
    const lines: string[] = []
    if (description) lines.push(`description: "${description}"`)
    if (applyTo) lines.push(`globs: ${JSON.stringify([applyTo])}`)
    // An applyTo of '**' means every file, which is the same as always applying.
    const apply = applyTo === '**' ? true : alwaysApply
    lines.push(`alwaysApply: ${apply ? 'true' : 'false'}`)
    return lines
  },
})

export const IDE_ID = adapter.IDE_ID
export const IDE_LABEL = adapter.IDE_LABEL
export const { install, update, getManagedPaths, getDoctorChecks } = adapter
