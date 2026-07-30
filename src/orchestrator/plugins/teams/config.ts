import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'teams',
  name: 'Microsoft Teams',
  category: 'team',
  subCategory: 'notifications',
  label: 'Microsoft Teams',
  hint: 'Agent notifications via Teams channels',
  skillName: 'teams-notifications',
  mcpServerKey: 'Teams',
  mcpConfig: {
    type: 'http',
    url: 'https://agent365.svc.cloud.microsoft/agents/tenants/${input:tenant_id}/servers/mcp_TeamsServer',
  },
  authType: 'oauth',
  envVars: [],
  agentToolMap: {
    'team-lead': [
      'Teams/mcp_graph_chat_createChat', 'Teams/mcp_graph_chat_listChats',
      'Teams/mcp_graph_chat_getChat', 'Teams/mcp_graph_chat_postMessage',
      'Teams/mcp_graph_chat_listChatMessages', 'Teams/mcp_graph_chat_getChatMessage',
      'Teams/mcp_graph_teams_listTeams', 'Teams/mcp_graph_teams_listChannels',
      'Teams/mcp_graph_teams_getChannel', 'Teams/mcp_graph_teams_postChannelMessage',
      'Teams/mcp_graph_teams_replyToChannelMessage', 'Teams/mcp_graph_teams_listChannelMessages',
    ],
    'devops-expert': [
      'Teams/mcp_graph_chat_postMessage', 'Teams/mcp_graph_chat_listChats',
      'Teams/mcp_graph_teams_listTeams', 'Teams/mcp_graph_teams_listChannels',
      'Teams/mcp_graph_teams_postChannelMessage', 'Teams/mcp_graph_teams_replyToChannelMessage',
      'Teams/mcp_graph_teams_listChannelMessages',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#teams',
  officialDocs: 'https://learn.microsoft.com/en-us/microsoftteams/',
  mcpInputs: [
    {
      id: 'tenant_id',
      type: 'promptString',
      description: 'Microsoft Entra tenant ID (GUID)',
    },
  ],
};
