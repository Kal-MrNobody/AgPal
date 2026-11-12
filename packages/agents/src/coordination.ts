import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { internalInvoices, messages, tasks, type Database } from '@agpal/db';
import type { Gate } from '@agpal/policy';
import { newId } from '@agpal/shared';
import type { InboxItem } from './runtime.js';
import { defineTool, type Tool, type ToolContext } from './tools.js';
import { departments, type AgentRecord } from './types.js';

/**
 * Coordination layer (Prompt 11): departments send each other requests (brief, budget offered, deadline) as threads,
 * deliver results, and settle with internal invoices. Settlement is an internal_invoice SpendIntent through the gate:
 * a ledger transfer between envelopes, never a PayPal call (constitution §2.4).
 */
export class Coordination {
  constructor(
    private readonly db: Database,
    private readonly gate: Gate,
  ) {}

  async request(i: {
    companyId: string;
    from: string;
    to: string;
    title: string;
    brief: string;
    budgetMinor: bigint;
    deadline?: Date;
    contractorEmail?: string;
    campaign?: string;
    agentId?: string;
    runId?: string;
  }): Promise<string> {
    const id = newId('task');
    await this.db.insert(tasks).values({
      id,
      companyId: i.companyId,
      fromDepartment: i.from,
      toDepartment: i.to,
      title: i.title,
      brief: i.brief,
      budgetMinor: i.budgetMinor,
      deadline: i.deadline ?? null,
      contractorEmail: i.contractorEmail ?? null,
      campaign: i.campaign ?? null,
      createdByAgent: i.agentId ?? null,
      createdByRun: i.runId ?? null,
    });
    if (!i.contractorEmail) {
      await this.message({
        companyId: i.companyId,
        taskId: id,
        from: i.from,
        to: i.to,
        body: `New request: ${i.title}\n\n${i.brief}`,
      });
    }
    return id;
  }

  async message(i: {
    companyId: string;
    taskId?: string;
    from: string;
    to: string;
    body: string;
    attachments?: { name: string; url?: string; text?: string }[];
    untrusted?: boolean;
  }): Promise<string> {
    const id = newId('msg');
    await this.db.insert(messages).values({
      id,
      companyId: i.companyId,
      taskId: i.taskId ?? null,
      fromParty: i.from,
      toDepartment: i.to,
      body: i.body,
      attachments: i.attachments ?? [],
      untrusted: i.untrusted ?? false,
    });
    return id;
  }

