import { describe, it, expect } from 'vitest';
import { updateSkillMatrixContent } from './stack-config.js';
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
