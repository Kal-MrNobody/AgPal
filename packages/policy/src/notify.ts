import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, notExists } from 'drizzle-orm';
import { approvalNotifications, approvals, channelCallbacks, type Database } from '@agpal/db';
import { newId, type Secret } from '@agpal/shared';
import type { Gate } from './gate.js';

/** An approval card as every channel renders it. */
export interface ApprovalCard {
  approvalId: string;
  action: string;
  amount: string;
  envelope: string;
  payee?: string;
  agentId: string;
  rule: string;
  explanation: string;
  reason: string;
  evidence: string[];
}

/** A place the founder gets approval cards and answers them (Prompt 21). */
export interface NotificationChannel {
  readonly name: string;
  sendApproval(card: ApprovalCard): Promise<{ ref: string }>;
}

export type ChannelDecision = 'approve' | 'reject';

/**
 * Signed callback data: `<d>:<approvalId>:<sig>` where sig is a truncated HMAC of `<d>:<approvalId>`. Fits Telegram's
 * 64-byte callback_data limit (1 + 1 + 36 + 1 + 22 = 61). The secret never leaves the server.
 */
export function signCallback(
  secret: Secret,
  decision: ChannelDecision,
  approvalId: string,
): string {
  const d = decision === 'approve' ? 'a' : 'r';
  const sig = createHmac('sha256', secret.reveal())
    .update(`${d}:${approvalId}`)
    .digest('base64url')
    .slice(0, 22);
  return `${d}:${approvalId}:${sig}`;
}

export function verifyCallback(
  secret: Secret,
  data: string,
): { decision: ChannelDecision; approvalId: string } | undefined {
  const [d, approvalId, sig] = data.split(':');
  if ((d !== 'a' && d !== 'r') || !approvalId || !sig || !/^apr_[a-f0-9]{32}$/.test(approvalId))
    return undefined;
  const expected = createHmac('sha256', secret.reveal())
    .update(`${d}:${approvalId}`)
    .digest('base64url')
    .slice(0, 22);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return { decision: d === 'a' ? 'approve' : 'reject', approvalId };
}

/** Telegram Bot API channel. The bot token sits in the URL path, so it comes from env, never logged. */
export class TelegramChannel implements NotificationChannel {
  readonly name = 'telegram';
  constructor(
    private readonly opts: {
      botToken: Secret;
      chatId: string;
      callbackSecret: Secret;
      fetch?: typeof fetch;
      apiBase?: string;
    },
  ) {}

