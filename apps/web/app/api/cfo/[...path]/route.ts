import { api } from '../../../../lib/server';

const ALLOWED = /^(envelope\/(revenue|finance|support|growth)|compare|approvals|reconciliation)$/;

/** Read-only CFO tool endpoints, proxied with the founder session. */
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  if (!ALLOWED.test(path))
    return Response.json({ error: 'unknown tool endpoint' }, { status: 404 });
  try {
    return Response.json(await api(`/api/cfo/${path}`));
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
}
