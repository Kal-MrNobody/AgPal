import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agentRuns, domainEvents, journalEntries, spendIntents } from '@agpal/db';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { ACC, Ledger } from '@agpal/ledger';
import { FakePayments, Gate } from '@agpal/policy';
import { newId } from '@agpal/shared';
import { defaultModelConfig } from './models.js';
import { ScriptedProvider } from './provider.js';
import { AgentRuntime } from './runtime.js';
import { coreToolsByName } from './tools.js';
import type { AgentDefinition } from './types.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const DEPTS = ['revenue', 'finance', 'support', 'growth'].map((code) => ({ code, name: code }));

const growthAgent: AgentDefinition = {
  id: 'growth-test',
  department: 'growth',
  title: 'Head of Growth (test)',
  mandate: 'Commission content from approved contractors within budget.',
  modelTier: 'routine',
  heartbeatCron: '0 9 * * *',
  envelope: 'growth',
  tools: ['get_envelope', 'request_payout'],
  reportsTo: 'founder',
};

describe.runIf(hasDb)('AgentRuntime (scripted model)', () => {
  let t: TestDatabase;
  let ledger: Ledger;
  let gate: Gate;
  let co: string;

  const runtime = (provider: ScriptedProvider) =>
    new AgentRuntime({
      db: t.db,
      ledger,
      gate,
      provider,
      models: defaultModelConfig,
      tools: coreToolsByName,
    });

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());
  beforeEach(async () => {
    ledger = new Ledger(t.db);
    gate = new Gate(t.db, ledger, new FakePayments());
    co = newId('co');
    await ledger.setupCompany({ id: co, name: 'Shop', currency: 'USD', departments: DEPTS });
    await ledger.post({
      companyId: co,
      currency: 'USD',
      actor: 'founder',
      description: 'fund growth',
      flow: 'founder_funding',
      postings: [
        { account: ACC.envelope('growth'), amountMinor: 10_000n },
        { account: ACC.ownerEquity, amountMinor: -10_000n },
      ],
    });
    await gate.allowPayee(co, 'alice@example.com', 'Alice', 'founder');
    growthAgent.id = newId('agt');
  });

  it('wakes on a heartbeat, reads its inbox, creates a SpendIntent and books its AI cost', async () => {
    const rt = runtime(
      new ScriptedProvider([
        (req) => {
          // The inbox event is visible to the model as data.
          expect(JSON.stringify(req.input)).toContain('brief.delivered');
          return {
            toolCalls: [
              {
                callId: 'c1',
                name: 'request_payout',
                arguments: JSON.stringify({
                  payee_email: 'alice@example.com',
                  amount_cents: 2500,
                  category: 'content',
                  reason: 'Blog post per brief #7 delivered',
                }),
              },
            ],
          };
        },
        { text: 'SUMMARY: Paid Alice $25 for the delivered blog post.' },
      ]),
    );
    await rt.hire(co, growthAgent);
    await t.db.insert(domainEvents).values({
      id: newId('evt'),
      companyId: co,
      name: 'brief.delivered',
      department: 'growth',
      dedupeKey: 'brief-7',
      payload: { brief: 7, contractor: 'alice@example.com' },
    });

    const r = await rt.run(growthAgent.id, { kind: 'heartbeat' });
    expect(r.status).toBe('completed');
    expect(r.summary).toBe('Paid Alice $25 for the delivered blog post.');

    // The gate recorded the intent, attributed to this agent and run.
    const [intent] = await t.db.select().from(spendIntents).where(eq(spendIntents.runId, r.runId));
    expect(intent).toMatchObject({
      agentId: growthAgent.id,
      action: 'payout',
      amountMinor: 2500n,
      decision: 'approve',
      status: 'executed',
    });

    // AI cost: 2 steps × (1000 in, 200 out) at the scripted price = 2000·$1/M + 400·$4/M = 3600 µ$ → 1 cent (rounded up).
    expect(r.costMicros).toBe(3_600n);
    expect(r.costMinor).toBe(1n);
    expect(await ledger.balance(co, ACC.aiCompute('growth'))).toBe(1n);
    expect(await ledger.balance(co, ACC.aiReserve)).toBe(1n);
    const env = await ledger.envelope(co, 'growth');
    expect(env.held).toBe(0n);
    expect(env.balance).toBe(10_000n - 2_500n - 50n - 1n); // payout + 2% fee + AI cost

    const [run] = await t.db.select().from(agentRuns).where(eq(agentRuns.id, r.runId));
    expect(run?.status).toBe('completed');
    const [costEntry] = await t.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, run?.costEntryId ?? ''));
    expect(costEntry).toMatchObject({ agentId: growthAgent.id, runId: r.runId, flow: 'ai_usage' });

    // The inbox cursor advanced: the same event is not delivered twice.
    const second = new ScriptedProvider([{ text: 'SUMMARY: nothing to do' }]);
    await runtime(second).run(growthAgent.id, { kind: 'heartbeat' });
    expect(JSON.stringify(second.requests[0]?.input)).not.toContain('brief.delivered');
  });

  it('refuses tools outside the allow-list and invalid arguments, without moving money', async () => {
    const rt = runtime(
      new ScriptedProvider([
        {
          toolCalls: [
            {
              callId: 'a',
              name: 'request_allocation',
              arguments: JSON.stringify({
                to_department: 'growth',
                amount_cents: 100000,
                reason: 'more budget please',
              }),
            },
            {
              callId: 'b',
              name: 'request_payout',
              arguments: JSON.stringify({
                payee_email: 'not-an-email',
                amount_cents: 1.5,
                category: 'x',
                reason: 'r',
              }),
            },
          ],
        },
        { text: 'SUMMARY: gave up' },
      ]),
    );
    await rt.hire(co, growthAgent);
    const r = await rt.run(growthAgent.id, { kind: 'manual' });
    expect(r.toolCalls[0]?.result).toMatchObject({
      error: expect.stringContaining('allow-list') as unknown,
    });
    expect(r.toolCalls[1]?.result).toMatchObject({
      error: expect.stringContaining('Invalid arguments') as unknown,
    });
    expect(
      await t.db.select().from(spendIntents).where(eq(spendIntents.runId, r.runId)),
    ).toHaveLength(0);
  });

  it('goes idle and notifies Finance when the envelope cannot cover the next run', async () => {
    const rt = runtime(new ScriptedProvider([]));
    await rt.hire(co, { ...growthAgent, envelope: 'support' });
    const r = await rt.run(growthAgent.id, { kind: 'heartbeat' });
    expect(r.status).toBe('skipped_no_budget');
    const evts = await t.db.select().from(domainEvents).where(eq(domainEvents.companyId, co));
    expect(evts.find((e) => e.name === 'envelope.low')?.department).toBe('finance');
  });

  it('a paused agent does not run', async () => {
    const provider = new ScriptedProvider([]);
    const rt = runtime(provider);
    await rt.hire(co, growthAgent);
    await gate.setAgentPaused(co, growthAgent.id, true, 'founder');
    expect((await rt.run(growthAgent.id, { kind: 'heartbeat' })).status).toBe('skipped_paused');
    expect(provider.requests).toHaveLength(0);
  });
});
