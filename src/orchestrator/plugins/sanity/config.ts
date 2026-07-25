import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'sanity',
  name: 'Sanity',
  category: 'tech',
  subCategory: 'cms',
  label: 'Sanity',
  hint: 'GROQ queries, real-time collaboration',
  skillName: 'sanity-cms',
  mcpServerKey: 'Sanity',
  mcpConfig: {
    type: 'http',
    url: 'https://mcp.sanity.io',
  },
  authType: 'oauth',
  envVars: [],
  agentToolMap: {
    'content-engineer': [
      'sanity/get_schema', 'sanity/get_sanity_rules', 'sanity/list_sanity_rules',
      'sanity/query_documents', 'sanity/get_document', 'sanity/create_documents_from_json',
      'sanity/create_documents_from_markdown', 'sanity/patch_document_from_json',
      'sanity/patch_document_from_markdown', 'sanity/deploy_schema', 'sanity/publish_documents',
      'sanity/unpublish_documents', 'sanity/discard_drafts', 'sanity/list_projects',
      'sanity/list_datasets', 'sanity/list_workspace_schemas', 'sanity/list_embeddings_indices',
      'sanity/search_docs', 'sanity/read_docs', 'sanity/semantic_search',
      'sanity/migration_guide', 'sanity/create_version', 'sanity/generate_image',
      'sanity/transform_image', 'sanity/add_cors_origin',
    ],
    'writer': [
      'sanity/get_schema', 'sanity/query_documents', 'sanity/get_document',
      'sanity/patch_document_from_json', 'sanity/patch_document_from_markdown',
      'sanity/list_datasets', 'sanity/list_projects',
    ],
    'data-engineer': [
      'sanity/get_schema', 'sanity/query_documents', 'sanity/create_documents_from_json',
      'sanity/patch_document_from_json', 'sanity/get_document', 'sanity/list_datasets',
      'sanity/list_projects',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#sanity',
  officialDocs: 'https://www.sanity.io/docs',
};
