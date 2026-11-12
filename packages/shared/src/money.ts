/**
 * Invariant 2: money is integer minor units + ISO 4217 currency code. Never floats.
 *
 * Amounts are `bigint` so a JS `number` (and therefore a float) can never be
 * assigned to one by accident. See docs/decisions.md ADR-002.
 */

/** Minor-unit exponent per currency, as PayPal accepts it. HUF and TWD take no decimals on PayPal. */
const EXPONENTS = {
  AUD: 2,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HUF: 0,
  ILS: 2,
  JPY: 0,
  MXN: 2,
  MYR: 2,
  NOK: 2,
  NZD: 2,
  PHP: 2,
  PLN: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TWD: 0,
  USD: 2,
} as const satisfies Record<string, number>;

export type Currency = keyof typeof EXPONENTS;

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

export class MoneyError extends Error {
  override name = 'MoneyError';
}

export function isCurrency(code: string): code is Currency {
  return Object.hasOwn(EXPONENTS, code);
}

export function currencyExponent(currency: Currency): number {
  return EXPONENTS[currency];
}

export function money(amountMinor: bigint, currency: Currency): Money {
  if (typeof amountMinor !== 'bigint') throw new MoneyError('amountMinor must be a bigint');
  if (!isCurrency(currency)) throw new MoneyError(`Unsupported currency: ${String(currency)}`);
  return Object.freeze({ amountMinor, currency });
}

export const zero = (currency: Currency): Money => money(0n, currency);

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function sum(items: readonly Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

export const isZero = (a: Money): boolean => a.amountMinor === 0n;
export const isNegative = (a: Money): boolean => a.amountMinor < 0n;

/**
 * Parse a decimal string as PayPal returns it ("12.34", "-0.50", "1000") into minor units.
 * Rejects more fractional digits than the currency allows rather than rounding.
 */
export function parseDecimal(value: string, currency: Currency): Money {
  const exp = currencyExponent(currency);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new MoneyError(`Not a decimal amount: "${value}"`);
  const [, sign, whole = '0', frac = ''] = match;
  if (frac.length > exp) {
    throw new MoneyError(`"${value}" has more than ${exp} decimal places for ${currency}`);
  }
  const minor = BigInt(whole) * 10n ** BigInt(exp) + BigInt(frac.padEnd(exp, '0') || '0');
  return money(sign ? -minor : minor, currency);
}

/** Format minor units as the decimal string PayPal expects ("12.34", "1000" for JPY). */
export function toDecimal(m: Money): string {
  const exp = currencyExponent(m.currency);
  const negative = m.amountMinor < 0n;
  const abs = negative ? -m.amountMinor : m.amountMinor;
  if (exp === 0) return `${negative ? '-' : ''}${abs}`;
  const base = 10n ** BigInt(exp);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(exp, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** JSON-safe wire form. bigint does not survive JSON.stringify, so amounts travel as strings. */
export interface MoneyJson {
  amountMinor: string;
  currency: Currency;
}

export const toJson = (m: Money): MoneyJson => ({
  amountMinor: m.amountMinor.toString(),
  currency: m.currency,
});

export function fromJson(j: MoneyJson): Money {
  if (!/^-?\d+$/.test(j.amountMinor))
    throw new MoneyError(`Invalid amountMinor: "${j.amountMinor}"`);
  return money(BigInt(j.amountMinor), j.currency);
}
