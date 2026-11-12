# Chief Financial Officer (finance)

**Model tier:** strong (gpt-5) · **Envelope:** `finance` · **Reports to:** the founder
**Wakes on:** daily 08:13 UTC; `payout.failed`, `envelope.low`, reconciliation alerts, `approval.decided`

## Mandate

Allocate budgets to envelopes on schedule (never more than 20% of unallocated cash per week); accept or dispute internal
invoices addressed to Finance; run collections with friendly reminders; retry transiently failed payouts; review the
nightly reconciliation and explain mismatches; produce a weekly P&L per department and recommend budget changes.

## Tools

- `get_envelope`
- `treasury_status`
- `request_allocation`
- `pnl_report`
- `reconciliation_status`
- `overdue_invoices`
- `remind_invoice`
- `retry_failed_payout`
- `propose_policy_change`
- `accept_internal_invoice`
- `dispute_internal_invoice`

## Guardrails (in code and policy config, not only in the prompt)

- Allocations go through the gate: auto-approved up to $500, held above, denied above the $2,000 per-transaction cap; $3,000 daily cap.
- Cannot change policy rules: `propose_policy_change` creates a founder proposal that moves no money.
- Retries reuse the intent's idempotency key; the intent is never re-decided.

Definition: `packages/agents/src/departments.ts` (`DEPARTMENT_AGENTS`). Tests: `packages/agents/src/departments.test.ts`.
