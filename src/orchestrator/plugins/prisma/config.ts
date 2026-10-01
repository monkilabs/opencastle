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
  // Prisma's own MCP server ships inside the Prisma CLI, so it runs from the
  // project's own dependency — the version your lockfile pins, the one your
  // migrations were written against. `--no` makes npx refuse to download a
  // different one. The previous default, `@anthropic/prisma-mcp`, was never
  // published on npm.
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['--no', 'prisma', 'mcp'],
  },
  authType: 'none',
  envVars: [],
  agentToolMap: {
    'data-engineer': ['prisma/*'],
    'developer': ['prisma/*'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#prisma',
  officialDocs: 'https://www.prisma.io/docs',
  mcpPackage: 'prisma',
  previousMcpConfigs: [
    {
      mcpConfig: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@anthropic/prisma-mcp@latest'],
      },
      envVars: [],
    },
  ],
};
