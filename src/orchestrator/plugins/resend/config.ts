import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'resend',
  name: 'Resend',
  category: 'tech',
  subCategory: 'email',
  label: 'Resend',
  hint: 'Transactional email API with React templates',
  skillName: 'resend-email',
  mcpServerKey: 'Resend',
  mcpConfig: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'resend-mcp'],
    envFile: '${workspaceFolder}/.env',
  },
  authType: 'env-token',
  envVars: [
    {
      name: 'RESEND_API_KEY',
      hint: 'Generate at resend.com → API Keys',
    },
  ],
  agentToolMap: {
    'developer': [
      'resend_send_email', 'resend_batch_send_email', 'resend_get_email',
      'resend_list_emails', 'resend_cancel_email', 'resend_update_email',
    ],
    'devops-expert': [
      'resend_create_domain', 'resend_list_domains', 'resend_get_domain',
      'resend_verify_domain', 'resend_update_domain', 'resend_remove_domain',
      'resend_create_api_key', 'resend_list_api_keys', 'resend_remove_api_key',
      'resend_create_webhook', 'resend_list_webhooks', 'resend_get_webhook',
      'resend_update_webhook', 'resend_remove_webhook',
    ],
    'data-engineer': [
      'resend_create_contact', 'resend_list_contacts', 'resend_get_contact',
      'resend_update_contact', 'resend_remove_contact',
      'resend_create_broadcast', 'resend_list_broadcasts', 'resend_get_broadcast',
      'resend_send_broadcast',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#resend',
  officialDocs: 'https://resend.com/docs',
  mcpPackage: 'resend-mcp',
};
