# Architecture

AgPal separates **deciding** to move money from **moving** it. Agents only ever produce
`SpendIntent`s. The policy gate decides, the ledger records, and only then does the PayPal adapter
touch the outside world. The founder's boardroom reads everything through the API.

```mermaid
flowchart LR
  subgraph apps
    web["apps/web<br/>Next.js boardroom"]
    api["apps/api<br/>Fastify: webhooks, gate, reads"]
    worker["apps/worker<br/>pg-boss: heartbeats, webhooks, reconciliation"]
  end
  subgraph packages
    agents["packages/agents<br/>runtime, tools"]
    policy["packages/policy<br/>THE GATE"]
    ledger["packages/ledger<br/>double-entry, append-only"]
    paypal["packages/paypal<br/>SDK + thin REST"]
    db["packages/db<br/>Drizzle schema"]
    shared["packages/shared<br/>money, env, Secret"]
  end
  pg[(Postgres)]
  pp{{PayPal}}
  llm{{Model provider}}

  web -->|HTTP| api
  api --> policy
  worker --> agents
  agents -->|SpendIntent only| policy
  agents --> llm
  policy -->|1 hold / post| ledger
  policy -->|2 execute| paypal
  paypal --> pp
  pp -->|webhooks| api
  api -->|enqueue| worker
  worker --> ledger
  worker -->|Transaction Search| paypal
  ledger --> db --> pg
  worker --> pg
```

## Boundaries

| Package           | May depend on                 | Must never                                                |
| ----------------- | ----------------------------- | --------------------------------------------------------- |
| `packages/paypal` | shared                        | depend on policy; leak SDK types                          |
| `packages/policy` | shared, ledger, paypal, db    | let an LLM read or change rule config                     |
| `packages/agents` | shared, policy (intents only) | import paypal or the PayPal SDK                           |
| `apps/*`          | packages except paypal        | import `@agpal/paypal` or the SDK (exceptions get an ADR) |

Import rules for PayPal are enforced by ESLint (`eslint.config.mjs`).

## Policy rule set

Implemented in Prompt 4. See `docs/money-constitution.md` (Prompt 2).
