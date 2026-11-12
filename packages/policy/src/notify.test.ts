import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals } from '@agpal/db';
import { createTestDatabase, type TestDatabase } from '@agpal/db/testing';
import { ACC, Ledger } from '@agpal/ledger';
import { newId, Secret } from '@agpal/shared';
import { Gate } from './gate.js';
import {
  announcePendingApprovals,
  handleTelegramCallback,
  signCallback,
  TelegramChannel,
  verifyCallback,
  type TelegramUpdate,
} from './notify.js';
import { FakePayments } from './ports.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const webhookSecret = new Secret('wh-secret-123');
const callbackSecret = new Secret('cb-secret-456');
const FOUNDER_CHAT = '1001';
const FOUNDER_USER = '42';

describe('signed callback data', () => {
  const id = `apr_${'a'.repeat(32)}`;
  it('fits Telegram’s 64-byte limit and round-trips', () => {
    const d = signCallback(callbackSecret, 'approve', id);
    expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
    expect(verifyCallback(callbackSecret, d)).toEqual({ decision: 'approve', approvalId: id });
  });
  it('rejects a flipped decision, another approval id or another secret', () => {
    const d = signCallback(callbackSecret, 'reject', id);
    expect(verifyCallback(callbackSecret, d.replace(/^r/, 'a'))).toBeUndefined();
    expect(verifyCallback(callbackSecret, d.replace('aaaa', 'bbbb'))).toBeUndefined();
    expect(verifyCallback(new Secret('other'), d)).toBeUndefined();
  });
});

describe.runIf(hasDb)('Telegram approvals', () => {
  let t: TestDatabase;
  let gate: Gate;
  let ledger: Ledger;
  let co: string;
  let approvalId: string;
  let payments: FakePayments;

  const update = (
    data: string,
    opts: { id?: string; chat?: string; user?: string } = {},
  ): TelegramUpdate => ({
    callback_query: {
      id: opts.id ?? newId('cq'),
      data,
      from: { id: Number(opts.user ?? FOUNDER_USER) },
      message: { chat: { id: Number(opts.chat ?? FOUNDER_CHAT) } },
    },
  });
  const deps = () => ({
    db: t.db,
    gate,
    webhookSecret,
    callbackSecret,
    founderChatId: FOUNDER_CHAT,
    founderUserId: FOUNDER_USER,
  });
  const ok = { 'x-telegram-bot-api-secret-token': 'wh-secret-123' };

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => t.drop());
  beforeEach(async () => {
    ledger = new Ledger(t.db);
    payments = new FakePayments();
    gate = new Gate(t.db, ledger, payments);
    co = newId('co');
    await ledger.setupCompany({
      id: co,
      name: 'Shop',
      currency: 'USD',
      departments: ['revenue', 'finance', 'support', 'growth'].map((code) => ({
        code,
        name: code,
      })),
    });
    await ledger.post({
      companyId: co,
      currency: 'USD',
      actor: 'founder',
      description: 'fund',
      flow: 'founder_funding',
      postings: [
        { account: ACC.envelope('growth'), amountMinor: 50_000n },
        { account: ACC.ownerEquity, amountMinor: -50_000n },
      ],
    });
    await gate.allowPayee(co, 'alice@example.com', 'Alice', 'founder');
    const r = await gate.submit({
      companyId: co,
      agentId: 'growth-agent',
      runId: 'r1',
      envelope: 'growth',
      action: 'payout',
      amountMinor: '9000',
      currency: 'USD',
      payee: 'alice@example.com',
      category: 'content',
      reason: 'Launch video',
    });
    approvalId = r.approvalId ?? '';
  });

  it('announces each pending approval once, with signed buttons', async () => {
    const sent: { body: Record<string, unknown> }[] = [];
    const channel = new TelegramChannel({
      botToken: new Secret('123:bot-token'),
      chatId: FOUNDER_CHAT,
      callbackSecret,
      fetch: (async (_url: string, init: RequestInit) => {
        sent.push({ body: JSON.parse(init.body as string) as Record<string, unknown> });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
      }) as unknown as typeof fetch,
    });
    expect(await announcePendingApprovals(t.db, co, channel)).toBe(1);
    expect(await announcePendingApprovals(t.db, co, channel)).toBe(0);
    const kb = (sent[0]?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard[0];
    expect(verifyCallback(callbackSecret, kb?.[0]?.callback_data ?? '')).toEqual({
      decision: 'approve',
      approvalId,
    });
    expect(JSON.stringify(sent)).not.toContain('bot-token');
  });

  it('a genuine founder callback approves through the gate (which re-checks its rules)', async () => {
    const r = await handleTelegramCallback(
      deps(),
      ok,
      update(signCallback(callbackSecret, 'approve', approvalId)),
    );
    expect(r).toMatchObject({ ok: true, status: 'executed' });
    expect(payments.payouts).toHaveLength(1);
  });

  it('forged callbacks approve nothing', async () => {
    const good = signCallback(callbackSecret, 'approve', approvalId);
    const forged = `a:${approvalId}:${'x'.repeat(22)}`;
    const results = await Promise.all([
      handleTelegramCallback(deps(), {}, update(good)), // no secret header
      handleTelegramCallback(
        deps(),
        { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
        update(good),
      ),
      handleTelegramCallback(deps(), ok, update(forged)), // bad signature
      handleTelegramCallback(
        deps(),
        ok,
        update(signCallback(new Secret('attacker'), 'approve', approvalId)),
      ),
      handleTelegramCallback(deps(), ok, update(good, { chat: '999' })), // another chat
      handleTelegramCallback(deps(), ok, update(good, { user: '7' })), // another user in the chat
      handleTelegramCallback(
        deps(),
        ok,
        update(signCallback(callbackSecret, 'reject', approvalId).replace(/^r/, 'a')),
      ), // flipped
    ]);
    expect(results.every((r) => !r.ok)).toBe(true);
    const [apr] = await t.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(apr?.status).toBe('pending');
    expect(payments.payouts).toHaveLength(0);
  });

  it('a replayed callback is ignored, and a deny cannot be replayed into an approve', async () => {
    const id = newId('cq');
    const deny = update(signCallback(callbackSecret, 'reject', approvalId), { id });
    expect((await handleTelegramCallback(deps(), ok, deny)).ok).toBe(true);
    expect(await handleTelegramCallback(deps(), ok, deny)).toEqual({
      ok: false,
      reason: 'replayed callback',
    });
    // A fresh approve after the founder denied: the gate ignores it (the approval is no longer pending).
    const late = await handleTelegramCallback(
      deps(),
      ok,
      update(signCallback(callbackSecret, 'approve', approvalId)),
    );
    expect(late.ok && late.status).toBe('rejected');
    expect(payments.payouts).toHaveLength(0);
  });

  it('a double-tapped approve pays once', async () => {
    const a = signCallback(callbackSecret, 'approve', approvalId);
    await Promise.all([
      handleTelegramCallback(deps(), ok, update(a)),
      handleTelegramCallback(deps(), ok, update(a)),
    ]);
    expect(payments.payouts).toHaveLength(1);
  });
});
