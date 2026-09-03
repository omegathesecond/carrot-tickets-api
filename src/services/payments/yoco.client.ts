import crypto from 'crypto';

/**
 * Yoco Checkout API client.
 *
 * Hosted-checkout REDIRECT flow: we create a checkout server-side, send the
 * buyer's browser to Yoco's page, and learn the outcome from a SIGNED WEBHOOK.
 *
 * Docs: https://developer.yoco.com/checkout-api-reference/checkout/create-checkout
 *
 * IMPORTANT — how this differs from PeachClient and DeltapayClient:
 * Yoco publishes NO status-query endpoint (only create, refund and webhook
 * management). There is therefore no `getStatus()` here, and no way to ask Yoco
 * "is this paid?" after the fact. The signature-verified webhook is the SINGLE
 * source of payment truth, which is why verifyWebhook is written to fail closed
 * on every ambiguity — an unverified body must never be able to mint a ticket.
 *
 * Currency: Yoco is ZAR-only. Carrot prices in SZL at 1:1 with ZAR (same basis
 * as the Peach card rail), so the numeric amount carries over unchanged.
 */

// Yoco takes integer CENTS. The helper now lives in @utils/serviceFee.util
// because the YeboPay rail needs the same conversion; re-exported here so
// existing importers of yoco.client are unaffected.
import { toCents } from '@utils/serviceFee.util';
export { toCents };

/**
 * Map a webhook event type onto the outcomes the sale finalizer acts on.
 *
 * SECURITY: anything unrecognised maps to 'ignore', never 'success' — a
 * provider-side event addition must never be able to mint tickets.
 */
export function classifyEventType(type: string): 'success' | 'rejected' | 'ignore' {
  switch (type) {
    case 'payment.succeeded':
      return 'success';
    case 'payment.failed':
      return 'rejected';
    default:
      return 'ignore';
  }
}

export interface YocoCheckoutCreateInput {
  /** Amount in RANDS/EMALANGENI — converted to cents on the wire. */
  amount: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  failureUrl: string;
  metadata: Record<string, string>;
  externalId: string;
  /** Prevents a retried initiate from creating a second checkout for one sale. */
  idempotencyKey: string;
}

export interface YocoCheckoutCreateResult {
  id: string;
  redirectUrl: string;
  status?: string;
}

export interface YocoWebhookVerifyInput {
  /** The EXACT bytes Yoco POSTed — any re-serialisation invalidates the signature. */
  rawBody: string;
  webhookId: string;
  webhookTimestamp: string;
  webhookSignature: string;
}

const DEFAULT_BASE_URL = 'https://payments.yoco.com';

/** Replay window, in seconds. Yoco recommends 3 minutes. */
const TIMESTAMP_TOLERANCE_S = 180;

export class YocoClient {
  private baseUrl = (process.env['YOCO_BASE_URL'] || DEFAULT_BASE_URL).replace(/\/+$/, '');
  private secretKey = process.env['YOCO_SECRET_KEY'] || '';

  /**
   * True only when Yoco is switched on AND fully credentialed. A half-configured
   * deploy therefore HIDES the method at checkout rather than failing the buyer
   * mid-purchase (same contract as DeltapayClient.isConfigured).
   */
  isConfigured(): boolean {
    return (
      process.env['YOCO_ENABLED'] === 'true' &&
      !!this.secretKey &&
      !!process.env['YOCO_RETURN_URL']
    );
  }

  /**
   * Create a hosted checkout.
   *
   * Throws on any non-2xx or malformed response — the caller releases the
   * inventory hold, fails the sale and surfaces the error. There is deliberately
   * no fallback: a buyer must never see a "working" checkout we can't bill.
   */
  async createCheckout(p: YocoCheckoutCreateInput): Promise<YocoCheckoutCreateResult> {
    const res = await fetch(`${this.baseUrl}/api/checkouts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.secretKey}`,
        'Idempotency-Key': p.idempotencyKey,
      },
      body: JSON.stringify({
        amount: toCents(p.amount),
        currency: p.currency,
        successUrl: p.successUrl,
        cancelUrl: p.cancelUrl,
        failureUrl: p.failureUrl,
        metadata: p.metadata,
        externalId: p.externalId,
      }),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.id || !data?.redirectUrl) {
      // Never interpolate the secret key into errors — only status + provider detail.
      const detail = data?.description ? JSON.stringify(data.description) : JSON.stringify(data || {});
      throw new Error(`Yoco createCheckout failed: HTTP ${res.status} ${detail}`);
    }

    return { id: data.id, redirectUrl: data.redirectUrl, status: data.status };
  }

  /**
   * Standard-Webhooks signature check over the RAW request body.
   *
   * Signed content is `{webhook-id}.{webhook-timestamp}.{raw-body}`, HMAC-SHA256
   * under the base64-decoded secret (minus its `whsec_` prefix), compared in
   * constant time against each `v1,<sig>` entry in the space-separated header.
   *
   * Fails CLOSED on every ambiguity — missing secret, malformed header, stale
   * timestamp, length mismatch — because this is the only thing standing between
   * an unauthenticated POST and minted tickets.
   */
  verifyWebhook(p: YocoWebhookVerifyInput): boolean {
    const rawSecret = process.env['YOCO_WEBHOOK_SECRET'] || '';
    if (!rawSecret || !p.webhookId || !p.webhookTimestamp || !p.webhookSignature) return false;

    // Replay guard — reject anything outside the tolerance in EITHER direction.
    const ts = Number(p.webhookTimestamp);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > TIMESTAMP_TOLERANCE_S) return false;

    const key = Buffer.from(rawSecret.replace(/^whsec_/, ''), 'base64');
    if (key.length === 0) return false;

    const expected = crypto
      .createHmac('sha256', key)
      .update(`${p.webhookId}.${p.webhookTimestamp}.${p.rawBody}`)
      .digest();

    // The header may carry several signatures; any one matching is a pass.
    return p.webhookSignature.split(' ').some((entry) => {
      const [version, sig] = entry.split(',');
      if (version !== 'v1' || !sig) return false;
      const provided = Buffer.from(sig, 'base64');
      if (provided.length !== expected.length) return false;
      return crypto.timingSafeEqual(provided, expected);
    });
  }
}
