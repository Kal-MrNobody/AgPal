/**
 * The only package allowed to talk to PayPal (invariant 1, enforced by ESLint).
 * The SDK adapter and thin REST clients arrive in Prompt 5. SDK types never leave this package.
 */
export const PAYPAL_BASE_URLS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const;

export type PayPalEnvironment = keyof typeof PAYPAL_BASE_URLS;

export function baseUrlFor(env: PayPalEnvironment): string {
  return PAYPAL_BASE_URLS[env];
}
