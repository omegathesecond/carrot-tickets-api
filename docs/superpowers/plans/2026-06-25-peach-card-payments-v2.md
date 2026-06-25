# Peach Card Payments (Payments API v2 redirect) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add Visa/Mastercard card payments to the Carrot Tickets online buyer checkout via Peach **Payments API v2** (hosted-redirect), shipped OFF behind a dashboard toggle.

**Architecture:** Async, redirect-verified payment mirroring the MTN MoMo pattern. `initiateCardPurchase` (PENDING sale + inventory reservation + Peach `POST /payments`) → buyer redirected to Peach's hosted card page → returns to `/payment-result` → `finalizeCardSale` verifies via `GET /payments/{id}` (and/or decrypted webhook) and mints idempotently. Ships with `cardEnabled=false`; flipping the dashboard toggle makes it live.

**Tech Stack:** Node 20 + TS + Express + Mongoose (api), React+Vite (landing buyer site, dashboard admin), Jest, Peach Payments API v2 (`api-v2.peachpayments.com`).

## Global Constraints

- Peach base URL: `process.env.PEACH_BASE_URL` (prod `https://api-v2.peachpayments.com`).
- Auth: JSON `authentication:{ userId, password, entityId }` in POST bodies; for GET status, the same three as query params `authentication.userId`/`authentication.password`/`authentication.entityId`. All three required.
- Create payment: `POST /payments` body `{authentication, amount(string 2dp), currency, paymentType:"DB", paymentBrand:"CARD", merchantTransactionId, nonce, shopperResultUrl}` → success `result.code` starts `000.200.000` (pending) + `redirect:{url, method, parameters}`.
- Status: `GET /payments/{id}?authentication.userId=&authentication.password=&authentication.entityId=` → `{result:{code}, amount, currency}`.
- Result-code classification: success `/^(000\.000\.000|000\.100\.1|000\.[36])/`; pending `/^(000\.200)/`; else rejected. (Final success webhook/status = `000.000.000`.)
- Currency: `process.env.CARD_CURRENCY` default `ZAR`, numeric amount == SZL price 1:1. Buyer sees `E`.
- Card sale is electronic ⇒ snapshot `fundsCustody:'carrot'` via `buildSaleSnapshot`.
- Mint ONLY after status/webhook success AND returned `amount`+`currency` exactly equal the sale's.
- Finalize idempotent via atomic `findOneAndUpdate({_id, paymentStatus:PENDING})`.
- Ship OFF: env `CARD_PAYMENTS_ENABLED=true` + creds present, but `cardEnabled=false` (admin toggle). `/payment-methods` lists card only when `cfg.cardEnabled && PeachClient.isConfigured()`.
- Env edits ADDITIVE. Buyer phone from token, never body. No silent fallbacks; SMS best-effort.
- Path aliases: `@models/* @services/* @interfaces/* @controllers/* @utils/* @middleware/*`.

## File Structure
- api Create: `src/services/payments/peach.client.ts`, `src/services/payments/card.processor.ts`, `src/controllers/card.controller.ts`, `src/routes/card.route.ts`; tests under `__tests__`.
- api Modify: `ticket.interface.ts`, `paymentMethodConfig.model.ts`, `paymentConfig.service.ts`, `ticketSale.model.ts`, `payments/index.ts`, `ticket.service.ts`, `public.controller.ts`, `public.route.ts`, `app.ts`, `.env.example`.
- landing Modify: `types/index.ts`, `services/api.ts`, `components/PurchaseModal.tsx`, `App.tsx`; Create `pages/PaymentResultPage.tsx`.
- dashboard Modify: settings page + api lib for the `cardEnabled` toggle.

---

## Task 1: CARD enum + cardEnabled config toggle (api)

**Files:** Modify `src/interfaces/ticket.interface.ts`, `src/models/paymentMethodConfig.model.ts`, `src/services/paymentConfig.service.ts`. Test: `src/services/__tests__/paymentConfig.card.test.ts`.

**Interfaces:** Produces `PaymentMethod.CARD='card'`; `PaymentConfig.cardEnabled:boolean` (default false) on `PaymentConfigService.get()/.update()`.

