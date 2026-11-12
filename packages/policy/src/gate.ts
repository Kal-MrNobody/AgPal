import { and, eq, gte, inArray, ne, sql, sum, count } from 'drizzle-orm';
import {
  agentControls,
  approvals,
  auditLog,
  companies,
  domainEvents,
  payees,
  policyConfigs,
  spendIntents,
  type Database,
  type DbOrTx,
  type Tx,
} from '@agpal/db';
import { ACC, type Ledger } from '@agpal/ledger';
import { newId, type Currency } from '@agpal/shared';
import { defaultPolicyConfig, parsePolicyConfig, type PolicyConfig } from './config.js';
import {
  spendIntentSchema,
  type Decision,
  type SpendIntent,
  type SpendIntentInput,
} from './intent.js';
import type { PaymentsPort } from './ports.js';
import { decide, drawsOnEnvelope, movesNoMoney, type Facts } from './rules.js';

export type IntentStatus =
  'denied' | 'held' | 'approved' | 'executed' | 'pending' | 'failed' | 'rejected';

export interface GateResult {
  intentId: string;
  decision: Decision;
  status: IntentStatus;
  approvalId?: string;
  externalRef?: string;
  error?: string;
}

export interface GateOptions {
  now?: () => Date;
}

const ACTIVE_STATUSES: IntentStatus[] = ['held', 'approved', 'executed', 'pending'];

/** Payee key used in ledger account codes: `liability:payable:payee_<id>`. */
const payeeKey = (payeeId: string) => payeeId;

/**
 * The gate (invariant 1). Every money action enters here as a SpendIntent, is decided by deterministic
 * config-driven rules, recorded (spend_intents + audit_log), reserved in the ledger (hold) and only then
 * executed through the PaymentsPort.
 */
export class Gate {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    private readonly ledger: Ledger,
    private readonly payments: PaymentsPort,
    opts: GateOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async config(companyId: string, db: DbOrTx = this.db): Promise<PolicyConfig> {
    const [row] = await db
      .select()
      .from(policyConfigs)
      .where(eq(policyConfigs.companyId, companyId));
    return parsePolicyConfig(row?.config ?? defaultPolicyConfig);
  }

  /** Founder-only. Validates before saving. */
  async setConfig(companyId: string, raw: unknown, by: string): Promise<void> {
    parsePolicyConfig(raw);
    await this.db
      .insert(policyConfigs)
      .values({ companyId, config: raw as Record<string, unknown> })
      .onConflictDoUpdate({
        target: policyConfigs.companyId,
        set: { config: raw as Record<string, unknown>, updatedAt: this.now() },
      });
    await this.audit(this.db, companyId, by, 'policy.config_set', 'company', companyId, {});
  }

  async setKillSwitch(companyId: string, on: boolean, by: string): Promise<void> {
    await this.db.update(companies).set({ killSwitch: on }).where(eq(companies.id, companyId));
    await this.audit(
      this.db,
      companyId,
      by,
      on ? 'kill_switch.on' : 'kill_switch.off',
      'company',
      companyId,
      {},
    );
  }

  async setAgentPaused(
    companyId: string,
    agentId: string,
    paused: boolean,
    by: string,
  ): Promise<void> {
    await this.db
      .insert(agentControls)
      .values({ companyId, agentId, paused })
      .onConflictDoUpdate({
        target: agentControls.agentId,
        set: { paused, updatedAt: this.now() },
      });
    await this.audit(
      this.db,
      companyId,
      by,
      paused ? 'agent.paused' : 'agent.resumed',
      'agent',
      agentId,
      {},
    );
  }

  async setAutonomyLevel(
    companyId: string,
    agentId: string,
    level: number,
    by: string,
  ): Promise<void> {
    await this.db
      .insert(agentControls)
      .values({ companyId, agentId, autonomyLevel: level })
      .onConflictDoUpdate({
        target: agentControls.agentId,
        set: { autonomyLevel: level, updatedAt: this.now() },
      });
    await this.audit(this.db, companyId, by, 'agent.autonomy_set', 'agent', agentId, { level });
  }

