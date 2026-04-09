import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'coolify',
  name: 'Coolify',
  category: 'tech',
  subCategory: 'deployment',
  label: 'Coolify',
  hint: 'Self-hosted PaaS — deploy apps, databases, and services',
  skillName: 'coolify-deployment',
  mcpServerKey: 'Coolify',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@masonator/coolify-mcp'],
  },
  authType: 'env-token',
  envVars: [
    { name: 'COOLIFY_ACCESS_TOKEN', hint: 'Generate in Coolify Settings → API' },
    { name: 'COOLIFY_BASE_URL', hint: 'Your Coolify instance URL (e.g. https://coolify.example.com)' },
  ],
  agentToolMap: {
    'developer': ['list_applications', 'get_application', 'application_logs', 'deploy'],
    'devops-expert': ['get_infrastructure_overview', 'diagnose_app', 'diagnose_server', 'find_issues', 'control', 'deploy', 'restart_project_apps'],
  },
  docsUrl: null,
  officialDocs: 'https://coolify.io/docs',
  mcpPackage: '@masonator/coolify-mcp',
};
