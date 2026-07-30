import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'slack',
  name: 'Slack',
  category: 'team',
  subCategory: 'notifications',
  label: 'Slack',
  hint: 'Agent notifications and communication',
  skillName: 'slack-notifications',
  mcpServerKey: 'Slack',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@kazuph/mcp-slack'],
    envFile: '${workspaceFolder}/.env',
    env: {
      SLACK_MCP_ADD_MESSAGE_TOOL: 'true',
    },
  },
  authType: 'env-token',
  envVars: [
    {
      name: 'SLACK_MCP_XOXB_TOKEN',
      hint: 'Create a Slack App at api.slack.com/apps → Bot User OAuth Token',
    },
  ],
  agentToolMap: {
    'team-lead': ['slack/*'],
    'devops-expert': ['slack/*'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#slack',
  officialDocs: 'https://api.slack.com/docs',
  mcpPackage: '@kazuph/mcp-slack',
};
