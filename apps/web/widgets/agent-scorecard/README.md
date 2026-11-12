# Agent scorecard

One card per AI employee: autonomy level (📌 when pinned by the founder), trust score and its inputs — accepted work,
reversals, approvals, holds and denials — plus AI cost and run count. Trust is computed from the ledger and gate record
(`packages/policy/src/autonomy.ts`), never from the model.
