import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { eq, sql } from 'drizzle-orm';
import { auditLog, spendIntents } from '@agpal/db';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { ACC, Ledger } from '@agpal/ledger';
import { newId } from '@agpal/shared';
import { FakePayments } from './ports.js';
import { Gate } from './gate.js';
import type { SpendIntentInput } from './intent.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const DEPTS = ['revenue', 'finance', 'support', 'growth'].map((code) => ({ code, name: code }));

describe.runIf(hasDb)('Gate (Postgres)', () => {
  let t: TestDatabase;
  let ledger: Ledger;
  let payments: FakePayments;
  let gate: Gate;
  let co: string;

  const fund = (amount: bigint) =>
    ledger.post({
      companyId: co,
      currency: 'USD',
      actor: 'founder',
      description: 'fund',
      flow: 'founder_funding',
      postings: [
        { account: ACC.unallocated, amountMinor: amount },
        { account: ACC.ownerEquity, amountMinor: -amount },
      ],
    });

  const intent = (patch: Partial<SpendIntentInput> = {}): SpendIntentInput => ({
    companyId: co,
    agentId: 'growth-agent',
    runId: newId('run'),
    envelope: 'growth',
    action: 'payout',
    amountMinor: '4000',
    currency: 'USD',
    payee: 'alice@example.com',
    category: 'content',
    reason: 'Blog post per brief #1',
    ...patch,
  });

  const allocate = (dept: string, amount: string) =>
    gate.submit({
      ...intent(),
      agentId: 'finance-agent',
      envelope: 'finance',
      action: 'allocation',
      amountMinor: amount,
      target: dept,
      category: 'budgeting',
      payee: undefined,
    });

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());

  beforeEach(async () => {
    ledger = new Ledger(t.db);
    payments = new FakePayments();
    gate = new Gate(t.db, ledger, payments);
    co = newId('co');
    await ledger.setupCompany({ id: co, name: 'Shop', currency: 'USD', departments: DEPTS });
    await fund(500_000n);
    expect((await allocate('growth', '50000')).status).toBe('executed');
    await gate.allowPayee(co, 'alice@example.com', 'Alice', 'founder');
    // These tests exercise the optional "hold the first payout to a payee" rule.
    const { defaultPolicyConfig } = await import('./config.js');
    await gate.setConfig(
      co,
      {
        ...defaultPolicyConfig,
        envelopes: {
          ...defaultPolicyConfig.envelopes,
          growth: { ...defaultPolicyConfig.envelopes.growth, holdFirstPayoutToNewPayee: true },
        },
      },
      'founder',
    );
  });

  it('auto-approves within policy, pays out once and books the constitution flow', async () => {
    // First payout to a new payee is held; approve it so later payouts auto-approve.
    const first = await gate.submit(intent());
    expect(first.status).toBe('held');
    expect((await gate.approve(first.approvalId ?? '', 'founder')).status).toBe('executed');

    const r = await gate.submit(intent());
    expect(r.decision).toMatchObject({ outcome: 'approve', rule: 'within_policy' });
    expect(r.status).toBe('executed');
    expect(payments.payouts).toHaveLength(2);
    expect(payments.payouts[1]?.senderBatchId).toBe(r.intentId);

    const env = await ledger.envelope(co, 'growth');
    expect(env.held).toBe(0n);
    expect(env.balance).toBe(50_000n - 2n * (4_000n + 80n)); // amount + 2% fee each
    expect(await ledger.balance(co, ACC.contractors('growth'))).toBe(8_000n);
    expect(await ledger.balance(co, ACC.paypalFees)).toBe(160n);
  });

  it('holds over-threshold payouts and reserves the funds until the founder decides', async () => {
    await gate.submit(intent()).then((r) => gate.approve(r.approvalId ?? '', 'founder'));
    const held = await gate.submit(intent({ amountMinor: '12000' }));
    expect(held.decision.rule).toBe('approval_threshold');
    expect(held.status).toBe('held');
    expect((await ledger.envelope(co, 'growth')).held).toBe(12_100n);

    const rejected = await gate.submit(intent({ amountMinor: '6000' }));
    await gate.reject(rejected.approvalId ?? '', 'founder', 'not now');
    expect((await ledger.envelope(co, 'growth')).held).toBe(12_100n);

    const approved = await gate.approve(held.approvalId ?? '', 'founder', 'ok');
    expect(approved.status).toBe('executed');
    expect((await ledger.envelope(co, 'growth')).held).toBe(0n);
    // Approving twice does nothing.
    expect((await gate.approve(held.approvalId ?? '', 'founder')).status).toBe('executed');
    expect(payments.payouts).toHaveLength(2);
  });

  it('re-checks deny rules at approval time', async () => {
    const held = await gate.submit(intent());
    await gate.setKillSwitch(co, true, 'founder');
    const r = await gate.approve(held.approvalId ?? '', 'founder');
    expect(r.decision.rule).toBe('kill_switch.company');
    expect(r.status).toBe('denied');
    expect((await ledger.envelope(co, 'growth')).held).toBe(0n);
    expect(payments.payouts).toHaveLength(0);
  });

  it('kill switches deny everything', async () => {
    await gate.setAgentPaused(co, 'growth-agent', true, 'founder');
    expect((await gate.submit(intent())).decision.rule).toBe('kill_switch.agent');
    await gate.setAgentPaused(co, 'growth-agent', false, 'founder');
    await gate.setKillSwitch(co, true, 'founder');
    expect((await allocate('support', '100')).decision.rule).toBe('kill_switch.company');
  });

  it('denies payees that are not allow-listed and writes every decision to the audit log', async () => {
    const r = await gate.submit(intent({ payee: 'mallory@example.com' }));
    expect(r.decision.rule).toBe('payee.not_allowlisted');
    const audits = await t.db.select().from(auditLog).where(eq(auditLog.subjectId, r.intentId));
    expect(audits.map((a) => a.action)).toContain('gate.deny');
    expect(audits[0]?.runId).toBeTruthy();
  });

  it('velocity cannot be raced: concurrent submits respect the limit', async () => {
    await gate.submit(intent()).then((r) => gate.approve(r.approvalId ?? '', 'founder'));
    await gate.setAutonomyLevel(co, 'growth-agent', 1, 'founder');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => gate.submit(intent({ amountMinor: '1000' }))),
    );
    const approved = results.filter((r) => r.decision.outcome === 'approve').length;
    // 5 per hour; the founder-approved first payout already counts as one.
    expect(approved).toBe(4);
    expect(results.filter((r) => r.decision.rule === 'velocity').length).toBe(4);
  });

  it('a failed execution keeps the hold and retries with the same idempotency key', async () => {
    await gate.submit(intent()).then((r) => gate.approve(r.approvalId ?? '', 'founder'));
    payments.failNext = new Error('PayPal 503');
    const r = await gate.submit(intent());
    expect(r.status).toBe('failed');
    expect((await ledger.envelope(co, 'growth')).held).toBe(4_100n);
    expect((await gate.retry(r.intentId)).status).toBe('executed');
    expect(payments.payouts.filter((p) => p.senderBatchId === r.intentId)).toHaveLength(1);
    expect((await ledger.envelope(co, 'growth')).held).toBe(0n);
  });

  it('refunds are limited to the captured amount, including in-flight refunds', async () => {
    await ledger.post({
      companyId: co,
      currency: 'USD',
      actor: 'system',
      description: 'capture',
      flow: 'capture',
      externalRef: 'CAP-1',
      postings: [
        { account: ACC.unallocated, amountMinor: 2_776n },
        { account: ACC.paypalFees, amountMinor: 124n },
        { account: ACC.sales('revenue'), amountMinor: -2_900n },
      ],
    });
    const refund = (amount: string) =>
      gate.submit({
        ...intent(),
        agentId: 'support-agent',
        envelope: 'support',
        action: 'refund',
        payee: 'CAP-1',
        amountMinor: amount,
        category: 'refunds',
      });
    expect((await refund('2000')).status).toBe('executed');
    expect((await refund('1000')).decision.rule).toBe('refund.over_captured');
    expect((await refund('900')).status).toBe('executed');
    expect(await ledger.balance(co, ACC.refunds('revenue'))).toBe(2_900n);
  });

  it('fuzz: random intents can never overspend an envelope', async () => {
    await gate.submit(intent()).then((r) => gate.approve(r.approvalId ?? '', 'founder'));
    await gate.setConfig(
      co,
      {
        ...(await import('./config.js')).defaultPolicyConfig,
        envelopes: {
          ...(await import('./config.js')).defaultPolicyConfig.envelopes,
          growth: {
            actions: ['payout', 'internal_invoice'],
            autoApproveUpToMinor: '25000',
            perTxCapMinor: '25000',
            dailyCapMinor: '10000000',
            velocity: { max: 1000, windowMinutes: 60 },
            payeePolicy: 'allowlist',
            categories: null,
          },
        },
      },
      'founder',
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            amount: fc.integer({ min: 1, max: 30_000 }),
            action: fc.constantFrom('payout', 'internal_invoice'),
          }),
          { minLength: 5, maxLength: 15 },
        ),
        async (ops) => {
          await Promise.all(
            ops.map((o) =>
              gate.submit(
                intent({
                  action: o.action,
                  amountMinor: String(o.amount),
                  target: o.action === 'internal_invoice' ? 'revenue' : undefined,
                }),
              ),
            ),
          );
          const env = await ledger.envelope(co, 'growth');
          expect(env.balance >= 0n).toBe(true);
          expect(env.available >= 0n).toBe(true);
          const res = await t.db.execute<{ n: string }>(
            sql`SELECT count(*) AS n FROM accounts WHERE company_id = ${co} AND rule = 'non_negative' AND balance_minor < 0`,
          );
          expect(res.rows[0]?.n).toBe('0');
        },
      ),
      { numRuns: 15 },
    );
    const executed = await t.db.select().from(spendIntents).where(eq(spendIntents.companyId, co));
    expect(executed.some((r) => r.rule === 'funds.insufficient')).toBe(true);
  });
});
