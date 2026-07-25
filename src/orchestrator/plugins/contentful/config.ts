import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'contentful',
  name: 'Contentful',
  category: 'tech',
  subCategory: 'cms',
  label: 'Contentful',
  hint: 'GraphQL / REST API, structured content',
  skillName: 'contentful-cms',
  mcpServerKey: 'Contentful',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@contentful/mcp-server'],
  },
  authType: 'none',
  envVars: [],
  agentToolMap: {
    'content-engineer': [
      'contentful/get_initial_context', 'contentful/list_content_types', 'contentful/get_content_type',
      'contentful/create_content_type', 'contentful/update_content_type', 'contentful/publish_content_type',
      'contentful/unpublish_content_type', 'contentful/delete_content_type', 'contentful/search_entries',
      'contentful/get_entry', 'contentful/create_entry', 'contentful/update_entry',
      'contentful/publish_entry', 'contentful/unpublish_entry', 'contentful/delete_entry',
      'contentful/list_editor_interfaces', 'contentful/get_editor_interface', 'contentful/update_editor_interface',
      'contentful/upload_asset', 'contentful/list_assets', 'contentful/get_asset',
      'contentful/update_asset', 'contentful/publish_asset', 'contentful/unpublish_asset',
      'contentful/delete_asset', 'contentful/list_spaces', 'contentful/get_space',
      'contentful/list_environments', 'contentful/create_environment', 'contentful/delete_environment',
      'contentful/list_locales', 'contentful/get_locale', 'contentful/create_locale',
      'contentful/update_locale', 'contentful/delete_locale', 'contentful/list_tags',
      'contentful/create_tag', 'contentful/list_orgs', 'contentful/get_org',
    ],
    'writer': [
      'contentful/get_initial_context', 'contentful/list_content_types', 'contentful/get_content_type',
      'contentful/search_entries', 'contentful/get_entry', 'contentful/update_entry',
      'contentful/publish_entry', 'contentful/list_spaces', 'contentful/get_space',
    ],
    'data-engineer': [
      'contentful/get_initial_context', 'contentful/list_content_types', 'contentful/get_content_type',
      'contentful/search_entries', 'contentful/get_entry', 'contentful/create_entry',
      'contentful/update_entry', 'contentful/list_spaces', 'contentful/get_space',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#contentful',
  officialDocs: 'https://www.contentful.com/developers/docs/',
  mcpPackage: '@contentful/mcp-server',
};
