import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'vercel',
  name: 'Vercel',
  category: 'tech',
  subCategory: 'deployment',
  label: 'Vercel',
  hint: 'Deployment and hosting platform',
  skillName: 'vercel-deployment',
  mcpServerKey: 'Vercel',
  mcpConfig: {
    type: 'http',
    url: 'https://mcp.vercel.com',
  },
  authType: 'oauth',
  envVars: [],
  agentToolMap: {
    'devops-expert': [
      'vercel/deploy_to_vercel', 'vercel/get_deployment', 'vercel/get_deployment_build_logs',
      'vercel/get_project', 'vercel/get_runtime_logs', 'vercel/list_deployments',
      'vercel/list_projects', 'vercel/list_teams', 'vercel/search_vercel_documentation',
      'vercel/check_domain_availability_and_price',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#vercel',
  officialDocs: 'https://vercel.com/docs',
};
