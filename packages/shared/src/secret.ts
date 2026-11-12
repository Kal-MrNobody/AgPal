/**
 * Invariant 6: secrets come only from env, are never logged and never sent to an LLM.
 *
 * A Secret hides its value from toString, JSON.stringify, util.inspect and template
 * literals. Call `.reveal()` only at the point of use (e.g. building an auth header).
 */
const REDACTED = '[redacted]';
const values = new WeakMap<Secret, string>();

export class Secret {
  constructor(value: string) {
    values.set(this, value);
    Object.freeze(this);
  }
  reveal(): string {
    const v = values.get(this);
    if (v === undefined) throw new Error('Secret has no value');
    return v;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}
