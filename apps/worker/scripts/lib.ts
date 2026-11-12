import { createDb, runMigrations, type Database } from '@agpal/db';
import { isTreasuryAccount } from '@agpal/ledger';
import { createServices, type Services } from '@agpal/policy';
import { loadEnv, money, toDecimal, type Env } from '@agpal/shared';

export interface Ctx {
  env: Env;
  db: Database;
  s: Services;
}

export async function context(
  opts: { dry?: boolean; payoutSettleWaitMs?: number } = {},
): Promise<Ctx> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL, { max: 5 });
  await runMigrations(db);
  const s = createServices(db, env, {
    ...(env.AGPAL_COMPANY_ID ? { defaultCompanyId: env.AGPAL_COMPANY_ID } : {}),
    ...(opts.dry !== undefined ? { dry: opts.dry } : {}),
    payoutSettleWaitMs: opts.payoutSettleWaitMs ?? 90_000,
  });
  return { env, db, s };
}

export const usd = (minor: bigint): string => `$${toDecimal(money(minor, 'USD'))}`;

export function arg(name: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = process.argv[i] ?? '';
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (process.argv[i + 1] ?? '');
}

export const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Print every non-zero ledger balance, the envelopes and the treasury total. */
export async function printBalances(s: Services, companyId: string, title: string): Promise<void> {
  const b = await s.ledger.balances(companyId);
  const rows = [...b].sort(([a], [c]) => a.localeCompare(c));
  let treasury = 0n;
  console.log(`\n  ── ${title}`);
  for (const [code, v] of rows) {
    if (isTreasuryAccount(code)) treasury += v;
    console.log(`     ${code.padEnd(40)} ${usd(v).padStart(12)}`);
  }
  for (const dept of ['revenue', 'finance', 'support', 'growth']) {
    const e = await s.ledger.envelope(companyId, dept).catch(() => undefined);
    if (e && (e.balance !== 0n || e.held !== 0n)) {
      console.log(
        `     envelope ${dept.padEnd(31)} balance ${usd(e.balance)}  held ${usd(e.held)}  available ${usd(e.available)}`,
      );
    }
  }
  console.log(
    `     ${'TREASURY (should equal PayPal available)'.padEnd(40)} ${usd(treasury).padStart(12)}`,
  );
}
