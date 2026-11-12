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
