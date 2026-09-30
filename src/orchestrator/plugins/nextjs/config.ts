import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'nextjs',
  name: 'Next.js',
  category: 'tech',
  subCategory: 'framework',
  label: 'Next.js',
  hint: 'React framework with App Router, Server Components, and MCP devtools',
  skillName: 'nextjs-framework',
  mcpServerKey: 'next-devtools',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'next-devtools-mcp@0.4.0'],
  },
  authType: 'none',
  envVars: [],
  agentToolMap: {
    'developer': [
      'next-devtools/get_errors', 'next-devtools/get_logs',
      'next-devtools/get_page_metadata', 'next-devtools/get_project_metadata',
      'next-devtools/get_server_action_by_id',
    ],
    'performance-expert': [
      'next-devtools/get_errors', 'next-devtools/get_logs',
      'next-devtools/get_page_metadata', 'next-devtools/get_project_metadata',
    ],
    'testing-expert': [
      'next-devtools/get_errors', 'next-devtools/get_logs',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#nextjs',
  officialDocs: 'https://nextjs.org/docs',
  mcpPackage: 'next-devtools-mcp',
  previousMcpConfigs: [
    {
      mcpConfig: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'next-devtools-mcp@latest'],
      },
      envVars: [],
    },
  ],
};
