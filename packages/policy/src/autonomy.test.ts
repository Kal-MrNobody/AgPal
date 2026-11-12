import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agentControls, auditLog, tasks } from '@agpal/db';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { ACC, Ledger } from '@agpal/ledger';
import { newId } from '@agpal/shared';
import {
  applyDailyAutonomy,
  nextLevel,
  pinAutonomy,
  trustRecord,
  type TrustRecord,
} from './autonomy.js';
import { Gate } from './gate.js';
import { FakePayments } from './ports.js';

const record = (p: Partial<TrustRecord>): TrustRecord => ({
  agentId: 'a',
  acceptedWork: 0,
  reversals: 0,
  refunds: 0,
  denials: 0,
  overrides: 0,
  score: 0,
  daysSinceDenial: Infinity,
  ...p,
});

describe('nextLevel (constitution §4)', () => {
  it('promotes one level at score ≥ 10 with no denial for 7 days, never past 3 without a pin', () => {
    expect(nextLevel(1, null, record({ score: 10 }), false)).toEqual({
      level: 2,
      reason: expect.stringContaining('≥ 10') as unknown,
    });
    expect(nextLevel(1, null, record({ score: 12, daysSinceDenial: 3 }), false).level).toBe(1);
    expect(nextLevel(3, null, record({ score: 50 }), false).level).toBe(3);
  });
  it('demotes on a negative score or a founder override, not below 0', () => {
    expect(nextLevel(2, null, record({ score: -1 }), false).level).toBe(1);
    expect(nextLevel(2, null, record({ score: 20 }), true).level).toBe(1);
    expect(nextLevel(0, null, record({ score: -9 }), true).level).toBe(0);
  });
  it('a pinned level never moves', () => {
    expect(nextLevel(1, 4, record({ score: -50 }), true)).toEqual({
      level: 4,
      reason: 'pinned by the founder',
    });
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)('applyDailyAutonomy (from the ledger record)', () => {
  let t: TestDatabase;
  let gate: Gate;
  let co: string;
  const agent = { id: 'growth-agent', department: 'growth' };

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());
  beforeEach(async () => {
    const ledger = new Ledger(t.db);
    gate = new Gate(t.db, ledger, new FakePayments());
    co = newId('co');
    agent.id = newId('agt');
    await ledger.setupCompany({
      id: co,
      name: 'Shop',
      currency: 'USD',
      departments: ['revenue', 'finance', 'support', 'growth'].map((code) => ({
        code,
        name: code,
      })),
    });
    await ledger.post({
      companyId: co,
      currency: 'USD',
      actor: 'founder',
      description: 'fund',
      flow: 'founder_funding',
      postings: [
        { account: ACC.envelope('growth'), amountMinor: 100_000n },
        { account: ACC.ownerEquity, amountMinor: -100_000n },
      ],
    });
  });

  const acceptedWork = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await t.db.insert(tasks).values({
        id: newId('task'),
        companyId: co,
        fromDepartment: 'revenue',
        toDepartment: 'growth',
        title: 't',
        brief: 'b',
        budgetMinor: 100n,
        status: 'accepted',
      });
    }
  };

  it('promotion: 10 accepted deliverables and no denials → level 2, effective at the next day boundary, logged', async () => {
    await acceptedWork(10);
    const r = await trustRecord(t.db, co, agent.id, agent.department);
    expect(r).toMatchObject({ acceptedWork: 10, score: 10 });
    const changes = await applyDailyAutonomy(t.db, co, [agent], new Date('2026-11-13T00:05:00Z'));
    expect(changes).toEqual([
      { agentId: agent.id, from: 1, to: 2, reason: expect.any(String) as unknown },
    ]);
    // Once per day: running again the same day changes nothing.
    await acceptedWork(10);
    expect(await applyDailyAutonomy(t.db, co, [agent], new Date('2026-11-13T09:00:00Z'))).toEqual(
      [],
    );
    const logs = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, agent.id), eq(auditLog.action, 'autonomy.daily')));
    expect(logs).toHaveLength(1);
    // The new level raises the gate's limits: a $70 payout now auto-approves (level 2 = 1.5× of $50).
    await gate.allowPayee(co, 'alice@example.com', 'Alice', 'founder');
    const p = await gate.submit({
      companyId: co,
      agentId: agent.id,
      runId: 'r',
      envelope: 'growth',
      action: 'payout',
      amountMinor: '7000',
      currency: 'USD',
      payee: 'alice@example.com',
      category: 'content',
      reason: 'x',
    });
    expect(p.decision.rule).toBe('within_policy');
  });

  it('demotion: policy denials push the score negative → level 0, where everything is held', async () => {
    for (let i = 0; i < 2; i++) {
      await gate.submit({
        companyId: co,
        agentId: agent.id,
        runId: 'r',
        envelope: 'growth',
        action: 'payout',
        amountMinor: '100',
        currency: 'USD',
        payee: 'stranger@example.com',
        category: 'content',
        reason: 'x',
      });
    }
    expect((await trustRecord(t.db, co, agent.id, agent.department)).score).toBe(-4);
    expect(
      await applyDailyAutonomy(t.db, co, [agent], new Date('2026-11-13T00:05:00Z')),
    ).toMatchObject([{ from: 1, to: 0 }]);
    await gate.allowPayee(co, 'alice@example.com', 'Alice', 'founder');
    const p = await gate.submit({
      companyId: co,
      agentId: agent.id,
      runId: 'r',
      envelope: 'growth',
      action: 'payout',
      amountMinor: '100',
      currency: 'USD',
      payee: 'alice@example.com',
      category: 'content',
      reason: 'x',
    });
    expect(p.decision.rule).toBe('approval_threshold');
  });

  it('pinning: the founder pins a level and the daily job leaves it alone', async () => {
    await pinAutonomy(t.db, co, agent.id, 3);
    await gate.submit({
      companyId: co,
      agentId: agent.id,
      runId: 'r',
      envelope: 'growth',
      action: 'payout',
      amountMinor: '100',
      currency: 'USD',
      payee: 'stranger@example.com',
      category: 'content',
      reason: 'x',
    });
    expect(await applyDailyAutonomy(t.db, co, [agent], new Date('2026-11-13T00:05:00Z'))).toEqual(
      [],
    );
    const [ctl] = await t.db
      .select()
      .from(agentControls)
      .where(eq(agentControls.agentId, agent.id));
    expect(ctl).toMatchObject({ pinnedLevel: 3, autonomyLevel: 3 });
    await pinAutonomy(t.db, co, agent.id, null);
    const [after] = await t.db
      .select()
      .from(agentControls)
      .where(eq(agentControls.agentId, agent.id));
    expect(after?.pinnedLevel).toBeNull();
  });
});
