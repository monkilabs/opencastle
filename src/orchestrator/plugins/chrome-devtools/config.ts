import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'chrome-devtools',
  name: 'Chrome DevTools',
  category: 'tech',
  subCategory: 'e2e-testing',
  label: 'Chrome DevTools',
  hint: 'Browser testing, screenshots, DOM inspection',
  skillName: 'browser-testing',
  mcpServerKey: 'chrome-devtools',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
  },
  authType: 'none',
  envVars: [],
  agentToolMap: {
    'performance-expert': ['chrome-devtools/*'],
    'writer': ['chrome-devtools/*'],
    'testing-expert': ['chrome-devtools/*'],
    'ui-ux-expert': ['chrome-devtools/*'],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#chrome-devtools',
  officialDocs: 'https://developer.chrome.com/docs/devtools',
  mcpPackage: 'chrome-devtools-mcp',
  preselected: true,
};
