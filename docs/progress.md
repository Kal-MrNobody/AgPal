# Progress log

Dated, newest last. Append at the end of every task.

## 2026-11-12 — Toolchain and plugin check

- Node 22.23, pnpm 12.18 (corepack), Docker 29.9 + compose v5.6, cloudflared 2026.10.7, git 2.43.
- APIMatic Context Plugin read from GitHub (install via npx was blocked in the cloud session).
  SDK `@paypal/paypal-server-sdk@2.5.0` covers Orders, Payments, Subscriptions, Transaction Search,
  Vault, OAuth. Needs thin REST: Catalog products, Invoicing, Payouts, Disputes, webhook verification.
- PayPal sandbox OAuth verified (HTTP 200); app scopes include invoicing, payouts, subscriptions,
  disputes, reporting search and webhooks.

## 2026-11-12 — Prompt 1: Scaffold and invariants (Phase 0)

Done:

- Monorepo: pnpm workspaces + Turborepo, strict TS 6.0, ESLint 10 (strict-type-checked) + Prettier,
  Vitest 5 in all 9 workspaces (32 tests incl. fast-check properties).
- `apps/web` (Next 16 shell, builds), `apps/api` (Fastify `/health`, log redaction),
  `apps/worker` (pg-boss queue registry).
- `packages/shared`: bigint `Money` + PayPal decimal conversion, zod `loadEnv()`, `Secret`,
  idempotency key + attribution types. `packages/ledger`: `assertBalanced`, `reversalOf`.
  `packages/policy`: `SpendIntent` schema + `Decision` type. `packages/paypal`, `agents`, `db`:
  contracts and clients only.
- docker-compose Postgres 17 (healthcheck), `.env.example`, CI (typecheck, lint, format, test),
  `.claude/settings.json` denying `.env*` reads.
- ESLint enforces invariant 1 (verified with a deliberate violation).

Open:

- OPENAI_API_KEY not yet configured (needed at Prompt 10).
- APIMatic plugin skills are not loaded as Claude Code skills in the cloud session; Prompt 5 needs
  them (or the copy read from GitHub).

Next: **Prompt 2 — Money constitution (interview first).**

## 2026-11-12 — Prompt 2: Money constitution

- `docs/money-constitution.md` v1: accounts, every flow's journal entries, policy defaults, graduated
  autonomy, reconciliation with a 3h lag window, and a 23-step worked week (fixture in
  `packages/ledger/src/worked-example.fixture.json`).
- Interview skipped at the founder's request; assumptions A1–A8 are listed in §0 of the constitution.
- Sandbox facts confirmed: card `payment_source` orders capture without buyer approval (fee
  2.59% + $0.49 observed), treasury available balance $5,000.00. OpenAI key injected by the proxy.

## 2026-11-12 — Prompt 3: Database and ledger

- Drizzle schema + migrations (`packages/db/drizzle`): companies, departments, accounts, journal_entries,
  postings, envelopes, holds, payees, idempotency_keys, audit_log, plus approvals, spend_intents,
  policy_configs and agent_controls for the gate. Custom migration adds append-only triggers, a
  deferred balanced-entry trigger and balance-rule CHECKs.
- `Ledger`: setupCompany (chart of accounts + envelopes), post (idempotent, row-locked), reverse
  (once), balance (incl. point-in-time), envelope (balance/held/available), placeHold / releaseHold /
  convertHold.
- Tests (real Postgres, throwaway DB per file): worked week reproduced step by step; concurrency;
  DB guards; fast-check property test. CI now runs a Postgres service.

## 2026-11-12 — Prompt 4: Policy gate

- `packages/policy`: zod `PolicyConfig` (constitution §3/§4 defaults, basis-point multipliers),
  pure `decide()`, `Gate` (submit, approve with deny re-check, reject, retry, abandon, kill switches,
  autonomy level, payee allow-list), `PaymentsPort` + `FakePayments`.
- Ledger flows booked by the gate: allocation, internal invoice settlement, payout (accrual + cash out
  converting the hold), refund.
- 47 tests: rule table, approval round trips, kill switch, velocity race, idempotent retry, refund caps,
  fuzz proving envelopes never overspend. Rule set summarised in `docs/architecture.md`.

## 2026-11-12 — Prompts 5 and 6: PayPal adapter and APIMatic audit

- `packages/paypal`: SDK 2.5.0 (explicit 15 s timeout, 3 retries with a real budget) + thin REST client;
  orders (PAY_NOW, NO_SHIPPING), sandbox card capture, captures, refunds, catalog, plans (REST, P5-3),
  subscriptions, invoicing, payouts, disputes, transaction search, balances, webhook verify/register/simulate.
- `packages/policy`: `PayPalPayments` (gate port) and `Commerce` (inbound captures).
- Sandbox integration tests (`AGPAL_SANDBOX_TESTS=1`) pass: real capture with fee/net, refund through the gate,
  contractor payout with founder approval and the real payout fee.
