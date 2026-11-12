# AgPal money constitution

Status: v1 (2026-11-12). Every ledger, policy and reconciliation behaviour in code must match this
document. Change the document first, then the code, then the tests.

## 0. Decisions made without an interview

The playbook asks for an interview. The founder asked for no blocking questions, so these are the
assumptions. Each one is a single place to change if the founder disagrees.

| #   | Question                    | Assumption                                                                                                            |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A1  | Currencies                  | USD only for v1. The ledger is multi-currency safe; envelopes and policy are single-currency.                         |
| A2  | Where AI cost is paid       | OpenAI is billed to the founder's card, outside PayPal. Each run's cost is still charged to the agent's envelope.     |
| A3  | Where refunds are paid from | `cash:unallocated` (where sales land). Support's _authority_ to refund is capped by policy, not by its envelope cash. |
| A4  | Budget cadence              | Finance allocates weekly (Monday). Unspent envelope cash stays in the envelope.                                       |
| A5  | Default limits              | The table in §3. Conservative; graduated autonomy raises them.                                                        |
| A6  | Fees                        | Always the amounts PayPal reports (capture `seller_receivable_breakdown`, payout `payout_item_fee`). Never estimated. |
| A7  | Founder funding in sandbox  | The sandbox treasury starts with a balance; founder funding is booked as an opening entry that matches it.            |
| A8  | Taxes, FX, chargeback fees  | Out of scope for v1. Any PayPal amount we cannot classify goes to suspense.                                           |

## 1. Accounts

Sign convention: postings are signed integers in minor units. **Positive = debit, negative = credit.**
Every journal entry sums to zero per currency.

| Code pattern                   | Type      | Purpose                                                                                 |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------- |
| `cash:unallocated`             | asset     | PayPal treasury money not yet given to a department. Sales land here.                   |
| `cash:envelope:<dept>`         | asset     | A department's budget envelope. Real PayPal money, earmarked.                           |
| `cash:reserve:ai_compute`      | asset     | Cash earmarked to pay the AI provider bill.                                             |
| `cash:withheld:disputes`       | asset     | Money PayPal holds because of open disputes.                                            |
| `cash:suspense`                | asset     | PayPal movements we could not match yet. Must be zero after reconciliation is resolved. |
| `equity:owner`                 | equity    | Founder funding (owner equity).                                                         |
| `revenue:sales:<dept>`         | revenue   | One-off sales (gross).                                                                  |
| `revenue:subscriptions:<dept>` | revenue   | Subscription payments (gross).                                                          |
| `revenue:refunds:<dept>`       | revenue   | Contra-revenue: refunds and lost disputes (debit balance).                              |
| `revenue:internal:<dept>`      | revenue   | Internal invoice income from another department. Eliminated in company totals.          |
| `expense:paypal_fees`          | expense   | Every PayPal fee: checkout, payout, dispute.                                            |
| `expense:ai_compute:<dept>`    | expense   | Model usage cost, per department.                                                       |
| `expense:contractors:<dept>`   | expense   | External contractor work.                                                               |
| `expense:internal:<dept>`      | expense   | Internal invoices paid to another department. Eliminated in company totals.             |
| `liability:payable:<payee>`    | liability | Owed to an external payee (contractors, `ai_provider`).                                 |

**PayPal treasury** (the account that mirrors the real balance) is the _group_ of `cash:*` accounts
except `cash:withheld:disputes`:

- `sum(cash:* except withheld)` must equal PayPal `available_balance`.
- `cash:withheld:disputes` must equal PayPal `withheld_balance`.

**Envelope available** = `balance(cash:envelope:<dept>) − active holds on that envelope`.
"Allocated" and "spent" are reporting views over the envelope's postings (allocations in; spend out).

Account balances may not go negative, except `cash:suspense`, contra/expense accounts by nature, and
credit-normal accounts (equity, revenue, liabilities), which are negative under this sign convention.
In particular **no `cash:envelope:*` and no `cash:unallocated` may go below zero**; the ledger rejects
the entry.