  /** The doing department (or a contractor) delivers; the requester is notified on the thread. */
  async deliver(
    companyId: string,
    taskId: string,
    by: string,
    result: string,
    attachments: { name: string; url?: string; text?: string }[] = [],
    untrusted = false,
  ): Promise<void> {
    const [t] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId)));
    if (!t) throw new Error(`No task ${taskId}`);
    if (t.status !== 'open') throw new Error(`Task ${taskId} is ${t.status}`);
    await this.db
      .update(tasks)
      .set({ status: 'delivered', updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
    await this.message({
      companyId,
      taskId,
      from: by,
      to: t.fromDepartment,
      body: `Delivered: ${t.title}\n\n${result}`,
      attachments,
      untrusted,
    });
  }

  /** Seller issues an internal invoice for delivered work (no money moves yet). */
  async issueInvoice(i: {
    companyId: string;
    seller: string;
    buyer: string;
    amountMinor: bigint;
    description: string;
    taskId?: string;
    runId?: string;
  }): Promise<string> {
    if (i.seller === i.buyer) throw new Error('A department cannot invoice itself');
    if (i.taskId) {
      const [t] = await this.db.select().from(tasks).where(eq(tasks.id, i.taskId));
      if (!t || t.toDepartment !== i.seller || t.fromDepartment !== i.buyer)
        throw new Error('Invoice does not match the task');
      if (i.amountMinor > t.budgetMinor)
        throw new Error(`Invoice exceeds the ${t.budgetMinor} budget offered on the task`);
    }
    const id = newId('iinv');
    await this.db.insert(internalInvoices).values({
      id,
      companyId: i.companyId,
      taskId: i.taskId ?? null,
      sellerDepartment: i.seller,
      buyerDepartment: i.buyer,
      amountMinor: i.amountMinor,
      currency: 'USD',
      description: i.description,
      issuedByRun: i.runId ?? null,
    });
    await this.message({
      companyId: i.companyId,
      ...(i.taskId ? { taskId: i.taskId } : {}),
      from: i.seller,
      to: i.buyer,
      body: `Internal invoice ${id}: ${i.description} — ${i.amountMinor} cents. Accept or dispute it.`,
    });
    return id;
  }

  /** Buyer accepts: an internal_invoice intent on the buyer's envelope; the gate settles it (or holds it). */
  async acceptInvoice(
    companyId: string,
    invoiceId: string,
    buyerAgentId: string,
    runId: string,
  ): Promise<{ status: string; rule: string; explanation: string }> {
    const [inv] = await this.db
      .select()
      .from(internalInvoices)
      .where(and(eq(internalInvoices.id, invoiceId), eq(internalInvoices.companyId, companyId)));
    if (!inv) throw new Error(`No internal invoice ${invoiceId}`);
    if (inv.status !== 'issued')
      return {
        status: inv.status,
        rule: 'already_decided',
        explanation: `Invoice is ${inv.status}`,
      };
    const r = await this.gate.submit({
      companyId,
      agentId: buyerAgentId,
      runId,
      envelope: inv.buyerDepartment,
      action: 'internal_invoice',
      amountMinor: inv.amountMinor.toString(),
      currency: 'USD',
      target: inv.sellerDepartment,
      category: 'internal',
      reason: `Accepting internal invoice ${inv.id}: ${inv.description}`,
      details: { internalInvoiceId: inv.id, taskId: inv.taskId },
    });
    const status = r.status === 'executed' ? 'settled' : r.status === 'held' ? 'held' : 'rejected';
    await this.db
      .update(internalInvoices)
      .set({ status, intentId: r.intentId, updatedAt: new Date() })
      .where(eq(internalInvoices.id, inv.id));
    if (inv.taskId && status === 'settled')
      await this.db
        .update(tasks)
        .set({ status: 'accepted', updatedAt: new Date() })
        .where(eq(tasks.id, inv.taskId));
    await this.message({
      companyId,
      ...(inv.taskId ? { taskId: inv.taskId } : {}),
      from: inv.buyerDepartment,
      to: inv.sellerDepartment,
      body: `Internal invoice ${inv.id}: ${status} (${r.decision.explanation})`,
    });
    return { status, rule: r.decision.rule, explanation: r.decision.explanation };
  }

  async disputeInvoice(companyId: string, invoiceId: string, reason: string): Promise<void> {
    const [inv] = await this.db
      .select()
      .from(internalInvoices)
      .where(and(eq(internalInvoices.id, invoiceId), eq(internalInvoices.companyId, companyId)));
    if (inv?.status !== 'issued') throw new Error(`Invoice ${invoiceId} cannot be disputed now`);
    await this.db
      .update(internalInvoices)
      .set({ status: 'disputed', disputeReason: reason, updatedAt: new Date() })
      .where(eq(internalInvoices.id, invoiceId));
    await this.message({
      companyId,
      ...(inv.taskId ? { taskId: inv.taskId } : {}),
      from: inv.buyerDepartment,
      to: inv.sellerDepartment,
      body: `Internal invoice ${inv.id} disputed: ${reason}`,
    });
  }

  /** Unread messages and open work for an agent's department, marked read once delivered. */
  inboxSource = async (agent: AgentRecord): Promise<InboxItem[]> => {
    const msgs = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.companyId, agent.companyId),
          eq(messages.toDepartment, agent.department),
          isNull(messages.readAt),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(20);
    const openInvoices = await this.db
      .select()
      .from(internalInvoices)
      .where(
        and(
          eq(internalInvoices.companyId, agent.companyId),
          eq(internalInvoices.buyerDepartment, agent.department),
          eq(internalInvoices.status, 'issued'),
        ),
      );
    if (msgs.length)
      await this.db
        .update(messages)
        .set({ readAt: new Date() })
        .where(
          inArray(
            messages.id,
            msgs.map((m) => m.id),
          ),
        );
    return [
      ...msgs.map((m) => ({
        kind: m.untrusted ? 'message:untrusted' : 'message',
        id: m.id,
        at: m.createdAt.toISOString(),
        data: { from: m.fromParty, taskId: m.taskId, body: m.body, attachments: m.attachments },
      })),
      ...openInvoices.map((v) => ({
        kind: 'internal_invoice:awaiting_you',
        id: v.id,
        at: v.createdAt.toISOString(),
        data: {
          invoiceId: v.id,
          seller: v.sellerDepartment,
          amountCents: Number(v.amountMinor),
          description: v.description,
          taskId: v.taskId,
        },
      })),
    ];
  };
}

