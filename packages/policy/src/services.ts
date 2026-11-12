import type { Database } from '@agpal/db';
import { Ledger } from '@agpal/ledger';
import { PayPal } from '@agpal/paypal';
import type { Env } from '@agpal/shared';
import { Commerce } from './commerce.js';
import { Gate } from './gate.js';
import type { PayPalInbound } from './inbound.js';
import { PayPalPayments } from './paypal-port.js';
import { FakePayments, type PaymentsPort } from './ports.js';
import { Reconciler } from './reconcile.js';
import { WebhookProcessor } from './webhooks.js';

export interface Services {
  ledger: Ledger;
  gate: Gate;
  commerce: Commerce;
  /** Read-only PayPal view (verification, search, balances). */
  inbound: PayPalInbound;
  webhooks: WebhookProcessor;
  reconciler: Reconciler;
  /** True when payouts/refunds go to a fake provider (dry mode). */
  dry: boolean;
}

/**
 * Wire the money stack once per process. The raw PayPal client stays inside packages/policy (invariant 1).
 * `dry: true` swaps the PaymentsPort for FakePayments so nothing reaches PayPal (simulation dry mode).
 */
export function createServices(
  db: Database,
  env: Env,
  opts: {
    dry?: boolean;
    payments?: PaymentsPort;
    defaultCompanyId?: string;
    payoutSettleWaitMs?: number;
  } = {},
): Services {
  const ledger = new Ledger(db);
  const paypal = new PayPal({
    environment: env.PAYPAL_ENVIRONMENT,
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
  });
  const payments =
    opts.payments ??
    (opts.dry
      ? new FakePayments()
      : new PayPalPayments(paypal, { payoutSettleWaitMs: opts.payoutSettleWaitMs ?? 0 }));
  const gate = new Gate(db, ledger, payments);
  const commerce = new Commerce(ledger, paypal);
  const inbound: PayPalInbound = paypal;
  const webhooks = new WebhookProcessor(
    db,
    ledger,
    gate,
    commerce,
    paypal,
    opts.defaultCompanyId ? { defaultCompanyId: opts.defaultCompanyId } : {},
  );
  const reconciler = new Reconciler(db, ledger, paypal);
  return { ledger, gate, commerce, inbound, webhooks, reconciler, dry: Boolean(opts.dry) };
}
