import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'sentry',
  name: 'Sentry',
  category: 'tech',
  subCategory: 'observability',
  label: 'Sentry',
  hint: 'Error monitoring, performance tracing, and observability',
  skillName: 'sentry-monitoring',
  mcpServerKey: 'Sentry',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['@sentry/mcp-server@latest'],
  },
  authType: 'env-token',
  envVars: [
    { name: 'SENTRY_ACCESS_TOKEN', hint: 'Create at Settings \u2192 Auth Tokens in sentry.io' },
  ],
  agentToolMap: {
    'developer': ['search_errors', 'get_issue_details', 'search_issues', 'create_sentry_issue'],
    'devops-expert': ['list_projects', 'get_project_stats', 'search_errors'],
    'security-expert': ['search_errors', 'get_issue_details', 'list_projects'],
  },
  docsUrl: null,
  officialDocs: 'https://docs.sentry.io/',
  mcpPackage: '@sentry/mcp-server',
};
