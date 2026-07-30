import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'nx',
  name: 'NX',
  category: 'tech',
  subCategory: 'codebase-tool',
  label: 'NX',
  hint: 'Monorepo build system',
  skillName: 'nx-workspace',
  mcpServerKey: 'Nx',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['nx', 'mcp'],
  },
  authType: 'none',
  envVars: [],
  agentToolMap: {
    'architect': ['nx-mcp-server/nx_workspace', 'nx-mcp-server/nx_project_details', 'nx-mcp-server/nx_visualize_graph'],
    'developer': ['nx-mcp-server/nx_project_details', 'nx-mcp-server/nx_workspace', 'nx-mcp-server/nx_generators'],
    'devops-expert': ['nx-mcp-server/nx_project_details', 'nx-mcp-server/nx_workspace', 'nx-mcp-server/nx_workspace_path'],
    'performance-expert': ['nx-mcp-server/nx_project_details', 'nx-mcp-server/nx_workspace'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#nx',
  officialDocs: 'https://nx.dev/getting-started/intro',
};
