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
  // The hosted server's tool names (developers.notion.com/docs/mcp-supported-tools):
  // `notion-update-page` both edits a page and appends to it.
  agentToolMap: {
    'team-lead': [
      'Notion/notion-search',
      'Notion/notion-fetch',
      'Notion/notion-create-pages',
      'Notion/notion-update-page',
      'Notion/notion-query-data-sources',
    ],
    'researcher': [
      'Notion/notion-search',
      'Notion/notion-fetch',
      'Notion/notion-create-pages',
      'Notion/notion-update-page',
      'Notion/notion-query-data-sources',
    ],
    'writer': [
      'Notion/notion-search',
      'Notion/notion-fetch',
      'Notion/notion-create-pages',
      'Notion/notion-update-page',
    ],
    'architect': [
      'Notion/notion-search',
      'Notion/notion-fetch',
      'Notion/notion-create-pages',
      'Notion/notion-update-page',
      'Notion/notion-query-data-sources',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#notion',
  officialDocs: 'https://developers.notion.com/docs/mcp',
};
