import { describe, expect, it } from 'vitest';
import {
  CaptureStatus,
  OrderStatus,
  RefundStatus,
  type CapturedPayment,
  type Order,
  type Refund,
} from '@paypal/paypal-server-sdk';
import {
  captureFromTypedOrder,
  normalizeCapture,
  normalizeRefund,
  normalizeTransaction,
} from './paypal.js';
import { captureWire, refundWire, searchPage, transactionWire } from './typed.js';

/** SDK typed models (camelCase, Money = { currencyCode, value }) mapped through the validating normalizers. */
describe('typed SDK models (ADR-017)', () => {
  const capture = {
    id: 'CAP1',
    status: CaptureStatus.Completed,
    amount: { currencyCode: 'USD', value: '29.00' },
    sellerReceivableBreakdown: {
      grossAmount: { currencyCode: 'USD', value: '29.00' },
      paypalFee: { currencyCode: 'USD', value: '1.24' },
      netAmount: { currencyCode: 'USD', value: '27.76' },
    },
    customId: 'sale-1',
    createTime: '2026-11-12T10:00:00Z',
  } as CapturedPayment;

  it('an order capture becomes integer minor units with fee and net', () => {
    const order = {
      id: 'ORDER1',
      status: OrderStatus.Completed,
      purchaseUnits: [{ payments: { captures: [capture] } }],
    } as Order;
    expect(captureFromTypedOrder(order)).toEqual({
      orderId: 'ORDER1',
      captureId: 'CAP1',
      status: 'COMPLETED',
      currency: 'USD',
      grossMinor: 2900n,
      feeMinor: 124n,
      netMinor: 2776n,
      customId: 'sale-1',
      createTime: '2026-11-12T10:00:00Z',
    });
  });

  it('keeps the money checks: a COMPLETED capture without its breakdown is refused', () => {
    const bare = { ...capture, sellerReceivableBreakdown: undefined } as CapturedPayment;
    expect(() => normalizeCapture(captureWire(bare), 'O')).toThrow(/no fee\/net breakdown/);
    expect(() => captureFromTypedOrder({ id: 'O2', status: OrderStatus.Created })).toThrow(
      /no capture/,
    );
  });

  it('a refund keeps the returned fee and finds its capture from the up link', () => {
    const refund = {
      id: 'R1',
      status: RefundStatus.Completed,
      amount: { currencyCode: 'USD', value: '29.00' },
      sellerPayableBreakdown: {
        grossAmount: { currencyCode: 'USD', value: '29.00' },
        paypalFee: { currencyCode: 'USD', value: '0.99' },
        netAmount: { currencyCode: 'USD', value: '28.01' },
      },
      links: [{ rel: 'up', href: 'https://api/v2/payments/captures/CAP1' }],
    } as Refund;
    expect(normalizeRefund(refundWire(refund), '')).toMatchObject({
      refundId: 'R1',
      captureId: 'CAP1',
      grossMinor: 2900n,
      feeReturnedMinor: 99n,
      netMinor: 2801n,
    });
  });

  it('transaction search rows', () => {
    const page = searchPage({
      totalPages: 2,
      transactionDetails: [
        {
          transactionInfo: {
            transactionId: 'T1',
            transactionEventCode: 'T0006',
            transactionStatus: 'S',
            transactionAmount: { currencyCode: 'USD', value: '29.00' },
            feeAmount: { currencyCode: 'USD', value: '-1.24' },
            transactionInitiationDate: '2026-11-12T10:00:00+0000',
            invoiceId: 'INV-1',
          },
        },
      ],
    });
    expect(page.totalPages).toBe(2);
    const [t] = page.transactions;
    expect(normalizeTransaction(transactionWire(t ?? {}))).toMatchObject({
      transactionId: 'T1',
      grossMinor: 2900n,
      feeMinor: -124n,
      netMinor: 2776n,
      invoiceId: 'INV-1',
    });
  });
});
