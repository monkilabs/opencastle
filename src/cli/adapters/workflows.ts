import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stripFrontmatter } from './frontmatter.js'

/**
 * The phase every workflow template ends with, written once in the source.
 *
 * It used to be installed beside the templates and linked from each of them,
 * which worked in exactly one layout. Claude Code names its copy
 * `workflow-shared-delivery-phase.md` and Cursor `shared-delivery-phase.mdc`,
 * so the link `shared-delivery-phase.md` led nowhere there; and in Claude Code
 * the fragment became a command of its own, `/oc:workflow-shared-delivery-phase`,
 * that runs nothing. Each template now carries the phase itself, so a template
 * is whole wherever it is read and the fragment is never installed.
 */
export const SHARED_PHASE_FILE = 'shared-delivery-phase.md'

/** Is this file in `agent-workflows/` a template someone can run? */
export function isWorkflowTemplate(name: string): boolean {
  return name.endsWith('.md') && name !== 'README.md' && name !== SHARED_PHASE_FILE
}

/** The shared phase as compiled from `srcRoot`, or null when no layer provides it. */
export function readSharedPhase(srcRoot: string): string | null {
  const path = resolve(srcRoot, 'agent-workflows', SHARED_PHASE_FILE)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** A pointer to the shared phase: a blockquote whose first line links to it. */
const POINTER = /^>[^\n]*\]\(shared-delivery-phase\.md\)[^\n]*\n(?:>[^\n]*\n?)*/m

/**
 * The template with its pointer to the shared phase replaced by the phase.
 *
 * The phase's own title and introduction are left out, and its sections are
 * nested under the template's delivery heading. Without the phase — a team
 * layer excluded it — the link is reduced to its words, so nothing points at a
 * file that was never written.
 */
export function inlineSharedPhase(template: string, shared: string | null): string {
  if (!POINTER.test(template)) return template
  if (shared === null) {
    return template.replace(/\[([^\]]+)\]\(shared-delivery-phase\.md\)/g, 'the shared delivery phase')
  }
  const body = stripFrontmatter(shared)
    .replace(/^<!--[\s\S]*?-->\s*/, '')
    .replace(/^#\s[^\n]*\n+/, '')
  // Everything before the first section is the phase describing itself.
  const sections = body.slice(Math.max(0, body.search(/^##\s/m))).trim()
  const nested = sections.replace(/^(#{2,4})(\s)/gm, '##$1$2')
  return template.replace(POINTER, `${nested}\n`)
}

/**
 * The source names the templates' folder as VS Code installs it,
 * `.github/agent-workflows/`. Every other target writes them somewhere else,
 * and the Team Lead was sent to search a folder that only a Copilot project
 * has. `where` is this target's folder, or the glob for its files.
 */
export function pointAtWorkflows(content: string, where: string): string {
  return content.replaceAll('`.github/agent-workflows/`', `\`${where}\``)
}