  /** Founder-only: add a payee to the allow-list. Returns the payee id. */
  async allowPayee(companyId: string, email: string, name: string, by: string): Promise<string> {
    const normalized = email.trim().toLowerCase();
    const [existing] = await this.db
      .select()
      .from(payees)
      .where(and(eq(payees.companyId, companyId), eq(payees.paypalEmail, normalized)));
    const id = existing?.id ?? newId('payee');
    if (existing) {
      await this.db
        .update(payees)
        .set({ allowlisted: true, approvedAt: this.now() })
        .where(eq(payees.id, id));
    } else {
      await this.db.insert(payees).values({
        id,
        companyId,
        name,
        kind: 'contractor',
        paypalEmail: normalized,
        allowlisted: true,
        approvedAt: this.now(),
      });
    }
    await this.audit(this.db, companyId, by, 'payee.allowlisted', 'payee', id, { name });
    return id;
  }

  /** Submit an intent: decide, record, reserve, execute. */
  async submit(raw: SpendIntentInput): Promise<GateResult> {
    const intent = spendIntentSchema.parse(raw);
    const intentId = newId('int');
    const recorded = await this.db.transaction(async (tx) => {
      await this.lock(tx, intent);
      const config = await this.config(intent.companyId, tx);
      const facts = await this.gatherFacts(tx, config, intent);
      const decision = decide(config, intent, facts);
      const status: IntentStatus =
        decision.outcome === 'deny'
          ? 'denied'
          : decision.outcome === 'hold_for_founder'
            ? 'held'
            : 'approved';

      let holdId: string | null = null;
      if (decision.outcome !== 'deny' && drawsOnEnvelope(intent.action)) {
        const fee = intent.action === 'payout' ? config.payoutFeeBufferMinor : 0n;
        holdId = await this.ledger.placeHold(
          intent.companyId,
          intent.envelope,
          intent.amountMinor + fee,
          intentId,
          tx,
        );
      }
      await tx.insert(spendIntents).values({
        id: intentId,
        companyId: intent.companyId,
        agentId: intent.agentId,
        runId: intent.runId,
        envelope: intent.envelope,
        action: intent.action,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        payee: intent.payee ?? null,
        reason: intent.reason,
        payload: {
          target: intent.target,
          category: intent.category,
          evidence: intent.evidence,
          details: intent.details,
        },
        decision: decision.outcome,
        rule: decision.rule,
        explanation: decision.explanation,
        status,
        holdId,
      });
      let approvalId: string | undefined;
      if (decision.outcome === 'hold_for_founder') {
        approvalId = newId('apr');
        await tx.insert(approvals).values({
          id: approvalId,
          companyId: intent.companyId,
          intentId,
          intent: serializeIntent(intent),
          rule: decision.rule,
          explanation: decision.explanation,
        });
      }
      await this.audit(
        tx,
        intent.companyId,
        intent.agentId,
        `gate.${decision.outcome}`,
        'spend_intent',
        intentId,
        {
          rule: decision.rule,
          explanation: decision.explanation,
          action: intent.action,
          amountMinor: intent.amountMinor.toString(),
          envelope: intent.envelope,
        },
        intent.runId,
      );
      return { decision, status, holdId, approvalId };
    });

    const base: GateResult = {
      intentId,
      decision: recorded.decision,
      status: recorded.status,
      ...(recorded.approvalId ? { approvalId: recorded.approvalId } : {}),
    };
    if (recorded.status !== 'approved') return base;
    return { ...base, ...(await this.execute(intentId, intent, recorded.holdId)) };
  }

