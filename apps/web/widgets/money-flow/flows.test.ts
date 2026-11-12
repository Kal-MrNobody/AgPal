import { describe, expect, it } from 'vitest';
import type { BoardroomData } from '../../lib/types';
import { moneyFlows } from './flows';

type Line = BoardroomData['ledger'][number];
const line = (entryId: string, flow: string, account: string, amount: number): Line =>
  ({ entryId, flow, account, amount }) as Line;

describe('moneyFlows (ADR-020 Sankey)', () => {
  it('turns ledger entries into customers → treasury → envelopes → payees, with fees, AI and internal invoices', () => {
    const ledger = [
      line('e1', 'founder_funding', 'cash:unallocated', 2000),
      line('e1', 'founder_funding', 'equity:owner', -2000),
      line('e2', 'capture', 'cash:unallocated', 27.76),
      line('e2', 'capture', 'expense:paypal_fees', 1.24),
      line('e2', 'capture', 'revenue:sales:revenue', -29),
      line('e3', 'allocation', 'cash:envelope:growth', 180),
      line('e3', 'allocation', 'cash:unallocated', -180),
      line('e4', 'payout_sent', 'cash:envelope:growth', -50.25),
      line('e4', 'payout_sent', 'expense:paypal_fees', 0.25),
      line('e4', 'payout_sent', 'liability:payable:payee_x', 50),
      line('e5', 'ai_usage', 'cash:envelope:growth', -0.07),
      line('e5', 'ai_usage', 'cash:reserve:ai_compute', 0.07),
      line('e6', 'internal_invoice_settle', 'expense:internal:growth', 15),
      line('e6', 'internal_invoice_settle', 'revenue:internal:revenue', -15),
      line('e6', 'internal_invoice_settle', 'cash:envelope:revenue', 15),
      line('e6', 'internal_invoice_settle', 'cash:envelope:growth', -15),
    ];
    const by = Object.fromEntries(moneyFlows(ledger).map((l) => [`${l.from}→${l.to}`, l]));
    expect(by['Founder→Treasury']?.size).toBe(2000);
    expect(by['Customers→Treasury']?.size).toBe(27.76);
    expect(by['Customers→PayPal fees']?.size).toBe(1.24);
    expect(by['Treasury→Growth envelope']?.size).toBe(180);
    expect(by['Growth envelope→Payees']?.size).toBe(50);
    expect(by['Growth envelope→PayPal fees']?.size).toBe(0.25);
    expect(by['Growth envelope→AI models']?.size).toBe(0.07);
    expect(by['Growth envelope→Revenue (internal invoices)']).toMatchObject({
      size: 15,
      kind: 'internal',
    });
  });

  it('a reversal nets a flow out', () => {
    const ledger = [
      line('a', 'allocation', 'cash:envelope:support', 80),
      line('a', 'allocation', 'cash:unallocated', -80),
      line('b', 'allocation', 'cash:envelope:support', -80),
      line('b', 'allocation', 'cash:unallocated', 80),
    ];
    expect(moneyFlows(ledger)).toEqual([]);
  });
});
