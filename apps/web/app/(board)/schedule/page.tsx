import { api } from '../../../lib/server';
import type { BoardroomData } from '../../../lib/types';
import { TimeViewsClient } from './client';

export const dynamic = 'force-dynamic';

export default async function SchedulePage() {
  const data = await api<BoardroomData>('/api/boardroom');
  const plan = await api<{
    tasks: { rows: { id: string; name: string; constraintDate?: string; cls?: string }[] };
  }>('/api/schedule');
  const payments = plan.tasks.rows
    .filter((t) => t.cls === 'payment-milestone')
    .map((t) => ({
      id: t.id,
      name: t.name,
      ...(t.constraintDate ? { constraintDate: t.constraintDate } : {}),
    }));
  return (
    <>
      <header className="pagehead">
        <h1>Schedule</h1>
        <span className="muted">
          Bryntum 8 · dates computed on the server by the headless engine
        </span>
      </header>
      <TimeViewsClient data={data} payments={payments} />
    </>
  );
}
