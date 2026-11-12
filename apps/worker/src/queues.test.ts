import { describe, expect, it } from 'vitest';
import { SCHEDULE_QUEUE } from '@agpal/schedule';
import { allQueues, QUEUES } from './queues.js';

describe('queues', () => {
  it('have unique, dot-namespaced names', () => {
    const names = allQueues();
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z]+\.[a-z]+$/);
  });
  it('the schedule queue is the one the API sends founder edits to', () => {
    expect(QUEUES.scheduleApply).toBe(SCHEDULE_QUEUE);
  });
});
