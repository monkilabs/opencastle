import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'prisma',
  name: 'Prisma',
  category: 'tech',
  subCategory: 'database',
  label: 'Prisma',
  hint: 'Type-safe ORM, migrations, schema management',
  skillName: 'prisma-database',
  mcpServerKey: 'Prisma',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@anthropic/prisma-mcp@latest'],
  },
  authType: 'none',
  envVars: [],
  agentToolMap: {
    'data-engineer': ['prisma/*'],
    'developer': ['prisma/*'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#prisma',
  officialDocs: 'https://www.prisma.io/docs',
  mcpPackage: '@anthropic/prisma-mcp',
};
