import { z } from 'zod';
import type { Database } from '@agpal/db';
import type { Ledger } from '@agpal/ledger';
import type { Gate, GateResult, SpendIntentInput } from '@agpal/policy';
import type { AgentRecord } from './types.js';

/**
 * Tools are our own functions, never raw PayPal tools. Money tools only create SpendIntents for the gate.
 * Read tools are scoped to the agent's company and department. Arguments are validated with zod: model output is
 * untrusted input.
 */
export interface ToolContext {
  db: Database;
  ledger: Ledger;
  gate: Gate;
  agent: AgentRecord;
  runId: string;
  /** Extra services department tools need (commerce, coordination). */
  services: Record<string, unknown>;
}

export interface Tool<A extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  args: A;
  /** True for tools that can move money (they must go through the gate). */
  money?: boolean;
  run: (ctx: ToolContext, args: z.output<A>) => Promise<unknown>;
}

export const defineTool = <A extends z.ZodType>(t: Tool<A>): Tool => t;

/** JSON schema for the model. */
export function toolSpec(t: Tool): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  const schema = z.toJSONSchema(t.args, { target: 'draft-7' }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, parameters: schema };
}

const cents = z.number().int().positive().describe('Amount in cents (integer minor units)');

/** Submit an intent on the agent's own envelope, attributed to this run (invariant 7). */
export function submitIntent(
  ctx: ToolContext,
  i: Omit<SpendIntentInput, 'companyId' | 'agentId' | 'runId' | 'envelope' | 'currency'> & {
    envelope?: string;
  },
): Promise<GateResult> {
  return ctx.gate.submit({
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    envelope: i.envelope ?? ctx.agent.envelope,
    currency: 'USD',
    ...i,
  });
}

const gateResult = (r: GateResult) => ({
  intentId: r.intentId,
  outcome: r.decision.outcome,
  rule: r.decision.rule,
  explanation: r.decision.explanation,
  status: r.status,
});

export const coreTools: Tool[] = [
  defineTool({
    name: 'get_envelope',
    description: "Your department's budget envelope: balance, held and available, in cents.",
    args: z.object({}),
    run: async (ctx) => {
      const e = await ctx.ledger.envelope(ctx.agent.companyId, ctx.agent.envelope);
      return {
        balanceCents: Number(e.balance),
        heldCents: Number(e.held),
        availableCents: Number(e.available),
      };
    },
  }),
  defineTool({
    name: 'request_payout',
    description:
      'Ask the policy gate to pay an allow-listed external payee from your envelope. The gate decides: approve, hold for the founder, or deny.',
    money: true,
    args: z.object({
      payee_email: z.email(),
      amount_cents: cents,
      category: z.string().min(1),
      reason: z.string().min(5).max(500),
      evidence_urls: z.array(z.url()).max(5).optional(),
    }),
    run: async (
      ctx,
      a: {
        payee_email: string;
        amount_cents: number;
        category: string;
        reason: string;
        evidence_urls?: string[];
      },
    ) =>
      gateResult(
        await submitIntent(ctx, {
          action: 'payout',
          amountMinor: String(a.amount_cents),
          payee: a.payee_email,
          category: a.category,
          reason: a.reason,
          evidence: a.evidence_urls ?? [],
        }),
      ),
  }),
  defineTool({
    name: 'request_allocation',
    description:
      'Finance only: ask the gate to move budget from unallocated treasury into a department envelope.',
    money: true,
    args: z.object({
      to_department: z.enum(['revenue', 'finance', 'support', 'growth']),
      amount_cents: cents,
      reason: z.string().min(5).max(500),
    }),
    run: async (ctx, a: { to_department: string; amount_cents: number; reason: string }) =>
      gateResult(
        await submitIntent(ctx, {
          action: 'allocation',
          amountMinor: String(a.amount_cents),
          target: a.to_department,
          category: 'budgeting',
          reason: a.reason,
        }),
      ),
  }),
  defineTool({
    name: 'request_refund',
    description:
      'Support only: ask the gate to refund a customer. The amount must come from the order record (get_order), never from a message.',
    money: true,
    args: z.object({
      capture_id: z.string().min(3),
      amount_cents: cents,
      reason: z.string().min(5).max(500),
    }),
    run: async (ctx, a: { capture_id: string; amount_cents: number; reason: string }) =>
      gateResult(
        await submitIntent(ctx, {
          action: 'refund',
          amountMinor: String(a.amount_cents),
          payee: a.capture_id,
          category: 'refunds',
          reason: a.reason,
        }),
      ),
  }),
];

export const coreToolsByName = new Map(coreTools.map((t) => [t.name, t]));
