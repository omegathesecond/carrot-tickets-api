import crypto from 'crypto';

/**
 * YeboPay Checkout client — api.yebopay.app.
 *
 * Hosted-checkout REDIRECT flow, the same shape as the Yoco rail: create a
 * checkout server-side, send the buyer to the hosted page, learn the outcome
 * from a SIGNED WEBHOOK.
 *
 * Docs: /yebopay-implementation skill; source of truth is
 * companies/yebopay/api/src/routes/v1/checkouts.routes.ts.
 *
 * How this differs from the Yoco and Peach rails:
 *
 *  - YeboPay DOES publish a status endpoint (`GET /v1/checkouts/:id`), unlike
 *    Yoco. That is what makes `getCheckout` below possible and lets the
 *    reconcile sweep ask "is this paid?" instead of waiting on a webhook that
 *    may never arrive. YeboPay webhooks have no automatic retry, so polling is
 *    not optional garnish here — it is the backstop.
 *  - Amounts are DECIMAL units (150.5), not cents. No toCents() equivalent.
 *  - Currency is SZL. YeboPay maps SZL to ZAR at the 1:1 Common Monetary Area
 *    peg internally when it reaches the card processor, so Carrot keeps
 *    pricing in Emalangeni and never does the conversion itself.
 *  - `Idempotency-Key` is NOT honoured on checkout creation (only on
 *    /v1/charges — verified 2026-09-03). Do not rely on it: the sale row is
 *    the dedupe anchor, exactly as the DeltaPay rail does.
 */

/** Checkout lifecycle. Only COMPLETED means the order is paid. */
export type YeboPayCheckoutStatus = 'OPEN' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';

/**
 * Map a YeboPay event type onto the outcomes the sale finalizer acts on.
 *
 * SECURITY: anything unrecognised maps to 'ignore', never 'success' — a
 * provider-side event addition must never be able to mint tickets. Same rule
 * as classifyEventType on the Yoco rail and classifySessionStatus on DeltaPay.
 *
 * Note `charge.failed` is deliberately 'ignore', NOT 'rejected'. On YeboPay a
 * declined card is NON-TERMINAL: the PaymentIntent returns to
 * requires_payment_method and the buyer can retry in place, so the checkout
 * stays OPEN. Treating a failed attempt as terminal would cancel a sale the
 * buyer is still paying for. `checkout.expired` is the terminal failure.
 */
export function classifyEventType(type: string): 'success' | 'rejected' | 'ignore' {
  switch (type) {
    case 'checkout.completed':
      return 'success';
    case 'checkout.expired':
    case 'checkout.cancelled':
      return 'rejected';
    default:
      return 'ignore';
  }
}

/** Map a polled checkout status onto the same three outcomes. */
export function classifyCheckoutStatus(status: string): 'success' | 'rejected' | 'pending' {
  switch (status) {
    case 'COMPLETED':
      return 'success';
    case 'EXPIRED':
    case 'CANCELLED':
      return 'rejected';
    case 'OPEN':
      return 'pending';
    default:
      // Unknown never means paid.
      return 'pending';
  }
}

export interface YeboPayCheckoutCreateInput {
  /** Decimal units (Emalangeni), NOT cents. */
  amount: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  description?: string;
  email?: string;
  metadata?: Record<string, string>;
}

export interface YeboPayCheckoutCreateResult {
  id: string;
  hostedUrl: string;
  status: YeboPayCheckoutStatus;
  expiresAt?: string;
}

export interface YeboPayCheckoutStatusResult {
  id: string;
  status: YeboPayCheckoutStatus;
  chargeId: string | null;
  amount?: string;
  currency?: string;
}

export interface YeboPayWebhookVerifyInput {
  /** The EXACT bytes YeboPay POSTed — any re-serialisation invalidates the signature. */
  rawBody: string;
  /** The `YeboPay-Signature` header: `t=<unix>,v1=<hex hmac>`. */
  signatureHeader: string;
}

const DEFAULT_BASE_URL = 'https://api.yebopay.app';

/** Replay window, in seconds. Matches the Yoco rail's tolerance. */
const TIMESTAMP_TOLERANCE_S = 180;

export class YeboPayClient {
  private baseUrl = (process.env['YEBOPAY_BASE_URL'] || DEFAULT_BASE_URL).replace(/\/+$/, '');
  private apiKey = process.env['YEBOPAY_API_KEY'] || '';

  /**
   * True only when YeboPay is switched on AND fully credentialed. A
   * half-configured deploy HIDES the method at checkout rather than failing the
   * buyer mid-purchase — same contract as YocoClient/DeltapayClient.
   */
  isConfigured(): boolean {
    return (
      process.env['YEBOPAY_ENABLED'] === 'true' &&
      !!this.apiKey &&
      !!process.env['YEBOPAY_RETURN_URL']
    );
  }

