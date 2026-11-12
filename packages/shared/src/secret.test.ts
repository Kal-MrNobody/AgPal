import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Secret } from './secret.js';

describe('Secret', () => {
  const s = new Secret('sk-very-secret');

  it('reveals only on request', () => {
    expect(s.reveal()).toBe('sk-very-secret');
  });

  it('never leaks through string conversion, JSON or inspect', () => {
    const out = [
      String(s),
      s.toString(),
      JSON.stringify({ s }),
      inspect(s),
      inspect({ nested: { s } }),
    ].join(' ');
    expect(out).not.toContain('sk-very-secret');
  });
});
