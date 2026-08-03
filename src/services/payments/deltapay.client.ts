/**
 * DeltaPay (DeltaCrypt) Hosted Checkout client.
 *
 * Hosted Checkout is a REDIRECT flow: we create a session server-side, send the
 * buyer's browser to DeltaPay's hosted page, and confirm the outcome with a
 * server-side verify call when they come back. Only two provider calls exist —
 * createSession and verifySession — everything in between happens on DeltaPay.
 *
 * Docs: https://deltacrypt.github.io/deltapay-api-docs/common_usecases/hosted_checkout/
 *
 * Currency: DeltaPay is SZL-native and the API takes a bare `amount` with no
 * currency field, so amounts are sent as-is (Emalangeni).
 */

/** Session lifecycle states. Only `succeeded` means the order is paid. */
export type DeltapaySessionStatus =
  | 'pending'      // awaiting the customer's phone number / username
  | 'processing'   // payment request sent; waiting for in-app approval
  | 'succeeded'    // payment received
  | 'failed'       // all allowed attempts exhausted
  | 'expired'      // session timed out (10 min)
  | 'cancelled';   // session cancelled

export interface DeltapaySessionCreateInput {
  amount: number;
  merchantReference: string;
  returnUrl: string;
  displayDescription?: string;
  sessionCallbackUrl?: string;
  metadata?: string;
  /** E.164 phone (e.g. +26876123456) or DeltaPay username, to skip identifier entry. */
  payerIdentifier?: string;
  payerIdentifierType?: 'phone_number' | 'username';
}

export interface DeltapaySessionCreateResult {
  checkoutSessionId: string;
  checkoutUrl: string;
  expiresAt?: string;
}

export interface DeltapayVerifyResult {
  checkoutSessionId: string;
  status: DeltapaySessionStatus;
  merchantReference?: string;
  amount?: number;
  finalisedAt?: string;
}

const DEFAULT_BASE_URL = 'https://api.prod.deltacrypt.net';

export class DeltapayClient {
  private baseUrl = (process.env['DELTAPAY_BASE_URL'] || DEFAULT_BASE_URL).replace(/\/+$/, '');
  private apiKey = process.env['DELTAPAY_API_KEY'] || '';

  /**
   * True only when DeltaPay is switched on AND fully credentialed. A
   * half-configured deploy therefore HIDES the method at checkout rather than
   * failing the buyer mid-purchase.
   */
  isConfigured(): boolean {
    return (
      process.env['DELTAPAY_ENABLED'] === 'true' &&
      !!this.apiKey &&
      !!process.env['DELTAPAY_RETURN_URL']
    );
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-api-key': this.apiKey };
  }

  /**
   * Create a hosted checkout session. Sessions expire 10 MINUTES after creation.
   *
   * Throws on any non-2xx or malformed response — the caller releases the
   * inventory hold, fails the sale and surfaces the error. There is deliberately
   * no fallback path: a buyer must never see a "working" checkout we can't bill.
   */
  async createSession(p: DeltapaySessionCreateInput): Promise<DeltapaySessionCreateResult> {
    const body: Record<string, unknown> = {
      amount: p.amount,
      merchant_reference: p.merchantReference,
      return_url: p.returnUrl,
    };
    if (p.displayDescription) body['display_description'] = p.displayDescription;
    if (p.sessionCallbackUrl) body['session_callback_url'] = p.sessionCallbackUrl;
    if (p.metadata) body['metadata'] = p.metadata;
    // An unknown/invalid identifier does NOT fail session creation — DeltaPay
    // falls back to prompting the customer on the hosted page.
    if (p.payerIdentifier && p.payerIdentifierType) {
      body['payer_identifier'] = p.payerIdentifier;
      body['payer_identifier_type'] = p.payerIdentifierType;
    }

    const res = await fetch(`${this.baseUrl}/v1/hosted-checkout/sessions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.checkout_session_id || !data?.checkout_url) {
      // Never interpolate the API key into errors — only status + provider detail.
      const detail = data?.detail ? JSON.stringify(data.detail) : JSON.stringify(data || {});
      throw new Error(`DeltaPay createSession failed: HTTP ${res.status} ${detail}`);
    }

    return {
      checkoutSessionId: data.checkout_session_id,
      checkoutUrl: data.checkout_url,
      expiresAt: data.expires_at,
    };
  }

  /**
   * Authoritative outcome for a session. Read-only and safe to call repeatedly.
   *
   * The buyer's return redirect is NOT proof of payment (they can close the tab,
   * lose connectivity, or hit the return URL by hand) — this call is the single
   * source of truth, and only `succeeded` confirms payment.
   */
  async verifySession(checkoutSessionId: string): Promise<DeltapayVerifyResult> {
    const url = `${this.baseUrl}/v1/hosted-checkout/sessions/${encodeURIComponent(
      checkoutSessionId
    )}/verify-return`;

    const res = await fetch(url, { method: 'GET', headers: this.headers() });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data?.status) {
      const detail = data?.detail ? JSON.stringify(data.detail) : JSON.stringify(data || {});
      throw new Error(`DeltaPay verifySession failed: HTTP ${res.status} ${detail}`);
    }

    return {
      checkoutSessionId: data.checkout_session_id || checkoutSessionId,
      status: data.status as DeltapaySessionStatus,
      merchantReference: data.merchant_reference,
      amount: data.amount === undefined || data.amount === null ? undefined : Number(data.amount),
      finalisedAt: data.finalised_at,
    };
  }
}

/**
 * Map a session status onto the three outcomes the sale finalizer acts on.
 *
 * SECURITY: anything we don't recognise maps to 'pending', never 'success' — a
 * provider-side enum addition must never be able to mint tickets. The
 * reservation-expiry sweep is the backstop for a session that never resolves.
 */
export function classifySessionStatus(
  status: string
): 'success' | 'pending' | 'rejected' {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'expired':
    case 'cancelled':
      return 'rejected';
    case 'pending':
    case 'processing':
      return 'pending';
    default:
      return 'pending';
  }
}
