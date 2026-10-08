import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSkillMatrixContent, isEnvVarSatisfied, getExcludedCoreSkills, isPreselected, envFileTextFor } from './stack-config.js';
import type { StackConfig } from './types.js';
import type { SkillMatrixData } from './stack-config.js';

function makeTemplate(): SkillMatrixData {
  return {
    bindings: {
      framework: {
        entries: [],
        description: 'SSR/SSG, routing, layouts, Server/Client Components',
      },
      database: { entries: [], description: 'Schema, migrations, auth flow, roles' },
      cms: { entries: [], description: 'Document types, queries, schema management' },
      deployment: {
        entries: [],
        description: 'Hosting, cron jobs, env vars, caching, headers',
      },
      'codebase-tool': {
        entries: [],
        description: 'Task running, building, linting, testing, code generation',
      },
      testing: {
        entries: [],
        description: 'Unit testing frameworks, coverage, test planning',
      },
      'e2e-testing': {
        entries: [],
        description: 'Browser automation, E2E testing, viewport testing, visual validation',
      },
      'task-management': {
        entries: [],
        description: 'Issue tracking, naming, priorities, workflow states',
      },
      'knowledge-management': {
        entries: [],
        description: 'Workspace knowledge base, research capture, ADRs, specs, page hierarchy',
      },
    },
    agents: {},
  };
}

function templateJson(): string {
  return JSON.stringify(makeTemplate(), null, 2) + '\n';
}

function parse(result: string): SkillMatrixData {
  return JSON.parse(result);
}

describe('isEnvVarSatisfied', () => {
  const set = (env: string) => isEnvVarSatisfied('OC_TEST_TOKEN', env);

  it('reads a value, exported or not, quoted or not', () => {
    expect(set('OC_TEST_TOKEN=abc')).toBe(true);
    expect(set('export OC_TEST_TOKEN = "abc"')).toBe(true);
    expect(set('OC_TEST_TOKEN=#not-a-comment')).toBe(true);
  });

  it('does not take the next line for the value of an empty one', () => {
    // The shape init writes: a placeholder, then the next variable's comment.
    expect(set('OC_TEST_TOKEN=\n# Another token\nOTHER=x')).toBe(false);
  });

  it('counts empty quotes and a comment as no value', () => {
    expect(set('OC_TEST_TOKEN=""')).toBe(false);
    expect(set("OC_TEST_TOKEN=''  # fill me")).toBe(false);
    expect(set('OC_TEST_TOKEN=   # fill me')).toBe(false);
  });
});

/**
 * `source-control` arrived with GitHub and GitLab, after every existing
 * project's matrix was written, and `sync` only filled slots a matrix had —
 * so adding GitHub bound its skill to no agent.
 */
describe('a slot a release added', () => {
  const withGithub: StackConfig = { ides: ['vscode'], techTools: [], teamTools: ['github'] };
  const slotsOf = (data: SkillMatrixData, agent: string) => data.agents[agent].slots;
  // A matrix as releases before the slot wrote it.
  const makeOld = (): SkillMatrixData => ({
    ...makeTemplate(),
    agents: {
      'Team Lead (OpenCastle)': { slots: ['task-management'], directSkills: [] },
      'DevOps & Release': { slots: ['deployment'], directSkills: [] },
      Developer: { slots: ['framework'], directSkills: [] },
    },
  });

  it('reaches an existing matrix once a selected integration fills it, with the agents it belongs to', () => {
    const data: SkillMatrixData = JSON.parse(updateSkillMatrixContent(JSON.stringify(makeOld()), withGithub));
    expect(data.bindings['source-control'].entries).toEqual([{ name: 'GitHub', skill: 'github-platform' }]);
    expect(data.bindings['source-control'].description).toBeTruthy();
    expect(slotsOf(data, 'Team Lead (OpenCastle)')).toContain('source-control');
    expect(slotsOf(data, 'DevOps & Release')).toContain('source-control');
    expect(slotsOf(data, 'Developer')).not.toContain('source-control');
  });

  it('is not added for a stack that does not use it', () => {
    const data: SkillMatrixData = JSON.parse(updateSkillMatrixContent(JSON.stringify(makeOld()), { ides: ['vscode'], techTools: [], teamTools: [] }));
    expect(data.bindings['source-control']).toBeUndefined();
  });

  it('is the team’s once it exists: an agent they took it from does not get it back', () => {
    const first: SkillMatrixData = JSON.parse(updateSkillMatrixContent(JSON.stringify(makeOld()), withGithub));
    first.agents['DevOps & Release'].slots = first.agents['DevOps & Release'].slots.filter((s) => s !== 'source-control');
    const again: SkillMatrixData = JSON.parse(updateSkillMatrixContent(JSON.stringify(first), withGithub));
    expect(slotsOf(again, 'DevOps & Release')).not.toContain('source-control');
  });
});

