/**
 * The only package allowed to talk to PayPal (invariant 1, enforced by ESLint).
 * SDK types never leave this package: everything exported is our own.
 */
export * from './types.js';
export { PayPalError } from './errors.js';
export { toPayPalAmount, fromPayPalAmount } from './amount.js';
export { newRequestId, toRequestId } from './http.js';
export {
  PayPal,
  PAYPAL_BASE_URLS,
  baseUrlFor,
  SANDBOX_VISA,
  normalizeCapture,
  normalizeRefund,
  normalizePayoutItem,
  normalizeTransaction,
  normalizeDispute,
  normalizeInvoice,
  captureFromOrder,
  isTransportError,
  type PayPalEnvironment,
  type PayPalOptions,
  type CreateOrderInput,
  type SandboxCard,
} from './paypal.js';
export { sdkConfiguration } from './sdk.js';
