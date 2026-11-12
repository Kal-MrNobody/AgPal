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
