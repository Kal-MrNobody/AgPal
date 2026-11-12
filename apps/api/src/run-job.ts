/** The slice of pg-boss the API needs to run a job in the worker and wait for its result. */
export interface JobQueue {
  send(name: string, data: object, options?: { retryLimit?: number }): Promise<string | null>;
  getJobById(name: string, id: string): Promise<{ state: string; output?: unknown } | null>;
}

/**
 * Enqueue one job and wait (bounded) for the worker to finish it. Resolves with the handler's return value, rejects
 * with the handler's error message, or times out (the job stays queued and still runs; the caller reloads later).
 */
export async function runAndWait<R>(
  queue: JobQueue,
  name: string,
  data: object,
  { timeoutMs = 20_000, pollMs = 200 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<R> {
  const id = await queue.send(name, data, { retryLimit: 0 });
  if (!id) throw new Error(`could not enqueue ${name}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await queue.getJobById(name, id);
    if (job?.state === 'completed') return job.output as R;
    if (job?.state === 'failed' || job?.state === 'cancelled') {
      const out = job.output as { message?: unknown } | undefined;
      throw new Error(typeof out?.message === 'string' ? out.message : `${name} failed`);
    }
    if (Date.now() > deadline)
      throw new Error(`${name} is still running in the worker; reload shortly`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
