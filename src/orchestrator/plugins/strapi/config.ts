import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'strapi',
  name: 'Strapi',
  category: 'tech',
  subCategory: 'cms',
  label: 'Strapi',
  hint: 'Open-source headless CMS',
  skillName: 'strapi-cms',
  mcpServerKey: 'Strapi',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'strapi-mcp'],
  },
  authType: 'none',
  envVars: [],
  agentToolMap: {
    'content-engineer': [
      'strapi/list_content_types', 'strapi/get_content_type_schema', 'strapi/get_entries',
      'strapi/get_entry', 'strapi/create_entry', 'strapi/update_entry', 'strapi/delete_entry',
      'strapi/publish_entry', 'strapi/unpublish_entry', 'strapi/upload_media',
      'strapi/upload_media_from_path', 'strapi/connect_relation', 'strapi/disconnect_relation',
      'strapi/create_content_type', 'strapi/update_content_type', 'strapi/delete_content_type',
      'strapi/list_components', 'strapi/get_component_schema', 'strapi/create_component',
      'strapi/update_component',
    ],
    'writer': [
      'strapi/list_content_types', 'strapi/get_content_type_schema', 'strapi/get_entries',
      'strapi/get_entry', 'strapi/update_entry', 'strapi/publish_entry',
    ],
    'data-engineer': [
      'strapi/list_content_types', 'strapi/get_content_type_schema', 'strapi/get_entries',
      'strapi/get_entry', 'strapi/create_entry', 'strapi/update_entry',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#strapi',
  officialDocs: 'https://docs.strapi.io/',
  mcpPackage: 'strapi-mcp',
};
