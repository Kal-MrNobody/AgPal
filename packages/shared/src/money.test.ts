import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  add,
  compare,
  fromJson,
  money,
  MoneyError,
  negate,
  parseDecimal,
  subtract,
  sum,
  toDecimal,
  toJson,
} from './money';

describe('money', () => {
  it('parses PayPal decimal strings into minor units', () => {
    expect(parseDecimal('12.34', 'USD').amountMinor).toBe(1234n);
    expect(parseDecimal('0.5', 'USD').amountMinor).toBe(50n);
    expect(parseDecimal('-3.07', 'EUR').amountMinor).toBe(-307n);
    expect(parseDecimal('1000', 'JPY').amountMinor).toBe(1000n);
  });

  it('refuses to round extra precision', () => {
    expect(() => parseDecimal('1.005', 'USD')).toThrow(MoneyError);
    expect(() => parseDecimal('10.5', 'JPY')).toThrow(MoneyError);
    expect(() => parseDecimal('1e3', 'USD')).toThrow(MoneyError);
    expect(() => parseDecimal('', 'USD')).toThrow(MoneyError);
  });

  it('formats minor units as PayPal decimals', () => {
    expect(toDecimal(money(1234n, 'USD'))).toBe('12.34');
    expect(toDecimal(money(5n, 'USD'))).toBe('0.05');
    expect(toDecimal(money(-5n, 'USD'))).toBe('-0.05');
    expect(toDecimal(money(1000n, 'JPY'))).toBe('1000');
  });

  it('rejects non-bigint amounts at runtime', () => {
    expect(() => money(12.5 as unknown as bigint, 'USD')).toThrow(MoneyError);
  });

  it('rejects mixed-currency arithmetic', () => {
    expect(() => add(money(1n, 'USD'), money(1n, 'EUR'))).toThrow(MoneyError);
  });

  it('sums and compares', () => {
    const total = sum([money(100n, 'USD'), money(250n, 'USD'), negate(money(50n, 'USD'))], 'USD');
    expect(total.amountMinor).toBe(300n);
    expect(compare(total, money(300n, 'USD'))).toBe(0);
    expect(subtract(total, money(301n, 'USD')).amountMinor).toBe(-1n);
  });

  const amount = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });

  it('decimal formatting round-trips for every amount (property)', () => {
    fc.assert(
      fc.property(
        amount,
        fc.constantFrom('USD' as const, 'JPY' as const, 'TWD' as const),
        (n, cur) => {
          const m = money(n, cur);
          expect(parseDecimal(toDecimal(m), cur)).toEqual(m);
        },
      ),
    );
  });

  it('JSON wire form round-trips (property)', () => {
    fc.assert(
      fc.property(amount, (n) => {
        const m = money(n, 'USD');
        expect(
          fromJson(JSON.parse(JSON.stringify(toJson(m))) as ReturnType<typeof toJson>),
        ).toEqual(m);
      }),
    );
  });
});
