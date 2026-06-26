import { randomUUID } from 'crypto';

export class MtnMomoClient {
  private baseUrl = process.env['MTN_MOMO_BASE_URL'] || '';
  private subKey  = process.env['MTN_MOMO_SUBSCRIPTION_KEY'] || '';
  private apiUser = process.env['MTN_MOMO_API_USER'] || '';
  private apiKey  = process.env['MTN_MOMO_API_KEY'] || '';
  private targetEnv = process.env['MTN_MOMO_TARGET_ENV'] || 'sandbox';
  private callbackUrl = process.env['MTN_MOMO_CALLBACK_URL'] || '';
  private token?: { value: string; expiresAt: number };

  isConfigured(): boolean {
    return process.env['MTN_MOMO_ENABLED'] === 'true'
      && !!this.baseUrl && !!this.subKey && !!this.apiUser && !!this.apiKey;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const auth = Buffer.from(`${this.apiUser}:${this.apiKey}`).toString('base64');
    const res = await fetch(`${this.baseUrl}/collection/token/`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Ocp-Apim-Subscription-Key': this.subKey },
    });
    if (!res.ok) throw new Error(`MoMo token failed: HTTP ${res.status}`);
    const data: any = await res.json();
    this.token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async requestToPay(p: { amount: number; currency: string; payerMsisdn: string; externalId: string; payerMessage: string; }): Promise<{ referenceId: string }> {
    const token = await this.getToken();
    const referenceId = randomUUID();
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'X-Reference-Id': referenceId,
      'X-Target-Environment': this.targetEnv,
      'Ocp-Apim-Subscription-Key': this.subKey,
      'Content-Type': 'application/json',
    };
    if (this.callbackUrl) headers['X-Callback-Url'] = this.callbackUrl;
    const res = await fetch(`${this.baseUrl}/collection/v1_0/requesttopay`, {
      method: 'POST', headers,
      body: JSON.stringify({
        amount: String(p.amount),
        currency: p.currency,
        externalId: p.externalId,
        payer: { partyIdType: 'MSISDN', partyId: p.payerMsisdn },
        payerMessage: p.payerMessage,
        payeeNote: 'Carrot Tickets',
      }),
    });
    if (res.status !== 202) {
      const body = await res.text().catch(() => '');
      throw new Error(`MoMo requestToPay failed: HTTP ${res.status} ${body}`);
    }
    return { referenceId };
  }

  async getStatus(referenceId: string): Promise<{ status: 'PENDING' | 'SUCCESSFUL' | 'FAILED'; raw: any }> {
    const token = await this.getToken();
    const res = await fetch(`${this.baseUrl}/collection/v1_0/requesttopay/${referenceId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Target-Environment': this.targetEnv,
        'Ocp-Apim-Subscription-Key': this.subKey,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[momo getStatus] ✗ HTTP error', { referenceId, httpStatus: res.status, body });
      throw new Error(`MoMo getStatus failed: HTTP ${res.status}`);
    }
    const data: any = await res.json();
    const status = data.status === 'SUCCESSFUL' ? 'SUCCESSFUL' : data.status === 'FAILED' ? 'FAILED' : 'PENDING';
    // Authoritative MTN payload — the forensic record for disputes / amount guard.
    console.log('[momo getStatus] ⇩ MTN response', {
      referenceId,
      status,
      raw: data, // includes amount, currency, payer, financialTransactionId, reason
    });
    return { status, raw: data };
  }
}