/**
 * VS Code starts a server with the `envFile` its entry names. A project that
 * keeps each server's secrets in its own file was told they were not set.
 */
describe('envFileTextFor', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads .env and the env file a server’s VS Code entry names', () => {
    dir = mkdtempSync(join(tmpdir(), 'oc-envfile-'));
    mkdirSync(join(dir, '.vscode'));
    mkdirSync(join(dir, '.env.d'));
    writeFileSync(join(dir, '.env'), 'SHARED_TOKEN=a\n');
    writeFileSync(join(dir, '.env.d', 'mcp-resend.env'), 'OC_TEST_RESEND_KEY=re_x\n');
    writeFileSync(join(dir, '.vscode', 'mcp.json'), JSON.stringify({
      servers: { Resend: { type: 'stdio', command: 'npx', args: ['-y', 'resend-mcp@2.24.0'], envFile: '${workspaceFolder}/.env.d/mcp-resend.env' } },
    }));

    expect(isEnvVarSatisfied('OC_TEST_RESEND_KEY', envFileTextFor(dir, 'Resend'))).toBe(true);
    expect(isEnvVarSatisfied('SHARED_TOKEN', envFileTextFor(dir, 'Resend'))).toBe(true);
    // Another server does not read Resend's file.
    expect(isEnvVarSatisfied('OC_TEST_RESEND_KEY', envFileTextFor(dir, 'Linear'))).toBe(false);
  });

  it('reads .env alone when there is no VS Code config', () => {
    dir = mkdtempSync(join(tmpdir(), 'oc-envfile-'));
    writeFileSync(join(dir, '.env'), 'SHARED_TOKEN=a\n');
    expect(isEnvVarSatisfied('SHARED_TOKEN', envFileTextFor(dir, 'Resend'))).toBe(true);
  });
});

describe('what a Python or Go project is given', () => {
  const browser = { preselected: true, subCategory: 'e2e-testing' };

  it('leaves TypeScript and web-interface rules, and the browser, out of an API service', () => {
    const api = { language: 'python', frameworks: ['fastapi'] };
    expect([...getExcludedCoreSkills(api)].sort()).toEqual(['accessibility-standards', 'frontend-design', 'seo-patterns', 'typescript-best-practices']);
    expect(isPreselected(browser, api)).toBe(false);
    expect(isPreselected(browser, { language: 'go', frameworks: ['gin'] })).toBe(false);
  });

  it('keeps the web rules and the browser for a framework that renders pages', () => {
    const site = { language: 'python', frameworks: ['django'] };
    expect([...getExcludedCoreSkills(site)]).toEqual(['typescript-best-practices']);
    expect(isPreselected(browser, site)).toBe(true);
  });

  it('changes nothing for a JavaScript project, or a Python one with JavaScript in it', () => {
    expect(getExcludedCoreSkills({ language: 'typescript' }).size).toBe(0);
    expect(getExcludedCoreSkills({ language: 'python', packageManager: 'pnpm' }).size).toBe(0);
    expect(isPreselected(browser, {})).toBe(true);
    expect(isPreselected({ preselected: false }, {})).toBe(false);
  });
});

