import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, internalInvoices, journalEntries, spendIntents } from '@agpal/db';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { ACC, Ledger } from '@agpal/ledger';
import { FakePayments, Gate, type Services } from '@agpal/policy';
import { newId } from '@agpal/shared';
import { createAgentRuntime } from './factory.js';
import { defaultModelConfig } from './models.js';
import { ScriptedProvider, type ScriptedTurn } from './provider.js';
import type { AgentDefinition } from './types.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const DEPTS = ['revenue', 'finance', 'support', 'growth'].map((code) => ({ code, name: code }));

const call = (name: string, args: Record<string, unknown>) => ({
  toolCalls: [{ callId: newId('c'), name, arguments: JSON.stringify(args) }],
});

describe.runIf(hasDb)('Coordination layer', () => {
  let t: TestDatabase;
  let ledger: Ledger;
  let gate: Gate;
  let co: string;
  let growth: AgentDefinition;
  let revenue: AgentDefinition;

  const build = (script: ScriptedTurn[]) => {
    const provider = new ScriptedProvider(script);
    const services = { ledger, gate, commerce: {}, inbound: {} } as unknown as Services;
    return {
      provider,
      ...createAgentRuntime(t.db, services, { provider, models: defaultModelConfig }),
    };
  };

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());
  beforeEach(async () => {
    ledger = new Ledger(t.db);
    gate = new Gate(t.db, ledger, new FakePayments());
    co = newId('co');
    await ledger.setupCompany({ id: co, name: 'Shop', currency: 'USD', departments: DEPTS });
    for (const d of ['growth', 'revenue']) {
      await ledger.post({
        companyId: co,
        currency: 'USD',
        actor: 'founder',
        description: 'fund',
        flow: 'founder_funding',
        postings: [
          { account: ACC.envelope(d), amountMinor: 10_000n },
          { account: ACC.ownerEquity, amountMinor: -10_000n },
        ],
      });
    }
    const base = {
      modelTier: 'routine' as const,
      heartbeatCron: '0 * * * *',
      reportsTo: 'founder',
    };
    growth = {
      ...base,
      id: newId('agt'),
      department: 'growth',
      envelope: 'growth',
      title: 'Growth',
      mandate: 'grow',
      tools: [
        'send_request',
        'accept_internal_invoice',
        'dispute_internal_invoice',
        'request_payout',
      ],
    };
    revenue = {
      ...base,
      id: newId('agt'),
      department: 'revenue',
      envelope: 'revenue',
      title: 'Revenue',
      mandate: 'sell',
      tools: ['list_open_tasks', 'deliver_task', 'issue_internal_invoice'],
    };
  });

  it('runs a full internal invoice cycle: request → deliver → invoice → accept → settled between envelopes', async () => {
    // 1. Growth asks Revenue for a listing rewrite, offering $25.
    let taskId = '';
    const g1 = build([
      call('send_request', {
        to_department: 'revenue',
        title: 'Rewrite the preset pack listing',
        brief: 'Make it clearer and add 3 benefits.',
        budget_cents: 2500,
        deadline_days: 3,
      }),
      { text: 'SUMMARY: asked Revenue' },
    ]);
    await g1.runtime.hire(co, growth);
    const r1 = await g1.runtime.run(growth.id, { kind: 'heartbeat' });
    taskId = (r1.toolCalls[0]?.result as { taskId: string }).taskId;

    // 2. Revenue sees it in its inbox, delivers and invoices $20.
    const rv = build([
      (req) => {
        expect(JSON.stringify(req.input)).toContain('Rewrite the preset pack listing');
        return call('deliver_task', { task_id: taskId, result: 'New listing: …three benefits…' });
      },
      call('issue_internal_invoice', {
        to_department: 'growth',
        amount_cents: 2000,
        description: 'Listing rewrite',
        task_id: taskId,
      }),
      { text: 'SUMMARY: delivered and invoiced' },
    ]);
    await rv.runtime.hire(co, revenue);
    await rv.runtime.run(revenue.id, { kind: 'heartbeat' });
    const [inv] = await t.db
      .select()
      .from(internalInvoices)
      .where(eq(internalInvoices.taskId, taskId));
    expect(inv?.status).toBe('issued');

    // 3. Growth accepts; the gate settles it as a ledger transfer between envelopes (no PayPal).
    const g2 = build([
      (req) => {
        expect(JSON.stringify(req.input)).toContain('internal_invoice:awaiting_you');
        return call('accept_internal_invoice', { invoice_id: inv?.id });
      },
      { text: 'SUMMARY: accepted' },
    ]);
    const growthBefore = (await ledger.envelope(co, 'growth')).balance;
    const revenueBefore = (await ledger.envelope(co, 'revenue')).balance;
    const r3 = await g2.runtime.run(growth.id, { kind: 'heartbeat' });
    expect(r3.toolCalls[0]?.result).toMatchObject({ status: 'settled' });
    const [settled] = await t.db
      .select()
      .from(internalInvoices)
      .where(eq(internalInvoices.id, inv?.id ?? ''));
    expect(settled?.status).toBe('settled');
    expect(await ledger.balance(co, ACC.internalExpense('growth'))).toBe(2_000n);
    expect(await ledger.balance(co, ACC.internalRevenue('revenue'))).toBe(-2_000n);
    // Growth paid 2000 + its AI cost; Revenue received 2000.
    expect((await ledger.envelope(co, 'revenue')).balance).toBe(revenueBefore + 2_000n);
    expect((await ledger.envelope(co, 'growth')).balance).toBe(
      growthBefore - 2_000n - r3.costMinor,
    );
  });

  it('cannot invoice more than the budget offered', async () => {
    const { coordination } = build([]);
    const task = await coordination.request({
      companyId: co,
      from: 'growth',
      to: 'revenue',
      title: 'x',
      brief: 'brief text',
      budgetMinor: 1000n,
    });
    await expect(
      coordination.issueInvoice({
        companyId: co,
        seller: 'revenue',
        buyer: 'growth',
        amountMinor: 1001n,
        description: 'too much',
        taskId: task,
      }),
    ).rejects.toThrow(/budget/);
  });

  it('approval round trip: a held payout is decided by the founder and the agent learns the outcome next run', async () => {
    await gate.allowPayee(co, 'alice@example.com', 'Alice', 'founder');
    const g = build([
      call('request_payout', {
        payee_email: 'alice@example.com',
        amount_cents: 9000,
        category: 'content',
        reason: 'Launch video',
      }),
      { text: 'SUMMARY: requested' },
    ]);
    await g.runtime.hire(co, growth);
    const r = await g.runtime.run(growth.id, { kind: 'heartbeat' });
    expect(r.toolCalls[0]?.result).toMatchObject({ outcome: 'hold_for_founder', status: 'held' });
    const [intent] = await t.db.select().from(spendIntents).where(eq(spendIntents.runId, r.runId));
    const { approvals } = await import('@agpal/db');
    const [apr] = await t.db
      .select()
      .from(approvals)
      .where(eq(approvals.intentId, intent?.id ?? ''));
    await gate.reject(apr?.id ?? '', 'founder', 'Not this week');

    const next = build([
      (req) => {
        const input = JSON.stringify(req.input);
        expect(input).toContain('approval.decided');
        expect(input).toContain('Not this week');
        return { text: 'SUMMARY: founder rejected; will re-plan' };
      },
    ]);
    await next.runtime.run(growth.id, { kind: 'heartbeat' });
    expect((await ledger.envelope(co, 'growth')).held).toBe(0n);
  });

  it('a paused agent cannot spend: the scheduler skips it and the gate denies it', async () => {
    await gate.allowPayee(co, 'alice@example.com', 'Alice', 'founder');
    const g = build([
      call('request_payout', {
        payee_email: 'alice@example.com',
        amount_cents: 100,
        category: 'content',
        reason: 'tiny thing',
      }),
    ]);
    await g.runtime.hire(co, growth);
    await gate.setAgentPaused(co, growth.id, true, 'founder');
    expect((await g.runtime.run(growth.id, { kind: 'heartbeat' })).status).toBe('skipped_paused');
    const direct = await gate.submit({
      companyId: co,
      agentId: growth.id,
      runId: 'r',
      envelope: 'growth',
      action: 'payout',
      amountMinor: '100',
      currency: 'USD',
      payee: 'alice@example.com',
      category: 'content',
      reason: 'bypass the scheduler',
    });
    expect(direct.decision.rule).toBe('kill_switch.agent');
  });

  it('audit trail links run → tool call → intent → decision → ledger entry', async () => {
    await gate.allowPayee(co, 'alice@example.com', 'Alice', 'founder');
    const g = build([
      call('request_payout', {
        payee_email: 'alice@example.com',
        amount_cents: 1500,
        category: 'content',
        reason: 'Newsletter blurb',
      }),
      { text: 'SUMMARY: paid' },
    ]);
    await g.runtime.hire(co, growth);
    const r = await g.runtime.run(growth.id, { kind: 'heartbeat' });
    const intentId = (r.toolCalls[0]?.result as { intentId: string }).intentId;
    const [intent] = await t.db.select().from(spendIntents).where(eq(spendIntents.id, intentId));
    expect(intent?.runId).toBe(r.runId);
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.subjectId, intentId));
    expect(audit.some((a) => a.action === 'gate.approve' && a.runId === r.runId)).toBe(true);
    const entries = await t.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.runId, r.runId));
    expect(entries.map((e) => e.flow).sort()).toEqual([
      'ai_usage',
      'payout_accrual',
      'payout_sent',
    ]);
    expect(entries.every((e) => e.agentId === growth.id)).toBe(true);
  });
});
