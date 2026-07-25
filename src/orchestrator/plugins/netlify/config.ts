import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'netlify',
  name: 'Netlify',
  category: 'tech',
  subCategory: 'deployment',
  label: 'Netlify',
  hint: 'Deployment, serverless functions, edge config',
  skillName: 'netlify-deployment',
  mcpServerKey: 'Netlify',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'netlify-mcp@latest'],
  },
  authType: 'env-token',
  envVars: [
    {
      name: 'NETLIFY_AUTH_TOKEN',
      hint: 'Generate at app.netlify.com → User Settings → Applications → Personal access tokens',
    },
  ],
  agentToolMap: {
    'devops-expert': ['netlify/*'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#netlify',
  officialDocs: 'https://docs.netlify.com',
  mcpPackage: 'netlify-mcp',
};
