'use server';

import { revalidatePath } from 'next/cache';
import { api } from '../lib/server';
import type { BoardroomData } from '../lib/types';

export async function refreshData(): Promise<BoardroomData> {
  return api<BoardroomData>('/api/boardroom');
}

export async function decideApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
  note: string,
): Promise<{ status: string; explanation?: string }> {
  if (!/^apr_[a-f0-9]{32}$/.test(approvalId)) throw new Error('bad id');
  const r = await api<{ status: string; explanation?: string }>(
    `/api/approvals/${approvalId}/${decision}`,
    { method: 'POST', body: { note: note.slice(0, 500) } },
  );
  revalidatePath('/', 'layout');
  return r;
}

/** Batch-approve every held spend at or under `maxDollars` (each re-checked by the gate). */
export async function batchApprove(
  maxDollars: number,
): Promise<{ approved: { approvalId: string; status: string; rule: string }[] }> {
  const maxMinor = String(Math.round(Math.min(Math.max(maxDollars, 0), 500) * 100));
  const r = await api<{ approved: { approvalId: string; status: string; rule: string }[] }>(
    '/api/approvals/batch',
    {
      method: 'POST',
      body: { maxMinor, note: `batch-approved (up to $${maxDollars})` },
    },
  );
  revalidatePath('/', 'layout');
  return r;
}
