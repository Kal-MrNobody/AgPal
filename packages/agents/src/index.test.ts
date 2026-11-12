import { describe, expect, it } from 'vitest';
import { isDepartment } from './index.js';

describe('departments', () => {
  it('starts with the four launch departments', () => {
    expect(['revenue', 'finance', 'support', 'growth'].every(isDepartment)).toBe(true);
    expect(isDepartment('procurement')).toBe(false);
  });
});
