import type { PluginConfig } from './types.js';
import { config as sanity } from './sanity/config.js';
import { config as trello } from './trello/config.js';
import { config as notion } from './notion/config.js';
import { config as contentful } from './contentful/config.js';
import { config as strapi } from './strapi/config.js';
import { config as supabase } from './supabase/config.js';
import { config as convex } from './convex/config.js';
import { config as vercel } from './vercel/config.js';
import { config as nx } from './nx/config.js';
import { config as linear } from './linear/config.js';
import { config as jira } from './jira/config.js';
import { config as slack } from './slack/config.js';
import { config as teams } from './teams/config.js';
import { config as chromeDevtools } from './chrome-devtools/config.js';
import { config as netlify } from './netlify/config.js';
import { config as turborepo } from './turborepo/config.js';
import { config as prisma } from './prisma/config.js';
import { config as cypress } from './cypress/config.js';
import { config as playwright } from './playwright/config.js';
import { config as vitest } from './vitest/config.js';
import { config as figma } from './figma/config.js';
import { config as resend } from './resend/config.js';
import { config as stripe } from './stripe/config.js';
import { config as nextjs } from './nextjs/config.js';
import { config as astro } from './astro/config.js';
import { config as sentry } from './sentry/config.js';
import { config as drizzle } from './drizzle/config.js';
import { config as cloudflare } from './cloudflare/config.js';
import { config as coolify } from './coolify/config.js';
import { config as expo } from './expo/config.js';

export type { PluginConfig, McpServerConfig, McpInput, EnvVarRequirement } from './types.js';

/** All registered plugins, keyed by ID. */
export const PLUGINS: Record<string, PluginConfig> = {
  sanity,
  contentful,
  strapi,
  supabase,
  convex,
  vercel,
  nx,
  'chrome-devtools': chromeDevtools,
  netlify,
  turborepo,
  prisma,
  cypress,
  playwright,
  vitest,
  figma,
  resend,
  stripe,
  nextjs,
  astro,
  sentry,
  drizzle,
  cloudflare,
  coolify,
  expo,
  linear,
  jira,
  trello,
  notion,
  slack,
  teams,
};

/** Tech tool plugins only. */
export const TECH_PLUGINS = Object.values(PLUGINS).filter(
  (p) => p.category === 'tech'
);

/** Team tool plugins only. */
export const TEAM_PLUGINS = Object.values(PLUGINS).filter(
  (p) => p.category === 'team'
);

/** CMS plugins (subset of tech). */
export const CMS_PLUGINS = TECH_PLUGINS.filter(
  (p) => p.subCategory === 'cms'
);

/** Database plugins (subset of tech). */
export const DB_PLUGINS = TECH_PLUGINS.filter(
  (p) => p.subCategory === 'database'
);

/** Get a plugin by ID. */
export function getPlugin(id: string): PluginConfig | undefined {
  return PLUGINS[id];
}

/** Get all plugins in a category. */
export function getPluginsByCategory(category: 'tech' | 'team'): PluginConfig[] {
  return Object.values(PLUGINS).filter((p) => p.category === category);
}

/** Get all plugins in a sub-category. */
export function getPluginsBySubCategory(
  subCategory: PluginConfig['subCategory']
): PluginConfig[] {
  return Object.values(PLUGINS).filter((p) => p.subCategory === subCategory);
}

/**
 * Get all skill names from selected plugins.
 * Returns only non-null skill names for the given tool IDs.
 */
export function getSelectedSkillNames(toolIds: string[]): string[] {
  return toolIds
    .map((id) => PLUGINS[id]?.skillName)
    .filter((s): s is string => s !== null);
}

/**
 * All possible tool-specific skill names (used to compute exclusions).
 */
export const ALL_PLUGIN_SKILL_NAMES: string[] = Object.values(PLUGINS)
  .map((p) => p.skillName)
  .filter((s): s is string => s !== null);
