import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'github',
  name: 'GitHub',
  category: 'team',
  subCategory: 'source-control',
  label: 'GitHub',
  hint: 'Pull requests, reviews, CI and stacked PRs via GitHub\'s MCP server',
  skillName: 'github-platform',
  mcpServerKey: 'GitHub',
  // GitHub's own remote server. VS Code signs in to it with OAuth; GitHub
  // supports no other client's OAuth, so every other target sends a token.
  mcpConfig: {
    type: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
  },
  tokenAuth: {
    oauthTargets: ['vscode'],
    headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' },
  },
  authType: 'env-token',
  envVars: [
    {
      name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      hint: 'Create at github.com → Settings → Developer settings → Personal access tokens (VS Code signs in with OAuth instead)',
    },
  ],
  // The whole server: GitHub adds and renames tools between releases, and a
  // named tool that does not exist is silently absent.
  agentToolMap: {
    'team-lead': ['GitHub/*'],
    'devops-expert': ['GitHub/*'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#github',
  officialDocs: 'https://github.com/github/github-mcp-server',
};
