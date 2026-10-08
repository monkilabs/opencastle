import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'gitlab',
  name: 'GitLab',
  category: 'team',
  subCategory: 'source-control',
  label: 'GitLab',
  hint: 'Merge requests, pipelines and stacked MRs via GitLab\'s MCP server',
  skillName: 'gitlab-platform',
  mcpServerKey: 'GitLab',
  // GitLab's own server, signed in with OAuth — it registers each client
  // itself, so no token in .env. A self-managed instance serves the same
  // path on its own host; edit the URL, and `sync` leaves the entry alone.
  mcpConfig: {
    type: 'http',
    url: 'https://gitlab.com/api/v4/mcp',
  },
  authType: 'oauth',
  envVars: [],
  agentToolMap: {
    'team-lead': ['GitLab/*'],
    'devops-expert': ['GitLab/*'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#gitlab',
  officialDocs: 'https://docs.gitlab.com/user/model_context_protocol/mcp_server/',
};
