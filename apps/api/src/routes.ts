import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  agentControls,
  domainEvents,
  tasks as taskTable,
  agentRuns,
  agents,
  alerts,
  approvals,
  reconciliationRuns,
  spendIntents,
  type Database,
} from '@agpal/db';
import { pinAutonomy, trustRecord, type Services } from '@agpal/policy';
import { ScheduleService } from '@agpal/schedule';

export interface RouteDeps {
  db: Database;
  services: Services;
  companyId?: string;
  /** Server-to-server token the boardroom's server side sends. Never reaches a browser. */
  adminToken?: string;
  /** Server-side OpenAI key for the Studio CFO proxy (absent in the cloud dev environment, where the proxy injects it). */
  openaiApiKey?: string;
}

/** Cents → dollars for display in charts only. All money logic stays in bigint minor units (invariant 2). */
const usd = (cents: bigint | number | string | null | undefined): number =>
  Number(cents ?? 0) / 100;

function authorized(req: FastifyRequest, token: string | undefined): boolean {
  if (!token) return false;
  const got = req.headers['x-agpal-admin'];
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Read endpoints and founder gate endpoints for the boardroom (apps/web, Phase 4). Founder-only. */
export function registerReadRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
    if (!authorized(req, deps.adminToken)) {
      await reply.code(401).send({ error: 'unauthorized' });
      return undefined;
    }
    const companyId = (req.query as { company?: string }).company ?? deps.companyId;
    if (!companyId) {
      await reply.code(503).send({ error: 'AGPAL_COMPANY_ID not set' });
      return undefined;
    }
    return companyId;
  };

  app.get('/api/boardroom', async (req, reply) => {
    const co = await guard(req, reply);
    if (!co) return reply;
    return boardroomData(deps, co);
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/api/approvals/:id/approve',
    async (req, reply) => {
      const co = await guard(req, reply);
      if (!co) return reply;
      const [apr] = await deps.db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, req.params.id), eq(approvals.companyId, co)));
      if (!apr) return reply.code(404).send({ error: 'not found' });
      // The gate re-checks every deny rule before executing (an approval can still be blocked).
      const r = await deps.services.gate.approve(apr.id, 'founder', req.body.note ?? '');
      return { status: r.status, rule: r.decision.rule, explanation: r.decision.explanation };
    },
  );

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/api/approvals/:id/reject',
    async (req, reply) => {
      const co = await guard(req, reply);
      if (!co) return reply;
      const [apr] = await deps.db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, req.params.id), eq(approvals.companyId, co)));
      if (!apr) return reply.code(404).send({ error: 'not found' });
      await deps.services.gate.reject(apr.id, 'founder', req.body.note ?? '');
      return { status: 'rejected' };
    },
  );

  /** Batch-approve small held items: every pending spend approval at or under `maxMinor` (deny rules re-checked each). */
  app.post<{ Body: { maxMinor: string; note?: string } }>(
    '/api/approvals/batch',
    async (req, reply) => {
      const co = await guard(req, reply);
      if (!co) return reply;
      if (!/^\d+$/.test(req.body.maxMinor))
        return reply.code(400).send({ error: 'maxMinor must be integer cents' });
      const max = BigInt(req.body.maxMinor);
      const pending = await deps.db
        .select()
        .from(approvals)
        .where(and(eq(approvals.companyId, co), eq(approvals.status, 'pending')));
      const results = [];
      for (const a of pending) {
        const i = a.intent as { amountMinor?: string };
        if (a.intentId.startsWith('prop_') || BigInt(i.amountMinor ?? '0') > max) continue;
        const r = await deps.services.gate.approve(
          a.id,
          'founder',
          req.body.note ?? 'batch-approved',
        );
        results.push({ approvalId: a.id, status: r.status, rule: r.decision.rule });
      }
      return { approved: results };
    },
  );

  /** Founder pins an agent's autonomy level (0–4) or unpins it (null). */
  app.post<{ Params: { id: string }; Body: { level: number | null } }>(
    '/api/agents/:id/pin',
    async (req, reply) => {
      const co = await guard(req, reply);
      if (!co) return reply;
      const level = req.body.level;
      if (level !== null && (!Number.isInteger(level) || level < 0 || level > 4))
        return reply.code(400).send({ error: 'level must be 0-4 or null' });
      await pinAutonomy(deps.db, co, req.params.id, level);
      return { agentId: req.params.id, pinned: level };
    },
  );

  app.post<{ Body: { on: boolean } }>('/api/kill-switch', async (req, reply) => {
    const co = await guard(req, reply);
    if (!co) return reply;
    await deps.services.gate.setKillSwitch(co, req.body.on, 'founder');
    return { killSwitch: req.body.on };
  });
  // ── Bryntum time views: the browser only displays the server's computed dates ──────────────────
  app.get('/api/schedule', async (req, reply) => {
    const co = await guard(req, reply);
    if (!co) return reply;
    return new ScheduleService(deps.db).crudLoad(co);
  });
  /** Edits from the browser Gantt go through the same server path as agents (engine recalculates on the server). */
  app.post<{
    Body: { taskId: string; constraintDate?: string; receivedOn?: string; reason?: string };
  }>('/api/schedule/change', async (req, reply) => {
    const co = await guard(req, reply);
    if (!co) return reply;
    const b = req.body;
    const change = b.receivedOn
      ? { kind: 'mark_received' as const, taskId: b.taskId, receivedAt: b.receivedOn.slice(0, 10) }
      : {
          kind: 'shift_payment' as const,
          taskId: b.taskId,
          newDate: (b.constraintDate ?? '').slice(0, 10),
        };
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(
        change.kind === 'mark_received' ? change.receivedAt : change.newDate,
      )
    )
      return reply.code(400).send({ error: 'date required' });
    const svc = new ScheduleService(deps.db);
    try {
      await svc.apply(co, change, {
        kind: 'founder',
        reason: b.reason ?? 'edited in the boardroom Gantt',
      });
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'invalid change' });
    }
    return svc.crudLoad(co);
  });

  // ── Boardroom CFO (AG Studio Agent Framework) ───────────────────────────────────────────────────
  /** LLM proxy for the in-browser Studio agents: the key stays on the server; models are allow-listed. */
  app.post('/api/ai/responses', async (req, reply) => {
    const co = await guard(req, reply);
    if (!co) return reply;
    const allowed = (process.env.AGPAL_CFO_MODELS ?? 'gpt-5-mini,gpt-5')
      .split(',')
      .map((m) => m.trim());
    const body = (req.body ?? {}) as Record<string, unknown>;
    const model =
      typeof body.model === 'string' && allowed.includes(body.model) ? body.model : allowed[0];
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // In the cloud dev environment the network proxy injects the key; elsewhere OPENAI_API_KEY is used.
        authorization: `Bearer ${deps.openaiApiKey ?? 'proxy-injected'}`,
      },
      body: JSON.stringify({ ...body, model, max_output_tokens: 16_000 }),
    });
    reply
      .code(upstream.status)
      .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
      .header('cache-control', 'no-store');
    return reply.send(upstream.body ? Readable.fromWeb(upstream.body) : '');
  });

  /** Read-only CFO tools. Nothing here moves money; a drafted SpendIntent is only returned, never submitted. */
  app.get<{ Params: { dept: string } }>('/api/cfo/envelope/:dept', async (req, reply) => {
    const co = await guard(req, reply);
    if (!co) return reply;
    const d = await boardroomData(deps, co);
    const dept = req.params.dept;
    const env = d.envelopes.find((e) => e.department === dept);
    const lines = d.ledger.filter((l) => l.account === `cash:envelope:${dept}`);
    const byFlow: Record<string, number> = {};
    for (const l of lines) byFlow[l.flow] = (byFlow[l.flow] ?? 0) + l.amount;
    const payouts = d.intents.filter((i) => i.envelope === dept && i.action === 'payout');
    return {
      envelope: env,
      movementsByFlow: byFlow,
      payouts: payouts.map((p) => ({
        amount: p.amount,
        payee: p.payee,
        decision: p.decision,
        rule: p.rule,
        status: p.status,
        reason: p.reason,
      })),
      denials: d.intents
        .filter((i) => i.envelope === dept && i.decision === 'deny')
        .map((i) => ({ rule: i.rule, explanation: i.explanation })),
    };
  });
  app.get('/api/cfo/compare', async (req, reply) => {
    const co = await guard(req, reply);
    if (!co) return reply;
    const d = await boardroomData(deps, co);
    return {
      departments: d.departments,
      envelopes: d.envelopes,
      agents: d.agents.map((a) => ({
        agent: a.title,
        department: a.department,
        aiCost: a.aiCost,
        runs: a.runs,
        trust: a.trustScore,
        level: a.autonomyLevel,
      })),
    };
  });
  app.get('/api/cfo/approvals', async (req, reply) => {
    const co = await guard(req, reply);
    if (!co) return reply;
    const d = await boardroomData(deps, co);
    return { held: d.approvals.filter((a) => a.status === 'pending') };
  });
  app.get('/api/cfo/reconciliation', async (req, reply) => {
    const co = await guard(req, reply);
    if (!co) return reply;
    const [run] = await deps.db
      .select()
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.companyId, co))
      .orderBy(desc(reconciliationRuns.createdAt))
      .limit(1);
    if (!run) return { latest: null };
    const report = run.report as {
      items?: { kind: string; detail: string; transactionId?: string }[];
    };
    return {
      latest: { at: run.createdAt.toISOString(), status: run.status },
      problems: (report.items ?? []).filter(
        (i) => !['matched', 'verified_live', 'pending', 'info'].includes(i.kind),
      ),
      pending: (report.items ?? []).filter(
        (i) => i.kind === 'pending' || i.kind === 'verified_live',
      ).length,
      howLagWorks:
        'Transaction Search trails real time by ~2-3h; items after its cutoff are pending or verified by id, never mismatches, until 24h old.',
    };
  });
}

