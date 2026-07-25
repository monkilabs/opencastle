import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'astro',
  name: 'Astro',
  category: 'tech',
  subCategory: 'framework',
  label: 'Astro',
  hint: 'Content-driven web framework with islands architecture and Docs MCP',
  skillName: 'astro-framework',
  mcpServerKey: 'Astro docs',
  mcpConfig: {
    type: 'http',
    url: 'https://mcp.docs.astro.build/mcp',
  },
  authType: 'none',
  envVars: [],
  agentToolMap: {
    'developer': [
      'astro-docs/search_astro_docs',
    ],
    'writer': [
      'astro-docs/search_astro_docs',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#astro',
  officialDocs: 'https://docs.astro.build',
};
