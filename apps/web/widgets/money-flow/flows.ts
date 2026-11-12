import type { BoardroomData } from '../../lib/types';

export interface MoneyFlowLink {
  from: string;
  to: string;
  /** Dollars, display only (the ledger itself stays in integer cents). */
  size: number;
  kind: 'funding' | 'sale' | 'allocation' | 'payout' | 'internal' | 'ai' | 'fees' | 'refund';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const dept = (account: string) => account.split(':').pop() ?? 'company';
const envelope = (d: string) => `${cap(d)} envelope`;

/**
 * The company's money story from the double-entry ledger (ADR-020): customers → treasury → department envelopes →
 * payees, with fees, AI cost, refunds and internal invoices as their own flows. Each journal entry contributes the
 * debits it posts, so the Sankey always reconciles to the ledger. Reversals net out.
 */
export function moneyFlows(ledger: BoardroomData['ledger']): MoneyFlowLink[] {
  const byEntry = new Map<string, BoardroomData['ledger']>();
  for (const l of ledger) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
  const sums = new Map<string, MoneyFlowLink>();
  const add = (from: string, to: string, size: number, kind: MoneyFlowLink['kind']) => {
    const key = `${from}→${to}`;
    const cur = sums.get(key);
    sums.set(key, { from, to, kind, size: (cur?.size ?? 0) + size });
  };
  for (const lines of byEntry.values()) {
    const flow = lines[0]?.flow ?? '';
    const debit = (pred: (a: string) => boolean) =>
      lines.filter((l) => pred(l.account)).reduce((s, l) => s + l.amount, 0);
    const credited = (pred: (a: string) => boolean) =>
      lines.find((l) => pred(l.account) && l.amount < 0);
    const isEnvelope = (a: string) => a.startsWith('cash:envelope:');
    switch (flow) {
      case 'founder_funding':
        add(
          'Founder',
          'Treasury',
          debit((a) => a === 'cash:unallocated'),
          'funding',
        );
        break;
      case 'capture':
        add(
          'Customers',
          'Treasury',
          debit((a) => a === 'cash:unallocated'),
          'sale',
        );
        add(
          'Customers',
          'PayPal fees',
          debit((a) => a === 'expense:paypal_fees'),
          'fees',
        );
        break;
      case 'allocation':
        for (const l of lines.filter((x) => isEnvelope(x.account)))
          add('Treasury', envelope(dept(l.account)), l.amount, 'allocation');
        break;
      case 'payout_sent': {
        const from = credited(isEnvelope);
        if (!from) break;
        const source = envelope(dept(from.account));
        add(
          source,
          'Payees',
          debit((a) => a.startsWith('liability:payable:payee')),
          'payout',
        );
        add(
          source,
          'PayPal fees',
          debit((a) => a === 'expense:paypal_fees'),
          'fees',
        );
        break;
      }
      case 'internal_invoice_settle': {
        const buyer = credited(isEnvelope);
        const seller = lines.find((l) => isEnvelope(l.account) && l.amount > 0);
        if (buyer && seller)
          add(
            envelope(dept(buyer.account)),
            `${cap(dept(seller.account))} (internal invoices)`,
            seller.amount,
            'internal',
          );
        break;
      }
      case 'ai_usage':
        for (const l of lines.filter((x) => isEnvelope(x.account) && x.amount < 0))
          add(envelope(dept(l.account)), 'AI models', -l.amount, 'ai');
        break;
      case 'refund':
        add(
          'Treasury',
          'Refunds to customers',
          debit((a) => a.startsWith('revenue:refunds')),
          'refund',
        );
        break;
      default:
        break;
    }
  }
  return [...sums.values()]
    .filter((l) => l.size > 0.004)
    .map((l) => ({ ...l, size: Math.round(l.size * 100) / 100 }));
}
