import { describe, expect, it } from 'vitest';
import { money } from '@agpal/shared';
import { formatMoney } from './format';

describe('formatMoney', () => {
  it('formats minor units for display', () => {
    expect(formatMoney(money(500_000n, 'USD'))).toBe('5000.00 USD');
  });
});
