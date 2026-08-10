import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'hetzner',
  name: 'Hetzner Cloud',
  category: 'tech',
  subCategory: 'deployment',
  label: 'Hetzner Cloud',
  hint: 'IaaS — servers, volumes, private networks, firewalls via hcloud CLI / Pulumi',
  skillName: 'hetzner-cloud',
  authType: 'env-token',
  envVars: [
    {
      name: 'HCLOUD_TOKEN',
      hint: 'Hetzner Cloud Console → project → Security → API tokens (read-write)',
    },
  ],
  agentToolMap: {},
  docsUrl: null,
  officialDocs: 'https://docs.hetzner.com/cloud/',
};
