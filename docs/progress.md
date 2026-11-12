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
