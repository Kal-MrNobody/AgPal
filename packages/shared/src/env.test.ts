import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './env';

const base = {
  DATABASE_URL: 'postgres://agpal:agpal@localhost:5432/agpal',
  PAYPAL_CLIENT_ID: 'client-id',
  PAYPAL_CLIENT_SECRET: 'top-secret-value',
};

describe('loadEnv', () => {
  it('parses a valid env with defaults and wraps secrets', () => {
    const env = loadEnv(base);
    expect(env.PAYPAL_ENVIRONMENT).toBe('sandbox');
    expect(env.API_PORT).toBe(4000);
    expect(env.PAYPAL_CLIENT_SECRET.reveal()).toBe('top-secret-value');
    expect(JSON.stringify(env)).not.toContain('top-secret-value');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('accepts legacy variable names, canonical names win', () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      Client_ID: 'legacy-id',
      Secret_key_1: 'legacy-secret',
    });
    expect(env.PAYPAL_CLIENT_ID).toBe('legacy-id');
    expect(env.PAYPAL_CLIENT_SECRET.reveal()).toBe('legacy-secret');
    expect(loadEnv({ ...base, Client_ID: 'legacy-id' }).PAYPAL_CLIENT_ID).toBe('client-id');
  });

  it('fails loudly, naming variables without echoing values', () => {
    const bad = { ...base, PAYPAL_ENVIRONMENT: 'production-oops', PAYPAL_CLIENT_SECRET: '' };
    expect(() => loadEnv(bad)).toThrow(EnvError);
    try {
      loadEnv(bad);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('PAYPAL_CLIENT_SECRET');
      expect(msg).toContain('PAYPAL_ENVIRONMENT');
      expect(msg).not.toContain('production-oops');
    }
  });
});
