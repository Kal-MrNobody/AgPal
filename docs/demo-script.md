# AgPal — 3-minute demo script

**Live:** https://agpal-web.onrender.com (sign-in link from `pnpm founder:link`, valid 15 minutes, session 12 hours).

## Before recording (5 minutes)

1. Fresh sign-in link (Render → agpal-worker → Shell: `WEB_URL=https://agpal-web.onrender.com pnpm founder:link`).
2. One held payout waiting for you: `pnpm demo:hold` in the same Shell. It tops up Growth by $100 through the
   gate (Finance allocation, within policy) and submits a $90 contractor payout that the gate **holds** (over
   Growth's $50 auto-approve). Both are attributed to `demo-setup` in the audit trail.
3. Second tab: PayPal sandbox dashboard (developer.paypal.com → Sandbox accounts → the business account → Activity).
4. Window at 1500 px wide or more. The AG Studio watermark and the Bryntum "Trial" badge are expected (no licence keys).

## 0:00–0:25 — The pitch (Overview)

"This is AgPal: a company whose employees are AI agents. Revenue, Finance, Support and Growth each run on a budget
envelope with a mandate and a P&L. I'm the founder; I'm the board. Every real dollar moves through PayPal, and no
agent can touch PayPal directly."

Point at the **Money flow** Sankey: "Every dollar from the ledger: customers and my funding into the treasury, out to
department envelopes, then to contractors, AI models and PayPal fees. Internal invoices between departments are their
own flows. It always reconciles to the double-entry ledger."

## 0:25–0:50 — Departments and the ledger

**Departments:** envelope gauges (spent, held, available) and each department's P&L, AI cost included.
**Ledger:** "Every line is a double-entry posting with the agent, the run and the reason behind it. It's
append-only, enforced in Postgres; corrections are reversing entries."

## 0:50–1:30 — The gate (Approvals)

"Agents can only _ask_ to spend. A deterministic policy gate decides: execute, hold for me, or deny. The rules are
code and config; the model never sees them."

Open the held card: $90 to the contractor, rule `approval_threshold`, "over the $50 auto-approve limit (autonomy
level 1)". Click **Approve**. "The gate re-checks every rule on the server, then pays." Switch to the PayPal sandbox
tab: the payout is there. "One payout per intent, ever: idempotency keys on every PayPal call, so a retry or a
double-click can't pay twice."

## 1:30–1:55 — Agents can't be talked into spending (Agents)

Scorecards: "Agents earn autonomy from their ledger record (accepted work up; denials, refunds and reversals down)
and I can pin any level." "We attacked it with prompt injection, forged approvals, split payments and payee swaps:
14 attacks, all held. In the seeded week a customer told Support to issue a refund; Support refused."

## 1:55–2:25 — CFO (AG Studio Agent Framework)

**Edit dashboard → AI** → prompt starter **"Why did Growth overspend?"** The panel shows **"Delegated to CFO"**:
"Studio's built-in lead agent hands money questions to our CFO agent, which only has read-only ledger tools." Then
ask it to add a chart: the change appears with attribution (which agent did what) and **Undo**.

## 2:25–2:50 — Schedule and reconciliation

**Schedule** (Bryntum Gantt): "Each expected payment is a milestone that gates what it pays for." Pick the INV-1042
payment, set a date 3 days later and click **Payment slips to this date**: the launch, the contractor payout and the Q1
milestone all move.
"That recalculation ran on the server in our worker, the same path the Finance agent uses through one schedule
tool. Agents never touch the UI." Move it back.

**Reconciliation:** "Every night we reconcile the ledger against PayPal's Transaction Search, gross and fee to the
cent." If an alert is open on the Overview: "Money PayPal reports that we can't attribute goes to suspense, never into
the books. I can resolve it with a written reason, and that's audited too."

## 2:50–3:00 — Close

"AgPal: agents run the company, PayPal moves the money, the founder stays in control."

## Talking points if judges ask

- **PayPal APIs:** Orders and Payments, Subscriptions and Transaction Search through the PayPal Server SDK (typed
  models); Payouts, Invoicing, Disputes, Catalog and Webhooks through REST. See `docs/apimatic-plugin.md`.
- **Safety:** integer cents only; append-only double-entry ledger; idempotency keys on every money call; spending
  rules in code; secrets never logged or sent to a model; every action attributable (agent, run, reason).
- **Reliability:** chaos tests for PayPal 5xx mid-capture, timeout mid-payout, a crash between hold and payout,
  double-clicked approvals and concurrent spends; a recovery sweep every 5 minutes.
