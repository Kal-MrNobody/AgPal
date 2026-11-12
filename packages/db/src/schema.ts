import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Schema per docs/money-constitution.md. Money columns are bigint minor units (mode: 'bigint').
 * journal_entries and postings are append-only: triggers in the custom migration reject UPDATE and
 * DELETE, and a deferred constraint trigger rejects any entry whose postings do not sum to zero.
 */

const id = () => text('id').primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => bigint(name, { mode: 'bigint' });

export const accountType = pgEnum('account_type', [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
]);

/** How the ledger constrains an account's balance (positive = debit). */
export const balanceRule = pgEnum('balance_rule', ['non_negative', 'non_positive', 'any']);

export const companies = pgTable('companies', {
  id: id(),
  name: text('name').notNull(),
  currency: text('currency').notNull(),
  killSwitch: boolean('kill_switch').notNull().default(false),
  createdAt: createdAt(),
});

export const departments = pgTable(
  'departments',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('departments_company_code').on(t.companyId, t.code)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    code: text('code').notNull(),
    type: accountType('type').notNull(),
    rule: balanceRule('rule').notNull(),
    departmentCode: text('department_code'),
    currency: text('currency').notNull(),
    /** Cache of sum(postings). Updated in the same transaction as each posting, under a row lock. */
    balanceMinor: money('balance_minor')
      .notNull()
      .default(sql`0`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('accounts_company_code').on(t.companyId, t.code)],
);

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    description: text('description').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    agentId: text('agent_id'),
    runId: text('run_id'),
    reason: text('reason'),
    actor: text('actor').notNull(),
    reversesEntryId: text('reverses_entry_id'),
    /** PayPal id this entry books (capture, refund, payout item, dispute) — for reconciliation. */
    externalRef: text('external_ref'),
    flow: text('flow').notNull(),
    idempotencyKey: text('idempotency_key'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('journal_entries_idem').on(t.companyId, t.idempotencyKey),
    uniqueIndex('journal_entries_one_reversal').on(t.reversesEntryId),
    index('journal_entries_external_ref').on(t.companyId, t.externalRef),
    index('journal_entries_occurred').on(t.companyId, t.occurredAt),
  ],
);

export const postings = pgTable(
  'postings',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    entryId: text('entry_id')
      .notNull()
      .references(() => journalEntries.id),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    amountMinor: money('amount_minor').notNull(),
    currency: text('currency').notNull(),
  },
  (t) => [index('postings_entry').on(t.entryId), index('postings_account').on(t.accountId)],
);

export const envelopes = pgTable(
  'envelopes',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    departmentCode: text('department_code').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    currency: text('currency').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('envelopes_company_dept').on(t.companyId, t.departmentCode)],
);

export const holdStatus = pgEnum('hold_status', ['active', 'released', 'converted']);

export const holds = pgTable(
  'holds',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    envelopeId: text('envelope_id')
      .notNull()
      .references(() => envelopes.id),
    amountMinor: money('amount_minor').notNull(),
    currency: text('currency').notNull(),
    status: holdStatus('status').notNull().default('active'),
    reference: text('reference').notNull(),
    convertedEntryId: text('converted_entry_id'),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('holds_envelope_active')
      .on(t.envelopeId)
      .where(sql`status = 'active'`),
    uniqueIndex('holds_reference').on(t.companyId, t.reference),
  ],
);

export const payees = pgTable(
  'payees',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    paypalEmail: text('paypal_email'),
    allowlisted: boolean('allowlisted').notNull().default(false),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payees_company_email').on(t.companyId, t.paypalEmail)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    scope: text('scope').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').notNull().default('in_flight'),
    response: jsonb('response'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('idempotency_keys_pk').on(t.companyId, t.scope, t.key)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    companyId: text('company_id').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    agentId: text('agent_id'),
    runId: text('run_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_subject').on(t.companyId, t.subjectType, t.subjectId)],
);

/** Policy-gate decisions held for the founder (Prompt 4). */
export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    intentId: text('intent_id').notNull(),
    intent: jsonb('intent').$type<Record<string, unknown>>().notNull(),
    rule: text('rule').notNull(),
    explanation: text('explanation').notNull(),
    status: text('status').notNull().default('pending'),
    decidedBy: text('decided_by'),
    note: text('note'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('approvals_intent').on(t.intentId)],
);

/** Every intent the gate has seen, with its decision and execution outcome. */
export const spendIntents = pgTable(
  'spend_intents',
  {
    id: id(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    agentId: text('agent_id').notNull(),
    runId: text('run_id').notNull(),
    envelope: text('envelope').notNull(),
    action: text('action').notNull(),
    amountMinor: money('amount_minor').notNull(),
    currency: text('currency').notNull(),
    payee: text('payee'),
    reason: text('reason').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    decision: text('decision').notNull(),
    rule: text('rule').notNull(),
    explanation: text('explanation').notNull(),
    status: text('status').notNull(),
    holdId: text('hold_id'),
    externalRef: text('external_ref'),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('spend_intents_velocity').on(t.companyId, t.agentId, t.action, t.createdAt),
    index('spend_intents_envelope').on(t.companyId, t.envelope, t.createdAt),
  ],
);

export const policyConfigs = pgTable('policy_configs', {
  companyId: text('company_id')
    .primaryKey()
    .references(() => companies.id),
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentControls = pgTable('agent_controls', {
  companyId: text('company_id').notNull(),
  agentId: text('agent_id').primaryKey(),
  paused: boolean('paused').notNull().default(false),
  autonomyLevel: integer('autonomy_level').notNull().default(1),
  pinnedLevel: integer('pinned_level'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Raw PayPal webhook events, deduplicated by PayPal's event id (Prompt 7). */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    eventType: text('event_type').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    verified: boolean('verified').notNull(),
    /** received | processed | ignored | suspense | failed */
    status: text('status').notNull().default('received'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [index('webhook_events_status').on(t.status, t.receivedAt)],
);

/** Alerts for the boardroom: suspense items, reconciliation mismatches, failed payouts. */
export const alerts = pgTable(
  'alerts',
  {
    id: id(),
    companyId: text('company_id').notNull(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull().default('warning'),
    message: text('message').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('alerts_open').on(t.companyId, t.resolvedAt)],
);

/**
 * Internal domain events (revenue.received, payout.failed, dispute.opened, invoice.overdue, …). Agents wake on
 * them. Deduplicated by `dedupe_key` so replays never double-publish.
 */
export const domainEvents = pgTable(
  'domain_events',
  {
    id: id(),
    companyId: text('company_id').notNull(),
    name: text('name').notNull(),
    department: text('department'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text('dedupe_key').notNull(),
    /** Simulated events (PayPal webhook simulator) are marked so the ledger and reports can tell. */
    simulated: boolean('simulated').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('domain_events_dedupe').on(t.companyId, t.dedupeKey),
    index('domain_events_name').on(t.companyId, t.name, t.createdAt),
  ],
);

/** Reconciliation runs (Prompt 8). */
export const reconciliationRuns = pgTable(
  'reconciliation_runs',
  {
    id: id(),
    companyId: text('company_id').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    matched: integer('matched').notNull().default(0),
    missingInLedger: integer('missing_in_ledger').notNull().default(0),
    missingInPaypal: integer('missing_in_paypal').notNull().default(0),
    pending: integer('pending').notNull().default(0),
    amountMismatches: integer('amount_mismatches').notNull().default(0),
    suspenseItems: integer('suspense_items').notNull().default(0),
    balanceDiffMinor: money('balance_diff_minor'),
    report: jsonb('report').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('reconciliation_runs_company').on(t.companyId, t.createdAt)],
);
