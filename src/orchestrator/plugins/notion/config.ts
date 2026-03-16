import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'notion',
  name: 'Notion',
  category: 'team',
  subCategory: 'knowledge-management',
  label: 'Notion',
  hint: 'Workspace knowledge base and documentation hub',
  skillName: 'notion-knowledge-management',
  mcpServerKey: 'Notion',
  mcpConfig: {
    type: 'http',
    url: 'https://mcp.notion.com/mcp',
  },
  authType: 'oauth',
  envVars: [],
  agentToolMap: {
    'team-lead': [
      'Notion/search',
      'Notion/create_page',
      'Notion/update_page',
      'Notion/query_database',
      'Notion/append_block_children',
    ],
    'researcher': [
      'Notion/search',
      'Notion/create_page',
      'Notion/append_block_children',
      'Notion/query_database',
    ],
    'documentation-writer': [
      'Notion/search',
      'Notion/create_page',
      'Notion/update_page',
      'Notion/append_block_children',
    ],
    'architect': [
      'Notion/search',
      'Notion/create_page',
      'Notion/update_page',
      'Notion/query_database',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#notion',
  officialDocs: 'https://developers.notion.com/docs/mcp',
};
