import { scale, type PolicyConfig } from './config.js';
import type { Decision, SpendIntent } from './intent.js';

/**
 * Everything the rules need, gathered by the gate under locks. Pure data: the rules are a pure function
 * of (config, intent, facts), which makes them deterministic and table-testable.
 */
export interface Facts {
  companyKillSwitch: boolean;
  agentPaused: boolean;
  autonomyLevel: number;
  /** Funds the intent would draw on: envelope available, or unallocated for allocations/refunds. */
  fundsAvailableMinor: bigint;
  /** Amount already approved or held today on this envelope for this action (excluding this intent). */
  spentTodayMinor: bigint;
  /** Intents by this agent for this action inside the velocity window (excluding this intent). */
  recentCount: number;
  payeeAllowlisted: boolean;
  payeeHasPriorPayout: boolean;
  /** Refunds: amount still refundable on the original capture; undefined if the capture is unknown. */
  refundableMinor?: bigint;
  /** True when the founder is approving a held intent: hold rules no longer apply. */
  founderApproved?: boolean;
}

const fmt = (m: bigint): string => {
  const s = (m < 0n ? -m : m).toString().padStart(3, '0');
  return `${m < 0n ? '-' : ''}$${s.slice(0, -2)}.${s.slice(-2)}`;
};

const deny = (rule: string, explanation: string): Decision => ({
  outcome: 'deny',
  rule,
  explanation,
});
const hold = (rule: string, explanation: string): Decision => ({
  outcome: 'hold_for_founder',
  rule,
  explanation,
});

/** Actions whose money comes out of the requesting department's envelope. */
export const drawsOnEnvelope = (action: SpendIntent['action']): boolean =>
  action === 'payout' || action === 'internal_invoice';

/** Actions that move no money themselves. */
export const movesNoMoney = (action: SpendIntent['action']): boolean =>
  action === 'price_change' || action === 'subscription_change';

export function decide(config: PolicyConfig, intent: SpendIntent, f: Facts): Decision {
  // 1. Deny rules. Always evaluated, including at founder approval time.
  if (f.companyKillSwitch)
    return deny('kill_switch.company', 'The company-wide kill switch is on.');
  if (f.agentPaused) return deny('kill_switch.agent', `Agent ${intent.agentId} is paused.`);
  if (intent.currency !== config.currency) {
    return deny(
      'currency',
      `Envelopes are in ${config.currency}; intent is in ${intent.currency}.`,
    );
  }
  const rules = config.envelopes[intent.envelope];
  if (!rules) return deny('envelope.unknown', `No envelope rules for "${intent.envelope}".`);
  if (!rules.actions.includes(intent.action)) {
    return deny(
      'action.not_allowed',
      `The ${intent.envelope} envelope may not ${intent.action.replace('_', ' ')}.`,
    );
  }
  if (rules.categories && !rules.categories.includes(intent.category ?? '')) {
    return deny(
      'category.not_allowed',
      `Category "${intent.category ?? '(none)'}" is not allowed for ${intent.envelope}; allowed: ${rules.categories.join(', ')}.`,
    );
  }
  if ((intent.action === 'allocation' || intent.action === 'internal_invoice') && !intent.target) {
    return deny('target.missing', `A ${intent.action} needs a receiving department.`);
  }
  if (intent.action === 'internal_invoice' && intent.target === intent.envelope) {
    return deny('target.self', 'A department cannot invoice itself.');
  }
  const level = config.autonomy.find((a) => a.level === f.autonomyLevel) ?? config.autonomy[1];
  if (!level) return deny('autonomy.unknown', `Unknown autonomy level ${f.autonomyLevel}.`);

  if (rules.perTxCapMinor !== null) {
    const cap = scale(rules.perTxCapMinor, level.capMultiplierBps);
    if (intent.amountMinor > cap) {
      return deny(
        'cap.per_tx',
        `${fmt(intent.amountMinor)} is over the ${fmt(cap)} per-transaction cap (autonomy level ${level.level}).`,
      );
    }
  }
  if (intent.action === 'payout' && rules.payeePolicy === 'allowlist') {
    if (!intent.payee) return deny('payee.missing', 'A payout needs a payee.');
    if (!f.payeeAllowlisted) {
      return deny(
        'payee.not_allowlisted',
        `${intent.payee} is not on the founder-approved payee list.`,
      );
    }
  }
  if (intent.action === 'refund') {
    if (!intent.payee) return deny('refund.no_order', 'A refund must name the original capture.');
    if (f.refundableMinor === undefined)
      return deny('refund.unknown_order', `No captured payment ${intent.payee}.`);
    if (intent.amountMinor > f.refundableMinor) {
      return deny(
        'refund.over_captured',
        `${fmt(intent.amountMinor)} is more than the ${fmt(f.refundableMinor)} still refundable on the order.`,
      );
    }
  }
  if (!movesNoMoney(intent.action)) {
    const needed =
      intent.amountMinor + (intent.action === 'payout' ? config.payoutFeeBufferMinor : 0n);
    if (f.fundsAvailableMinor < needed) {
      return deny(
        'funds.insufficient',
        `Needs ${fmt(needed)} (incl. fee buffer); ${fmt(f.fundsAvailableMinor)} available.`,
      );
    }
  }

  if (f.founderApproved)
    return {
      outcome: 'approve',
      rule: 'founder.approved',
      explanation: 'Approved by the founder.',
    };

  // 2. Hold rules.
  if (rules.alwaysHold.includes(intent.action)) {
    return hold('always_hold', `Every ${intent.action.replace('_', ' ')} needs founder approval.`);
  }
  if (intent.action === 'payout' && rules.holdFirstPayoutToNewPayee && !f.payeeHasPriorPayout) {
    return hold(
      'payee.first_payout',
      `First payout to ${intent.payee ?? 'this payee'} needs founder approval.`,
    );
  }
  const daily = scale(rules.dailyCapMinor, level.capMultiplierBps);
  if (f.spentTodayMinor + intent.amountMinor > daily) {
    return hold(
      'cap.daily',
      `This would bring today's ${intent.action} total to ${fmt(f.spentTodayMinor + intent.amountMinor)}, over the ${fmt(daily)} daily cap.`,
    );
  }
  if (f.recentCount >= rules.velocity.max) {
    return hold(
      'velocity',
      `${f.recentCount} ${intent.action}s in the last ${rules.velocity.windowMinutes} minutes; limit ${rules.velocity.max}.`,
    );
  }
  const auto = scale(rules.autoApproveUpToMinor, level.autoApproveMultiplierBps);
  if (intent.amountMinor > auto) {
    return hold(
      'approval_threshold',
      `${fmt(intent.amountMinor)} is over the ${fmt(auto)} auto-approve limit (autonomy level ${level.level}).`,
    );
  }
  return {
    outcome: 'approve',
    rule: 'within_policy',
    explanation: `Within ${intent.envelope} policy at autonomy level ${level.level}.`,
  };
}
