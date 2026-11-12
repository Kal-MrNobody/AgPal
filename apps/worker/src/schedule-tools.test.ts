import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, scheduleTasks } from '@agpal/db';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import type { ToolContext } from '@agpal/agents';
import { ScheduleService } from '@agpal/schedule';
import { scheduleTool, scheduleTools } from './schedule-tools.js';

const hasDb = Boolean(process.env.DATABASE_URL);

describe('schedule tool (ADR-018)', () => {
  it('is the one schedule tool agents get', () => {
    expect(scheduleTools.map((t) => t.name)).toEqual(['schedule']);
  });

  it('rejects a write without its fields', () => {
    expect(scheduleTool.args.safeParse({ action: 'shift_payment', task_id: 'st_1' }).success).toBe(
      false,
    );
    expect(scheduleTool.args.safeParse({ action: 'view' }).success).toBe(true);
  });
});

describe.runIf(hasDb)('schedule tool against the database', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());

  it('view, shift a payment (audited, attributed) and mark it received', async () => {
    const co = 'co_tool';
    await new ScheduleService(t.db).seedDemo(co, new Date('2026-11-16T00:00:00Z'));
    const ctx = {
      db: t.db,
      agent: { id: 'finance-x', companyId: co },
      runId: 'run_t',
    } as unknown as ToolContext;
    const run = (a: unknown) => scheduleTool.run(ctx, scheduleTool.args.parse(a));

    const view = (await run({ action: 'view' })) as { id: string; name: string }[];
    const payment = view.find((x) => x.name.includes('INV-1042'));
    expect(payment).toBeDefined();

    const shifted = (await run({
      action: 'shift_payment',
      task_id: payment?.id,
      new_date: '2026-11-24',
      reason: 'Client pays next week',
    })) as { rescheduled: number };
    expect(shifted.rescheduled).toBeGreaterThanOrEqual(3);
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectId, payment?.id ?? ''),
          eq(auditLog.action, 'schedule.shift_payment'),
        ),
      );
    expect(audit).toMatchObject({ agentId: 'finance-x', runId: 'run_t' });

    await run({ action: 'mark_received', task_id: payment?.id, received_on: '2026-11-24' });
    const [row] = await t.db
      .select()
      .from(scheduleTasks)
      .where(eq(scheduleTasks.id, payment?.id ?? ''));
    expect(row?.percentDone).toBe(100);
  });
});
