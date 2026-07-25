import type { PluginConfig } from '../types.js';

export const config: PluginConfig = {
  id: 'stripe',
  name: 'Stripe',
  category: 'tech',
  subCategory: 'payments',
  label: 'Stripe',
  hint: 'Payments, billing, and financial infrastructure',
  skillName: 'stripe-payments',
  mcpServerKey: 'Stripe',
  mcpConfig: {
    type: 'http',
    url: 'https://mcp.stripe.com',
  },
  authType: 'oauth',
  envVars: [],
  agentToolMap: {
    'developer': [
      'create_customer', 'list_customers', 'create_product', 'create_price',
      'list_products', 'list_prices', 'create_payment_link',
      'create_checkout_session', 'create_invoice', 'create_invoice_item',
      'finalize_invoice', 'list_invoices', 'create_refund',
      'list_payment_intents', 'search_stripe_documentation',
    ],
    'data-engineer': [
      'list_customers', 'list_products', 'list_prices',
      'list_invoices', 'list_subscriptions', 'list_payment_intents',
      'search_stripe_resources', 'fetch_stripe_resources',
    ],
    'security-expert': [
      'get_stripe_account_info', 'retrieve_balance',
      'list_disputes', 'search_stripe_documentation',
    ],
    'devops-expert': [
      'get_stripe_account_info', 'retrieve_balance',
      'search_stripe_documentation',
    ],
  },
  docsUrl: 'https://www.opencastle.dev/docs/plugins#stripe',
  officialDocs: 'https://docs.stripe.com/',
  mcpPackage: undefined,
};
