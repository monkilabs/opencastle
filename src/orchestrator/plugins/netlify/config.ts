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
  // Netlify's official server. The previous default, `netlify-mcp`, was
  // unpublished from npm in January 2026 — a name anyone can claim — and ran as
  // `@latest` with `-y`. It signs in through the browser; a personal access
  // token is only a fallback, so none is required here.
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@netlify/mcp@1.17.0'],
  },
  authType: 'oauth',
  envVars: [],
  agentToolMap: {
    'devops-expert': ['netlify/*'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#netlify',
  officialDocs: 'https://docs.netlify.com',
  mcpPackage: '@netlify/mcp',
  previousMcpConfigs: [
    {
      mcpConfig: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'netlify-mcp@latest'],
      },
      envVars: [
        {
          name: 'NETLIFY_AUTH_TOKEN',
          hint: 'Generate at app.netlify.com → User Settings → Applications → Personal access tokens',
        },
      ],
    },
  ],
};
