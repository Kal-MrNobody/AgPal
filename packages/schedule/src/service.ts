import { and, asc, eq } from 'drizzle-orm';
import { auditLog, scheduleDependencies, scheduleTasks, type Database } from '@agpal/db';
import { newId } from '@agpal/shared';
import {
  EngineUnavailableError,
  recalculate,
  type PlanChange,
  type PlanSnapshot,
  type Recalculated,
} from './headless.js';

/**
 * The one server path for schedule changes (Prompt 20). Agents (schedule tool) and the browser Gantt (CrudManager
 * sync) both come here: load the company plan into a Bryntum ProjectModel, apply the change, wait for the engine to
 * propagate, and write every recalculated date back in one transaction together with the audit entry.
 */
export class ScheduleService {
  constructor(private readonly db: Database) {}

  async snapshot(companyId: string): Promise<PlanSnapshot> {
    const tasks = await this.db
      .select()
      .from(scheduleTasks)
      .where(eq(scheduleTasks.companyId, companyId))
      .orderBy(asc(scheduleTasks.sortOrder));
    const deps = await this.db
      .select()
      .from(scheduleDependencies)
      .where(eq(scheduleDependencies.companyId, companyId));
    const earliest = tasks
      .map((t) => t.constraintDate ?? t.startDate)
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return {
      projectStart: (earliest ?? new Date()).toISOString().slice(0, 10),
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        durationDays: t.durationDays,
        percentDone: t.percentDone,
        ...(t.constraintDate
          ? { constraintDate: t.constraintDate.toISOString().slice(0, 10) }
          : {}),
        ...(t.ref ? { ref: t.ref } : {}),
      })),
      dependencies: deps.map((d) => ({
        id: d.id,
        from: d.fromTask,
        to: d.toTask,
        lagDays: d.lagDays,
      })),
    };
  }

  /** Apply one change (or none, to recalculate), persist all dates atomically with an audit entry. */
  async apply(
    companyId: string,
    change: PlanChange | null,
    actor: {
      kind: 'agent' | 'founder' | 'system';
      agentId?: string;
      runId?: string;
      reason: string;
    },
  ) {
    const plan = await this.snapshot(companyId);
    if (change) {
      const t = plan.tasks.find((x) => x.id === change.taskId);
      if (!t) throw new Error(`No plan task ${change.taskId}`);
      if (t.constraintDate === undefined) throw new Error(`${t.name} is not a payment milestone`);
    }
    let result: Recalculated;
    try {
      result = await recalculate(plan, change ? [change] : []);
    } catch (e) {
      if (e instanceof EngineUnavailableError)
        return this.applyUnconfirmed(companyId, plan, change, actor, e);
      throw e;
    }
    await this.db.transaction(async (tx) => {
      for (const t of result.tasks) {
        const original = plan.tasks.find((x) => x.id === t.id);
        await tx
          .update(scheduleTasks)
          .set({
            startDate: new Date(t.start),
            endDate: new Date(t.end),
            percentDone: t.percentDone,
            confirmed: true,
            ...(original?.constraintDate !== undefined && t.constraintDate
              ? { constraintDate: new Date(t.constraintDate) }
              : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(scheduleTasks.id, t.id), eq(scheduleTasks.companyId, companyId)));
      }
      await tx.insert(auditLog).values({
        companyId,
        actor: actor.kind === 'agent' ? (actor.agentId ?? 'agent') : actor.kind,
        action: change ? `schedule.${change.kind}` : 'schedule.recalculated',
        subjectType: 'schedule',
        subjectId: change?.taskId ?? companyId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
        data: {
          change,
          reason: actor.reason,
          changed: result.changed,
          dates: Object.fromEntries(
            result.tasks.map((t) => [t.id, { start: t.start, end: t.end }]),
          ),
        },
      });
    });
    return { ...result, engine: 'server' as const };
  }

  /**
   * ADR-018 fallback when no Bryntum engine build loads in Node: store the change itself (a payment milestone's
   * constraintDate is known exactly), flag every task downstream of it as unconfirmed, and let the browser Gantt
   * recalculate those rows for display. The next successful server recalculation confirms them again.
   */
  private async applyUnconfirmed(
    companyId: string,
    plan: PlanSnapshot,
    change: PlanChange | null,
    actor: {
      kind: 'agent' | 'founder' | 'system';
      agentId?: string;
      runId?: string;
      reason: string;
    },
    cause: Error,
  ) {
    const next = new Map<string, string[]>();
    for (const d of plan.dependencies) next.set(d.from, [...(next.get(d.from) ?? []), d.to]);
    const unconfirmed = new Set<string>();
    if (change) {
      const queue = [...(next.get(change.taskId) ?? [])];
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (unconfirmed.has(id)) continue;
        unconfirmed.add(id);
        queue.push(...(next.get(id) ?? []));
      }
    } else {
      for (const t of plan.tasks) if (t.constraintDate === undefined) unconfirmed.add(t.id);
    }
    await this.db.transaction(async (tx) => {
      if (change) {
        const day = new Date(
          `${change.kind === 'shift_payment' ? change.newDate : change.receivedAt}T00:00:00Z`,
        );
        await tx
          .update(scheduleTasks)
          .set({
            constraintDate: day,
            startDate: day,
            endDate: day,
            ...(change.kind === 'mark_received' ? { percentDone: 100 } : {}),
            confirmed: true,
            updatedAt: new Date(),
          })
          .where(and(eq(scheduleTasks.id, change.taskId), eq(scheduleTasks.companyId, companyId)));
      }
      for (const id of unconfirmed)
        await tx
          .update(scheduleTasks)
          .set({ confirmed: false, updatedAt: new Date() })
          .where(and(eq(scheduleTasks.id, id), eq(scheduleTasks.companyId, companyId)));
      await tx.insert(auditLog).values({
        companyId,
        actor: actor.kind === 'agent' ? (actor.agentId ?? 'agent') : actor.kind,
        action: change ? `schedule.${change.kind}` : 'schedule.recalculated',
        subjectType: 'schedule',
        subjectId: change?.taskId ?? companyId,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
        data: {
          change,
          reason: actor.reason,
          engine: 'browser-fallback',
          cause: cause.message,
          unconfirmed: [...unconfirmed],
        },
      });
    });
    const rows = await this.db
      .select()
      .from(scheduleTasks)
      .where(eq(scheduleTasks.companyId, companyId))
      .orderBy(asc(scheduleTasks.sortOrder));
    return {
      tasks: rows.map((t) => ({
        id: t.id,
        name: t.name,
        start: t.startDate?.toISOString() ?? '',
        end: t.endDate?.toISOString() ?? '',
        percentDone: t.percentDone,
      })),
      changed: [...unconfirmed],
      engine: 'browser-fallback' as const,
    };
  }

  /** CrudManager load response for the browser Gantt (display only; dates are the server's). */
  async crudLoad(companyId: string) {
    const tasks = await this.db
      .select()
      .from(scheduleTasks)
      .where(eq(scheduleTasks.companyId, companyId))
      .orderBy(asc(scheduleTasks.sortOrder));
    const deps = await this.db
      .select()
      .from(scheduleDependencies)
      .where(eq(scheduleDependencies.companyId, companyId));
    const plan = await this.snapshot(companyId);
    return {
      success: true,
      project: { startDate: plan.projectStart },
      tasks: {
        rows: tasks.map((t) => ({
          id: t.id,
          name: t.name,
          startDate: t.startDate?.toISOString(),
          endDate: t.endDate?.toISOString(),
          duration: t.durationDays,
          durationUnit: 'day',
          percentDone: t.percentDone,
          // Confirmed rows show the server's computed dates as-is; unconfirmed rows (engine fallback, ADR-018) are left
          // to the browser engine to schedule and are flagged in the UI.
          manuallyScheduled: t.confirmed,
          ...(t.constraintDate
            ? {
                constraintType: 'startnoearlierthan',
                constraintDate: t.constraintDate.toISOString(),
              }
            : {}),
          cls: [t.kind === 'payment' ? 'payment-milestone' : '', t.confirmed ? '' : 'unconfirmed']
            .filter(Boolean)
            .join(' '),
          confirmed: t.confirmed,
        })),
      },
      dependencies: {
        rows: deps.map((d) => ({
          id: d.id,
          fromTask: d.fromTask,
          toTask: d.toTask,
          type: 2,
          lag: d.lagDays,
          lagUnit: 'day',
        })),
      },
    };
  }

  /** Seed a demo plan: payment milestones gating launches, settlement delay as lag. */
  async seedDemo(companyId: string, from = new Date()): Promise<void> {
    const day = (n: number) => new Date(from.getTime() + n * 86_400_000);
    const rows = [
      {
        id: newId('st'),
        name: 'Payment received: INV-1042 (agency retainer)',
        kind: 'payment',
        durationDays: 0,
        constraintDate: day(3),
        ref: 'INV-1042',
      },
      { id: newId('st'), name: 'Launch: Creator Pro annual offer', kind: 'task', durationDays: 3 },
      {
        id: newId('st'),
        name: 'Pay contractor: launch thread (Ava)',
        kind: 'task',
        durationDays: 1,
      },
      {
        id: newId('st'),
        name: 'Payment received: INV-1043 (template bundle B2B)',
        kind: 'payment',
        durationDays: 0,
        constraintDate: day(6),
        ref: 'INV-1043',
      },
      {
        id: newId('st'),
        name: 'Milestone: Q1 budget allocation',
        kind: 'milestone',
        durationDays: 0,
      },
    ];
    await this.db
      .insert(scheduleTasks)
      .values(rows.map((r, i) => ({ ...r, companyId, sortOrder: i })));
    const [a, b, c, d, e] = rows.map((r) => r.id);
    await this.db.insert(scheduleDependencies).values([
      { id: newId('sd'), companyId, fromTask: a ?? '', toTask: b ?? '', lagDays: 2 },
      { id: newId('sd'), companyId, fromTask: b ?? '', toTask: c ?? '', lagDays: 0 },
      { id: newId('sd'), companyId, fromTask: d ?? '', toTask: e ?? '', lagDays: 1 },
      { id: newId('sd'), companyId, fromTask: c ?? '', toTask: e ?? '', lagDays: 0 },
    ]);
    await this.apply(companyId, null, { kind: 'system', reason: 'seed demo plan' });
  }
}
