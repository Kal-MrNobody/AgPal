import { describe, expect, it } from 'vitest';
import { baseUrlFor } from './index.js';

describe('baseUrlFor', () => {
  it('maps environments to PayPal REST hosts', () => {
    expect(baseUrlFor('sandbox')).toBe('https://api-m.sandbox.paypal.com');
    expect(baseUrlFor('live')).toBe('https://api-m.paypal.com');
  });
});
