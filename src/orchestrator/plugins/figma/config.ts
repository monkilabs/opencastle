import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'figma',
  name: 'Figma',
  category: 'tech',
  subCategory: 'design',
  label: 'Figma',
  hint: 'Design tokens, component specs, asset export',
  skillName: 'figma-design',
  mcpServerKey: 'Figma',
  // Figma's own remote server, signed in with OAuth. The previous default
  // pointed at `@anthropic/figma-mcp`, a package that was never published on
  // npm, so the server could not start for anyone.
  mcpConfig: {
    type: 'http',
    url: 'https://mcp.figma.com/mcp',
  },
  authType: 'oauth',
  envVars: [],
  agentToolMap: {
    'ui-ux-expert': ['figma/*'],
    'developer': ['figma/*'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#figma',
  officialDocs: 'https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server',
  previousMcpConfigs: [
    {
      mcpConfig: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@anthropic/figma-mcp@latest'],
        envFile: '${workspaceFolder}/.env',
      },
      envVars: [
        {
          name: 'FIGMA_ACCESS_TOKEN',
          hint: 'Generate at figma.com → Settings → Personal access tokens',
        },
      ],
    },
  ],
};
