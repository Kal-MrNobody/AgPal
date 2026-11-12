import { api } from '../../../../lib/server';

/** Founder edits from the Gantt go to the server, where the engine recalculates (same path as agents). */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    taskId?: string;
    constraintDate?: string;
    receivedOn?: string;
  };
  if (!body.taskId) return Response.json({ error: 'taskId required' }, { status: 400 });
  try {
    return Response.json(await api('/api/schedule/change', { method: 'POST', body }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 400 });
  }
}
