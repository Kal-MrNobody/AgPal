# Headless schedule recalculation with Bryntum Gantt 8 (Node, no browser)

**Status: works.** `ProjectModel` from `@bryntum/gantt-enterprise@8.0.1` (public npm, trial mode, no licence key)
loads and recalculates in Node with no DOM. There is no separate `gantt.node.mjs` in 8.0; deep-importing the data
model (`@bryntum/gantt-enterprise/lib/Gantt/model/ProjectModel.js`) avoids loading any UI widget.

## The model (as Bryntum's team recommended)

- Each expected payment is its own **zero-duration milestone**, named like "Payment received: INV-123".
- It links to the milestone it gates with a **Finish-to-Start dependency** (dependencies only connect tasks — a payment
  is never a constraint on another entity or an event).
- The expected payment date is a **`startnoearlierthan` constraint** (`constraintDate`) on the payment milestone.
- **Settlement delay is the dependency's lag**, not a padded date.
- When a payment slips, change **only that milestone's `constraintDate`** and let the engine reschedule everything
  downstream. When it lands, mark the milestone done at the actual date.

## Standalone example

`examples/bryntum-headless/` — three tasks, one payment milestone slipping, dates recalculated in Node:

```bash
cd examples/bryntum-headless && npm install && npm start
```

Expected output (dates are what the engine computes; the test suite asserts the same numbers):

```
Initial plan                      payment 11-20 → launch 11-22 (2-day settlement lag) → contractor after launch
After the payment slips to 11-25  payment 11-25 → launch 11-27 → contractor moves by 5 days
After the payment lands on 11-24  payment 11-24, 100% done → downstream follows
```

## How AgPal uses it

- `packages/schedule/src/headless.ts` — `recalculate(plan, changes)`: builds a `ProjectModel`, applies one change,
  awaits `commitAsync()`, returns every task's dates and which ones changed.
- `packages/schedule/src/service.ts` — `ScheduleService.apply()`: the **one server path**. Loads the company plan,
  applies the change, waits for the engine, writes every recalculated date **and** the audit entry in one database
  transaction. Used by the agents' `shift_expected_payment` / `mark_payment_received` tools (apps/worker) and by
  founder edits from the boardroom (`POST /api/schedule/change`).
- The browser Gantt (`apps/web/components/time-views.tsx`, React wrapper `@bryntum/gantt-react-enterprise`) only
  **loads and displays** the server's dates through Bryntum's CrudManager (`loadUrl: /api/schedule`), read-only, with
  tasks manually scheduled so it never recomputes. It uses Bryntum's direct JavaScript API; no WebMCP.
- Tests: `packages/schedule/src/headless.test.ts` (engine in Node) and `service.test.ts` (with no browser open,
  changing one payment's `constraintDate` recalculates every dependent milestone on the server, the CrudManager load
  returns exactly the server's dates, and the change is in the audit trail with agent and run ids).

## Notes for the Bryntum team

- Deep import of `ProjectModel` worked first time in Node 22 with the 8.0.1 enterprise package in trial mode.
- `commitAsync()` resolves after propagation; destroying the project afterwards keeps memory flat across calls.
- Scheduler Pro 8 is not on public npm; the agent timeline uses `@bryntum/scheduler-react-enterprise@8.0.1`.
