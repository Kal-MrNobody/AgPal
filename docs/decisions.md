# Decisions (ADR log)

One entry per non-obvious choice. Newest last.

## ADR-001: TypeScript 6.0, not 7.0 (2026-11-12)

**Context.** TypeScript 7.0 (native port) is the latest release, but typescript-eslint 8.72 supports
`typescript >=4.8.4 <6.1.0`, and type-aware lint is how we enforce invariant 1.
**Decision.** Pin `typescript@6.0.3`. Revisit when typescript-eslint supports 7.x.

## ADR-002: Money amounts are `bigint`, transported as strings (2026-11-12)

**Context.** Invariant 2 forbids floats. A `number` holding minor units is safe up to 2^53 but the
type system cannot tell a float from an integer.
**Decision.** `Money.amountMinor` is `bigint`, so a JS number cannot be assigned to it. JSON does
not support bigint, so the wire form is `{ amountMinor: "1234", currency: "USD" }`. Postgres
columns will be `bigint` with Drizzle `mode: 'bigint'`. Conversion to PayPal decimals never rounds:
extra precision is an error. HUF and TWD use exponent 0 because PayPal rejects decimals for them.

## ADR-003: Internal packages export TypeScript source (2026-11-12)

**Context.** Building every package to `dist` slows the loop and adds watch-mode complexity.
**Decision.** Packages expose `./src/index.ts`. Node apps run through `tsx`; Next.js uses
`transpilePackages`; Vitest and `tsc --noEmit` resolve source directly. A bundling step for deploy
arrives with Prompt 25.

## ADR-004: Invariant 1 enforced by lint, not only by convention (2026-11-12)

**Decision.** `no-restricted-imports` blocks `@paypal/paypal-server-sdk` everywhere except
`packages/paypal`, and `@agpal/paypal` everywhere except `packages/policy`. Exceptions (e.g.
reconciliation's read-only Transaction Search) must be added explicitly and recorded here.

## ADR-005: Env names, aliases and `.env` read protection (2026-11-12)

**Context.** The hosted dev environment exposes PayPal sandbox credentials as `Client_ID` and
`Secret_key_1`.
**Decision.** Canonical names are `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`; `loadEnv()` accepts
the legacy names as a fallback. `.claude/settings.json` denies Claude Code reads and edits of
`.env` and `.env.*`, which includes `.env.example`; that file has no secrets and is maintained
alongside `packages/shared/src/env.ts`.

## ADR-006: pnpm build-script allow-list (2026-11-12)

pnpm 12 refuses to install when dependency build scripts are not approved. Only `esbuild` (needed by
tsx and drizzle-kit) is allowed, in `pnpm-workspace.yaml` `allowBuilds`.

## ADR-007: Ledger concurrency with row locks, not SERIALIZABLE (2026-11-12)

**Context.** Two spends on one envelope must not both pass if together they exceed it.
**Options.** (a) SERIALIZABLE transactions with retry on serialization failure; (b) READ COMMITTED with
`SELECT … FOR UPDATE` on the affected account rows.
**Decision.** (b). Every posting locks its account rows in a stable order (by id), updates a cached
`balance_minor` and checks the balance rule and active holds before commit. `placeHold` locks the
envelope's account row before summing holds. Contention is per account, never global; no retry loop is
needed, and failures are deterministic `InsufficientFundsError`s rather than serialization retries.
Defense in depth: a `CHECK` constraint on the cached balance, append-only triggers, and a deferred
constraint trigger that rejects unbalanced entries even if code is bypassed.

## ADR-008: Entry idempotency in the ledger (2026-11-12)

`journal_entries` has a unique `(company_id, idempotency_key)`. `post` returns the existing entry with
`duplicate: true` instead of posting twice, including under concurrent retries (unique-violation path).
Reversals use the key `reversal:<entryId>`, and a unique index allows one reversal per entry.

## ADR-009: PayPal Server SDK where it covers the API, thin REST elsewhere (2026-11-12)

**Decision.** `@paypal/paypal-server-sdk@2.5.0` for Orders, Payments (captures, refunds), Subscriptions (create,
get) and Transaction Search. A thin typed REST client (`packages/paypal/src/http.ts`) for Catalog products,
billing plans (P5-3), subscription cancel (P6-1), Invoicing, Payouts, Disputes and webhook verification/
registration. Both use explicit timeouts and retry budgets, send `PayPal-Request-Id` on every write that moves or
creates something, and normalize every response into our own types; SDK types never leave `packages/paypal`.
Fee and net amounts are read from the raw response body.

## ADR-010: Inbound money through packages/policy too (2026-11-12)

Captures are not spends, so they skip the rules, but they are still PayPal calls, so `Commerce` lives in
`packages/policy` (the only package allowed to import `@agpal/paypal`). Every capture is booked once, keyed by
`paypal:capture:<id>`, whether it is seen in the API response or the webhook.

## ADR-011: Sandbox card payments for automation (2026-11-12)

Sandbox orders with a test card `payment_source` capture without buyer approval, so loops, simulations and
integration tests need no browser. `createAndCaptureSandboxCardOrder` refuses to run against live.

## ADR-012: Apps reach PayPal only through `createServices()` (2026-11-12)

`apps/api` and `apps/worker` never import `@agpal/paypal`. `packages/policy` builds the money stack
(`createServices`) and hands apps the `Gate`, `Commerce`, `WebhookProcessor` and a read-only `PayPalInbound` view
(webhook verification, Transaction Search, balances, lookups). Nothing in the inbound view moves money.

## ADR-013: Webhooks — verify raw bytes, dedupe, process idempotently, pull as fallback (2026-11-12)

`POST /webhooks/paypal` verifies with PayPal's verify-webhook-signature API against the exact raw body (fails
closed without `PAYPAL_WEBHOOK_ID`), stores the event keyed by PayPal's event id and enqueues it. The worker maps
events to constitution flows with idempotency keys derived from PayPal ids (`paypal:capture:<id>`,
`paypal:refund:<id>`, `paypal:dispute:<id>:hold|resolved`, `intent:<id>:sent`), so a webhook and an API response
booking the same money produce one entry. Out-of-order events throw `RetryLaterError` (pg-boss retries 8× with
backoff); still unmatched on the final attempt → alert + suspense. When inbound delivery is impossible (the cloud
session's safety policy blocks ingress tunnels), `pnpm webhooks:pull` fetches the same events from
`/v1/notifications/webhooks-events` over the authenticated API.

## ADR-014: Agent model cost is reserved up front and booked from real token usage (2026-11-12)

Each run places a ledger hold for its tier's `maxRunCostMinor` before calling the model, so concurrent runs and
spends cannot overdraw the envelope; a budget guard stops further steps once half of that maximum is used. After the
run the hold is converted into the constitution §2.8 entry for the exact cost (micro-dollars from token usage ×
configured prices, rounded up to the cent). Prices and model names are config (`AGPAL_MODELS_JSON`), never code.