const coord = (ctx: ToolContext): Coordination => {
  const c = ctx.services.coordination;
  if (!(c instanceof Coordination)) throw new Error('coordination not available');
  return c;
};

const dept = z.enum(departments);

export const coordinationTools: Tool[] = [
  defineTool({
    name: 'send_request',
    description:
      'Ask another department to do work for you: a brief, the budget you offer (cents) and a deadline.',
    args: z.object({
      to_department: dept,
      title: z.string().min(3).max(120),
      brief: z.string().min(10).max(4000),
      budget_cents: z.number().int().nonnegative(),
      deadline_days: z.number().int().min(1).max(60).optional(),
    }),
    run: async (
      ctx,
      a: {
        to_department: string;
        title: string;
        brief: string;
        budget_cents: number;
        deadline_days?: number;
      },
    ) => {
      if (a.to_department === ctx.agent.department)
        return { error: 'You cannot send a request to your own department.' };
      const id = await coord(ctx).request({
        companyId: ctx.agent.companyId,
        from: ctx.agent.department,
        to: a.to_department,
        title: a.title,
        brief: a.brief,
        budgetMinor: BigInt(a.budget_cents),
        ...(a.deadline_days
          ? { deadline: new Date(Date.now() + a.deadline_days * 86_400_000) }
          : {}),
        agentId: ctx.agent.id,
        runId: ctx.runId,
      });
      return { taskId: id };
    },
  }),
  defineTool({
    name: 'list_open_tasks',
    description: 'Open requests other departments sent to your department.',
    args: z.object({}),
    run: async (ctx) => {
      const rows = await ctx.db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, ctx.agent.companyId),
            eq(tasks.toDepartment, ctx.agent.department),
            eq(tasks.status, 'open'),
          ),
        );
      return rows.map((t) => ({
        taskId: t.id,
        from: t.fromDepartment,
        title: t.title,
        brief: t.brief,
        budgetCents: Number(t.budgetMinor),
        deadline: t.deadline?.toISOString(),
      }));
    },
  }),
  defineTool({
    name: 'deliver_task',
    description: 'Deliver the result of a request sent to your department.',
    args: z.object({ task_id: z.string().min(3), result: z.string().min(10).max(8000) }),
    run: async (ctx, a: { task_id: string; result: string }) => {
      await coord(ctx).deliver(ctx.agent.companyId, a.task_id, ctx.agent.department, a.result);
      return { delivered: true };
    },
  }),
  defineTool({
    name: 'issue_internal_invoice',
    description:
      'Invoice another department for work you delivered (must not exceed the budget they offered).',
    args: z.object({
      to_department: dept,
      amount_cents: z.number().int().positive(),
      description: z.string().min(5).max(500),
      task_id: z.string().optional(),
    }),
    run: async (
      ctx,
      a: { to_department: string; amount_cents: number; description: string; task_id?: string },
    ) => ({
      invoiceId: await coord(ctx).issueInvoice({
        companyId: ctx.agent.companyId,
        seller: ctx.agent.department,
        buyer: a.to_department,
        amountMinor: BigInt(a.amount_cents),
        description: a.description,
        ...(a.task_id ? { taskId: a.task_id } : {}),
        runId: ctx.runId,
      }),
    }),
  }),
  defineTool({
    name: 'accept_internal_invoice',
    description:
      'Accept an internal invoice addressed to your department; the gate settles it from your envelope.',
    money: true,
    args: z.object({ invoice_id: z.string().min(3) }),
    run: async (ctx, a: { invoice_id: string }) =>
      coord(ctx).acceptInvoice(ctx.agent.companyId, a.invoice_id, ctx.agent.id, ctx.runId),
  }),
  defineTool({
    name: 'dispute_internal_invoice',
    description: 'Dispute an internal invoice addressed to your department, with a reason.',
    args: z.object({ invoice_id: z.string().min(3), reason: z.string().min(5).max(500) }),
    run: async (ctx, a: { invoice_id: string; reason: string }) => {
      await coord(ctx).disputeInvoice(ctx.agent.companyId, a.invoice_id, a.reason);
      return { disputed: true };
    },
  }),
];
