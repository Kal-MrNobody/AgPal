# AgPal — project memory for Claude Code

AgPal is a PayPal-native operating system where AI agents are the employees of a small company.
Each department (Revenue, Finance, Support, Growth to start) is run by an agent with a budget
envelope, a mandate and a P&L. The founder is the board: funds the company, sets rules, approves
big actions. Real money moves only through PayPal at the company's boundary; money between
departments is internal ledger entries.

Read at the start of every session: this file, `docs/money-constitution.md`, `docs/architecture.md`,
`docs/progress.md`. Work follows the prompt playbook; each prompt ends at a stop condition.

## Invariants (never break these; keep this list current)

1. **No agent, tool or UI ever calls PayPal directly.** Every money action goes through
   `packages/policy` (the gate), which writes to `packages/ledger` and then calls `packages/paypal`.
   Enforced by ESLint `no-restricted-imports`: only `packages/paypal` may import
   `@paypal/paypal-server-sdk`; only `packages/policy` may import `@agpal/paypal`.
2. **Money is integer minor units + ISO currency code. Never floats.** Use `Money` / `bigint` from
   `@agpal/shared`. Convert to PayPal's decimal strings only with `toDecimal` / `parseDecimal`.
   Over JSON, amounts travel as strings (`toJson` / `fromJson`).
3. **The ledger is double-entry and append-only.** Postings in an entry sum to zero per currency;
   corrections are reversing entries (`reversalOf`), never edits or deletes.
4. **Every external call that moves money carries an idempotency key and is safe to retry.**
   (`PayPal-Request-Id` on captures, refunds, payouts; `sender_batch_id` = one payout per intent.)
5. **Spending rules live in code and config, never only in prompts.** The LLM never sees or edits
   rule config.
6. **Secrets come only from env; never logged; never sent to an LLM.** `loadEnv()` wraps secrets in
   `Secret`, which redacts itself everywhere; call `.reveal()` only at the point of use. API logs
   redact auth headers.
7. **Every agent action is attributable:** agent id, run id, reason (`Attribution` in
   `@agpal/shared`).
8. **Claude Code never reads `.env` or `.env.*`.** `.claude/settings.json` denies it; scripts and apps still load
   them at runtime (`--env-file-if-exists`, `loadEnv()`). (ADR-016)

## Stack

- pnpm 12 workspaces + Turborepo; TypeScript 6.0 strict (`noUncheckedIndexedAccess`); ESLint 10 +
  typescript-eslint strict-type-checked; Prettier; Vitest 5 everywhere; Node >= 22.12.
- `apps/web` Next.js 16 App Router (boardroom) · `apps/api` Fastify 5 · `apps/worker` pg-boss 12.
- `packages/db` Drizzle + Postgres 17 · `packages/ledger` · `packages/policy` · `packages/paypal` ·
  `packages/agents` · `packages/shared` (money, env, Secret, ids).
- Internal packages export TypeScript source (`"exports": "./src/index.ts"`); apps run via `tsx`,
  Next transpiles them with `transpilePackages`.

## Commands

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm format
pnpm db:up            # Postgres via docker compose (waits for healthy)
pnpm --filter @agpal/api dev
pnpm --filter @agpal/worker dev
pnpm --filter @agpal/web dev
```

DB-backed tests run only when `DATABASE_URL` is set.

## Working rules

- Secrets: `.env` is git-ignored and Claude Code is denied read access (`.claude/settings.json`).
  Never paste or echo secret values. Hosted environments may expose PayPal creds as `Client_ID` /
  `Secret_key_1`; `loadEnv()` maps those to `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`.
- `NODE_ENV=development` may be set globally; `next build` must run with `NODE_ENV=production`
  (the web `build` script sets it).
- Append to `docs/progress.md` at the end of every task. Record non-obvious choices as ADRs in
  `docs/decisions.md`. Propose stack changes before making them.
- Before risky changes run the invariant guard: no PayPal call outside `packages/paypal`, no money
  rule only in a prompt, no float amounts, no money movement without an idempotency key.