- [ ] **Step 1: Failing test**
```typescript
import { PaymentConfigService } from '@services/paymentConfig.service';
import { PaymentMethodConfig } from '@models/paymentMethodConfig.model';
jest.mock('@models/paymentMethodConfig.model');
describe('PaymentConfigService cardEnabled', () => {
  afterEach(() => jest.clearAllMocks());
  it('defaults cardEnabled false', async () => {
    (PaymentMethodConfig.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(null) });
    expect((await PaymentConfigService.get()).cardEnabled).toBe(false);
  });
  it('reads cardEnabled from doc', async () => {
    (PaymentMethodConfig.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve({ cardEnabled: true }) });
    expect((await PaymentConfigService.get()).cardEnabled).toBe(true);
  });
});
```
- [ ] **Step 2: Run** `npx jest src/services/__tests__/paymentConfig.card.test.ts` → FAIL (undefined).
- [ ] **Step 3:** Add `CARD = 'card'` to `PaymentMethod` enum.
- [ ] **Step 4:** Add `cardEnabled: boolean;` to `IPaymentMethodConfig` + `cardEnabled: { type: Boolean, default: false },` to schema (after `mtnMomoEnabled`).
- [ ] **Step 5:** In `paymentConfig.service.ts` add `cardEnabled: false,` to DEFAULTS and `cardEnabled: doc?.cardEnabled ?? DEFAULTS.cardEnabled,` to both `get()` and `update()` returns (`doc!` in update).
- [ ] **Step 6: Run** test → PASS.
- [ ] **Step 7: Commit** `feat(payments): CARD method + cardEnabled toggle`.

---

## Task 2: PeachClient (api)

**Files:** Create `src/services/payments/peach.client.ts`, test `src/services/payments/__tests__/peach.client.test.ts`. Modify `.env.example`.

**Interfaces:** Produces `class PeachClient { isConfigured(); createPayment(p:{amount:number;currency:string;merchantTransactionId:string;shopperResultUrl:string;nonce:string}):Promise<{id:string;code:string;redirect?:{url:string;method:string;parameters?:any[]}}>; getPaymentStatus(id:string):Promise<{code:string;amount?:string;currency?:string;raw:any}>; decryptWebhook(p:{bodyHex:string;ivHex:string;authTagHex:string}):any }` and `classifyResultCode(code):'success'|'pending'|'rejected'`.

