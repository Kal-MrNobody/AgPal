import { api } from '../../../lib/server';

/** CrudManager load for the boardroom Gantt (founder session → apps/api). */
export async function GET() {
  try {
    return Response.json(await api('/api/schedule'));
  } catch {
    return Response.json({ success: false, message: 'unauthorized' }, { status: 401 });
  }
}
