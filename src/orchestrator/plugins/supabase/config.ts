import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'supabase',
  name: 'Supabase',
  category: 'tech',
  subCategory: 'database',
  label: 'Supabase',
  hint: 'Postgres + Auth + RLS + Edge Functions',
  skillName: 'supabase-database',
  mcpServerKey: 'Supabase',
  mcpConfig: {
    type: 'http',
    url: 'https://mcp.supabase.com/mcp',
  },
  authType: 'oauth',
  envVars: [],
  agentToolMap: {
    'data-engineer': [
      'supabase/apply_migration', 'supabase/execute_sql', 'supabase/list_tables',
      'supabase/list_migrations', 'supabase/list_extensions', 'supabase/get_logs',
      'supabase/get_project', 'supabase/get_project_url', 'supabase/list_projects',
      'supabase/search_docs', 'supabase/generate_typescript_types', 'supabase/get_advisors',
      'supabase/create_branch', 'supabase/list_branches',
    ],
    'security-expert': [
      'supabase/execute_sql', 'supabase/list_tables', 'supabase/get_advisors',
      'supabase/list_migrations', 'supabase/get_project',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#supabase',
  officialDocs: 'https://supabase.com/docs',
};
