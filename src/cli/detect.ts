import { resolve } from 'node:path';
import { readFile, readdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { IdeChoice, RepoInfo, StackConfig } from './types.js';

// ── IDE detection ───────────────────────────────────────────────

/**
 * Detect which IDE the CLI is running from, based on environment variables.
 * Returns the IdeChoice value or undefined if unknown.
 */
export function detectCurrentIde(): IdeChoice | undefined {
  const env = process.env;

  // Cursor sets its own TERM_PROGRAM or CURSOR-specific env vars
  if (env.CURSOR_TRACE_DIR || env.CURSOR_CHANNEL) return 'cursor';

  // Windsurf sets WINDSURF_TRACE_DIR or TERM_PROGRAM=windsurf
  if (env.WINDSURF_TRACE_DIR || env.TERM_PROGRAM === 'windsurf') return 'windsurf';

  // VS Code sets TERM_PROGRAM=vscode in its integrated terminal
  if (env.TERM_PROGRAM === 'vscode') return 'vscode';

  // Claude Code — check for CLAUDE_* env vars set by the CLI
  if (env.CLAUDE_CODE === '1' || env.CLAUDE_PROJECT_ROOT) return 'claude-code';

  return undefined;
}

// ── Detection rules ───────────────────────────────────────────

interface DetectionRule {
  /** Human-readable label stored in repoInfo */
  label: string;
  /** File patterns to check (relative to project root) */
  files: string[];
  /** Optional: glob-style directory check */
  dirs?: string[];
}

const PACKAGE_MANAGERS: DetectionRule[] = [
  { label: 'pnpm', files: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'] },
  { label: 'yarn', files: ['yarn.lock'] },
  { label: 'bun', files: ['bun.lockb', 'bun.lock'] },
  { label: 'npm', files: ['package-lock.json'] },
];

const MONOREPO_TOOLS: DetectionRule[] = [
  { label: 'nx', files: ['nx.json'] },
  { label: 'turborepo', files: ['turbo.json'] },
  { label: 'lerna', files: ['lerna.json'] },
  { label: 'pnpm-workspaces', files: ['pnpm-workspace.yaml'] },
];

const FRAMEWORKS: DetectionRule[] = [
  { label: 'next', files: ['next.config.js', 'next.config.mjs', 'next.config.ts'] },
  { label: 'nuxt', files: ['nuxt.config.js', 'nuxt.config.ts'] },
  { label: 'astro', files: ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'] },
  { label: 'remix', files: ['remix.config.js', 'remix.config.ts'] },
  { label: 'sveltekit', files: ['svelte.config.js', 'svelte.config.ts'] },
  { label: 'vite', files: ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'] },
  { label: 'angular', files: ['angular.json'] },
  { label: 'gatsby', files: ['gatsby-config.js', 'gatsby-config.ts'] },
  { label: 'express', files: [] }, // detected via package.json
];

const DATABASES: DetectionRule[] = [
  { label: 'supabase', files: ['supabase/config.toml'], dirs: ['supabase/'] },
  { label: 'prisma', files: ['prisma/schema.prisma'] },
  { label: 'drizzle', files: ['drizzle.config.ts', 'drizzle.config.js'] },
  { label: 'convex', files: ['convex/_generated'], dirs: ['convex/'] },
  { label: 'mongoose', files: [] }, // detected via package.json
  { label: 'typeorm', files: [] }, // detected via package.json
];

const CMS_PLATFORMS: DetectionRule[] = [
  { label: 'sanity', files: ['sanity.config.ts', 'sanity.config.js', 'sanity.config.mjs'] },
  { label: 'contentful', files: ['.contentful.json', 'contentful.config.js'] },
  { label: 'strapi', files: [] }, // detected via package.json
  { label: 'payload', files: ['payload.config.ts', 'payload.config.js'] },
];

const DEPLOYMENT: DetectionRule[] = [
  { label: 'vercel', files: ['vercel.json'] },
  { label: 'netlify', files: ['netlify.toml'] },
  { label: 'docker', files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'] },
  { label: 'railway', files: ['railway.json', 'railway.toml'] },
  { label: 'fly', files: ['fly.toml'] },
  { label: 'render', files: ['render.yaml'] },
  { label: 'aws-cdk', files: ['cdk.json'] },
  { label: 'terraform', files: [] , dirs: ['terraform/'] },
  { label: 'pulumi', files: ['Pulumi.yaml'] },
];

const TESTING: DetectionRule[] = [
  { label: 'jest', files: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs'] },
  { label: 'vitest', files: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs'] },
  { label: 'playwright', files: ['playwright.config.ts', 'playwright.config.js'] },
  { label: 'cypress', files: ['cypress.config.ts', 'cypress.config.js'], dirs: ['cypress/'] },
];

const CICD: DetectionRule[] = [
  { label: 'github-actions', files: [], dirs: ['.github/workflows/'] },
  { label: 'gitlab-ci', files: ['.gitlab-ci.yml'] },
  { label: 'circleci', files: ['.circleci/config.yml'] },
  { label: 'jenkins', files: ['Jenkinsfile'] },
  { label: 'travis', files: ['.travis.yml'] },
];

const STYLING: DetectionRule[] = [
  { label: 'tailwind', files: ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.mjs'] },
  { label: 'sass', files: [] }, // detected via package.json
  { label: 'styled-components', files: [] }, // detected via package.json
  { label: 'emotion', files: [] }, // detected via package.json
  { label: 'css-modules', files: [] }, // detected via file extensions
];

const AUTH: DetectionRule[] = [
  { label: 'next-auth', files: [] }, // detected via package.json
  { label: 'clerk', files: [] }, // detected via package.json
  { label: 'auth0', files: [] }, // detected via package.json
  { label: 'supabase-auth', files: [] }, // detected via supabase presence
  { label: 'lucia', files: [] }, // detected via package.json
  { label: 'passport', files: [] }, // detected via package.json
];

// Mapping of npm package names to detection labels
const PACKAGE_DETECTIONS: Record<string, { category: string; label: string }> = {
  'next': { category: 'frameworks', label: 'next' },
  'nuxt': { category: 'frameworks', label: 'nuxt' },
  'astro': { category: 'frameworks', label: 'astro' },
  '@remix-run/node': { category: 'frameworks', label: 'remix' },
  '@sveltejs/kit': { category: 'frameworks', label: 'sveltekit' },
  'express': { category: 'frameworks', label: 'express' },
  'fastify': { category: 'frameworks', label: 'fastify' },
  'hono': { category: 'frameworks', label: 'hono' },
  'mongoose': { category: 'databases', label: 'mongoose' },
  'typeorm': { category: 'databases', label: 'typeorm' },
  '@supabase/supabase-js': { category: 'databases', label: 'supabase' },
  '@prisma/client': { category: 'databases', label: 'prisma' },
  'drizzle-orm': { category: 'databases', label: 'drizzle' },
  'convex': { category: 'databases', label: 'convex' },
  'sanity': { category: 'cms', label: 'sanity' },
  'contentful': { category: 'cms', label: 'contentful' },
  '@strapi/strapi': { category: 'cms', label: 'strapi' },
  'payload': { category: 'cms', label: 'payload' },
  'next-auth': { category: 'auth', label: 'next-auth' },
  '@auth/core': { category: 'auth', label: 'next-auth' },
  '@clerk/nextjs': { category: 'auth', label: 'clerk' },
  '@clerk/clerk-sdk-node': { category: 'auth', label: 'clerk' },
  '@auth0/nextjs-auth0': { category: 'auth', label: 'auth0' },
  'auth0': { category: 'auth', label: 'auth0' },
  'lucia': { category: 'auth', label: 'lucia' },
  'passport': { category: 'auth', label: 'passport' },
  'sass': { category: 'styling', label: 'sass' },
  'styled-components': { category: 'styling', label: 'styled-components' },
  '@emotion/react': { category: 'styling', label: 'emotion' },
  '@emotion/styled': { category: 'styling', label: 'emotion' },
  'tailwindcss': { category: 'styling', label: 'tailwind' },
  'jest': { category: 'testing', label: 'jest' },
  'vitest': { category: 'testing', label: 'vitest' },
  '@playwright/test': { category: 'testing', label: 'playwright' },
  'cypress': { category: 'testing', label: 'cypress' },
};

// ── Helpers ───────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path);
    const entries = await readdir(path);
    return entries.length >= 0; // exists as a directory
  } catch {
    return false;
  }
}

function addUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

// ── Main detect function ──────────────────────────────────────

/** Internal type with required arrays for detection phase. */
interface RepoInfoInternal {
  packageManager?: string;
  monorepo?: string;
  language?: string;
  frameworks: string[];
  databases: string[];
  cms: string[];
  deployment: string[];
  testing: string[];
  cicd: string[];
  styling: string[];
  auth: string[];
  mcpConfig?: boolean;
  configFiles: string[];
}

/**
 * Perform repo research: scan the project root for config files,
 * package.json dependencies, and directory structures to detect
 * the project's tooling and tech stack.
 */
export async function detectRepoInfo(projectRoot: string): Promise<RepoInfo> {
  const info: RepoInfoInternal = {
    frameworks: [],
    databases: [],
    cms: [],
    deployment: [],
    testing: [],
    cicd: [],
    styling: [],
    auth: [],
    configFiles: [],
  };

  // ── 1. Detect package manager ───────────────────────────────
  for (const pm of PACKAGE_MANAGERS) {
    const found = await checkFiles(projectRoot, pm.files);
    if (found.length > 0) {
      info.packageManager = pm.label;
      info.configFiles.push(...found);
      break; // first match wins (order = priority)
    }
  }

  // ── 2. Detect monorepo tool ─────────────────────────────────
  for (const tool of MONOREPO_TOOLS) {
    const found = await checkFiles(projectRoot, tool.files);
    if (found.length > 0) {
      info.monorepo = tool.label;
      info.configFiles.push(...found);
      break;
    }
  }

  // ── 3. Detect by config files (parallel) ─────────────────────
  await Promise.all([
    detectCategory(projectRoot, FRAMEWORKS, info, 'frameworks'),
    detectCategory(projectRoot, DATABASES, info, 'databases'),
    detectCategory(projectRoot, CMS_PLATFORMS, info, 'cms'),
    detectCategory(projectRoot, DEPLOYMENT, info, 'deployment'),
    detectCategory(projectRoot, TESTING, info, 'testing'),
    detectCategory(projectRoot, CICD, info, 'cicd'),
    detectCategory(projectRoot, STYLING, info, 'styling'),
    detectCategory(projectRoot, AUTH, info, 'auth'),
  ]);

  // ── 4. Detect from package.json deps ────────────────────────
  await detectFromPackageJson(projectRoot, info);

  // ── 4b. Scan workspace packages in monorepos ────────────────
  if (info.monorepo) {
    await scanWorkspacePackages(projectRoot, info);
  }

  // ── 5. Detect MCP config ────────────────────────────────────
  const mcpPaths = [
    '.vscode/mcp.json',
    '.cursor/mcp.json',
    '.claude/mcp.json',
    'mcp.json',
  ];
  await Promise.all(
    mcpPaths.map(async (p) => {
      if (await fileExists(resolve(projectRoot, p))) {
        info.mcpConfig = true;
        info.configFiles.push(p);
      }
    })
  );

  // ── 6. Check for TypeScript ─────────────────────────────────
  const tsConfigPath = resolve(projectRoot, 'tsconfig.json');
  if (await fileExists(tsConfigPath)) {
    info.language = 'typescript';
    info.configFiles.push('tsconfig.json');
  } else {
    const jsConfigPath = resolve(projectRoot, 'jsconfig.json');
    if (await fileExists(jsConfigPath)) {
      info.language = 'javascript';
      info.configFiles.push('jsconfig.json');
    }
  }

  // ── 7. Detect CSS modules via src scan ──────────────────────
  if (!info.styling.includes('css-modules')) {
    const hasCssModules = await scanForPattern(projectRoot, /\.module\.(css|scss|sass)$/);
    if (hasCssModules) {
      addUnique(info.styling, 'css-modules');
    }
  }

  // ── 8. Detect supabase-auth if supabase is present ──────────
  if (info.databases.includes('supabase') && !info.auth.includes('supabase-auth')) {
    addUnique(info.auth, 'supabase-auth');
  }

  // Deduplicate configFiles
  info.configFiles = [...new Set(info.configFiles)];

  // Sort arrays for stable output
  for (const key of ['frameworks', 'databases', 'cms', 'deployment', 'testing', 'cicd', 'styling', 'auth', 'configFiles'] as const) {
    info[key].sort();
  }

  // Strip empty arrays for cleaner JSON and return as RepoInfo
  return cleanEmpty(info);
}

// ── Internal helpers ──────────────────────────────────────────

async function checkFiles(root: string, files: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const f of files) {
    if (await fileExists(resolve(root, f))) {
      found.push(f);
    }
  }
  return found;
}

type CategoryKey = 'frameworks' | 'databases' | 'cms' | 'deployment' | 'testing' | 'cicd' | 'styling' | 'auth';

async function detectCategory(
  root: string,
  rules: DetectionRule[],
  info: RepoInfoInternal,
  category: CategoryKey,
): Promise<void> {
  for (const rule of rules) {
    if (rule.files.length === 0 && !rule.dirs?.length) continue; // package.json-only detection

    const foundFiles = await checkFiles(root, rule.files);
    let foundDir = false;
    if (rule.dirs) {
      for (const d of rule.dirs) {
        if (await dirExists(resolve(root, d))) {
          foundDir = true;
          break;
        }
      }
    }

    if (foundFiles.length > 0 || foundDir) {
      addUnique(info[category], rule.label);
      info.configFiles.push(...foundFiles);
    }
  }
}

async function detectFromPackageJson(root: string, info: RepoInfoInternal): Promise<void> {
  const pkgPath = resolve(root, 'package.json');
  if (!await fileExists(pkgPath)) return;

  try {
    const content = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      packageManager?: string;
    };

    // Detect from dependencies
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [pkgName, detection] of Object.entries(PACKAGE_DETECTIONS)) {
      if (pkgName in allDeps) {
        addUnique(info[detection.category as CategoryKey], detection.label);
      }
    }

    // Detect package manager from packageManager field (corepack)
    if (pkg.packageManager && !info.packageManager) {
      const pm = pkg.packageManager.split('@')[0];
      if (['pnpm', 'yarn', 'bun', 'npm'].includes(pm)) {
        info.packageManager = pm;
      }
    }

    // Track package.json itself
    if (!info.configFiles.includes('package.json')) {
      info.configFiles.push('package.json');
    }
  } catch {
    // Malformed package.json — skip silently
  }
}

/**
 * Quick scan of src/ directory (1 level deep) for file name patterns.
 * Used to detect CSS modules without walking the entire tree.
 */
async function scanForPattern(root: string, pattern: RegExp): Promise<boolean> {
  const srcDir = resolve(root, 'src');
  if (!existsSync(srcDir)) return false;

  try {
    const queue = [srcDir];
    let depth = 0;
    const maxDepth = 3;

    while (queue.length > 0 && depth < maxDepth) {
      const nextQueue: string[] = [];
      for (const dir of queue) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          if (entry.isFile() && pattern.test(entry.name)) return true;
          if (entry.isDirectory()) nextQueue.push(resolve(dir, entry.name));
        }
      }
      queue.length = 0;
      queue.push(...nextQueue);
      depth++;
    }
  } catch {
    // Permission or read error — skip
  }

  return false;
}

/**
 * Scan workspace package directories in monorepos for additional tooling.
 * Checks both package.json dependencies and config files in each workspace package.
 */
async function scanWorkspacePackages(projectRoot: string, info: RepoInfoInternal): Promise<void> {
  const packageDirs = await resolveWorkspacePackageDirs(projectRoot);

  for (const pkgDir of packageDirs) {
    await detectFromPackageJson(pkgDir, info);
    await Promise.all([
      detectCategory(pkgDir, FRAMEWORKS, info, 'frameworks'),
      detectCategory(pkgDir, DATABASES, info, 'databases'),
      detectCategory(pkgDir, CMS_PLATFORMS, info, 'cms'),
      detectCategory(pkgDir, DEPLOYMENT, info, 'deployment'),
      detectCategory(pkgDir, TESTING, info, 'testing'),
      detectCategory(pkgDir, CICD, info, 'cicd'),
      detectCategory(pkgDir, STYLING, info, 'styling'),
      detectCategory(pkgDir, AUTH, info, 'auth'),
    ]);
  }
}

/**
 * Resolve workspace package directories.
 * Tries pnpm-workspace.yaml first, then falls back to scanning common directories.
 */
async function resolveWorkspacePackageDirs(projectRoot: string): Promise<string[]> {
  const dirs: string[] = [];

  // Try pnpm-workspace.yaml first
  const pnpmWorkspacePath = resolve(projectRoot, 'pnpm-workspace.yaml');
  if (await fileExists(pnpmWorkspacePath)) {
    try {
      const content = await readFile(pnpmWorkspacePath, 'utf8');
      const globs = parsePnpmWorkspaceGlobs(content);
      for (const glob of globs) {
        const resolved = await expandGlobDirs(projectRoot, glob);
        dirs.push(...resolved);
      }
    } catch {
      // Fall through to common directory scan
    }
  }

  // Fall back to common directories if nothing found
  if (dirs.length === 0) {
    const commonDirs = ['apps', 'packages', 'libs'];
    for (const dir of commonDirs) {
      const dirPath = resolve(projectRoot, dir);
      if (await dirExists(dirPath)) {
        try {
          const entries = await readdir(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
              dirs.push(resolve(dirPath, entry.name));
            }
          }
        } catch {
          // Skip unreadable directories
        }
      }
    }
  }

  return dirs;
}