/** Every boardroom data source, as plain rows (AG Studio sources). */
export async function boardroomData(deps: RouteDeps, co: string) {
  const { db, services } = deps;
  const postings = await db.execute<{
    entry_id: string;
    occurred_at: Date | string;
    flow: string;
    description: string;
    account: string;
    account_type: string;
    department: string | null;
    amount: string;
    agent_id: string | null;
    run_id: string | null;
    external_ref: string | null;
    reversal: boolean;
  }>(sql`
    SELECT j.id AS entry_id, j.occurred_at, j.flow, j.description, a.code AS account, a.type AS account_type,
      a.department_code AS department, p.amount_minor AS amount, j.agent_id, j.run_id, j.external_ref,
      (j.reverses_entry_id IS NOT NULL) AS reversal
    FROM postings p JOIN journal_entries j ON j.id = p.entry_id JOIN accounts a ON a.id = p.account_id
    WHERE j.company_id = ${co}
    ORDER BY j.occurred_at DESC, j.id
    LIMIT 5000`);
  const ledger = postings.rows.map((r) => ({
    entryId: r.entry_id,
    date: new Date(r.occurred_at).toISOString(),
    flow: r.flow,
    description: r.description,
    account: r.account,
    accountType: r.account_type,
    department: r.department ?? 'company',
    amount: usd(r.amount),
    debit: Number(r.amount) > 0 ? usd(r.amount) : 0,
    credit: Number(r.amount) < 0 ? -usd(r.amount) : 0,
    agentId: r.agent_id ?? '',
    runId: r.run_id ?? '',
    paypalRef: r.external_ref ?? '',
    status: r.reversal ? 'reversal' : 'posted',
  }));

  const envelopes = [];
  for (const d of ['revenue', 'finance', 'support', 'growth']) {
    const e = await services.ledger.envelope(co, d);
    const allocated = ledger
      .filter(
        (l) =>
          l.account === `cash:envelope:${d}` &&
          l.amount > 0 &&
          l.flow !== 'internal_invoice_settle',
      )
      .reduce((s, l) => s + l.amount, 0);
    envelopes.push({
      department: d,
      balance: usd(e.balance),
      held: usd(e.held),
      available: usd(e.available),
      allocated,
      spent: Math.max(0, allocated - usd(e.balance) - usd(e.held)),
    });
  }

  // P&L per department: income positive, costs negative.
  const pnl = new Map<
    string,
    {
      department: string;
      revenue: number;
      internalRevenue: number;
      refunds: number;
      contractors: number;
      internalSpend: number;
      aiCost: number;
      fees: number;
    }
  >();
  for (const l of ledger) {
    if (l.accountType !== 'revenue' && l.accountType !== 'expense') continue;
    const row = pnl.get(l.department) ?? {
      department: l.department,
      revenue: 0,
      internalRevenue: 0,
      refunds: 0,
      contractors: 0,
      internalSpend: 0,
      aiCost: 0,
      fees: 0,
    };
    const v = -l.amount;
    if (/^revenue:(sales|subscriptions)/.test(l.account)) row.revenue += v;
    else if (l.account.startsWith('revenue:internal')) row.internalRevenue += v;
    else if (l.account.startsWith('revenue:refunds')) row.refunds += v;
    else if (l.account.startsWith('expense:contractors')) row.contractors += v;
    else if (l.account.startsWith('expense:internal')) row.internalSpend += v;
    else if (l.account.startsWith('expense:ai_compute')) row.aiCost += v;
    else if (l.account === 'expense:paypal_fees') row.fees += v;
    pnl.set(l.department, row);
  }
  const departments = [...pnl.values()].map((r) => ({
    ...r,
    net:
      r.revenue +
      r.internalRevenue +
      r.refunds +
      r.contractors +
      r.internalSpend +
      r.aiCost +
      r.fees,
  }));

  const staff = await db.select().from(agents).where(eq(agents.companyId, co));
  const runs = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.companyId, co))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1000);
  const intents = await db
    .select()
    .from(spendIntents)
    .where(eq(spendIntents.companyId, co))
    .orderBy(desc(spendIntents.createdAt))
    .limit(2000);
  const controls = await db.select().from(agentControls).where(eq(agentControls.companyId, co));
  const agentRows = [];
  for (const a of staff) {
    const mine = intents.filter((i) => i.agentId === a.id);
    const ctl = controls.find((c) => c.agentId === a.id);
    const trust = await trustRecord(db, co, a.id, a.department);
    agentRows.push({
      autonomyLevel: ctl?.pinnedLevel ?? ctl?.autonomyLevel ?? 1,
      pinned: ctl?.pinnedLevel !== null && ctl?.pinnedLevel !== undefined,
      trustScore: trust.score,
      acceptedWork: trust.acceptedWork,
      reversals: trust.reversals,
      agentId: a.id,
      title: a.title,
      department: a.department,
      status: a.status,
      modelTier: a.modelTier,
      runs: runs.filter((r) => r.agentId === a.id).length,
      aiCost: runs
        .filter((r) => r.agentId === a.id)
        .reduce((s, r) => s + Number(r.costMicros) / 1_000_000, 0),
      intents: mine.length,
      approved: mine.filter((i) => i.decision === 'approve').length,
      held: mine.filter((i) => i.decision === 'hold_for_founder').length,
      denied: mine.filter((i) => i.decision === 'deny').length,
    });
  }
  const apr = await db
    .select()
    .from(approvals)
    .where(eq(approvals.companyId, co))
    .orderBy(desc(approvals.createdAt))
    .limit(500);
  const recon = await db
    .select()
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.companyId, co))
    .orderBy(desc(reconciliationRuns.createdAt))
    .limit(100);
  const openAlerts = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.companyId, co), isNull(alerts.resolvedAt)))
    .orderBy(desc(alerts.createdAt))
    .limit(200);
  const balances = await services.ledger.balances(co);
  let cash = 0;
  for (const [code, v] of balances)
    if (code.startsWith('cash:') && code !== 'cash:withheld:disputes') cash += usd(v);
  const weeklyBurn = departments.reduce(
    (s, d) => s + Math.min(0, d.contractors + d.aiCost + d.fees),
    0,
  );

  // Time views: disputes (with whether Support has worked on them), open commissioned tasks.
  const disputeEvents = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.companyId, co), eq(domainEvents.name, 'dispute.opened')));
  const supportRuns = runs.filter(
    (r) => staff.find((a) => a.id === r.agentId)?.department === 'support',
  );
  const disputes = disputeEvents.map((e) => {
    const p = e.payload as { disputeId?: string; dueDate?: string; amountMinor?: string };
    const worked = supportRuns.some(
      (r) =>
        r.startedAt > e.createdAt &&
        r.toolCalls.some((c) => ((c as { name?: string }).name ?? '').includes('dispute')),
    );
    return {
      disputeId: p.disputeId ?? e.id,
      openedAt: e.createdAt.toISOString(),
      dueDate: p.dueDate ?? '',
      amount: usd(p.amountMinor),
      worked,
    };
  });
  const openTasks = await db.select().from(taskTable).where(eq(taskTable.companyId, co));

  return {
    asOf: new Date().toISOString(),
    companyId: co,
    disputes,
    tasks: openTasks.map((t) => ({
      taskId: t.id,
      title: t.title,
      from: t.fromDepartment,
      to: t.contractorEmail ?? t.toDepartment,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      deadline: t.deadline?.toISOString() ?? '',
      budget: usd(t.budgetMinor),
    })),
    overview: [
      {
        cash,
        unallocated: usd(balances.get('cash:unallocated')),
        withheld: usd(balances.get('cash:withheld:disputes')),
        revenue: departments.reduce((s, d) => s + d.revenue, 0),
        aiCost: -departments.reduce((s, d) => s + d.aiCost, 0),
        approvalsWaiting: apr.filter((a) => a.status === 'pending').length,
        openAlerts: openAlerts.length,
        runwayWeeks: weeklyBurn < 0 ? Math.round((cash / -weeklyBurn) * 10) / 10 : null,
      },
    ],
    ledger,
    envelopes,
    departments,
    agents: agentRows,
    agentRuns: runs.map((r) => ({
      runId: r.id,
      agentId: r.agentId,
      department: staff.find((a) => a.id === r.agentId)?.department ?? '',
      status: r.status,
      trigger: r.trigger,
      startedAt: r.startedAt.toISOString(),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cost: Number(r.costMicros) / 1_000_000,
      toolCalls: r.toolCalls.length,
      summary: r.summary ?? '',
    })),
    intents: intents.map((i) => ({
      intentId: i.id,
      agentId: i.agentId,
      runId: i.runId,
      envelope: i.envelope,
      action: i.action,
      amount: usd(i.amountMinor),
      payee: i.payee ?? '',
      decision: i.decision,
      rule: i.rule,
      explanation: i.explanation,
      status: i.status,
      reason: i.reason,
      createdAt: i.createdAt.toISOString(),
    })),
    approvals: apr.map((a) => {
      const i = a.intent as {
        action?: string;
        amountMinor?: string;
        envelope?: string;
        payee?: string;
        agentId?: string;
        reason?: string;
        evidence?: string[];
      };
      return {
        approvalId: a.id,
        intentId: a.intentId,
        status: a.status,
        action: i.action ?? '',
        amount: usd(i.amountMinor),
        envelope: i.envelope ?? '',
        payee: i.payee ?? '',
        agentId: i.agentId ?? '',
        reason: i.reason ?? '',
        evidence: (i.evidence ?? []).join(' '),
        rule: a.rule,
        explanation: a.explanation,
        note: a.note ?? '',
        createdAt: a.createdAt.toISOString(),
      };
    }),
    reconciliation: recon.map((r) => ({
      runId: r.id,
      at: r.createdAt.toISOString(),
      status: r.status,
      matched: r.matched,
      pending: r.pending,
      missingInLedger: r.missingInLedger,
      missingInPaypal: r.missingInPaypal,
      amountMismatches: r.amountMismatches,
      suspense: r.suspenseItems,
    })),
    alerts: openAlerts.map((a) => ({
      alertId: a.id,
      kind: a.kind,
      severity: a.severity,
      message: a.message,
      at: a.createdAt.toISOString(),
    })),
  };
}

export type BoardroomData = Awaited<ReturnType<typeof boardroomData>>;