  /** Founder approves a held intent. Deny rules are re-checked first. */
  async approve(approvalId: string, by: string, note = ''): Promise<GateResult> {
    const prepared = await this.db.transaction(async (tx) => {
      const [apr] = await tx
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .for('update');
      if (!apr) throw new Error(`No approval ${approvalId}`);
      const [row] = await tx
        .select()
        .from(spendIntents)
        .where(eq(spendIntents.id, apr.intentId))
        .for('update');
      if (!row) throw new Error(`No intent ${apr.intentId}`);
      if (apr.status !== 'pending') {
        return { already: true as const, row };
      }
      const intent = deserializeIntent(apr.intent);
      await this.lock(tx, intent);
      const config = await this.config(intent.companyId, tx);
      const facts = await this.gatherFacts(tx, config, intent, row.id);
      // The intent's own hold already reserves its funds.
      if (row.holdId)
        facts.fundsAvailableMinor +=
          intent.amountMinor + (intent.action === 'payout' ? config.payoutFeeBufferMinor : 0n);
      const decision = decide(config, intent, { ...facts, founderApproved: true });
      const approved = decision.outcome === 'approve';
      await tx
        .update(approvals)
        .set({
          status: approved ? 'approved' : 'blocked',
          decidedBy: by,
          note,
          decidedAt: this.now(),
        })
        .where(eq(approvals.id, approvalId));
      await tx
        .update(spendIntents)
        .set({
          status: approved ? 'approved' : 'denied',
          decision: approved ? 'approve' : 'deny',
          rule: decision.rule,
          explanation: decision.explanation,
          updatedAt: this.now(),
        })
        .where(eq(spendIntents.id, row.id));
      if (!approved && row.holdId) await this.ledger.releaseHold(row.holdId, tx);
      await this.publishDecision(
        tx,
        intent.companyId,
        row.id,
        intent.envelope,
        approved ? 'approved' : `blocked: ${decision.rule}`,
        note,
      );
      await this.audit(
        tx,
        intent.companyId,
        by,
        approved ? 'founder.approved' : 'founder.approval_blocked',
        'spend_intent',
        row.id,
        {
          note,
          rule: decision.rule,
        },
      );
      return { already: false as const, row, intent, decision, approved };
    });
    if (prepared.already) {
      return {
        intentId: prepared.row.id,
        decision: toDecision(prepared.row),
        status: prepared.row.status as IntentStatus,
      };
    }
    const base: GateResult = {
      intentId: prepared.row.id,
      decision: prepared.decision,
      status: prepared.approved ? 'approved' : 'denied',
      approvalId,
    };
    if (!prepared.approved) return base;
    return {
      ...base,
      ...(await this.execute(prepared.row.id, prepared.intent, prepared.row.holdId)),
    };
  }

  /** Tell the requesting department how the founder decided (the agent reads it on its next run). */
  private async publishDecision(
    db: DbOrTx,
    companyId: string,
    intentId: string,
    department: string,
    outcome: string,
    note: string,
  ): Promise<void> {
    await db
      .insert(domainEvents)
      .values({
        id: newId('evt'),
        companyId,
        name: 'approval.decided',
        department,
        dedupeKey: `approval:${intentId}`,
        payload: { intentId, outcome, note },
      })
      .onConflictDoNothing();
  }

