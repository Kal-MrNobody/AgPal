import { isFounder } from '../../../../lib/server';

/**
 * Browser → here (founder session) → apps/api /api/ai/responses (admin token) → OpenAI. The Studio adapter posts to
 * `${endpoint}/responses` with endpoint `/api/ai`; no key ever reaches the browser. The SSE stream is passed through.
 */
export async function POST(req: Request) {
  if (!(await isFounder()))
    return Response.json({ error: { message: 'Sign in as the founder.' } }, { status: 401 });
  const upstream = await fetch(
    `${process.env.AGPAL_API_URL ?? (process.env.AGPAL_API_HOSTPORT ? `http://${process.env.AGPAL_API_HOSTPORT}` : 'http://localhost:4000')}/api/ai/responses`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agpal-admin': process.env.AGPAL_ADMIN_TOKEN ?? '',
      },
      body: await req.text(),
      signal: req.signal,
    },
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}