/**
 * Parse pnpm-workspace.yaml to extract package glob patterns.
 * Simple line parser — no YAML library needed.
 */
function parsePnpmWorkspaceGlobs(content: string): string[] {
  const globs: string[] = [];
  const lines = content.split('\n');
  let inPackages = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'packages:') {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      // Stop at next top-level key
      if (trimmed && !trimmed.startsWith('-') && !trimmed.startsWith('#')) {
        break;
      }
      const match = trimmed.match(/^-\s+['"]?([^'"]+?)['"]?\s*$/);
      if (match) {
        globs.push(match[1]);
      }
    }
  }

  return globs;
}

/**
 * Expand a glob pattern like 'apps/*' into actual directories.
 * Only supports simple patterns ending in /* (single-level wildcard).
 */
async function expandGlobDirs(root: string, glob: string): Promise<string[]> {
  const dirs: string[] = [];
  // Strip trailing /* or /** and resolve the parent directory
  const cleaned = glob.replace(/\/\*\*?$/, '').replace(/\/$/, '');
  const parentDir = resolve(root, cleaned);

  if (await dirExists(parentDir)) {
    try {
      const entries = await readdir(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          dirs.push(resolve(parentDir, entry.name));
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return dirs;
}

/**
 * Build a Set of detected tool plugin IDs from RepoInfo.
 * Maps detection labels to plugin IDs (e.g., 'next' → 'nextjs').
 * Includes all categories: cms, databases, deployment, testing, monorepo, frameworks.
 */
export function buildDetectedToolsSet(repoInfo: RepoInfo): Set<string> {
  return new Set([
    ...(repoInfo.cms ?? []),
    ...(repoInfo.databases ?? []),
    ...(repoInfo.deployment ?? []),
    ...(repoInfo.testing ?? []),
    ...(repoInfo.monorepo ? [repoInfo.monorepo] : []),
    ...((repoInfo.frameworks ?? []).map(f => f === 'next' ? 'nextjs' : f)),
  ]);
}

/**
 * Remove empty arrays and undefined values, returning a clean RepoInfo.
 */
function cleanEmpty(info: RepoInfoInternal): RepoInfo {
  const result: RepoInfo = {};

  if (info.packageManager) result.packageManager = info.packageManager;
  if (info.monorepo) result.monorepo = info.monorepo;
  if (info.language) result.language = info.language;
  if (info.mcpConfig) result.mcpConfig = info.mcpConfig;
  if (info.frameworks.length > 0) result.frameworks = info.frameworks;
  if (info.databases.length > 0) result.databases = info.databases;
  if (info.cms.length > 0) result.cms = info.cms;
  if (info.deployment.length > 0) result.deployment = info.deployment;
  if (info.testing.length > 0) result.testing = info.testing;
  if (info.cicd.length > 0) result.cicd = info.cicd;
  if (info.styling.length > 0) result.styling = info.styling;
  if (info.auth.length > 0) result.auth = info.auth;
  if (info.configFiles.length > 0) result.configFiles = info.configFiles;

  return result;
}

/**
 * Merge user-declared stack choices into the auto-detected repoInfo.
 * Adds tech tools and team tools from the questionnaire so
 * repoInfo becomes the single combined source of truth.
 */
export function mergeStackIntoRepoInfo(info: RepoInfo, stack: StackConfig): RepoInfo {
  const merged = { ...info };

  for (const tool of stack.techTools) {
    if (['sanity', 'contentful', 'strapi'].includes(tool)) {
      merged.cms = addUniqueToArray(merged.cms, tool);
    } else if (['supabase', 'convex'].includes(tool)) {
      merged.databases = addUniqueToArray(merged.databases, tool);
    } else if (tool === 'vercel') {
      merged.deployment = addUniqueToArray(merged.deployment, tool);
    } else if (tool === 'nx') {
      merged.monorepo = merged.monorepo ?? 'nx';
    }
  }

  for (const tool of stack.teamTools) {
    if (['linear', 'jira'].includes(tool)) {
      merged.pm = addUniqueToArray(merged.pm, tool);
    } else if (['slack', 'teams'].includes(tool)) {
      merged.notifications = addUniqueToArray(merged.notifications, tool);
    }
  }

  return merged;
}

function addUniqueToArray(arr: string[] | undefined, value: string): string[] {
  const result = arr ? [...arr] : [];
  if (!result.includes(value)) result.push(value);
  return result.sort();
}

/**
 * Format the detected repo info for console display.
 */
export function formatRepoInfo(info: RepoInfo): string {
  const lines: string[] = [];

  if (info.packageManager) lines.push(`Package manager: ${info.packageManager}`);
  if (info.monorepo) lines.push(`Monorepo: ${info.monorepo}`);
  if (info.language) lines.push(`Language: ${info.language}`);
  if (info.frameworks?.length) lines.push(`Frameworks: ${info.frameworks.join(', ')}`);
  if (info.databases?.length) lines.push(`Databases: ${info.databases.join(', ')}`);
  if (info.cms?.length) lines.push(`CMS: ${info.cms.join(', ')}`);
  if (info.auth?.length) lines.push(`Auth: ${info.auth.join(', ')}`);
  if (info.pm?.length) lines.push(`Project management: ${info.pm.join(', ')}`);
  if (info.notifications?.length) lines.push(`Notifications: ${info.notifications.join(', ')}`);
  if (info.deployment?.length) lines.push(`Deployment: ${info.deployment.join(', ')}`);
  if (info.testing?.length) lines.push(`Testing: ${info.testing.join(', ')}`);
  if (info.cicd?.length) lines.push(`CI/CD: ${info.cicd.join(', ')}`);
  if (info.styling?.length) lines.push(`Styling: ${info.styling.join(', ')}`);
  if (info.mcpConfig) lines.push(`MCP config: found`);

  return lines.map(l => `    ${l}`).join('\n');
}
