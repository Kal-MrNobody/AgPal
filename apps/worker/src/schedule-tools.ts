import { z } from 'zod';
import { defineTool, type Tool } from '@agpal/agents';
import { ScheduleService } from '@agpal/schedule';

// One flat object (function-calling APIs need a top-level object schema); per-action fields checked below.
const args = z
  .object({
    action: z.enum(['view', 'shift_payment', 'mark_received']),
    task_id: z.string().min(3).optional(),
    new_date: z.iso.date().optional().describe('shift_payment: the new expected payment date'),
    received_on: z.iso.date().optional().describe('mark_received: the date the money arrived'),
    reason: z.string().min(5).max(300).optional().describe('shift_payment: why the payment moved'),
  })
  .superRefine((a, ctx) => {
    const need = (k: keyof typeof a) => {
      if (a[k] === undefined)
        ctx.addIssue({ code: 'custom', path: [k], message: `required for ${a.action}` });
    };
    if (a.action === 'shift_payment') (['task_id', 'new_date', 'reason'] as const).forEach(need);
    if (a.action === 'mark_received') (['task_id', 'received_on'] as const).forEach(need);
  });

/**
 * The one server-side schedule tool (ADR-018). Agents never touch the UI: they read or change the plan here, the
 * headless Bryntum engine recalculates in this worker, and every date plus the audit entry is written in one
 * transaction. Payment milestones are the only thing an agent can move: a slipped payment changes just that
 * milestone's constraintDate and the engine reschedules everything downstream.
 */
export const scheduleTool: Tool = defineTool({
  name: 'schedule',
  description: [
    'The company plan (Bryntum Gantt, recalculated on the server).',
    'action "view": payment milestones with expected dates and the launches/payouts they gate, with computed dates.',
    'action "shift_payment": move a payment milestone\'s expected date (a customer will pay later/earlier); dependents are rescheduled.',
    'action "mark_received": mark a payment milestone done at the date the money actually arrived.',
  ].join(' '),
  args,
  run: async (ctx, a: z.infer<typeof args>) => {
    const svc = new ScheduleService(ctx.db);
    const co = ctx.agent.companyId;
    if (a.action === 'view') {
      return (await svc.crudLoad(co)).tasks.rows.map((t) => ({
        id: t.id,
        name: t.name,
        start: t.startDate?.slice(0, 10),
        done: t.percentDone,
        confirmed: t.confirmed,
      }));
    }
    const by = { kind: 'agent' as const, agentId: ctx.agent.id, runId: ctx.runId };
    const taskId = a.task_id ?? '';
    const r =
      a.action === 'shift_payment'
        ? await svc.apply(
            co,
            { kind: 'shift_payment', taskId, newDate: a.new_date ?? '' },
            { ...by, reason: a.reason ?? '' },
          )
        : await svc.apply(
            co,
            { kind: 'mark_received', taskId, receivedAt: a.received_on ?? '' },
            { ...by, reason: 'payment received' },
          );
    return {
      rescheduled: r.changed.length,
      tasks: r.tasks.map((t) => ({ id: t.id, name: t.name, start: t.start.slice(0, 10) })),
    };
  },
});

export const scheduleTools: Tool[] = [scheduleTool];
