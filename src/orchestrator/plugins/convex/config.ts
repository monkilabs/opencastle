import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'convex',
  name: 'Convex',
  category: 'tech',
  subCategory: 'database',
  label: 'Convex',
  hint: 'Reactive backend with real-time sync',
  skillName: 'convex-database',
  mcpServerKey: 'Convex',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'convex@latest', 'mcp', 'start'],
  },
  authType: 'none',
  envVars: [],
  agentToolMap: {
    'data-engineer': [
      'convex/status', 'convex/data', 'convex/tables', 'convex/functionSpec',
      'convex/run', 'convex/envList', 'convex/envGet', 'convex/envSet',
      'convex/envRemove', 'convex/runOneoffQuery', 'convex/logs', 'convex/insights',
    ],
    'security-expert': [
      'convex/status', 'convex/tables', 'convex/functionSpec',
      'convex/envList', 'convex/envGet', 'convex/logs', 'convex/insights',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#convex',
  officialDocs: 'https://docs.convex.dev/',
  mcpPackage: 'convex',
};