  /** Founder denies a held intent. */
  async reject(approvalId: string, by: string, note = ''): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [apr] = await tx
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .for('update');
      if (apr?.status !== 'pending') return;
      const [row] = await tx
        .select()
        .from(spendIntents)
        .where(eq(spendIntents.id, apr.intentId))
        .for('update');
      await tx
        .update(approvals)
        .set({ status: 'rejected', decidedBy: by, note, decidedAt: this.now() })
        .where(eq(approvals.id, approvalId));
      await tx
        .update(spendIntents)
        .set({ status: 'rejected', updatedAt: this.now() })
        .where(eq(spendIntents.id, apr.intentId));
      if (row?.holdId) await this.ledger.releaseHold(row.holdId, tx);
      if (row)
        await this.publishDecision(tx, apr.companyId, apr.intentId, row.envelope, 'rejected', note);
      await this.audit(tx, apr.companyId, by, 'founder.rejected', 'spend_intent', apr.intentId, {
        note,
      });
    });
  }

  /** Execute an approved intent: call the provider (idempotently) and book the ledger flow. */
  private async execute(
    intentId: string,
    intent: SpendIntent,
    holdId: string | null,
  ): Promise<Partial<GateResult>> {
    try {
      const result = await this.book(intentId, intent, holdId);
      await this.db
        .update(spendIntents)
        .set({
          status: result.status,
          externalRef: result.externalRef ?? null,
          updatedAt: this.now(),
        })
        .where(eq(spendIntents.id, intentId));
      await this.audit(
        this.db,
        intent.companyId,
        'system',
        `execute.${result.status}`,
        'spend_intent',
        intentId,
        {
          externalRef: result.externalRef,
        },
        intent.runId,
      );
      return result;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // The provider call may or may not have happened. Keep the hold: the intent is retried with the same
      // idempotency key (sender_batch_id / PayPal-Request-Id), never re-decided.
      await this.db
        .update(spendIntents)
        .set({ status: 'failed', error, updatedAt: this.now() })
        .where(eq(spendIntents.id, intentId));
      await this.audit(
        this.db,
        intent.companyId,
        'system',
        'execute.failed',
        'spend_intent',
        intentId,
        { error },
        intent.runId,
      );
      return { status: 'failed', error };
    }
  }

  /** Retry a failed execution with the same idempotency key. */
  async retry(intentId: string): Promise<Partial<GateResult>> {
    const [row] = await this.db.select().from(spendIntents).where(eq(spendIntents.id, intentId));
    if (row?.status !== 'failed') throw new Error(`Intent ${intentId} is not failed`);
    return this.execute(intentId, rowToIntent(row), row.holdId);
  }

  /** Give up on a failed intent: release its hold. Only safe once the provider confirms nothing moved. */
  async abandon(intentId: string, by: string): Promise<void> {
    const [row] = await this.db.select().from(spendIntents).where(eq(spendIntents.id, intentId));
    if (row?.status !== 'failed') throw new Error(`Intent ${intentId} is not failed`);
    if (row.holdId) await this.ledger.releaseHold(row.holdId);
    await this.db
      .update(spendIntents)
      .set({ status: 'rejected', updatedAt: this.now() })
      .where(eq(spendIntents.id, intentId));
    await this.audit(this.db, row.companyId, by, 'execute.abandoned', 'spend_intent', intentId, {});
  }

  private async book(
    intentId: string,
    intent: SpendIntent,
    holdId: string | null,
  ): Promise<{ status: IntentStatus; externalRef?: string }> {
    const attribution = { agentId: intent.agentId, runId: intent.runId, reason: intent.reason };
    const base = {
      companyId: intent.companyId,
      currency: intent.currency,
      actor: 'agent',
      attribution,
    };
    switch (intent.action) {
      case 'allocation': {
        const target = intent.target ?? '';
        await this.ledger.post({
          ...base,
          description: `Allocation to ${target}: ${intent.reason}`,
          flow: 'allocation',
          postings: [
            { account: ACC.envelope(target), amountMinor: intent.amountMinor },
            { account: ACC.unallocated, amountMinor: -intent.amountMinor },
          ],
          idempotencyKey: `intent:${intentId}`,
          metadata: { intentId },
        });
        return { status: 'executed' };
      }
      case 'internal_invoice': {
        if (!holdId) throw new Error('internal invoice without hold');
        const seller = intent.target ?? '';
        await this.ledger.convertHold(holdId, {
          ...base,
          description: `Internal invoice ${intent.envelope} → ${seller}: ${intent.reason}`,
          flow: 'internal_invoice_settle',
          postings: [
            { account: ACC.internalExpense(intent.envelope), amountMinor: intent.amountMinor },
            { account: ACC.internalRevenue(seller), amountMinor: -intent.amountMinor },
            { account: ACC.envelope(seller), amountMinor: intent.amountMinor },
            { account: ACC.envelope(intent.envelope), amountMinor: -intent.amountMinor },
          ],
          idempotencyKey: `intent:${intentId}`,
          metadata: { intentId, ...intent.details },
        });
        return { status: 'executed' };
      }
      case 'payout': {
        if (!holdId) throw new Error('payout without hold');
        const payee = await this.payeeByEmail(intent.companyId, intent.payee ?? '');
        if (!payee) throw new Error('payee vanished');
        const result = await this.payments.payout({
          senderBatchId: intentId,
          receiverEmail: payee.paypalEmail ?? '',
          amountMinor: intent.amountMinor,
          currency: intent.currency,
          note: intent.reason.slice(0, 255),
        });
        const ref = result.itemId ?? result.batchId;
        if (result.feeMinor === undefined) {
          await this.db
            .update(spendIntents)
            .set({ externalRef: ref, status: 'pending' })
            .where(eq(spendIntents.id, intentId));
          return { status: 'pending', externalRef: ref };
        }
        await this.settlePayout(intentId, {
          itemId: ref,
          feeMinor: result.feeMinor,
          ...(result.transactionId ? { transactionId: result.transactionId } : {}),
        });
        return { status: 'executed', externalRef: ref };
      }
      case 'refund': {
        const captureId = intent.payee ?? '';
        const r = await this.payments.refund({
          captureId,
          amountMinor: intent.amountMinor,
          currency: intent.currency,
          idempotencyKey: intentId,
          note: intent.reason.slice(0, 255),
        });
        await this.bookRefund(intent.companyId, intent.currency, captureId, r, {
          intentId,
          attribution,
        });
        return { status: 'executed', externalRef: r.refundId };
      }
      case 'price_change':
      case 'subscription_change':
        return { status: 'executed' };
    }
  }

  /** Book a refund (constitution §2.6). Idempotent on the refund id; also used by webhooks. */
  async bookRefund(
    companyId: string,
    currency: Currency,
    captureId: string,
    r: { refundId: string; grossMinor: bigint; feeReturnedMinor: bigint },
    opts: {
      intentId?: string;
      attribution?: { agentId: string; runId: string; reason: string };
    } = {},
  ): Promise<void> {
    const postings = [
      { account: ACC.refunds('revenue'), amountMinor: r.grossMinor },
      { account: ACC.unallocated, amountMinor: -(r.grossMinor - r.feeReturnedMinor) },
    ];
    if (r.feeReturnedMinor > 0n)
      postings.push({ account: ACC.paypalFees, amountMinor: -r.feeReturnedMinor });
    await this.ledger.post({
      companyId,
      currency,
      actor: opts.attribution ? 'agent' : 'system',
      ...(opts.attribution ? { attribution: opts.attribution } : {}),
      description: `Refund ${r.refundId} on capture ${captureId}`,
      flow: 'refund',
      postings,
      externalRef: r.refundId,
      idempotencyKey: `paypal:refund:${r.refundId}`,
      metadata: { captureId, ...(opts.intentId ? { intentId: opts.intentId } : {}) },
    });
  }

  /**
   * Book a payout once PayPal reports its fee (constitution §2.5): accrual + cash out, converting the hold.
   * Idempotent; called by the executor or by the payout webhook.
   */
  async settlePayout(
    intentId: string,
    p: { itemId: string; feeMinor: bigint; transactionId?: string },
  ): Promise<void> {
    const [row] = await this.db.select().from(spendIntents).where(eq(spendIntents.id, intentId));
    if (!row?.holdId) throw new Error(`No payout intent ${intentId}`);
    const payee = await this.payeeByEmail(row.companyId, row.payee ?? '');
    if (!payee) throw new Error('payee vanished');
    const currency = row.currency as Currency;
    const payable = await this.ledger.ensurePayable(row.companyId, payeeKey(payee.id), currency);
    const attribution = { agentId: row.agentId, runId: row.runId, reason: row.reason };
    await this.db.transaction(async (tx) => {
      await this.ledger.post(
        {
          companyId: row.companyId,
          currency,
          actor: 'agent',
          attribution,
          description: `Payout accrued to ${payee.name}: ${row.reason}`,
          flow: 'payout_accrual',
          postings: [
            { account: ACC.contractors(row.envelope), amountMinor: row.amountMinor },
            { account: payable, amountMinor: -row.amountMinor },
          ],
          idempotencyKey: `intent:${intentId}:accrual`,
          metadata: { intentId },
        },
        tx,
      );
      await this.ledger.convertHold(
        row.holdId ?? '',
        {
          companyId: row.companyId,
          currency,
          actor: 'agent',
          attribution,
          description: `Payout sent to ${payee.name} (item ${p.itemId})`,
          flow: 'payout_sent',
          postings: [
            { account: payable, amountMinor: row.amountMinor },
            ...(p.feeMinor > 0n ? [{ account: ACC.paypalFees, amountMinor: p.feeMinor }] : []),
            { account: ACC.envelope(row.envelope), amountMinor: -(row.amountMinor + p.feeMinor) },
          ],
          externalRef: p.itemId,
          idempotencyKey: `intent:${intentId}:sent`,
          metadata: {
            intentId,
            payoutItemId: p.itemId,
            senderBatchId: intentId,
            ...(p.transactionId ? { paypalTransactionId: p.transactionId } : {}),
          },
        },
        tx,
      );
      await tx
        .update(spendIntents)
        .set({ status: 'executed', externalRef: p.itemId, updatedAt: this.now() })
        .where(eq(spendIntents.id, intentId));
    });
  }

  /**
   * A payout failed or came back (constitution §2.5): reverse the cash-out and the accrual, release any hold and
   * mark the intent failed. Idempotent.
   */
  async payoutReversed(
    intentId: string,
    p: { itemId: string; status: string; reason: string },
  ): Promise<void> {
    const [row] = await this.db.select().from(spendIntents).where(eq(spendIntents.id, intentId));
    if (!row) throw new Error(`No payout intent ${intentId}`);
    const reason = `payout ${p.itemId} ${p.status}: ${p.reason}`;
    for (const suffix of ['sent', 'accrual']) {
      const entryId = await this.ledger.findEntry(row.companyId, `intent:${intentId}:${suffix}`);
      if (entryId) await this.ledger.reverse(row.companyId, entryId, reason, 'system');
    }
    if (row.holdId) await this.ledger.releaseHold(row.holdId);
    await this.db
      .update(spendIntents)
      .set({ status: 'failed', error: reason, updatedAt: this.now() })
      .where(eq(spendIntents.id, intentId));
    await this.audit(
      this.db,
      row.companyId,
      'system',
      'payout.reversed',
      'spend_intent',
      intentId,
      { itemId: p.itemId, status: p.status },
    );
  }

  private payeeByEmail(companyId: string, email: string) {
    return this.db
      .select()
      .from(payees)
      .where(
        and(eq(payees.companyId, companyId), eq(payees.paypalEmail, email.trim().toLowerCase())),
      )
      .then((r) => r[0]);
  }

  /** Serialize decisions per envelope and per agent so caps and velocity cannot be raced. */
  private async lock(tx: Tx, intent: SpendIntent): Promise<void> {
    const keys = [
      `env:${intent.companyId}:${intent.envelope}`,
      `agent:${intent.companyId}:${intent.agentId}`,
    ].sort();
    for (const k of keys)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`);
  }

  private async gatherFacts(
    tx: Tx,
    config: PolicyConfig,
    intent: SpendIntent,
    excludeIntentId?: string,
  ): Promise<Facts> {
    const [company] = await tx
      .select({ kill: companies.killSwitch })
      .from(companies)
      .where(eq(companies.id, intent.companyId));
    if (!company) throw new Error(`Unknown company ${intent.companyId}`);
    const [ctl] = await tx
      .select()
      .from(agentControls)
      .where(eq(agentControls.agentId, intent.agentId));
    const rules = config.envelopes[intent.envelope];
    const now = this.now();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const windowStart = new Date(now.getTime() - (rules?.velocity.windowMinutes ?? 60) * 60_000);
    const exclude = excludeIntentId ? ne(spendIntents.id, excludeIntentId) : undefined;

    const [today] = await tx
      .select({ total: sum(spendIntents.amountMinor) })
      .from(spendIntents)
      .where(
        and(
          eq(spendIntents.companyId, intent.companyId),
          eq(spendIntents.envelope, intent.envelope),
          eq(spendIntents.action, intent.action),
          inArray(spendIntents.status, ACTIVE_STATUSES),
          gte(spendIntents.createdAt, dayStart),
          exclude,
        ),
      );
    const [recent] = await tx
      .select({ n: count() })
      .from(spendIntents)
      .where(
        and(
          eq(spendIntents.companyId, intent.companyId),
          eq(spendIntents.agentId, intent.agentId),
          eq(spendIntents.action, intent.action),
          inArray(spendIntents.status, ACTIVE_STATUSES),
          gte(spendIntents.createdAt, windowStart),
          exclude,
        ),
      );

    let fundsAvailableMinor = 0n;
    if (!movesNoMoney(intent.action)) {
      fundsAvailableMinor = drawsOnEnvelope(intent.action)
        ? ((await this.envelopeAvailable(tx, intent.companyId, intent.envelope)) ?? 0n)
        : await this.accountBalance(tx, intent.companyId, ACC.unallocated);
    }

    let payeeAllowlisted = false;
    let payeeHasPriorPayout = false;
    if (intent.action === 'payout' && intent.payee) {
      const email = intent.payee.trim().toLowerCase();
      const [p] = await tx
        .select()
        .from(payees)
        .where(and(eq(payees.companyId, intent.companyId), eq(payees.paypalEmail, email)));
      payeeAllowlisted = p?.allowlisted ?? false;
      const [prior] = await tx
        .select({ n: count() })
        .from(spendIntents)
        .where(
          and(
            eq(spendIntents.companyId, intent.companyId),
            eq(spendIntents.action, 'payout'),
            eq(spendIntents.payee, intent.payee),
            eq(spendIntents.status, 'executed'),
          ),
        );
      payeeHasPriorPayout = (prior?.n ?? 0) > 0;
    }

    const facts: Facts = {
      companyKillSwitch: company.kill,
      agentPaused: ctl?.paused ?? false,
      autonomyLevel: ctl?.pinnedLevel ?? ctl?.autonomyLevel ?? 1,
      fundsAvailableMinor,
      spentTodayMinor: BigInt(today?.total ?? '0'),
      recentCount: recent?.n ?? 0,
      payeeAllowlisted,
      payeeHasPriorPayout,
    };
    if (intent.action === 'refund' && intent.payee) {
      const refundable = await this.refundable(tx, intent.companyId, intent.payee, excludeIntentId);
      if (refundable !== undefined) facts.refundableMinor = refundable;
    }
    return facts;
  }

  private async envelopeAvailable(
    tx: Tx,
    companyId: string,
    dept: string,
  ): Promise<bigint | undefined> {
    const res = await tx.execute<{ available: string | null }>(sql`
      SELECT a.balance_minor - coalesce((SELECT sum(h.amount_minor) FROM holds h WHERE h.envelope_id = e.id AND h.status = 'active'), 0) AS available
      FROM envelopes e JOIN accounts a ON a.id = e.account_id
      WHERE e.company_id = ${companyId} AND e.department_code = ${dept}`);
    const v = res.rows[0]?.available;
    return v === undefined || v === null ? undefined : BigInt(v);
  }

  private async accountBalance(tx: Tx, companyId: string, code: string): Promise<bigint> {
    const res = await tx.execute<{ b: string }>(
      sql`SELECT balance_minor AS b FROM accounts WHERE company_id = ${companyId} AND code = ${code}`,
    );
    return BigInt(res.rows[0]?.b ?? '0');
  }

  /** Captured gross on the capture minus refunds booked and refund intents in flight. */
  private async refundable(
    tx: Tx,
    companyId: string,
    captureId: string,
    excludeIntentId?: string,
  ): Promise<bigint | undefined> {
    const res = await tx.execute<{
      gross: string | null;
      refunded: string | null;
      inflight: string | null;
    }>(sql`
      SELECT
        (SELECT -sum(p.amount_minor) FROM journal_entries j JOIN postings p ON p.entry_id = j.id JOIN accounts a ON a.id = p.account_id
          WHERE j.company_id = ${companyId} AND j.flow = 'capture' AND j.external_ref = ${captureId} AND a.type = 'revenue') AS gross,
        (SELECT sum(p.amount_minor) FROM journal_entries j JOIN postings p ON p.entry_id = j.id JOIN accounts a ON a.id = p.account_id
          WHERE j.company_id = ${companyId} AND j.flow = 'refund' AND j.metadata->>'captureId' = ${captureId} AND a.code LIKE 'revenue:refunds:%') AS refunded,
        (SELECT sum(amount_minor) FROM spend_intents
          WHERE company_id = ${companyId} AND action = 'refund' AND payee = ${captureId} AND status IN ('held', 'approved', 'pending', 'failed')
          ${excludeIntentId ? sql`AND id <> ${excludeIntentId}` : sql``}) AS inflight`);
    const row = res.rows[0];
    if (!row?.gross) return undefined;
    return BigInt(row.gross) - BigInt(row.refunded ?? '0') - BigInt(row.inflight ?? '0');
  }

  private async audit(
    db: DbOrTx,
    companyId: string,
    actor: string,
    action: string,
    subjectType: string,
    subjectId: string,
    data: Record<string, unknown>,
    runId?: string,
  ): Promise<void> {
    await db.insert(auditLog).values({
      companyId,
      actor,
      action,
      subjectType,
      subjectId,
      agentId: runId ? actor : null,
      runId: runId ?? null,
      data,
    });
  }
}

function serializeIntent(i: SpendIntent): Record<string, unknown> {
  return { ...i, amountMinor: i.amountMinor.toString() };
}

function deserializeIntent(raw: Record<string, unknown>): SpendIntent {
  return spendIntentSchema.parse(raw);
}

function rowToIntent(row: typeof spendIntents.$inferSelect): SpendIntent {
  const payload = row.payload as {
    target?: string;
    category?: string;
    evidence?: string[];
    details?: Record<string, unknown>;
  };
  return spendIntentSchema.parse({
    companyId: row.companyId,
    agentId: row.agentId,
    runId: row.runId,
    envelope: row.envelope,
    action: row.action,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    payee: row.payee ?? undefined,
    target: payload.target,
    category: payload.category,
    reason: row.reason,
    evidence: payload.evidence ?? [],
    details: payload.details ?? {},
  });
}

function toDecision(row: typeof spendIntents.$inferSelect): Decision {
  return {
    outcome: row.decision as Decision['outcome'],
    rule: row.rule,
    explanation: row.explanation,
  };
}
