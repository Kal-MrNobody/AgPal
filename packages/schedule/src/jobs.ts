import type { PlanChange } from './headless.js';

/**
 * Founder edits from the boardroom Gantt are recalculated in apps/worker, like agent changes (ADR-018): the API
 * enqueues one job on this queue and waits for its result; the worker runs ScheduleService.apply (headless engine).
 */
export const SCHEDULE_QUEUE = 'schedule.apply';

export interface ScheduleJob {
  companyId: string;
  change: PlanChange;
  actor: { kind: 'founder'; reason: string };
}

export interface ScheduleJobResult {
  engine: 'server' | 'browser-fallback';
  changed: string[];
}
