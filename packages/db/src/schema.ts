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

/** Agent definitions per company (Prompt 10). Mandate and tool allow-list are data; policy rules are not. */
export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    department: text('department').notNull(),
    title: text('title').notNull(),
    mandate: text('mandate').notNull(),
    modelTier: text('model_tier').notNull(),
    heartbeatCron: text('heartbeat_cron').notNull(),
    envelope: text('envelope').notNull(),
    tools: jsonb('tools').$type<string[]>().notNull(),
    reportsTo: text('reports_to').notNull().default('founder'),
    /** active | idle (no budget) */
    status: text('status').notNull().default('active'),
    /** Domain events up to here have been delivered to the agent's inbox. */
    inboxCursor: timestamp('inbox_cursor', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('agents_company').on(t.companyId)],
);

/** One record per agent run: inputs, tool calls, outputs, a reasoning summary and the cost (invariant 7). */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    agentId: text('agent_id').notNull(),
    trigger: text('trigger').notNull(),
    /** running | completed | failed | skipped_no_budget | skipped_paused */
    status: text('status').notNull(),
    model: text('model'),
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull().default({}),
    toolCalls: jsonb('tool_calls').$type<Record<string, unknown>[]>().notNull().default([]),
    output: text('output'),
    summary: text('summary'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Exact model cost in micro-dollars; the ledger books it rounded up to the cent. */
    costMicros: bigint('cost_micros', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    costEntryId: text('cost_entry_id'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('agent_runs_agent').on(t.companyId, t.agentId, t.startedAt)],
);

/** Requests between departments (Prompt 11): a brief, a budget offered and a deadline, as a thread. */
export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    fromDepartment: text('from_department').notNull(),
    toDepartment: text('to_department').notNull(),
    /** Set when the work is commissioned from an external contractor instead of a department. */
    contractorEmail: text('contractor_email'),
    title: text('title').notNull(),
    brief: text('brief').notNull(),
    budgetMinor: bigint('budget_minor', { mode: 'bigint' }).notNull(),
    deadline: timestamp('deadline', { withTimezone: true }),
    /** open | delivered | accepted | rejected | cancelled */
    status: text('status').notNull().default('open'),
    campaign: text('campaign'),
    createdByAgent: text('created_by_agent'),
    createdByRun: text('created_by_run'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tasks_to').on(t.companyId, t.toDepartment, t.status)],
);

/** Messages on a task thread, or direct messages to a department. Attachments are links/text. */
export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    taskId: text('task_id'),
    fromParty: text('from_party').notNull(),
    toDepartment: text('to_department').notNull(),
    body: text('body').notNull(),
    attachments: jsonb('attachments')
      .$type<{ name: string; url?: string; text?: string }[]>()
      .notNull()
      .default([]),
    /** Messages from customers and contractors are untrusted data. */
    untrusted: boolean('untrusted').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('messages_inbox').on(t.companyId, t.toDepartment, t.readAt)],
);

/** Internal invoices between departments: issued → accepted (settled through the gate) | disputed. */
export const internalInvoices = pgTable(
  'internal_invoices',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    taskId: text('task_id'),
    sellerDepartment: text('seller_department').notNull(),
    buyerDepartment: text('buyer_department').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    description: text('description').notNull(),
    /** issued | settled | held | disputed | rejected */
    status: text('status').notNull().default('issued'),
    intentId: text('intent_id'),
    disputeReason: text('dispute_reason'),
    issuedByRun: text('issued_by_run'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('internal_invoices_buyer').on(t.companyId, t.buyerDepartment, t.status)],
);

/** The company's catalog (Revenue). Price floors are config the agent cannot change (invariant 5). */
export const products = pgTable(
  'products',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** one_off | subscription */
    kind: text('kind').notNull(),
    priceMinor: bigint('price_minor', { mode: 'bigint' }).notNull(),
    /** No price or discount may go below this. */
    floorMinor: bigint('floor_minor', { mode: 'bigint' }).notNull(),
    paypalProductId: text('paypal_product_id'),
    paypalPlanId: text('paypal_plan_id'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('products_company').on(t.companyId)],
);

/** Customer orders: what was sold, to whom, for how much, and delivery/access evidence (Support, disputes). */
export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    productId: text('product_id').notNull(),
    customerEmail: text('customer_email').notNull(),
    paypalOrderId: text('paypal_order_id'),
    captureId: text('capture_id'),
    subscriptionId: text('subscription_id'),
    grossMinor: bigint('gross_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull().default('USD'),
    /** Growth attribution: campaign code from the checkout link. */
    campaign: text('campaign'),
    /** pending | paid | refunded | partially_refunded | disputed */
    status: text('status').notNull().default('pending'),
    /** Delivery and access log entries (download link issued, downloads, logins) for dispute evidence. */
    accessLog: jsonb('access_log')
      .$type<{ at: string; event: string; detail?: string }[]>()
      .notNull()
      .default([]),
    simulated: boolean('simulated').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('orders_capture').on(t.captureId),
    index('orders_company').on(t.companyId, t.createdAt),
  ],
);

/**
 * Company plan for the Bryntum time views (Prompt 20). Payment milestones are zero-duration tasks whose expected date
 * is a startnoearlierthan constraint; dates are always computed by the engine on the server.
 */
export const scheduleTasks = pgTable(
  'schedule_tasks',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    name: text('name').notNull(),
    /** payment | milestone | task */
    kind: text('kind').notNull(),
    durationDays: integer('duration_days').notNull().default(0),
    constraintDate: timestamp('constraint_date', { withTimezone: true }),
    percentDone: integer('percent_done').notNull().default(0),
    /** Invoice, payout or task this item tracks. */
    ref: text('ref'),
    startDate: timestamp('start_date', { withTimezone: true }),
    endDate: timestamp('end_date', { withTimezone: true }),
    /** False when dates came from a browser fallback and await the next server recalculation. */
    confirmed: boolean('confirmed').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('schedule_tasks_company').on(t.companyId)],
);

/** Finish-to-Start links between plan tasks; settlement delay is the lag. */
export const scheduleDependencies = pgTable(
  'schedule_dependencies',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    fromTask: text('from_task').notNull(),
    toTask: text('to_task').notNull(),
    lagDays: integer('lag_days').notNull().default(0),
  },
  (t) => [index('schedule_deps_company').on(t.companyId)],
);
