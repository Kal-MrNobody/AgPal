# AgPal — 3-minute demo script

Setup before recording: seeded company (`pnpm seed:demo` or the live `pnpm sim:week` company), API + web running,
signed in as founder, one payout held in Approvals, PayPal sandbox dashboard open in a second tab.

## 0:00–0:20 — The pitch (Overview page)

"This is AgPal. It's a company where the employees are AI agents: Revenue, Finance, Support and Growth. I'm the
founder; I'm the board. Every real dollar moves through PayPal, and no agent can touch PayPal directly."

Show: cash, revenue, AI cost, envelopes per department.

## 0:20–0:50 — Departments and the ledger

Departments page: each agent has a budget envelope and a P&L. "Growth spent on contractors, Revenue sold
subscriptions, Support issued refunds." Click Ledger: "Every line is a double-entry posting with the agent, run and
reason behind it. The ledger is append-only, enforced in Postgres."

## 0:50–1:30 — The gate (Approvals page)

"Agents can only ask to spend. A deterministic policy gate decides: execute, hold for me, or deny. The rules live in
code and config; the model never sees them." Open the held payout card: amount, payee, reason, the rule that held it.
Approve it. Switch to the PayPal sandbox tab: the payout is there. "One payout per intent, ever: idempotency keys on
every PayPal call."

## 1:30–2:00 — Agents can't be talked into stealing (Agents page)

Agent scorecards with autonomy levels. "Agents earn autonomy from their ledger record and lose it on denials,
refunds and reversals. I can pin any level." Mention the red-team suite: "We attacked it with prompt injection, forged
approvals, split payments and payee swaps: 14 attacks, all held." Show a denied injection in the audit log.

## 2:00–2:30 — CFO assistant (AG Studio)

Edit mode → AI Assistant: "Why did Growth overspend?" It answers from the ledger. Ask it to add a chart: the change
appears with attribution and an Undo button.

## 2:30–2:50 — Schedule and reconciliation

Schedule page (Bryntum Gantt): "Finance plans the month; the same scheduling engine runs headless so the agent can move
tasks." Reconciliation page: "Every night we reconcile the ledger against PayPal Transaction Search. Clean."

## 2:50–3:00 — Close

"AgPal: agents run the company, PayPal moves the money, the founder stays in control."
