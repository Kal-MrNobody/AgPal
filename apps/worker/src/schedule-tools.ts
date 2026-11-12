import { z } from 'zod';
import { defineTool, type Tool } from '@agpal/agents';
import { ScheduleService } from '@agpal/schedule';

/**
 * Agents change the plan only through these tools, which run the headless Bryntum engine on the server (Prompt 20):
 * load the plan, apply one change, let the engine propagate, write every date + the audit entry in one transaction.
 */
export const scheduleTools: Tool[] = [
  defineTool({
    name: 'shift_expected_payment',
    description:
      "Move a payment milestone's expected date (e.g. a customer will pay later). Every dependent milestone is rescheduled by the engine.",
    args: z.object({
      task_id: z.string().min(3),
      new_date: z.iso.date(),
      reason: z.string().min(5).max(300),
    }),
    run: async (ctx, a: { task_id: string; new_date: string; reason: string }) => {
      const r = await new ScheduleService(ctx.db).apply(
        ctx.agent.companyId,
        { kind: 'shift_payment', taskId: a.task_id, newDate: a.new_date },
        { kind: 'agent', agentId: ctx.agent.id, runId: ctx.runId, reason: a.reason },
      );
      return {
        rescheduled: r.changed.length,
        tasks: r.tasks.map((t) => ({ id: t.id, name: t.name, start: t.start.slice(0, 10) })),
      };
    },
  }),
  defineTool({
    name: 'mark_payment_received',
    description: 'Mark a payment milestone done at the actual date the money arrived.',
    args: z.object({ task_id: z.string().min(3), received_on: z.iso.date() }),
    run: async (ctx, a: { task_id: string; received_on: string }) => {
      const r = await new ScheduleService(ctx.db).apply(
        ctx.agent.companyId,
        { kind: 'mark_received', taskId: a.task_id, receivedAt: a.received_on },
        { kind: 'agent', agentId: ctx.agent.id, runId: ctx.runId, reason: 'payment received' },
      );
      return { rescheduled: r.changed.length };
    },
  }),
  defineTool({
    name: 'view_schedule',
    description:
      'The company plan: payment milestones (with expected dates), launches and payouts they gate, with computed dates.',
    args: z.object({}),
    run: async (ctx) =>
      (await new ScheduleService(ctx.db).crudLoad(ctx.agent.companyId)).tasks.rows.map((t) => ({
        id: t.id,
        name: t.name,
        start: t.startDate?.slice(0, 10),
        done: t.percentDone,
      })),
  }),
];
