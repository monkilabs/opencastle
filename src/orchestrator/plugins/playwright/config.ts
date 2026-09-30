import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'playwright',
  name: 'Playwright',
  category: 'tech',
  subCategory: 'e2e-testing',
  label: 'Playwright',
  hint: 'Cross-browser E2E testing by Microsoft',
  skillName: 'playwright-testing',
  mcpServerKey: 'Playwright',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.83'],
  },
  authType: 'none',
  envVars: [],
  agentToolMap: {
    'testing-expert': ['playwright/*'],
    'ui-ux-expert': ['playwright/*'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#playwright',
  officialDocs: 'https://playwright.dev/docs/intro',
  mcpPackage: '@playwright/mcp',
  previousMcpConfigs: [
    {
      mcpConfig: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      },
    },
  ],
};
