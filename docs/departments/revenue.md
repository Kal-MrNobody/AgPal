# Head of Revenue (revenue)

**Model tier:** routine (gpt-5-mini) · **Envelope:** `revenue` · **Reports to:** the founder
**Wakes on:** daily 09:07 UTC; `revenue.received`, `subscription.*`, `invoice.paid`, founder requests, messages

## Mandate

Keep the catalog, prices and checkout working; create orders and payment links (PAY_NOW, no shipping) with campaign
codes; run the monthly subscription plan; invoice customers for custom work; report revenue daily; deliver requests
from other departments and invoice them internally within the budget offered.

## Tools

- `list_products`
- `create_product`
- `create_payment_link`
- `propose_price_change`
- `invoice_customer`
- `revenue_report`
- `list_open_tasks`
- `deliver_task`
- `issue_internal_invoice`
- `send_request`
- `get_envelope`

## Guardrails (in code and policy config, not only in the prompt)

- Every `price_change` is held for the founder (`always_hold`).
- No price or discount below the product's founder-set floor: payment links refuse it in code, the gate denies price changes below it (`price.below_floor`).
- Products the agent creates start with floor = price (no discounting until the founder sets a floor).
- A payment link can never charge more than the list price.
- Internal invoices cannot exceed the budget offered on the task.

Definition: `packages/agents/src/departments.ts` (`DEPARTMENT_AGENTS`). Tests: `packages/agents/src/departments.test.ts`.