  private async call(
    method: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await (this.opts.fetch ?? fetch)(
      `${this.opts.apiBase ?? 'https://api.telegram.org'}/bot${this.opts.botToken.reveal()}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const json = (await res.json()) as {
      ok?: boolean;
      result?: Record<string, unknown>;
      description?: string;
    };
    // Never echo the URL (it contains the token).
    if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
    return json.result ?? {};
  }

  async sendApproval(c: ApprovalCard): Promise<{ ref: string }> {
    const text = [
      `🟡 ${c.action.replace('_', ' ')} $${c.amount} from ${c.envelope}${c.payee ? ` → ${c.payee}` : ''}`,
      `Agent: ${c.agentId}`,
      `Rule: ${c.rule} — ${c.explanation}`,
      `Reason: ${c.reason}`,
      ...(c.evidence.length ? [`Evidence: ${c.evidence.join(' ')}`] : []),
    ].join('\n');
    const r = await this.call('sendMessage', {
      chat_id: this.opts.chatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '✅ Approve',
              callback_data: signCallback(this.opts.callbackSecret, 'approve', c.approvalId),
            },
            {
              text: '❌ Deny',
              callback_data: signCallback(this.opts.callbackSecret, 'reject', c.approvalId),
            },
          ],
        ],
      },
    });
    return {
      ref:
        typeof r.message_id === 'number' || typeof r.message_id === 'string'
          ? String(r.message_id)
          : '',
    };
  }

  answer(callbackQueryId: string, text: string): Promise<Record<string, unknown>> {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text.slice(0, 190),
    });
  }
}

/** Send every pending approval that this channel has not announced yet. */
export async function announcePendingApprovals(
  db: Database,
  companyId: string,
  channel: NotificationChannel,
): Promise<number> {
  const pending = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.status, 'pending'),
        notExists(
          db
            .select()
            .from(approvalNotifications)
            .where(
              and(
                eq(approvalNotifications.approvalId, approvals.id),
                eq(approvalNotifications.channel, channel.name),
              ),
            ),
        ),
      ),
    );
  let sent = 0;
  for (const a of pending) {
    const i = a.intent as {
      action?: string;
      amountMinor?: string;
      envelope?: string;
      payee?: string;
      agentId?: string;
      reason?: string;
      evidence?: string[];
    };
    const cents = BigInt(i.amountMinor ?? '0');
    const { ref } = await channel.sendApproval({
      approvalId: a.id,
      action: i.action ?? '',
      amount: `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`,
      envelope: i.envelope ?? '',
      ...(i.payee ? { payee: i.payee } : {}),
      agentId: i.agentId ?? '',
      rule: a.rule,
      explanation: a.explanation,
      reason: i.reason ?? '',
      evidence: i.evidence ?? [],
    });
    await db
      .insert(approvalNotifications)
      .values({ id: newId('ntf'), approvalId: a.id, channel: channel.name, externalRef: ref })
      .onConflictDoNothing();
    sent++;
  }
  return sent;
}

export interface TelegramUpdate {
  update_id?: number;
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { chat?: { id: number } };
  };
}

export type CallbackOutcome =
  { ok: true; status: string; explanation: string } | { ok: false; reason: string };

/**
 * Handle a Telegram callback (Prompt 21). Every check must pass, and the gate still re-checks every deny rule:
 * secret header, founder chat and user, a valid signature for this approval and decision, and a callback id never
 * seen before (a replayed callback is ignored). Approving twice does nothing (the gate is idempotent per approval).
 */
export async function handleTelegramCallback(
  deps: {
    db: Database;
    gate: Gate;
    webhookSecret: Secret;
    callbackSecret: Secret;
    founderChatId: string;
    founderUserId: string;
  },
  headers: Record<string, string | undefined>,
  update: TelegramUpdate,
): Promise<CallbackOutcome> {
  const header = headers['x-telegram-bot-api-secret-token'] ?? '';
  const want = deps.webhookSecret.reveal();
  if (header.length !== want.length || !timingSafeEqual(Buffer.from(header), Buffer.from(want)))
    return { ok: false, reason: 'bad secret header' };
  const cq = update.callback_query;
  if (!cq?.data) return { ok: false, reason: 'not a callback' };
  if (
    String(cq.message?.chat?.id ?? '') !== deps.founderChatId ||
    String(cq.from?.id ?? '') !== deps.founderUserId
  ) {
    return { ok: false, reason: 'not the founder' };
  }
  const parsed = verifyCallback(deps.callbackSecret, cq.data);
  if (!parsed) return { ok: false, reason: 'bad signature' };
  const fresh = await deps.db
    .insert(channelCallbacks)
    .values({
      id: `telegram:${cq.id}`,
      channel: 'telegram',
      approvalId: parsed.approvalId,
      decision: parsed.decision,
    })
    .onConflictDoNothing()
    .returning({ id: channelCallbacks.id });
  if (fresh.length === 0) return { ok: false, reason: 'replayed callback' };
  if (parsed.decision === 'approve') {
    const r = await deps.gate.approve(parsed.approvalId, 'founder', 'approved in Telegram');
    return { ok: true, status: r.status, explanation: r.decision.explanation };
  }
  await deps.gate.reject(parsed.approvalId, 'founder', 'denied in Telegram');
  return { ok: true, status: 'rejected', explanation: 'Denied by the founder in Telegram.' };
}
