import { pathToFileURL } from 'node:url';
/**
 * Headless schedule recalculation with Bryntum's Gantt engine (Prompt 20), following Bryntum's guidance:
 * - each expected payment is its own zero-duration milestone ("Payment received: INV-123");
 * - it gates the milestone it unblocks through a Finish-to-Start dependency (dependencies only connect tasks);
 * - the expected payment date is a `startnoearlierthan` constraint (constraintDate) on the payment milestone;
 * - settlement delay is the dependency's lag, not a padded date;
 * - a slip changes only that milestone's constraintDate and the engine reschedules everything downstream; when the
 *   payment lands, the milestone is marked done at the actual date.
 * Runs in Node with no browser (ADR-018). The engine is loaded lazily, in this order:
 *  1. Bryntum's Node bundle `gantt.node.mjs` (path in BRYNTUM_GANTT_NODE_BUNDLE, or `@bryntum/gantt/gantt.node.mjs`):
 *     the distribution Bryntum recommends for servers. It ships from Bryntum's own registry / customer zone, not the
 *     public npm packages;
 *  2. the engine data model inside the public `@bryntum/gantt-enterprise` package (`lib/Gantt/model/ProjectModel.js`),
 *     no UI widgets;
 *  3. neither loads → `EngineUnavailableError`, and ScheduleService falls back to browser recalculation with
 *     downstream dates flagged unconfirmed.
 */

export class EngineUnavailableError extends Error {}

/** Which engine build recalculates on the server. `AGPAL_SCHEDULE_ENGINE=browser` forces the fallback (tests, drills). */
export type EngineSource = 'gantt.node.mjs' | 'gantt-enterprise/ProjectModel';

export interface PlanTask {
  id: string;
  name: string;
  durationDays: number;
  /** Expected payment date: a startnoearlierthan constraint (payment milestones only). */
  constraintDate?: string;
  percentDone?: number;
  /** For payment milestones: the invoice or payout they track. */
  ref?: string;
}

export interface PlanDependency {
  id: string;
  from: string;
  to: string;
  /** Settlement delay, in days. */
  lagDays: number;
}

export interface PlanSnapshot {
  projectStart: string;
  tasks: PlanTask[];
  dependencies: PlanDependency[];
}

export type PlanChange =
  | { kind: 'shift_payment'; taskId: string; newDate: string }
  | { kind: 'mark_received'; taskId: string; receivedAt: string };

export interface ScheduledTask {
  id: string;
  name: string;
  start: string;
  end: string;
  percentDone: number;
  constraintDate?: string;
}

export interface Recalculated {
  tasks: ScheduledTask[];
  /** Task ids whose dates changed because of the applied changes. */
  changed: string[];
}

interface BryntumTask {
  id: string;
  name: string;
  startDate?: Date;
  endDate?: Date;
  percentDone: number;
  constraintType?: string;
  constraintDate?: Date | string;
  duration: number;
}
interface BryntumProject {
  commitAsync(): Promise<unknown>;
  taskStore: {
    getById(id: string): BryntumTask | undefined;
    map<T>(fn: (t: BryntumTask) => T): T[];
  };
  destroy(): void;
}
type ProjectCtor = new (config: Record<string, unknown>) => BryntumProject;

let engine: Promise<{ ProjectModel: ProjectCtor; source: EngineSource }> | undefined;

async function tryImport(spec: string): Promise<Record<string, unknown> | undefined> {
  try {
    return (await import(spec)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Load the engine once per process (see the order above). */
export function loadEngine(): Promise<{ ProjectModel: ProjectCtor; source: EngineSource }> {
  if (process.env.AGPAL_SCHEDULE_ENGINE === 'browser')
    return Promise.reject(
      new EngineUnavailableError('server engine disabled (AGPAL_SCHEDULE_ENGINE=browser)'),
    );
  engine ??= (async () => {
    const bundlePath = process.env.BRYNTUM_GANTT_NODE_BUNDLE;
    const bundle =
      (bundlePath ? await tryImport(pathToFileURL(bundlePath).href) : undefined) ??
      (await tryImport('@bryntum/gantt/gantt.node.mjs'));
    if (typeof bundle?.ProjectModel === 'function')
      return { ProjectModel: bundle.ProjectModel as ProjectCtor, source: 'gantt.node.mjs' };
    const model = await tryImport('@bryntum/gantt-enterprise/lib/Gantt/model/ProjectModel.js');
    if (typeof model?.default === 'function')
      return {
        ProjectModel: model.default as ProjectCtor,
        source: 'gantt-enterprise/ProjectModel',
      };
    throw new EngineUnavailableError('no Bryntum engine build could be loaded in Node');
  })();
  // A failed load is retried on the next call (e.g. after the bundle is installed).
  engine.catch(() => {
    engine = undefined;
  });
  return engine;
}

const iso = (d: Date | undefined): string => (d ? d.toISOString() : '');

function build(ProjectModel: ProjectCtor, plan: PlanSnapshot): BryntumProject {
  return new ProjectModel({
    startDate: plan.projectStart,
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      name: t.name,
      duration: t.durationDays,
      durationUnit: 'day',
      percentDone: t.percentDone ?? 0,
      ...(t.constraintDate
        ? { constraintType: 'startnoearlierthan', constraintDate: t.constraintDate }
        : {}),
    })),
    // type 2 = Finish-to-Start
    dependencies: plan.dependencies.map((d) => ({
      id: d.id,
      fromTask: d.from,
      toTask: d.to,
      type: 2,
      lag: d.lagDays,
      lagUnit: 'day',
    })),
  });
}

/** Load the plan into a ProjectModel, apply the changes, let the engine propagate, and return every task's dates. */
export async function recalculate(
  plan: PlanSnapshot,
  changes: PlanChange[],
): Promise<Recalculated> {
  const { ProjectModel } = await loadEngine();
  const before = build(ProjectModel, plan);
  await before.commitAsync();
  const baseline = new Map(
    before.taskStore.map((t) => [t.id, `${iso(t.startDate)}|${iso(t.endDate)}`]),
  );
  before.destroy();

  const project = build(ProjectModel, plan);
  await project.commitAsync();
  for (const c of changes) {
    const task = project.taskStore.getById(c.taskId);
    if (!task) throw new Error(`No task ${c.taskId}`);
    if (c.kind === 'shift_payment') {
      task.constraintDate = new Date(`${c.newDate}T00:00:00Z`);
    } else {
      task.constraintType = 'startnoearlierthan';
      task.constraintDate = new Date(`${c.receivedAt}T00:00:00Z`);
      task.percentDone = 100;
    }
  }
  await project.commitAsync();
  const tasks = project.taskStore.map((t) => ({
    id: t.id,
    name: t.name,
    start: iso(t.startDate),
    end: iso(t.endDate),
    percentDone: t.percentDone,
    ...(t.constraintDate ? { constraintDate: new Date(t.constraintDate).toISOString() } : {}),
  }));
  project.destroy();
  const changed = tasks
    .filter((t) => baseline.get(t.id) !== `${t.start}|${t.end}`)
    .map((t) => t.id);
  return { tasks, changed };
}
