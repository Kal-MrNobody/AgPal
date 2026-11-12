/**
 * pnpm approvals                          list pending founder approvals
 * pnpm approvals approve <id> [--note x]  approve (deny rules are re-checked, then it executes)
 * pnpm approvals reject <id> [--note x]   reject and release the hold
 * Options: --company <id> (defaults to AGPAL_COMPANY_ID)
 */
import { and, eq } from 'drizzle-orm';
import { approvals } from '@agpal/db';
import { arg, context, usd } from './lib.js';

const ctx = await context();
const note = arg('note') ?? '';
const companyId = arg('company') ?? ctx.env.AGPAL_COMPANY_ID;
const positional = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const [cmd, id] = positional;

if (!cmd || cmd === 'list') {
  const rows = await ctx.db
    .select()
    .from(approvals)
    .where(
      companyId
        ? and(eq(approvals.status, 'pending'), eq(approvals.companyId, companyId))
        : eq(approvals.status, 'pending'),
    );
  if (rows.length === 0) console.log('No pending approvals.');
  for (const r of rows) {
    const i = r.intent as {
      action: string;
      amountMinor: string;
      envelope: string;
      payee?: string;
      agentId: string;
      reason: string;
    };
    console.log(
      `${r.id}  ${i.action} ${usd(BigInt(i.amountMinor))} from ${i.envelope}${i.payee ? ` → ${i.payee}` : ''}\n` +
        `    rule: ${r.rule} — ${r.explanation}\n    agent ${i.agentId}: ${i.reason}`,
    );
  }
} else if (cmd === 'approve' && id) {
  const r = await ctx.s.gate.approve(id, 'founder', note);
  console.log(
    `${r.status}: ${r.decision.rule} — ${r.decision.explanation}${r.externalRef ? ` (PayPal ${r.externalRef})` : ''}`,
  );
} else if (cmd === 'reject' && id) {
  await ctx.s.gate.reject(id, 'founder', note);
  console.log('rejected; hold released');
} else {
  console.log(
    'usage: pnpm approvals [list | approve <id> | reject <id>] [--note text] [--company id]',
  );
}
await ctx.db.$client.end();
