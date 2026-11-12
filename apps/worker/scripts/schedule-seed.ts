/** pnpm schedule:seed [--company id] — seed a demo plan (payment milestones gating launches) and compute its dates. */
import { ScheduleService } from '@agpal/schedule';
import { arg, context } from './lib.js';

const ctx = await context();
const companyId = arg('company') ?? ctx.env.AGPAL_COMPANY_ID;
if (!companyId) throw new Error('--company or AGPAL_COMPANY_ID is required');
await new ScheduleService(ctx.db).seedDemo(companyId);
console.log(`Seeded the demo plan for ${companyId}; dates computed by the headless engine.`);
await ctx.db.$client.end();