describe('updateSkillMatrixContent', () => {
  it('fills database slot when a database tool is selected', () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: ['supabase'], teamTools: [] };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings.database.entries).toEqual([
      { name: 'Supabase', skill: 'supabase-database' },
    ]);
  });

  it('fills cms slot when a CMS tool is selected', () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: ['sanity'], teamTools: [] };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings.cms.entries).toEqual([{ name: 'Sanity', skill: 'sanity-cms' }]);
  });

  it('fills framework slot when a framework tool is selected', () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: ['nextjs'], teamTools: [] };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings.framework.entries).toEqual([
      { name: 'Next.js', skill: 'nextjs-framework' },
    ]);
  });

  it('fills deployment slot when a deployment tool is selected', () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: ['vercel'], teamTools: [] };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings.deployment.entries).toEqual([
      { name: 'Vercel', skill: 'vercel-deployment' },
    ]);
  });

  it('fills codebase-tool slot when a monorepo tool is selected', () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: ['nx'], teamTools: [] };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings['codebase-tool'].entries).toEqual([
      { name: 'NX', skill: 'nx-workspace' },
    ]);
  });

  it('fills task-management slot when a tracker tool is selected', () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: [], teamTools: ['linear'] };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings['task-management'].entries).toEqual([
      { name: 'Linear', skill: 'linear-task-management' },
    ]);
  });

  it('fills task-management slot when trello is selected', () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: [], teamTools: ['trello'] };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings['task-management'].entries).toEqual([
      { name: 'Trello', skill: 'trello-task-management' },
    ]);
  });

  it('fills knowledge-management slot when notion is selected', () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: [], teamTools: ['notion'] };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings['knowledge-management'].entries).toEqual([
      { name: 'Notion', skill: 'notion-knowledge-management' },
    ]);
  });

  it('clears database slot when no database tool is selected', () => {
    const template = makeTemplate();
    template.bindings.database.entries = [
      { name: 'Supabase', skill: 'supabase-database' },
    ];
    const stack: StackConfig = { ides: ['vscode'], techTools: [], teamTools: [] };
    const data = parse(
      updateSkillMatrixContent(JSON.stringify(template, null, 2) + '\n', stack)
    );
    expect(data.bindings.database.entries).toEqual([]);
  });

  it('switches from one database to another', () => {
    const template = makeTemplate();
    template.bindings.database.entries = [
      { name: 'Supabase', skill: 'supabase-database' },
    ];
    const stack: StackConfig = { ides: ['vscode'], techTools: ['convex'], teamTools: [] };
    const data = parse(
      updateSkillMatrixContent(JSON.stringify(template, null, 2) + '\n', stack)
    );
    expect(data.bindings.database.entries).toEqual([
      { name: 'Convex', skill: 'convex-database' },
    ]);
  });

  it('fills multiple slots at once', () => {
    const stack: StackConfig = {
      ides: ['vscode'],
      techTools: ['supabase', 'sanity', 'vercel', 'nextjs'],
      teamTools: ['linear'],
    };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings.database.entries).toEqual([
      { name: 'Supabase', skill: 'supabase-database' },
    ]);
    expect(data.bindings.cms.entries).toEqual([{ name: 'Sanity', skill: 'sanity-cms' }]);
    expect(data.bindings.deployment.entries).toEqual([
      { name: 'Vercel', skill: 'vercel-deployment' },
    ]);
    expect(data.bindings.framework.entries).toEqual([
      { name: 'Next.js', skill: 'nextjs-framework' },
    ]);
    expect(data.bindings['task-management'].entries).toEqual([
      { name: 'Linear', skill: 'linear-task-management' },
    ]);
  });

  it('does not modify unrelated slots', () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: ['supabase'], teamTools: [] };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings.framework.entries).toEqual([]);
    expect(data.bindings.cms.entries).toEqual([]);
  });

  it('supports multiple plugins in the same slot', () => {
    const stack: StackConfig = {
      ides: ['vscode'],
      techTools: ['supabase', 'convex'],
      teamTools: [],
    };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings.database.entries).toEqual([
      { name: 'Supabase', skill: 'supabase-database' },
      { name: 'Convex', skill: 'convex-database' },
    ]);
  });

  it('supports multiple frameworks in the same slot', () => {
    const stack: StackConfig = {
      ides: ['vscode'],
      techTools: ['nextjs', 'astro'],
      teamTools: [],
    };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings.framework.entries).toEqual([
      { name: 'Next.js', skill: 'nextjs-framework' },
      { name: 'Astro', skill: 'astro-framework' },
    ]);
  });

  it('supports multiple CMS tools in the same slot', () => {
    const stack: StackConfig = {
      ides: ['vscode'],
      techTools: ['sanity', 'contentful'],
      teamTools: [],
    };
    const data = parse(updateSkillMatrixContent(templateJson(), stack));
    expect(data.bindings.cms.entries).toEqual([
      { name: 'Sanity', skill: 'sanity-cms' },
      { name: 'Contentful', skill: 'contentful-cms' },
    ]);
  });

  it('preserves agents section', () => {
    const template = makeTemplate();
    template.agents = {
      Developer: { slots: ['framework'], directSkills: ['validation-gates'] },
    };
    const stack: StackConfig = { ides: ['vscode'], techTools: ['supabase'], teamTools: [] };
    const data = parse(
      updateSkillMatrixContent(JSON.stringify(template, null, 2) + '\n', stack)
    );
    expect(data.agents.Developer).toEqual({
      slots: ['framework'],
      directSkills: ['validation-gates'],
    });
  });

  it('outputs valid JSON with trailing newline', () => {
    const stack: StackConfig = { ides: ['vscode'], techTools: ['supabase'], teamTools: [] };
    const result = updateSkillMatrixContent(templateJson(), stack);
    expect(result.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(result)).not.toThrow();
  });
});
