import { describe, expect, it } from 'vitest';
import { runAndWait, type JobQueue } from './run-job.js';

const queue = (states: { state: string; output?: unknown }[]): JobQueue & { sent: object[] } => {
  const sent: object[] = [];
  let i = 0;
  return {
    sent,
    send: (_n, data) => {
      sent.push(data);
      return Promise.resolve('job-1');
    },
    getJobById: () => Promise.resolve(states[Math.min(i++, states.length - 1)] ?? null),
  };
};

describe('runAndWait (API → worker)', () => {
  it('returns the worker result once the job completes', async () => {
    const q = queue([
      { state: 'created' },
      { state: 'active' },
      { state: 'completed', output: { ok: 1 } },
    ]);
    await expect(runAndWait(q, 'schedule.apply', { a: 1 }, { pollMs: 1 })).resolves.toEqual({
      ok: 1,
    });
    expect(q.sent).toEqual([{ a: 1 }]);
  });
  it("surfaces the worker's error message", async () => {
    const q = queue([
      { state: 'failed', output: { message: 'Launch is not a payment milestone' } },
    ]);
    await expect(runAndWait(q, 'schedule.apply', {}, { pollMs: 1 })).rejects.toThrow(
      /not a payment milestone/,
    );
  });
  it('times out without losing the job', async () => {
    const q = queue([{ state: 'active' }]);
    await expect(runAndWait(q, 'schedule.apply', {}, { pollMs: 1, timeoutMs: 5 })).rejects.toThrow(
      /still running/,
    );
  });
});