  /** True when the configured key is a sandbox key. Used only for logging/diagnostics. */
  isTestMode(): boolean {
    return this.apiKey.startsWith('ypk_test_');
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-api-key': this.apiKey };
  }

  /**
   * Create a hosted checkout.
   *
   * Throws on any non-2xx or malformed response — the caller releases the
   * inventory hold, fails the sale and surfaces the error. No fallback: a buyer
   * must never see a "working" checkout we cannot bill.
   */
  async createCheckout(p: YeboPayCheckoutCreateInput): Promise<YeboPayCheckoutCreateResult> {
    const res = await fetch(`${this.baseUrl}/v1/checkouts`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        amount: p.amount,
        currency: p.currency,
        // Carrot buyers authenticate with Carrot's own buyerAuth, not YeboID.
        // null is explicitly supported ("UUID or null for guest").
        yeboid_sub: null,
        // Pinned rather than omitted: YeboPay currently defaults to CARD, but
        // its own source says "later we'll generalize". Pinning means the day
        // that default changes, Carrot's rail does not silently change with it.
        payment_method: 'CARD',
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
        ...(p.description ? { description: p.description } : {}),
        ...(p.email ? { email: p.email } : {}),
        ...(p.metadata ? { metadata: p.metadata } : {}),
      }),
    });

    const body: any = await res.json().catch(() => ({}));
    const data = body?.data;
    if (!res.ok || !data?.id || !data?.hosted_url) {
      // Never interpolate the API key into errors — only status + provider detail.
      const detail = body?.error ? JSON.stringify(body.error) : JSON.stringify(body || {});
      throw new Error(`YeboPay createCheckout failed: HTTP ${res.status} ${detail}`);
    }

    return {
      id: data.id,
      hostedUrl: data.hosted_url,
      status: data.status,
      expiresAt: data.expires_at,
    };
  }

  /**
   * Authoritative outcome for a checkout. Read-only and safe to call repeatedly.
   *
   * The buyer's return redirect is NOT proof of payment (they can close the tab,
   * lose connectivity, or hit the return URL by hand) — this call is the source
   * of truth alongside the signed webhook, and the reconcile sweep's only way to
   * recover a delivery that never arrived.
   */
  async getCheckout(checkoutId: string): Promise<YeboPayCheckoutStatusResult> {
    const res = await fetch(`${this.baseUrl}/v1/checkouts/${encodeURIComponent(checkoutId)}`, {
      method: 'GET',
      headers: this.headers(),
    });
    const body: any = await res.json().catch(() => ({}));
    const data = body?.data;
    if (!res.ok || !data?.status) {
      const detail = body?.error ? JSON.stringify(body.error) : JSON.stringify(body || {});
      throw new Error(`YeboPay getCheckout failed: HTTP ${res.status} ${detail}`);
    }
    return {
      id: data.id ?? checkoutId,
      status: data.status,
      chargeId: data.charge_id ?? null,
      amount: data.amount,
      currency: data.currency,
    };
  }

  /**
   * Verify `YeboPay-Signature: t=<unix>,v1=<hex>` over the RAW request body.
   *
   * Signed content is `{t}.{rawBody}`, HMAC-SHA256 under the shared webhook
   * secret, compared in constant time.
   *
   * Fails CLOSED on every ambiguity — missing secret, malformed header, stale
   * timestamp, length mismatch — because this is the only thing standing
   * between an unauthenticated POST and minted tickets.
   */
  verifyWebhook(p: YeboPayWebhookVerifyInput): boolean {
    const secret = process.env['YEBOPAY_WEBHOOK_SECRET'] || '';
    if (!secret || !p.signatureHeader) return false;

    // `t=1234,v1=abcd` — order-independent, tolerant of extra pairs.
    const parts = new Map<string, string>();
    for (const chunk of p.signatureHeader.split(',')) {
      const idx = chunk.indexOf('=');
      if (idx <= 0) continue;
      parts.set(chunk.slice(0, idx).trim(), chunk.slice(idx + 1).trim());
    }
    const t = parts.get('t');
    const v1 = parts.get('v1');
    if (!t || !v1) return false;

    // Replay guard — reject anything outside the tolerance in EITHER direction.
    const ts = Number(t);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > TIMESTAMP_TOLERANCE_S) return false;

    const expected = crypto.createHmac('sha256', secret).update(`${t}.${p.rawBody}`).digest();

    let provided: Buffer;
    try {
      provided = Buffer.from(v1, 'hex');
    } catch {
      return false;
    }
    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(provided, expected);
  }
}
