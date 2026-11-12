import { describe, expect, it } from 'vitest';
import { PayPalError } from './errors.js';
import {
  captureFromOrder,
  normalizePayoutItem,
  normalizeRefund,
  normalizeTransaction,
} from './paypal.js';

// Recorded from the PayPal sandbox on 2026-11-12 (ids shortened).
const capturedOrder = {
  id: 'ORDER1',
  status: 'COMPLETED',
  purchase_units: [
    {
      payments: {
        captures: [
          {
            id: 'CAP1',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '10.00' },
            custom_id: 'agpal:co_1:sale_1',
            seller_receivable_breakdown: {
              gross_amount: { currency_code: 'USD', value: '10.00' },
              paypal_fee: { currency_code: 'USD', value: '0.75' },
              net_amount: { currency_code: 'USD', value: '9.25' },
            },
          },
        ],
      },
    },
  ],
};

describe('normalizers', () => {
  it('reads gross, fee and net from seller_receivable_breakdown as minor units', () => {
    const c = captureFromOrder(capturedOrder);
    expect(c).toMatchObject({
      orderId: 'ORDER1',
      captureId: 'CAP1',
      grossMinor: 1000n,
      feeMinor: 75n,
      netMinor: 925n,
      currency: 'USD',
      customId: 'agpal:co_1:sale_1',
    });
  });

  it('refuses a completed capture without a fee breakdown (the ledger needs net)', () => {
    const broken = structuredClone(capturedOrder);
    const cap = broken.purchase_units[0]?.payments.captures[0] as Record<string, unknown>;
    delete cap.seller_receivable_breakdown;
    expect(() => captureFromOrder(broken)).toThrow(PayPalError);
  });

  it('refuses a breakdown where gross ≠ fee + net', () => {
    const broken = structuredClone(capturedOrder);
    const b = broken.purchase_units[0]?.payments.captures[0]?.seller_receivable_breakdown;
    if (b) b.net_amount.value = '9.26';
    expect(() => captureFromOrder(broken)).toThrow(/gross/);
  });

  it('normalizes refunds including returned fees', () => {
    const r = normalizeRefund(
      {
        id: 'REF1',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '10.00' },
        seller_payable_breakdown: {
          gross_amount: { currency_code: 'USD', value: '10.00' },
          paypal_fee: { currency_code: 'USD', value: '0.26' },
          net_amount: { currency_code: 'USD', value: '9.74' },
        },
      },
      'CAP1',
    );
    expect(r).toMatchObject({
      refundId: 'REF1',
      grossMinor: 1000n,
      feeReturnedMinor: 26n,
      netMinor: 974n,
    });
  });

  it('normalizes payout items before and after the fee is known', () => {
    const pending = normalizePayoutItem({
      payout_item_id: 'I1',
      transaction_status: 'PENDING',
      payout_item: { amount: { currency_code: 'USD', value: '1.00' }, receiver: 'a@example.com' },
    });
    expect(pending.feeMinor).toBeUndefined();
    const done = normalizePayoutItem({
      payout_item_id: 'I1',
      transaction_status: 'UNCLAIMED',
      transaction_id: 'T1',
      payout_item_fee: { currency_code: 'USD', value: '0.25' },
      payout_item: {
        amount: { currency_code: 'USD', value: '1.00' },
        receiver: 'a@example.com',
        sender_item_id: 'int_1',
      },
      errors: { name: 'RECEIVER_UNREGISTERED' },
    });
    expect(done).toMatchObject({
      status: 'UNCLAIMED',
      feeMinor: 25n,
      amountMinor: 100n,
      senderItemId: 'int_1',
      errorName: 'RECEIVER_UNREGISTERED',
    });
  });

  it('normalizes Transaction Search rows (fee is negative, net = gross + fee)', () => {
    const t = normalizeTransaction({
      transaction_id: 'CAP1',
      transaction_event_code: 'T0006',
      transaction_status: 'S',
      transaction_amount: { currency_code: 'USD', value: '10.00' },
      fee_amount: { currency_code: 'USD', value: '-0.75' },
      transaction_initiation_date: '2026-11-12T11:00:00+0000',
    });
    expect(t).toMatchObject({
      grossMinor: 1000n,
      feeMinor: -75n,
      netMinor: 925n,
      eventCode: 'T0006',
    });
  });
});
