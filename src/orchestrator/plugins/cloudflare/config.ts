import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'cloudflare',
  name: 'Cloudflare',
  category: 'tech',
  subCategory: 'deployment',
  label: 'Cloudflare',
  hint: 'Workers, Pages, KV, D1, R2, and edge computing',
  skillName: 'cloudflare-platform',
  mcpServerKey: 'Cloudflare',
  mcpConfig: {
    type: 'http',
    url: 'https://mcp.cloudflare.com/mcp',
  },
  authType: 'oauth',
  envVars: [],
  agentToolMap: {
    'developer': ['search', 'execute'],
    'devops-expert': ['search', 'execute'],
  },
  docsUrl: null,
  officialDocs: 'https://developers.cloudflare.com/',
};
