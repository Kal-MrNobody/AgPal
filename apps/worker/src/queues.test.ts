import { describe, expect, it } from 'vitest';
import { allQueues } from './queues.js';

describe('queues', () => {
  it('have unique, dot-namespaced names', () => {
    const names = allQueues();
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z]+\.[a-z]+$/);
  });
});
