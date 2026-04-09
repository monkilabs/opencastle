import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'expo',
  name: 'Expo',
  category: 'tech',
  subCategory: 'framework',
  label: 'Expo',
  hint: 'React Native framework with EAS builds and OTA updates',
  skillName: 'expo-development',
  mcpServerKey: 'Expo',
  mcpConfig: {
    type: 'http',
    url: 'https://mcp.expo.dev/mcp',
  },
  authType: 'oauth',
  envVars: [],
  agentToolMap: {
    'developer': ['search_documentation', 'read_documentation', 'add_library'],
    'testing-expert': ['automation_take_screenshot', 'automation_tap', 'automation_find_view'],
  },
  docsUrl: null,
  officialDocs: 'https://docs.expo.dev/',
};
