const net = (gross: string, fee: string): string => {
  const cents = (v: string) => BigInt(v.replace('.', ''));
  const n = cents(gross) - cents(fee);
  return `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}`;
};

/** Webhook payloads in PayPal's shapes (recorded from sandbox / PayPal docs, ids replaced). */
export const captureCompleted = (
  companyId: string,
  captureId = 'CAP-WH-1',
  gross = '29.00',
  fee = '1.24',
) => ({
  id: `WH-${captureId}`,
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource_type: 'capture',
  resource: {
    id: captureId,
    status: 'COMPLETED',
    amount: { currency_code: 'USD', value: gross },
    custom_id: `agpal:${companyId}:sale_1`,
    seller_receivable_breakdown: {
      gross_amount: { currency_code: 'USD', value: gross },
      paypal_fee: { currency_code: 'USD', value: fee },
      net_amount: { currency_code: 'USD', value: net(gross, fee) },
    },
    supplementary_data: { related_ids: { order_id: 'ORDER-1' } },
  },
});

export const captureRefunded = (
  captureId = 'CAP-WH-1',
  refundId = 'REF-WH-1',
  gross = '29.00',
) => ({
  id: `WH-${refundId}`,
  event_type: 'PAYMENT.CAPTURE.REFUNDED',
  resource_type: 'refund',
  resource: {
    id: refundId,
    status: 'COMPLETED',
    amount: { currency_code: 'USD', value: gross },
    seller_payable_breakdown: {
      gross_amount: { currency_code: 'USD', value: gross },
      paypal_fee: { currency_code: 'USD', value: '0.00' },
      net_amount: { currency_code: 'USD', value: gross },
    },
    links: [
      {
        rel: 'up',
        href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`,
        method: 'GET',
      },
    ],
  },
});

export const saleCompleted = (companyId: string, saleId = 'SALE-1') => ({
  id: `WH-${saleId}`,
  event_type: 'PAYMENT.SALE.COMPLETED',
  resource_type: 'sale',
  resource: {
    id: saleId,
    state: 'completed',
    amount: { total: '9.00', currency: 'USD' },
    transaction_fee: { value: '0.72', currency: 'USD' },
    billing_agreement_id: 'I-SUB1',
    custom: `agpal:${companyId}:sub_1`,
  },
});

export const dispute = (
  type: 'CREATED' | 'UPDATED' | 'RESOLVED',
  captureId = 'CAP-WH-1',
  outcome?: string,
) => ({
  id: `WH-DISPUTE-${type}-${outcome ?? ''}-${captureId}`,
  event_type: `CUSTOMER.DISPUTE.${type}`,
  resource_type: 'dispute',
  resource: {
    dispute_id: `PP-D-${captureId}`,
    status: type === 'RESOLVED' ? 'RESOLVED' : 'WAITING_FOR_SELLER_RESPONSE',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    dispute_amount: { currency_code: 'USD', value: '29.00' },
    disputed_transactions: [{ seller_transaction_id: captureId }],
    seller_response_due_date: '2026-11-22T00:00:00Z',
    ...(outcome ? { dispute_outcome: { outcome_code: outcome } } : {}),
  },
});

export const payoutItem = (
  status: string,
  intentId: string,
  fee: string | null = '0.25',
  amount = '40.00',
) => ({
  id: `WH-PO-${status}-${intentId}`,
  event_type: `PAYMENT.PAYOUTS-ITEM.${status}`,
  resource_type: 'payouts_item',
  resource: {
    payout_item_id: `ITEM-${intentId}`,
    transaction_status: status === 'SUCCEEDED' ? 'SUCCESS' : status,
    payout_batch_id: 'BATCH-1',
    ...(fee ? { payout_item_fee: { currency: 'USD', value: fee } } : {}),
    payout_item: {
      amount: { currency: 'USD', value: amount },
      receiver: 'alice@example.com',
      sender_item_id: intentId,
      recipient_type: 'EMAIL',
    },
  },
});
