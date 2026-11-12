/**
 * pnpm agent:run <agentId | department> [--company id] [--note "why"] — run one agent now (manual trigger) with the real model
 * provider, and print its tool calls, summary and cost. In the cloud dev environment set NODE_USE_ENV_PROXY=1 so the
 * OpenAI call goes through the proxy that injects the key.
 */
import { createAgentRuntime } from '@agpal/agents';
import { agents } from '@agpal/db';
import { and, eq } from 'drizzle-orm';
import { arg, context, usd } from './lib.js';

const ctx = await context();
const target = process.argv
  .slice(2)
  .find((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
if (!target) throw new Error('usage: pnpm agent:run <agentId | department>');
/** A department name (revenue, finance, support, growth) resolves to that department's agent in the company. */
async function resolveAgentId(t: string): Promise<string> {
  if (t.startsWith('agt_')) return t;
  const companyId = arg('company') ?? ctx.env.AGPAL_COMPANY_ID;
  if (!companyId) throw new Error('a department name needs --company or AGPAL_COMPANY_ID');
  const [row] = await ctx.db
    .select({ id: agents.id, title: agents.title })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.department, t.toLowerCase())));
  if (!row) throw new Error(`no ${t} agent in ${companyId}`);
  console.log(`agent ${row.id} (${row.title})`);
  return row.id;
}
const agentId = await resolveAgentId(target);
const { runtime } = createAgentRuntime(
  ctx.db,
  ctx.s,
  ctx.env.OPENAI_API_KEY ? { openaiApiKey: ctx.env.OPENAI_API_KEY.reveal() } : {},
);
const note = arg('note');
const r = await runtime.run(agentId, { kind: 'manual', ...(note ? { note } : {}) });
console.log(`run ${r.runId}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
for (const c of r.toolCalls)
  console.log(`  tool ${c.name} ${JSON.stringify(c.args)} → ${JSON.stringify(c.result)}`);
console.log(`summary: ${r.summary ?? ''}`);
console.log(`cost: ${r.costMicros} µ$ → booked ${usd(r.costMinor)}`);
await ctx.db.$client.end();
