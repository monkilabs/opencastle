// Platform skill compatibility -- not all skills are relevant on all platforms

export interface PlatformSkillConfig {
  platform: 'claude-code' | 'cursor' | 'opencode' | 'gemini'
  excludedSkills: string[]
  displayName: string
  manifestFile: string
  entryPoint: string
  outputDir: string
  includedDirs: ('skills' | 'agents' | 'instructions' | 'prompts' | 'agent-workflows')[]
}

const SESSION_ONLY = ['session-checkpoints']
const CONCURRENT_ONLY = ['panel-majority-vote']
const TEAM_LEAD_ONLY = [
  'orchestration-protocols', 'team-lead-reference', 'decomposition',
  'agent-memory', 'context-map', 'fast-review', 'memory-merger',
]
const SIMPLE_PLATFORM_EXCLUSIONS = [...SESSION_ONLY, ...CONCURRENT_ONLY, ...TEAM_LEAD_ONLY]

export const PLATFORM_CONFIGS: Record<string, PlatformSkillConfig> = {
  'claude-code': {
    platform: 'claude-code', excludedSkills: [], displayName: 'Claude Code',
    manifestFile: 'manifest.json', entryPoint: 'CLAUDE.md', outputDir: 'claude-code',
    includedDirs: ['skills', 'agents', 'instructions', 'prompts', 'agent-workflows'],
  },
  cursor: {
    platform: 'cursor', excludedSkills: [...SESSION_ONLY], displayName: 'Cursor',
    manifestFile: 'manifest.json', entryPoint: '.cursorrules', outputDir: 'cursor',
    includedDirs: ['skills', 'agents', 'instructions'],
  },
  opencode: {
    platform: 'opencode', excludedSkills: [...SIMPLE_PLATFORM_EXCLUSIONS], displayName: 'OpenCode',
    manifestFile: 'manifest.json', entryPoint: 'OPENCODE.md', outputDir: 'opencode',
    includedDirs: ['skills', 'agents', 'instructions'],
  },
  gemini: {
    platform: 'gemini', excludedSkills: [...SIMPLE_PLATFORM_EXCLUSIONS], displayName: 'Gemini CLI',
    manifestFile: 'gemini-extension.json', entryPoint: 'GEMINI.md', outputDir: 'gemini',
    includedDirs: ['skills', 'agents', 'instructions'],
  },
}

export function getSkillsForPlatform(platform: string, allSkills: string[]): string[] {
  const config = PLATFORM_CONFIGS[platform]
  if (!config) return allSkills
  return allSkills.filter(skill => !config.excludedSkills.includes(skill))
}