## 2. Flows and their journal entries

`G` gross, `F` fee, `N` net (`G − F`), `A` amount. Every entry carries `companyId`, a description,
attribution (agent id, run id, reason, or `founder`/`system`) and, for PayPal-originated entries,
the PayPal id (capture, refund, payout item, dispute) used for idempotency and reconciliation.

### 2.1 Founder funds the company

| Account            | Dr  | Cr  |
| ------------------ | --- | --- |
| `cash:unallocated` | A   |     |
| `equity:owner`     |     | A   |

Matched in reconciliation to the incoming PayPal transfer (or, in sandbox, the opening balance).

### 2.2 Customer payment captured (order or subscription payment)

| Account                                      | Dr  | Cr  |
| -------------------------------------------- | --- | --- |
| `cash:unallocated`                           | N   |     |
| `expense:paypal_fees`                        | F   |     |
| `revenue:sales:revenue` (or `subscriptions`) |     | G   |

Fee and net come from `seller_receivable_breakdown`. Booked once per capture id, whichever arrives
first (API response or `PAYMENT.CAPTURE.COMPLETED` / `PAYMENT.SALE.COMPLETED`).

### 2.3 Allocation from treasury to an envelope

| Account                | Dr  | Cr  |
| ---------------------- | --- | --- |
| `cash:envelope:<dept>` | A   |     |
| `cash:unallocated`     |     | A   |

Returning money from an envelope is the same entry with the sides swapped (a new entry, not an edit).

### 2.4 Internal invoice between departments

1. **Request:** seller issues an invoice document. No ledger entry.
2. **Accept:** the buyer accepts it; a **hold** of `A` is placed on the buyer's envelope. No entry.
3. **Settle:** one entry, the hold is converted:

| Account                     | Dr  | Cr  |
| --------------------------- | --- | --- |
| `expense:internal:<buyer>`  | A   |     |
| `revenue:internal:<seller>` |     | A   |
| `cash:envelope:<seller>`    | A   |     |
| `cash:envelope:<buyer>`     |     | A   |

No PayPal call. Company-level P&L eliminates `revenue:internal` against `expense:internal`.

### 2.5 Payout to an external payee

| Stage                                  | Ledger effect                                                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| requested                              | Gate decision. If approved: **hold** `A + max_fee` on the envelope. No entry.                                                                                                                                                                            |
| approved / sent                        | Entry 1 (accrual): Dr `expense:contractors:<dept>` A / Cr `liability:payable:<payee>` A. Entry 2 (cash out, when PayPal accepts the batch): Dr `liability:payable:<payee>` A, Dr `expense:paypal_fees` F / Cr `cash:envelope:<dept>` A+F. Hold released. |
| succeeded                              | Status only. No entry.                                                                                                                                                                                                                                   |
| failed / returned / unclaimed-returned | Reverse entry 2 (money and fee come back to the envelope). The payable is open again. If the payout is abandoned, reverse entry 1 too.                                                                                                                   |

One payout per intent: the intent id is the `sender_batch_id`.

### 2.6 Refund

| Account                   | Dr  | Cr         |
| ------------------------- | --- | ---------- |
| `revenue:refunds:revenue` | G   |            |
| `expense:paypal_fees`     |     | F_back     |
| `cash:unallocated`        |     | G − F_back |

`G` is the refunded gross; `F_back` is any fee PayPal returns (often zero). Both come from the refund
response's `seller_payable_breakdown`. Refund amount is always taken from the order record, never
from a message.

### 2.7 Dispute

| Event               | Entry                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| opened (funds held) | Dr `cash:withheld:disputes` A / Cr `cash:unallocated` A                                                                                |
| won                 | Dr `cash:unallocated` A / Cr `cash:withheld:disputes` A                                                                                |
| lost                | Dr `revenue:refunds:revenue` A / Cr `cash:withheld:disputes` A; plus any dispute fee: Dr `expense:paypal_fees` / Cr `cash:unallocated` |

