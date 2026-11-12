import type { Capture, CreatedOrder, Dispute, PayPal } from '@agpal/paypal';
import type { Currency } from '@agpal/shared';

/** Thrown by any PayPal call in dry mode. */
export class DryModeViolation extends Error {
  override name = 'DryModeViolation';
}

/**
 * A PayPal client for dry mode whose every method throws, and counts the attempt. Simulation dry mode wires this
 * everywhere a real client would go, so a single real call fails loudly (Prompt 16).
 */
export function blockedPayPal(): { client: PayPal; attempts: string[] } {
  const attempts: string[] = [];
  const client = new Proxy({} as PayPal, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      return () => {
        attempts.push(String(prop));
        return Promise.reject(new DryModeViolation(`dry mode: PayPal.${String(prop)} blocked`));
      };
    },
  });
  return { client, attempts };
}

let seq = 0;
const id = (p: string) => `${p}-DRY-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Deterministic in-memory stand-in for the inbound-money side of PayPal (orders, captures, catalog, invoices). */
export class FakeCommercePayPal {
  readonly captures: Capture[] = [];
  /** Checkout fee as in the constitution's worked example: 2.59% + $0.49, half-up. */
  fee = (gross: bigint): bigint => (gross * 259n + 5000n) / 10000n + 49n;

  createOrder(): Promise<CreatedOrder> {
    const orderId = id('ORDER');
    return Promise.resolve({
      orderId,
      status: 'PAYER_ACTION_REQUIRED',
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
    });
  }

  captureOrder(orderId: string): Promise<Capture> {
    return Promise.reject(new Error(`dry: order ${orderId} has no approved payer`));
  }

  createAndCaptureSandboxCardOrder(i: {
    amountMinor: bigint;
    currency: Currency;
    customId?: string;
  }): Promise<Capture> {
    const fee = this.fee(i.amountMinor);
    const c: Capture = {
      orderId: id('ORDER'),
      captureId: id('CAP'),
      status: 'COMPLETED',
      currency: i.currency,
      grossMinor: i.amountMinor,
      feeMinor: fee,
      netMinor: i.amountMinor - fee,
      ...(i.customId ? { customId: i.customId } : {}),
    };
    this.captures.push(c);
    return Promise.resolve(c);
  }

  createProduct(i: { name: string }): Promise<{ id: string; name: string }> {
    return Promise.resolve({ id: id('PROD'), name: i.name });
  }

  createMonthlyPlan(i: {
    productId: string;
    name: string;
  }): Promise<{ id: string; productId: string; name: string; status: string }> {
    return Promise.resolve({ id: id('P'), productId: i.productId, name: i.name, status: 'ACTIVE' });
  }

  createSubscription(): Promise<{ id: string; planId: string; status: string }> {
    return Promise.resolve({ id: id('I'), planId: 'P', status: 'APPROVAL_PENDING' });
  }

  createInvoice(): Promise<{ id: string; status: string }> {
    return Promise.resolve({ id: id('INV'), status: 'DRAFT' });
  }

  sendInvoice(): Promise<void> {
    return Promise.resolve();
  }

  remindInvoice(): Promise<void> {
    return Promise.resolve();
  }

  provideDisputeEvidence(): Promise<void> {
    return Promise.resolve();
  }

  getDispute(disputeId: string): Promise<Dispute> {
    return Promise.resolve({ id: disputeId, status: 'WAITING_FOR_SELLER_RESPONSE' });
  }
}
