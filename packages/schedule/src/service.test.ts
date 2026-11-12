import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, scheduleTasks } from '@agpal/db';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { ScheduleService } from './service.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe.runIf(hasDb)('ScheduleService (server-side recalculation, no browser)', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());

  it('a slipped payment recalculates every dependent milestone on the server and lands in the audit trail', async () => {
    const svc = new ScheduleService(t.db);
    const co = 'co_sched';
    await svc.seedDemo(co, new Date('2026-11-16T00:00:00Z'));
    const before = await t.db.select().from(scheduleTasks).where(eq(scheduleTasks.companyId, co));
    const payment = before.find((x) => x.ref === 'INV-1042');
    const launch = before.find((x) => x.name.startsWith('Launch'));
    expect(launch?.startDate?.toISOString().slice(0, 10)).toBe('2026-11-21'); // payment 19th + 2 days settlement lag

    const r = await svc.apply(
      co,
      { kind: 'shift_payment', taskId: payment?.id ?? '', newDate: '2026-11-24' },
      {
        kind: 'agent',
        agentId: 'finance-x',
        runId: 'run_1',
        reason: 'Client asked to pay next week',
      },
    );
    expect(r.changed.length).toBeGreaterThanOrEqual(3);
    const after = await t.db.select().from(scheduleTasks).where(eq(scheduleTasks.companyId, co));
    expect(
      after
        .find((x) => x.id === launch?.id)
        ?.startDate?.toISOString()
        .slice(0, 10),
    ).toBe('2026-11-26');
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectId, payment?.id ?? ''),
          eq(auditLog.action, 'schedule.shift_payment'),
        ),
      );
    expect(audit[0]).toMatchObject({ agentId: 'finance-x', runId: 'run_1' });

    // What the browser Gantt loads is exactly the server's dates.
    const load = await svc.crudLoad(co);
    const row = load.tasks.rows.find((x) => x.id === launch?.id);
    expect(row?.startDate).toBe(after.find((x) => x.id === launch?.id)?.startDate?.toISOString());
    expect(row?.manuallyScheduled).toBe(true);
  });

  it('only payment milestones can be shifted', async () => {
    const svc = new ScheduleService(t.db);
    const [task] = await t.db
      .select()
      .from(scheduleTasks)
      .where(and(eq(scheduleTasks.companyId, 'co_sched'), eq(scheduleTasks.kind, 'task')));
    await expect(
      svc.apply(
        'co_sched',
        { kind: 'shift_payment', taskId: task?.id ?? '', newDate: '2026-12-01' },
        { kind: 'founder', reason: 'x' },
      ),
    ).rejects.toThrow(/not a payment milestone/);
  });

  it('engine fallback (ADR-018): the change is stored, downstream dates are flagged unconfirmed for the browser', async () => {
    const svc = new ScheduleService(t.db);
    const co = 'co_fallback';
    await svc.seedDemo(co, new Date('2026-11-16T00:00:00Z'));
    const rows = await t.db.select().from(scheduleTasks).where(eq(scheduleTasks.companyId, co));
    const payment = rows.find((x) => x.ref === 'INV-1042');
    const launch = rows.find((x) => x.name.startsWith('Launch'));
    process.env.AGPAL_SCHEDULE_ENGINE = 'browser';
    try {
      const r = await svc.apply(
        co,
        { kind: 'shift_payment', taskId: payment?.id ?? '', newDate: '2026-11-24' },
        { kind: 'founder', reason: 'drill' },
      );
      expect(r.engine).toBe('browser-fallback');
      expect(r.changed).toContain(launch?.id);
    } finally {
      delete process.env.AGPAL_SCHEDULE_ENGINE;
    }
    const after = await t.db.select().from(scheduleTasks).where(eq(scheduleTasks.companyId, co));
    const p = after.find((x) => x.id === payment?.id);
    expect(p?.constraintDate?.toISOString().slice(0, 10)).toBe('2026-11-24');
    expect(p?.confirmed).toBe(true);
    expect(after.find((x) => x.id === launch?.id)?.confirmed).toBe(false);
    const load = await svc.crudLoad(co);
    const row = load.tasks.rows.find((x) => x.id === launch?.id);
    expect(row).toMatchObject({ manuallyScheduled: false, confirmed: false });
    expect(row?.cls).toContain('unconfirmed');
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectId, payment?.id ?? ''),
          eq(auditLog.action, 'schedule.shift_payment'),
        ),
      );
    expect(audit?.data).toMatchObject({ engine: 'browser-fallback' });

    // Once the server engine is back, the next recalculation confirms everything again.
    await svc.apply(co, null, { kind: 'system', reason: 'engine back' });
    const healed = await t.db.select().from(scheduleTasks).where(eq(scheduleTasks.companyId, co));
    expect(healed.every((x) => x.confirmed)).toBe(true);
    expect(
      healed
        .find((x) => x.id === launch?.id)
        ?.startDate?.toISOString()
        .slice(0, 10),
    ).toBe('2026-11-26');
  });
});