### 2.8 AI model usage

Per run, one entry. The envelope pays; the cash moves to the AI reserve until the bill is paid.

| Account                         | Dr  | Cr  |
| ------------------------------- | --- | --- |
| `expense:ai_compute:<dept>`     | A   |     |
| `liability:payable:ai_provider` |     | A   |
| `cash:reserve:ai_compute`       | A   |     |
| `cash:envelope:<dept>`          |     | A   |

Paying the bill by card outside PayPal (A2): Dr `liability:payable:ai_provider` / Cr `equity:owner`,
and Dr `cash:unallocated` / Cr `cash:reserve:ai_compute` (the earmark returns). Paying it from PayPal:
Dr `liability:payable:ai_provider` / Cr `cash:reserve:ai_compute`.

AI cost is computed from token usage × the per-token price in config, in **micro-dollars**, and booked
rounded **up** to the cent per run (never under-charge an envelope).

### 2.9 Unmatched items

Anything from PayPal we cannot map: Dr/Cr `cash:suspense` against `cash:unallocated` with the raw event
attached, plus an alert. Resolution is a reversing entry plus the correct entry.

## 3. Policy rules per envelope

Rules are config (zod-validated, per company). The LLM never sees or edits them.

| Rule               | Revenue                                                  | Finance                                        | Support                           | Growth                            |
| ------------------ | -------------------------------------------------------- | ---------------------------------------------- | --------------------------------- | --------------------------------- |
| Actions allowed    | price_change, subscription_change, internal_invoice      | allocation, internal_invoice                   | refund, internal_invoice          | payout, internal_invoice          |
| Auto-approve up to | —                                                        | $500 per allocation                            | $50 per refund                    | $50 per payout                    |
| Hard per-tx cap    | —                                                        | $2,000                                         | order's captured amount           | $250                              |
| Daily cap          | —                                                        | $3,000                                         | $200                              | $400                              |
| Velocity           | 10 / hour                                                | 10 / hour                                      | 5 refunds / hour                  | 5 payouts / hour                  |
| Payee allow-list   | n/a                                                      | n/a                                            | refund only to the original order | founder-approved contractors only |
| Categories         | pricing                                                  | budgeting                                      | refunds                           | content, listings, launches       |
| Always held        | every price_change; discounts below the floor are denied | moving money out of an envelope it doesn't own | dispute claim acceptance          | first payout to a new payee       |

**On breach:**

- Over the hard cap, payee not allowed, action not allowed, category not allowed, envelope
  insufficient, kill switch on: **deny**.
- Over the auto-approve amount, over the daily cap, over velocity, or "always held": **hold for founder**.
- Founder approval re-runs every deny rule at approval time (a held intent that would now be denied stays denied).

**Kill switch:** company-wide and per agent. While on, every intent is denied and the scheduler wakes no
agent.

## 4. Graduated autonomy

Levels 0–4. New agents start at **level 1**.

| Level | Cap & daily multiplier | Auto-approve multiplier | Notes                         |
| ----- | ---------------------- | ----------------------- | ----------------------------- |
| 0     | 0.5×                   | 0 (everything held)     | Probation                     |
| 1     | 1×                     | 1×                      | Default                       |
| 2     | 1.5×                   | 1.5×                    |                               |
| 3     | 2×                     | 2×                      |                               |
| 4     | 3×                     | 3×                      | Founder pin required to reach |

Trust score over the trailing 30 days:
`+1` per accepted deliverable or settled internal invoice, `−3` per reversal it caused, `−2` per refund it
caused, `−2` per policy denial, `−3` per founder override (denying an intent it proposed).

- Promote one level when score ≥ 10 and no denial in the last 7 days.
- Demote one level when score < 0, or immediately on any founder override.
- Changes apply at the next UTC day boundary and are logged. The founder can pin a level.

