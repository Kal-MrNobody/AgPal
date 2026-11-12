import { toDecimal, type Money } from '@agpal/shared';

/** Display formatting only. Arithmetic always stays in bigint minor units. */
export function formatMoney(m: Money): string {
  return `${toDecimal(m)} ${m.currency}`;
}