- [ ] **Step 1: Failing test**
```typescript
import { PeachClient, classifyResultCode } from '@services/payments/peach.client';
import crypto from 'crypto';
describe('classifyResultCode', () => {
  it('success/pending/rejected', () => {
    expect(classifyResultCode('000.000.000')).toBe('success');
    expect(classifyResultCode('000.100.110')).toBe('success');
    expect(classifyResultCode('000.200.000')).toBe('pending');
    expect(classifyResultCode('800.100.151')).toBe('rejected');
  });
});
describe('PeachClient', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD, CARD_PAYMENTS_ENABLED:'true', PEACH_BASE_URL:'https://api-v2.peachpayments.com',
    PEACH_ENTITY_ID:'E', PEACH_USER_ID:'U', PEACH_PASSWORD:'P', CARD_CURRENCY:'ZAR' }; });
  afterEach(() => { process.env = OLD; jest.restoreAllMocks(); });
  it('isConfigured requires enabled+creds', () => {
    expect(new PeachClient().isConfigured()).toBe(true);
    process.env.PEACH_USER_ID=''; expect(new PeachClient().isConfigured()).toBe(false);
  });
  it('createPayment posts auth+fields, returns id+redirect', async () => {
    const spy = jest.spyOn(global,'fetch' as any).mockResolvedValue({ ok:true, status:200,
      json: async () => ({ id:'pay_1', result:{code:'000.200.000'}, redirect:{url:'https://peach/pay',method:'GET',parameters:[]} }),
      text: async () => '' } as any);
    const r = await new PeachClient().createPayment({ amount:50, currency:'ZAR', merchantTransactionId:'TKT-1', shopperResultUrl:'https://x/r', nonce:'n1' });
    expect(r.id).toBe('pay_1'); expect(r.redirect?.url).toBe('https://peach/pay');
    const [url,opts] = spy.mock.calls[0]; expect(url).toBe('https://api-v2.peachpayments.com/payments');
    const body = JSON.parse((opts as any).body);
    expect(body.authentication).toEqual({ userId:'U', password:'P', entityId:'E' });
    expect(body.amount).toBe('50.00'); expect(body.paymentType).toBe('DB'); expect(body.paymentBrand).toBe('CARD');
  });
  it('createPayment throws on non-ok', async () => {
    jest.spyOn(global,'fetch' as any).mockResolvedValue({ ok:false, status:401, text: async () => 'no' } as any);
    await expect(new PeachClient().createPayment({ amount:1, currency:'ZAR', merchantTransactionId:'x', shopperResultUrl:'y', nonce:'z' }))
      .rejects.toThrow(/Peach createPayment failed: HTTP 401/);
  });
  it('getPaymentStatus GETs with query auth', async () => {
    const spy = jest.spyOn(global,'fetch' as any).mockResolvedValue({ ok:true, status:200,
      json: async () => ({ result:{code:'000.000.000'}, amount:'50.00', currency:'ZAR' }) } as any);
    const s = await new PeachClient().getPaymentStatus('pay_1');
    expect(s.code).toBe('000.000.000'); expect(s.amount).toBe('50.00');
    expect((spy.mock.calls[0][0] as string)).toContain('/payments/pay_1?');
    expect((spy.mock.calls[0][0] as string)).toContain('authentication.userId=U');
  });
  it('decryptWebhook round-trips an AES-128-GCM payload', () => {
    const key = '00112233445566778899aabbccddeeff';
    const iv = '000000000000000000000000';
    const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(key,'hex'), Buffer.from(iv,'hex'));
    const pt = JSON.stringify({ id:'pay_1', result:{code:'000.000.000'} });
    const enc = Buffer.concat([cipher.update(pt,'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    process.env.PEACH_WEBHOOK_SECRET = key;
    const out = new PeachClient().decryptWebhook({ bodyHex: enc.toString('hex'), ivHex: iv, authTagHex: tag.toString('hex') });
    expect(out.id).toBe('pay_1'); expect(out.result.code).toBe('000.000.000');
  });
});
```
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement**
```typescript
// src/services/payments/peach.client.ts
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
```
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5:** Append additive env to `.env.example`:
```
# Peach Payments (card via Payments API v2)
CARD_PAYMENTS_ENABLED=false
PEACH_BASE_URL=https://api-v2.peachpayments.com
PEACH_ENTITY_ID=
PEACH_USER_ID=
PEACH_PASSWORD=
PEACH_WEBHOOK_SECRET=
CARD_CURRENCY=ZAR
CARD_RESULT_URL=
```
- [ ] **Step 6: Commit** `feat(payments): PeachClient for Payments API v2`.

---

## Task 3: CardProcessor + peachPaymentId field (api)

**Files:** Create `src/services/payments/card.processor.ts`; Modify `src/services/payments/index.ts`, `src/models/ticketSale.model.ts`. Test `src/services/payments/__tests__/card.processor.test.ts`.

**Interfaces:** `getProcessor(PaymentMethod.CARD)` returns a processor whose `charge()` throws. `TicketSale.peachPaymentId?:string` (indexed).

- [ ] **Step 1: Failing test**
```typescript
import { getProcessor } from '@services/payments';
import { PaymentMethod } from '@interfaces/ticket.interface';
describe('CardProcessor', () => {
  it('registered for CARD', () => { expect(getProcessor(PaymentMethod.CARD).method).toBe(PaymentMethod.CARD); });
  it('charge throws (async-only)', async () => {
    await expect(getProcessor(PaymentMethod.CARD).charge({ method: PaymentMethod.CARD, amount: 1, description: 'x' })).rejects.toThrow(/async/i);
  });
});
```
- [ ] **Step 2: Run** → FAIL (Unsupported payment method).
- [ ] **Step 3: Implement** `card.processor.ts` (mirror `mtnMomo.processor.ts`): `method=PaymentMethod.CARD; isConfigured(){return true;} async charge(){ throw new Error('Card is async — use TicketService.initiateCardPurchase, not the synchronous charge path'); }`.
- [ ] **Step 4:** Register in `payments/index.ts`: import `CardProcessor`, add `[PaymentMethod.CARD]: new CardProcessor(),`.
- [ ] **Step 5:** In `ticketSale.model.ts` after `momoReferenceId` block add `peachPaymentId: { type: String, sparse: true, index: true, trim: true },` (+ interface field if present).
- [ ] **Step 6: Run** test + `npx tsc --noEmit` → PASS / clean.
- [ ] **Step 7: Commit** `feat(payments): CardProcessor + peachPaymentId`.

