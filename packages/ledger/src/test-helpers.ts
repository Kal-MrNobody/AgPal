import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { newId } from '@agpal/shared';
import { Ledger } from './ledger.js';

export const DEPARTMENTS = [
  { code: 'revenue', name: 'Revenue' },
  { code: 'finance', name: 'Finance' },
  { code: 'support', name: 'Support' },
  { code: 'growth', name: 'Growth' },
] as const;

export const hasDatabase = (): boolean => Boolean(process.env.DATABASE_URL);

export async function setupLedger(): Promise<{
  t: TestDatabase;
  ledger: Ledger;
  companyId: string;
}> {
  const t = await createTestDatabase();
  const ledger = new Ledger(t.db);
  const companyId = newId('co');
  await ledger.setupCompany({
    id: companyId,
    name: 'Test Shop',
    currency: 'USD',
    departments: DEPARTMENTS,
  });
  return { t, ledger, companyId };
}
