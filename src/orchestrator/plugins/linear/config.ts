import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'linear',
  name: 'Linear',
  category: 'team',
  subCategory: 'task-management',
  label: 'Linear',
  hint: 'Issue tracking with MCP integration',
  skillName: 'linear-task-management',
  mcpServerKey: 'Linear',
  // Linear's own remote server, signed in with OAuth — no API key in .env. It
  // replaces a third-party republish of a community server.
  mcpConfig: {
    type: 'http',
    url: 'https://mcp.linear.app/mcp',
  },
  authType: 'oauth',
  envVars: [],
  // The whole server, not a list of names. The names belonged to the previous
  // community server; Linear's own names its tools differently and changes them
  // between versions, and a named tool that does not exist is silently absent.
  agentToolMap: {
    'team-lead': ['linear/*'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#linear',
  officialDocs: 'https://linear.app/docs/mcp',
  previousMcpConfigs: [
    {
      mcpConfig: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@mseep/linear-mcp'],
        envFile: '${workspaceFolder}/.env',
      },
      envVars: [
        {
          name: 'LINEAR_API_KEY',
          hint: 'Create at linear.app → Settings → API → Personal API keys',
        },
      ],
    },
  ],
};