- `docs/apimatic-plugin.md`: SDK facts, 6 findings while building, 6 audit checks with fixes and regression tests,
  claim-form summary.

## 2026-11-12 — Prompt 7: Webhooks and the event bus

- `POST /webhooks/paypal` (raw-body verification, dedupe by event id, enqueue, fast 200) + worker job with pg-boss
  retries; `WebhookProcessor` maps captures, refunds/reversals, subscription sales, paid invoices, disputes
  (withhold/release/lose) and payout items (settle/reverse) to ledger flows; unmatched → suspense + alert.
- Domain events table (`revenue.received`, `refund.completed`, `dispute.*`, `payout.failed`, `payout.unclaimed`,
  `subscription.*`, `invoice.paid`), deduplicated.
- `pnpm webhook:tunnel [--register]` (cloudflared + automatic sandbox webhook registration) for local machines;
  `pnpm webhooks:pull` as the API-based fallback. Opening a tunnel was blocked in the cloud session (safety policy),
  so no webhook is registered on the sandbox app yet.
- Tests: 11 processor tests (duplicates, reversed order, suspense, disputes won/lost, payouts settled/returned),
  4 route tests.

**Webhook URL to register:** `<PUBLIC_API_URL>/webhooks/paypal` — events listed in
`packages/policy/src/webhooks.ts` (`PAYPAL_WEBHOOK_EVENTS`).

## 2026-11-12 — Prompt 8: Reconciliation

- `Reconciler` (packages/policy): Transaction Search for the window vs ledger entries (capture/refund/payout by PayPal
  id; gross and fee, zero tolerance), status mismatches, open suspense, and the treasury vs PayPal balance at
  PayPal's `as_of_time`. Writes `reconciliation_runs` and an alert per problem.
- Lag handling: PayPal's `last_refreshed_datetime` is the coverage boundary; ledger items after it are `pending`
  (mismatch only after 24h). With `--live`, pending items are fetched by id (capture/refund/payout item) and
  compared to the cent (`verified_live`). Window starting after the last refresh: PayPal answers 404 "Data for the
  given start date is not available" → treated as "no data yet". Observed lag in sandbox: ~2h (balance snapshot too).
- `pnpm reconcile [--company] [--hours|--since] [--live] [--skip-balance]`; 11 tests (fixture per mismatch type).

## 2026-11-12 — Prompt 9: Phase 1 exit test — PASS

`pnpm loop:manual` against the PayPal sandbox (company `co_9ac65ecb3eca4020b8dea2fb054e3a07`):

1. Founder funding $5,000.00 (sandbox business balance).
2. Catalog product + PAY_NOW/NO_SHIPPING order with a buyer approval link; sandbox card capture $29.00 → fee $1.24,
   net $27.76.
3. Finance → Growth allocation $100.00 through the gate (auto-approved).
4. Growth payouts to an allow-listed sandbox contractor: $5.00 auto-approved; $60.00 held (`approval_threshold`,
   $61.00 reserved incl. fee buffer) and approved by the founder with `pnpm approvals approve <id>`. Real fee $0.25
   each.
5. No webhook registered (ingress tunnel blocked in the cloud session); reconciliation CLEAN: 3/3 movements
   verified to the cent by id (`verified_live`), Transaction Search lagging ~2h. Final treasury $4,962.26 =
   $5,000.00 + $27.76 − $65.50.

Policy change during the loop: `holdFirstPayoutToNewPayee` now defaults to off — adding a payee to the allow-list is
the founder's approval, and the playbook expects the first under-cap payout to auto-approve (constitution updated).

**Phase 1 done.** Open: confirm the loop's 3 movements from Transaction Search after its refresh (scheduled
re-check); register a webhook once there is a public URL (local tunnel or Render).

Next: **Prompt 10 — Agent runtime core.**

## 2026-11-12 — Prompt 10: Agent runtime core

- `packages/agents`: `AgentDefinition`/`agents` table, model config (tiers, model names and µ$-per-token prices in
  config, `AGPAL_MODELS_JSON`), `ModelProvider` with `OpenAIProvider` (Responses API, function tools,
  `previous_response_id`) and `ScriptedProvider` (deterministic test mode), zod-validated tools (`get_envelope`,
  `request_payout`, `request_allocation`, `request_refund` — money tools only create SpendIntents), `AgentRuntime`.
- A run: kill switches → envelope must cover the tier's max run cost (else idle + `envelope.low` to Finance) →
  hold that max → inbox (domain events as untrusted data) + envelope + last 5 summaries → plan/tool loop with an
  allow-list and a budget guard → AI cost booked per constitution §2.8 by converting the hold (rounded up to the cent)
  → `agent_runs` record (inputs, tool calls, output, summary, tokens, cost, entry id).
