import {
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  SubscriptionsController,
  TransactionSearchController,
} from '@paypal/paypal-server-sdk';
import type { Secret } from '@agpal/shared';

export interface SdkOptions {
  environment: 'sandbox' | 'live';
  clientId: string;
  clientSecret: Secret;
  timeoutMs: number;
  maxRetries: number;
}

export interface SdkControllers {
  orders: OrdersController;
  payments: PaymentsController;
  subscriptions: SubscriptionsController;
  transactions: TransactionSearchController;
}

/**
 * Build the PayPal Server SDK client once per process (typescript-client-initialization).
 *
 * The SDK's generated defaults are `timeout: 0` (no timeout) and `maxNumberOfRetries: 0`,
 * `maximumRetryWaitTime: 0` (retries never fire) — see docs/apimatic-plugin.md. We set both explicitly.
 * POST is retried, so every SDK POST we make must carry a PayPal-Request-Id (PayPal then de-duplicates it,
 * invariant 4). SDK operations that accept no request id (e.g. cancelSubscription) go through the REST client,
 * which never retries a POST without one (audit finding P6-1).
 */
export function sdkConfiguration(
  o: SdkOptions,
): NonNullable<ConstructorParameters<typeof Client>[0]> {
  return {
    environment: o.environment === 'live' ? Environment.Production : Environment.Sandbox,
    clientCredentialsAuthCredentials: {
      oAuthClientId: o.clientId,
      oAuthClientSecret: o.clientSecret.reveal(),
      oAuthClockSkew: 300,
    },
    timeout: o.timeoutMs,
    httpClientOptions: {
      timeout: o.timeoutMs,
      retryConfig: {
        maxNumberOfRetries: o.maxRetries,
        retryInterval: 1,
        backoffFactor: 2,
        maximumRetryWaitTime: 30,
        retryOnTimeout: true,
        httpStatusCodesToRetry: [408, 429, 500, 502, 503, 504],
        httpMethodsToRetry: ['GET', 'PUT', 'POST'],
      },
    },
  };
}

export function createSdk(o: SdkOptions): SdkControllers {
  const client = new Client(sdkConfiguration(o));
  return {
    orders: new OrdersController(client),
    payments: new PaymentsController(client),
    subscriptions: new SubscriptionsController(client),
    transactions: new TransactionSearchController(client),
  };
}