---

## Task 4: TicketService.initiateCardPurchase (api)

**Files:** Modify `src/services/ticket.service.ts` (after `initiateMomoPurchase`). Test `src/services/__tests__/ticket.card.test.ts`.

**Interfaces:** Produces `TicketService.initiateCardPurchase(p):Promise<{paymentId:string;redirect:any;saleId:string;expiresAt:Date}>`, `getCardSaleByPaymentId(id)`.

- [ ] **Step 1: Failing test** (copy the Event/TicketSale/ReservationService mock scaffold from the existing momo test in `src/services/__tests__`; mock PeachClient):
```typescript
jest.mock('@services/payments/peach.client', () => {
  const createPayment = jest.fn(); const getPaymentStatus = jest.fn();
  return { classifyResultCode: jest.requireActual('@services/payments/peach.client').classifyResultCode,
    PeachClient: jest.fn().mockImplementation(() => ({ isConfigured: () => true, createPayment, getPaymentStatus })),
    __mock: { createPayment, getPaymentStatus } };
});
// createPayment → { id:'pay_1', code:'000.200.000', redirect:{url:'https://peach/pay',method:'GET'} }
describe('initiateCardPurchase', () => {
  it('creates PENDING card sale, reserves, returns paymentId+redirect', async () => {
    const r = await TicketService.initiateCardPurchase({ eventId:'000000000000000000000001', ticketTypeId:'000000000000000000000002', quantity:1, customerPhone:'+26878422613' } as any);
    expect(r.paymentId).toBeDefined(); expect(r.redirect).toBeDefined(); expect(r.saleId).toBeDefined();
  });
});
```
- [ ] **Step 2: Run** → FAIL (not a function).
- [ ] **Step 3:** Add `import { PeachClient, classifyResultCode } from '@services/payments/peach.client';` and `private static peachClient = new PeachClient();`.
- [ ] **Step 4: Implement** `initiateCardPurchase` (mirror `initiateMomoPurchase`; no payer phone; `paymentMethod: PaymentMethod.CARD`; after reserving, `const nonce = sale.saleId + '-' + sale._id.toString();` then `createPayment({ amount: totalAmount, currency: process.env['CARD_CURRENCY']||'ZAR', merchantTransactionId: sale.saleId, shopperResultUrl: process.env['CARD_RESULT_URL']||'', nonce })`; store `sale.peachPaymentId = id`; return `{ paymentId:id, redirect, saleId: sale._id.toString(), expiresAt }`; on error release+fail+rethrow). Add `getCardSaleByPaymentId(id){ return TicketSale.findOne({ peachPaymentId: id }); }`.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(payments): initiateCardPurchase`.

---

## Task 5: TicketService.finalizeCardSale (api)

**Files:** Modify `src/services/ticket.service.ts` (after `finalizeMomoSale`). Test: extend `src/services/__tests__/ticket.card.test.ts`.

**Interfaces:** `TicketService.finalizeCardSale(paymentId):Promise<{status:'completed'|'failed'|'pending'}>`.

- [ ] **Step 1: Failing tests** — pending(`000.200.000`)→pending; rejected(`800.100.151`)→release+fail; success(`000.000.000`,amount/currency match)→completed+mint; amount/currency mismatch→failed; already-COMPLETED→completed (idempotent).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** mirroring `finalizeMomoSale` but: lookup by `peachPaymentId`; `const { code, amount, currency } = await this.peachClient.getPaymentStatus(paymentId); const outcome = classifyResultCode(code||'');`; pending→pending; rejected→release+fail; success→assert `Number(amount)===sale.totalAmount && currency===(process.env['CARD_CURRENCY']||'ZAR')` else log+release+fail; atomic claim; mint via `buildTicket`; confirm reservation; `updateTicketsSold`; best-effort SMS.
- [ ] **Step 4: Run** → PASS (5 cases).
- [ ] **Step 5: Commit** `feat(payments): finalizeCardSale idempotent + amount guard`.

---

## Task 6: Public routes + controllers + webhook (api)

**Files:** Modify `src/controllers/public.controller.ts`, `src/routes/public.route.ts`, `src/app.ts`; Create `src/controllers/card.controller.ts`, `src/routes/card.route.ts`. Test `src/routes/__tests__/card.route.test.ts`.

**Interfaces:** `GET /api/public/payment-methods` includes `'card'` when enabled+configured. `POST /api/public/purchase/card` (buyer-auth) → `{paymentId,redirect,saleId,expiresAt}`. `GET /api/public/purchase/card/:paymentId/status` (buyer-auth, ownership-checked) → `{status}`. `POST /api/public/purchase/card/webhook` (unauth) → decrypt → finalize → always 200.

- [ ] **Step 1: Failing test** (webhook always-200 + calls finalize; copy supertest setup from momo route test). Webhook reads encrypted body: headers `x-initialization-vector`, `x-authentication-tag`; body is raw hex text. For the test, mock `TicketService.finalizeCardSale` and post a JSON `{ id }` fallback path (controller also accepts plaintext `{id}` when `PEACH_WEBHOOK_SECRET` unset).
- [ ] **Step 2: Run** → FAIL (404).
- [ ] **Step 3:** In `public.controller.ts`: import `PeachClient`; in `getPaymentMethods` add `if (cfg.cardEnabled && new PeachClient().isConfigured()) methods.push('card');`. Add `cardInitiateSchema` (eventId,ticketTypeId,quantity,customerName?) + `initiateCardPurchase` and `getCardStatus` (mirror momo controllers; ownership via `getCardSaleByPaymentId` + normalizePhone).
- [ ] **Step 4:** In `public.route.ts` add `router.post('/purchase/card', authenticateBuyer, PublicController.initiateCardPurchase);` and `router.get('/purchase/card/:paymentId/status', authenticateBuyer, PublicController.getCardStatus);`.
- [ ] **Step 5:** Create `card.controller.ts` webhook: if `PEACH_WEBHOOK_SECRET` set, read `req.headers['x-initialization-vector']`/`['x-authentication-tag']` + raw body hex → `new PeachClient().decryptWebhook(...)` → payload; else parse `req.body` JSON. Extract `payload.id`; `await TicketService.finalizeCardSale(id)` in try/catch; always `res.status(200).json({ok:true})`. Create `card.route.ts` (`router.post('/webhook', express.text({type:'*/*'})?, CardController.webhook)` — accept raw). Mount in `app.ts`: `app.use('/api/public/purchase/card', cardRoutes)`.
- [ ] **Step 6: Run** test + `npx jest && npx tsc --noEmit` → PASS/clean.
- [ ] **Step 7: Commit** `feat(payments): card public routes + webhook`.

---

## Task 7: landing buyer frontend (types + api + modal + result page)

**Files:** Modify `landing/src/types/index.ts`, `landing/src/services/api.ts`, `landing/src/components/PurchaseModal.tsx`, `landing/src/App.tsx`; Create `landing/src/pages/PaymentResultPage.tsx`.

**Interfaces:** `PaymentMethodId` += `'card'`; `CardInitiateResponse{paymentId;redirect:{url:string;method:string;parameters?:any[]};saleId:string}`; `api.initiateCardPayment(data)`, `api.checkCardPaymentStatus(paymentId)`.

- [ ] **Step 1:** types: add `'card'` + `CardInitiateResponse` + reuse `MomoStatusResponse`.
- [ ] **Step 2:** api: `initiateCardPayment` (POST `/api/public/purchase/card`, buyer token) and `checkCardPaymentStatus` (GET status) — mirror the momo functions.
- [ ] **Step 3:** PurchaseModal: add `'card'` method button (CreditCard icon, label "Card"). On pay with card: `const { redirect } = await api.initiateCardPayment({eventId,ticketTypeId:ticketType.id,quantity,customerName})`; then perform the redirect: if `redirect.method==='GET'` → `window.location.href = redirect.url` (append `parameters` as query if present); if `POST` → build+submit a hidden form to `redirect.url` with each `parameters[i].name/value`. Show a "Redirecting to secure card page…" loading state first.
- [ ] **Step 4:** Create `PaymentResultPage.tsx` at `/payment-result`: read `id`/`merchantTransactionId`/`ref` query params (Peach appends the payment id); call `checkCardPaymentStatus(id)`; poll ~20×3s; show success (→ /my-tickets) / failure (→ /). (Same shape as the MoMo polling logic.)
- [ ] **Step 5:** Register `<Route path="/payment-result" element={<PaymentResultPage/>}/>` in `App.tsx`.
- [ ] **Step 6:** `cd landing && npx tsc --noEmit && npx vite build` → clean.
- [ ] **Step 7: Commit** (landing) `feat(checkout): card payment redirect flow + result page`.

---

## Task 8: dashboard cardEnabled toggle

**Files:** Modify the dashboard Settings page + its payments api lib (inspect `dashboard/src/pages/SettingsPage.tsx` + `dashboard/src/lib/payment.ts`/`api.ts` for the existing `mtnMomoEnabled`/`keshlessWalletEnabled` toggles and mirror).

**Interfaces:** A "Card payments (Peach)" toggle bound to `cardEnabled` via the existing payment-config update endpoint.

- [ ] **Step 1:** Find how the existing toggles read/write config (the endpoint + the lib function). Add `cardEnabled` to the relevant TS type.
- [ ] **Step 2:** Add the toggle UI next to the MoMo toggle, labeled "Card payments (Peach) — Visa/Mastercard", wired to the same update call with `{cardEnabled}`.
- [ ] **Step 3:** `cd dashboard && npx tsc --noEmit && npx vite build` → clean.
- [ ] **Step 4: Commit** (dashboard) `feat(settings): card payments toggle`.

---

## Task 9: Deploy (OFF), verify wiring

**Files:** none (operational). Ship with `cardEnabled=false` so card is invisible until toggled.

- [ ] **Step 1:** Bind Peach secrets additively on Cloud Run (`carrot-tickets-api`, europe-west1) via deployer SA: create secrets `CARROT_TICKETS__PEACH_USER_ID`, `CARROT_TICKETS__PEACH_PASSWORD`, `CARROT_TICKETS__PEACH_ENTITY_ID` (+ `CARROT_TICKETS__PEACH_WEBHOOK_SECRET` when available); grant the service's runtime SA secretAccessor.
- [ ] **Step 2:** `gcloud run services update carrot-tickets-api --region=europe-west1 --update-secrets=PEACH_ENTITY_ID=...:latest,PEACH_USER_ID=...:latest,PEACH_PASSWORD=...:latest --update-env-vars=CARD_PAYMENTS_ENABLED=true,PEACH_BASE_URL=https://api-v2.peachpayments.com,CARD_CURRENCY=ZAR,CARD_RESULT_URL=https://<landing-domain>/payment-result` (additive). Leave `cardEnabled=false` in DB.
- [ ] **Step 3:** Merge/deploy branches: api via Cloud Build trigger; landing + dashboard via Cloudflare Pages (push prod branch). Confirm `GET /api/public/payment-methods` does NOT list `card` (toggle off) — proving it's shipped but dark.
- [ ] **Step 4:** Hand off: "Flip the dashboard Card toggle ON once Peach activates the entity. Add the webhook URL `https://<api-domain>/api/public/purchase/card/webhook` and paste the webhook secret for encrypted-webhook finalization (polling works without it)."

---

## Self-Review
- Spec coverage: enum/toggle (T1), client incl webhook decrypt (T2), processor+field (T3), initiate (T4), finalize+guard (T5), routes+webhook (T6), buyer FE redirect+result (T7), dashboard toggle (T8), deploy-dark (T9). Ship-off gate = env-on + cardEnabled-off (T1/T6/T9). Confirmed contract used verbatim (T2 Global Constraints).
- Type consistency: `createPayment`→{id,code,redirect} (T2) used in T4; `getPaymentStatus`→{code,amount,currency} (T2) used in T5; `initiateCardPurchase`→{paymentId,redirect,saleId} (T4)→controller (T6)→`CardInitiateResponse` (T7); `finalizeCardSale`→{status} (T5) used T6; `classifyResultCode` (T2) used T5.
- Live verification (real charge) deferred — blocked on Peach entity activation; documented in T9 handoff.
