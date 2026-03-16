import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'trello',
  name: 'Trello',
  category: 'team',
  subCategory: 'task-management',
  label: 'Trello',
  hint: 'Visual board task management via MCP',
  skillName: 'trello-task-management',
  mcpServerKey: 'Trello',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@delorenj/mcp-server-trello'],
    envFile: '${workspaceFolder}/.env',
  },
  authType: 'env-token',
  envVars: [
    {
      name: 'TRELLO_API_KEY',
      hint: 'Create at trello.com/app-key -> API Key',
    },
    {
      name: 'TRELLO_TOKEN',
      hint: 'Generate at trello.com/app-key -> Token (click "Generate a Token")',
    },
  ],
  agentToolMap: {
    'team-lead': [
      'Trello/get_boards',
      'Trello/get_lists',
      'Trello/get_cards_by_list_id',
      'Trello/get_card_details',
      'Trello/create_card',
      'Trello/update_card',
      'Trello/add_checklist_to_card',
      'Trello/add_comment_to_card',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#trello',
  officialDocs: 'https://developer.atlassian.com/cloud/trello/',
  mcpPackage: '@delorenj/mcp-server-trello',
};
