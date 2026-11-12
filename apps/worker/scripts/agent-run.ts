/**
 * pnpm agent:run <agentId> [--company id] [--note "why"] — run one agent now (manual trigger) with the real model
 * provider, and print its tool calls, summary and cost. In the cloud dev environment set NODE_USE_ENV_PROXY=1 so the
 * OpenAI call goes through the proxy that injects the key.
 */
import { createAgentRuntime } from '@agpal/agents';
import { arg, context, usd } from './lib.js';

const ctx = await context();
const agentId = process.argv
  .slice(2)
  .find((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
if (!agentId) throw new Error('usage: pnpm agent:run <agentId>');
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
