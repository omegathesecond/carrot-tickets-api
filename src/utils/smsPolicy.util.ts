/**
 * Outbound SMS delivery policy.
 *
 * Two switches, both read at CALL time so a redeploy isn't needed to change
 * them and tests can vary env without module-cache games:
 *
 *   SMS_ENABLED    — set to exactly 'false' to mute all outbound SMS.
 *   SMS_ALLOWLIST  — comma-separated numbers; when non-empty, ONLY these
 *                    receive messages. Used in dev so test purchases can't
 *                    text real buyers or burn gateway credits.
 *
 * Both FAIL OPEN: absent or unparseable config means "send", because silently
 * muting production SMS is far worse than an unexpected send. This mirrors the
 * repo's no-silent-fallback stance — a skipped send is configured intent and is
 * logged plainly, never disguised as success.
 */
import { normalizePhone } from '@utils/phone.util';

export interface SmsPolicyDecision {
  send: boolean;
  reason?: string;
}

export function shouldSendSms(phoneNumber: string): SmsPolicyDecision {
  if (process.env['SMS_ENABLED'] === 'false') {
    return { send: false, reason: 'SMS_ENABLED=false — outbound SMS disabled' };
  }

  const raw = (process.env['SMS_ALLOWLIST'] || '').trim();
  if (!raw) return { send: true };

  const allowed = raw
    .split(',')
    .map((n) => normalizePhone(n.trim()))
    .filter(Boolean);
  if (allowed.length === 0) return { send: true };

  const target = normalizePhone(phoneNumber);
  if (allowed.includes(target)) return { send: true };

  return { send: false, reason: `not on SMS_ALLOWLIST's allow-list (${allowed.length} entr${allowed.length === 1 ? 'y' : 'ies'})` };
}
