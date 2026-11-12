import { NextResponse } from 'next/server';

/** Liveness for the platform health check (no data, no auth). */
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