## 5. Reconciliation

Daily (and on demand) for the window `[start, end − 3h]`:

1. Pull PayPal Transaction Search for the window. Match each PayPal transaction to ledger entries by
   PayPal id: capture, refund, payout item, dispute.
2. Compare gross, fee, net, currency and status. **Tolerance is zero.**
3. Compare balances: treasury group vs `available_balance`; withheld vs `withheld_balance`.
4. Report: matched, missing in ledger, missing in PayPal, amount mismatches, suspense items.
5. Any mismatch creates an alert for the boardroom. Unmatched PayPal items post to `cash:suspense`.

**Lag:** Transaction Search can trail real time by up to ~3 hours. Ledger items newer than the window end
are "pending", not "missing in PayPal". A pending item that is still unmatched after 24 hours becomes a
mismatch.

## 6. Worked example: one week of a digital-goods shop

Assumed fees for the example (real runs always use PayPal's reported amounts): checkout 2.59% + $0.49,
rounded half-up to the cent; payouts 2% capped at $1.00. Treasury = sum of cash accounts except withheld,
and must equal the PayPal available balance.

| #   | Day | Step                                                               | Unalloc  | Rev env | Fin env | Sup env | Gro env | AI rsv | Withheld | Treasury | Owner eq. |
| --- | --- | ------------------------------------------------------------------ | -------- | ------- | ------- | ------- | ------- | ------ | -------- | -------- | --------- |
| 1   | Mon | Founder funds the company $5,000.00                                | 5,000.00 | 0.00    | 0.00    | 0.00    | 0.00    | 0.00   | 0.00     | 5,000.00 | 5,000.00  |
| 2   | Mon | Finance allocates $300.00 to revenue                               | 4,700.00 | 300.00  | 0.00    | 0.00    | 0.00    | 0.00   | 0.00     | 5,000.00 | 5,000.00  |
| 3   | Mon | Finance allocates $100.00 to finance                               | 4,600.00 | 300.00  | 100.00  | 0.00    | 0.00    | 0.00   | 0.00     | 5,000.00 | 5,000.00  |
| 4   | Mon | Finance allocates $200.00 to support                               | 4,400.00 | 300.00  | 100.00  | 200.00  | 0.00    | 0.00   | 0.00     | 5,000.00 | 5,000.00  |
| 5   | Mon | Finance allocates $500.00 to growth                                | 3,900.00 | 300.00  | 100.00  | 200.00  | 500.00  | 0.00   | 0.00     | 5,000.00 | 5,000.00  |
| 6   | Tue | Capture Notion template $29.00 (fee 1.24)                          | 3,927.76 | 300.00  | 100.00  | 200.00  | 500.00  | 0.00   | 0.00     | 5,027.76 | 5,000.00  |
| 7   | Tue | Capture Preset pack $49.00 (fee 1.76)                              | 3,975.00 | 300.00  | 100.00  | 200.00  | 500.00  | 0.00   | 0.00     | 5,075.00 | 5,000.00  |
| 8   | Tue | AI usage revenue $0.50                                             | 3,975.00 | 299.50  | 100.00  | 200.00  | 500.00  | 0.50   | 0.00     | 5,075.00 | 5,000.00  |
| 9   | Tue | AI usage finance $0.50                                             | 3,975.00 | 299.50  | 99.50   | 200.00  | 500.00  | 1.00   | 0.00     | 5,075.00 | 5,000.00  |
| 10  | Tue | AI usage support $0.50                                             | 3,975.00 | 299.50  | 99.50   | 199.50  | 500.00  | 1.50   | 0.00     | 5,075.00 | 5,000.00  |
| 11  | Tue | AI usage growth $0.50                                              | 3,975.00 | 299.50  | 99.50   | 199.50  | 499.50  | 2.00   | 0.00     | 5,075.00 | 5,000.00  |
| 12  | Wed | Subscription payment #1 $9.00 (fee 0.72)                           | 3,983.28 | 299.50  | 99.50   | 199.50  | 499.50  | 2.00   | 0.00     | 5,083.28 | 5,000.00  |
| 13  | Wed | Subscription payment #2 $9.00 (fee 0.72)                           | 3,991.56 | 299.50  | 99.50   | 199.50  | 499.50  | 2.00   | 0.00     | 5,091.56 | 5,000.00  |
| 14  | Wed | Subscription payment #3 $9.00 (fee 0.72)                           | 3,999.84 | 299.50  | 99.50   | 199.50  | 499.50  | 2.00   | 0.00     | 5,099.84 | 5,000.00  |
| 15  | Wed | Growth payout approved: $40.00 to contractor A (auto)              | 3,999.84 | 299.50  | 99.50   | 199.50  | 499.50  | 2.00   | 0.00     | 5,099.84 | 5,000.00  |
| 16  | Wed | Payout sent (fee 0.80)                                             | 3,999.84 | 299.50  | 99.50   | 199.50  | 458.70  | 2.00   | 0.00     | 5,059.04 | 5,000.00  |
| 17  | Thu | Internal invoice settled: Revenue -> Growth $25.00 listing rewrite | 3,999.84 | 324.50  | 99.50   | 199.50  | 433.70  | 2.00   | 0.00     | 5,059.04 | 5,000.00  |
| 18  | Fri | Refund Notion template $29.00 (fee not returned)                   | 3,970.84 | 324.50  | 99.50   | 199.50  | 433.70  | 2.00   | 0.00     | 5,030.04 | 5,000.00  |
| 19  | Sat | Dispute opened on Preset pack $49.00                               | 3,921.84 | 324.50  | 99.50   | 199.50  | 433.70  | 2.00   | 49.00    | 4,981.04 | 5,000.00  |
| 20  | Sat | Growth payout $120.00 held -> founder approves                     | 3,921.84 | 324.50  | 99.50   | 199.50  | 433.70  | 2.00   | 49.00    | 4,981.04 | 5,000.00  |
| 21  | Sat | Payout sent (fee 1.00)                                             | 3,921.84 | 324.50  | 99.50   | 199.50  | 312.70  | 2.00   | 49.00    | 4,860.04 | 5,000.00  |
| 22  | Sun | Dispute won: funds released                                        | 3,970.84 | 324.50  | 99.50   | 199.50  | 312.70  | 2.00   | 0.00     | 4,909.04 | 5,000.00  |
| 23  | Sun | Founder pays OpenAI bill $2.00 by card outside PayPal              | 3,972.84 | 324.50  | 99.50   | 199.50  | 312.70  | 0.00   | 0.00     | 4,909.04 | 5,002.00  |

End of week, P&L:

| Department | Revenue (ext.) | Internal in  | Refunds | Contractors | Internal out | AI    | Net                |
| ---------- | -------------- | ------------ | ------- | ----------- | ------------ | ----- | ------------------ |
| Revenue    | 105.00         | 25.00        | −29.00  | —           | —            | −0.50 | 100.50             |
| Finance    | —              | —            | —       | —           | —            | −0.50 | −0.50              |
| Support    | —              | —            | —       | —           | —            | −0.50 | −0.50              |
| Growth     | —              | —            | —       | −160.00     | −25.00       | −0.50 | −185.50            |
| Company    | 105.00         | (eliminated) | −29.00  | −160.00     | (eliminated) | −2.00 | −86.00 before fees |

PayPal fees for the week: $6.96 (checkout $5.16, payouts $1.80). Company net after fees: −$92.96.
Equity check: opening $5,000.00 + $2.00 founder-paid AI bill − $92.96 = $4,909.04 = closing treasury.

The test `packages/ledger/src/worked-example.test.ts` reproduces every step and balance above.
