import crypto from 'crypto';
const SUCCESS_RE = /^(000\.000\.000|000\.100\.1|000\.[36])/;
const PENDING_RE = /^(000\.200)/;
export function classifyResultCode(code: string): 'success'|'pending'|'rejected' {
  if (SUCCESS_RE.test(code)) return 'success';
  if (PENDING_RE.test(code)) return 'pending';
  return 'rejected';
}
export class PeachClient {
  private baseUrl = process.env['PEACH_BASE_URL'] || 'https://api-v2.peachpayments.com';
  private entityId = process.env['PEACH_ENTITY_ID'] || '';
  private userId = process.env['PEACH_USER_ID'] || '';
  private password = process.env['PEACH_PASSWORD'] || '';
  isConfigured(): boolean {
    return process.env['CARD_PAYMENTS_ENABLED'] === 'true' && !!this.entityId && !!this.userId && !!this.password;
  }
  private auth() { return { userId: this.userId, password: this.password, entityId: this.entityId }; }
  async createPayment(p: { amount: number; currency: string; merchantTransactionId: string; shopperResultUrl: string; nonce: string }) {
    const res = await fetch(`${this.baseUrl}/payments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authentication: this.auth(), amount: p.amount.toFixed(2), currency: p.currency,
        paymentType: 'DB', paymentBrand: 'CARD', merchantTransactionId: p.merchantTransactionId, nonce: p.nonce, shopperResultUrl: p.shopperResultUrl }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) {
      const t = data?.result ? JSON.stringify(data.result) : await res.text().catch(() => '');
      throw new Error(`Peach createPayment failed: HTTP ${res.status} ${t}`);
    }
    return { id: data.id, code: data?.result?.code, redirect: data.redirect };
  }
  async getPaymentStatus(id: string) {
    // SECURITY: Peach Payments API v2 mandates auth as query params on this GET
    // endpoint (verified: GET /payments/{id} rejects with "Missing required request
    // parameters: [authentication.userId,...]" and offers no header/body variant).
    // Credentials therefore ride the query string. Invariants that keep this safe:
    //   - HTTPS only (query encrypted in transit).
    //   - The URL is NEVER logged and is NEVER interpolated into errors/telemetry
    //     (the throw below uses only res.status + res.text(), not the URL). Keep it that way.
    //   - Encrypted webhooks (decryptWebhook) are the preferred finalisation channel;
    //     this call is the synchronous fallback when the buyer returns to the result page.
    const q = new URLSearchParams({ 'authentication.userId': this.userId, 'authentication.password': this.password, 'authentication.entityId': this.entityId });
    const res = await fetch(`${this.baseUrl}/payments/${encodeURIComponent(id)}?${q.toString()}`);
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Peach getPaymentStatus failed: HTTP ${res.status} ${t}`); }
    const data: any = await res.json();
    return { code: data?.result?.code, amount: data?.amount, currency: data?.currency, raw: data };
  }
  decryptWebhook(p: { bodyHex: string; ivHex: string; authTagHex: string }): any {
    const key = Buffer.from(process.env['PEACH_WEBHOOK_SECRET'] || '', 'hex');
    const decipher = crypto.createDecipheriv('aes-128-gcm', key, Buffer.from(p.ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(p.authTagHex, 'hex'));
    const out = Buffer.concat([decipher.update(Buffer.from(p.bodyHex, 'hex')), decipher.final()]).toString('utf8');
    return JSON.parse(out);
  }
}