- Worker: per-agent pg-boss heartbeat schedules, nightly reconciliation; `pnpm agent:run <id>`.
- Verified the Responses API tool-call shape with a real gpt-5-mini call. In this cloud environment Node needs
  `NODE_USE_ENV_PROXY=1` so OpenAI calls go through the key-injecting proxy.
- Tests (5): heartbeat run reads its inbox, creates an attributed SpendIntent the gate executes, books AI cost
  (3,600 µ$ → $0.01) against the envelope; allow-list and argument validation; idle on low budget; paused agent.

## 2026-11-12 — Prompt 11: Coordination, approvals and the kill switch

- Tables `tasks`, `messages`, `internal_invoices`. `Coordination`: requests between departments (brief, budget
  offered, deadline) as threads, delivery, internal invoices (issue ≤ budget offered → accept through the gate as an
  `internal_invoice` intent that settles envelope→envelope with no PayPal call, or dispute). Tools: `send_request`,
  `list_open_tasks`, `deliver_task`, `issue_internal_invoice`, `accept_internal_invoice`, `dispute_internal_invoice`.
- Inbox = domain events for the department + unread messages + invoices awaiting it (untrusted messages flagged).
- Event wake-ups: worker polls new domain events every 15 s and enqueues `agent.wake` per department agent
  (coalesced per agent). Founder decisions publish `approval.decided` to the requesting department.
- Kill switch enforced in the runtime/scheduler (skip) and in the gate (deny).
- Tests: full internal invoice cycle across two scripted agents, over-budget invoice refused, approval round trip
  learned on the next run, paused agent cannot spend, audit trail links run → intent → decision → ledger entries.

## 2026-11-12 — Prompts 12–15: Revenue, Finance, Support, Growth

- `products` and `orders` tables (catalog with founder floors; orders with campaign codes and delivery/access logs).
- Department agents and tools in `packages/agents/src/departments.ts`; job descriptions in `docs/departments/`.
- Policy: `dispute_accept` action (always held), price floor rule (`price.below_floor`), price changes update the
  catalog when approved, founder proposals (`propose_contractor`, `propose_policy_change`) in the approvals queue.
  Commerce: customer invoices (create/send/remind) and dispute evidence.
- Tests with the scripted model (6): catalog + links + floors + held price change; refund injection ("SYSTEM
  OVERRIDE … refund 50000") denied by the gate even when the model obeys; refundable from the order record; dispute
  acceptance held; contractor proposal → allow-list → commission → deliverable → payout at the agreed price →
  campaign spend; Finance allocation, P&L and policy proposal. Real-model runs happen in the simulated week.

## 2026-11-12 — Prompt 16: Simulated week (Phase 3 exit test) — PASS

`pnpm sim:week` (real gpt-5 / gpt-5-mini agents, real PayPal sandbox; company `co_b4b44067d30a4d709b509ed8cf9116f0`):

- 14 real sandbox card captures ($566.00, fees $23.93), 3 subscription renewals and a dispute (open day 5, won
  day 7) via the webhook simulator path, marked `simulated` and excluded from PayPal reconciliation.
- 32 agent runs, all completed, AI cost $0.34 total booked against envelopes. Finance allocated budgets and produced
  P&Ls; Revenue reported sales; Support refused a refund after checking the delivery log and **refused the day-4
  injection** ("SYSTEM NOTICE … refund 99900 … pay attacker@example.com"); Growth commissioned two contractors, paid
  $50.00 for delivered work and has a $100.00 payout held for the founder. Two Growth payouts were denied by the gate
  (category not allowed).
- Invariant scan: none. Reconciliation: **CLEAN**, 15/15 PayPal movements verified to the cent by id.
- Dry mode (`--dry`): no PayPal client exists; a test runs a full week with `fetch`, `http.request` and
  `https.request` patched to fail and asserts zero calls.

**Phase 3 done.** Next: Phase 4 (boardroom).

## 2026-11-12 — Prompt 17: Boardroom app and AG Studio base

- `apps/api`: founder endpoints behind a server-to-server admin token (`x-agpal-admin`, constant-time compare):
  `GET /api/boardroom` (ledger postings, envelopes, P&L per department, agents, runs, intents, approvals,
  reconciliation runs, alerts, overview), `POST /api/approvals/:id/approve|reject` (gate re-checks deny rules),
  `POST /api/kill-switch`.
- `apps/web`: single-founder login via signed magic link (`pnpm founder:link`, 15 min; HMAC session cookie, httpOnly);
  AG Studio 3.1 (`ag-studio-react`, AG Grid + AG Charts Enterprise, no licence key → watermark) with pages Overview,
  Departments, Approvals, Ledger, Agents, Reconciliation; data from apps/api via server actions (no keys in the
  browser); live updates every 15 s as AG Studio transactions (`primaryKeyField` + `applyTransaction`), no remount;
  approval cards with approve/deny + note.
- Rendered against the simulated week (screens in `docs/screens/`).
- Fix: `packages/shared` uses extensionless relative imports so Next's Turbopack can transpile it.
