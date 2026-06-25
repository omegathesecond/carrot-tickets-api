# Peach Card Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Visa/Mastercard card payments to the Carrot Tickets online buyer checkout via Peach Payments COPYandPAY.

**Architecture:** Card is an async, redirect-verified payment that follows the existing MTN MoMo pattern: `initiateCardPurchase` (PENDING sale + inventory reservation + Peach prepare-checkout) → buyer pays on the embedded Peach widget → full-page redirect to a result page → `finalizeCardSale` verifies status server-side and mints tickets idempotently. A new `PeachClient` encapsulates all Peach HTTP. Tickets mint ONLY after server-side status verification with an exact amount+currency match.

**Tech Stack:** Node 20 + TypeScript + Express + Mongoose (api), React + Vite + react-router (landing), Jest tests, Peach Payments COPYandPAY (OPPWA, `card.peachpayments.com/v1`).

## Global Constraints

- Peach product: COPYandPAY (OPPWA). Base URL `https://card.peachpayments.com` (production).
- Currency sent to Peach: `process.env.CARD_CURRENCY` default `ZAR`, numeric amount equals the SZL price 1:1. Buyer-facing display stays `E`.
- `paymentType=DB` (immediate debit). No preauth, no refunds in this plan.
- No silent fallbacks: every Peach failure surfaces (thrown error → 4xx/5xx). SMS sends stay best-effort.
- Card sale is electronic ⇒ economic snapshot `fundsCustody` derives to `'carrot'` via the existing `buildSaleSnapshot` helper.
- Mint tickets ONLY after `getPaymentStatus` confirms success AND returned `amount`+`currency` exactly equal the sale's (mirror `finalizeMomoSale`).
- Finalize is idempotent via atomic `findOneAndUpdate({_id, paymentStatus: PENDING})`.
- Env edits are ADDITIVE — never wipe existing keys. Secret Manager bindings on Cloud Run use `--update-secrets` (additive).
- Buyer phone always comes from the buyer token (`req.ticketsUser.userPhone`), never the request body.
- Path aliases: `@models/*`, `@services/*`, `@interfaces/*`, `@controllers/*`, `@utils/*`, `@middleware/*` (see `tsconfig.json`).

## File Structure

**api (`carrot-tickets-api`):**
- Create: `src/services/payments/peach.client.ts` — all Peach HTTP (token, prepare-checkout, status, result-code helpers).
- Create: `src/services/payments/card.processor.ts` — registry processor whose `charge()` throws (async-only).
- Create: `src/controllers/card.controller.ts` — unauthenticated Peach webhook receiver.
- Create: `src/routes/card.route.ts` — mounts the webhook route.
- Create: tests under `src/services/payments/__tests__/peach.client.test.ts`, `src/services/__tests__/ticket.card.test.ts`, `src/routes/__tests__/card.route.test.ts`.
- Create: `src/scripts/peachAuthSpike.ts` — throwaway prod auth probe (removed at end of Task 1).
- Modify: `src/interfaces/ticket.interface.ts` — add `PaymentMethod.CARD`.
- Modify: `src/models/paymentMethodConfig.model.ts` + `src/services/paymentConfig.service.ts` — add `cardEnabled`.
- Modify: `src/models/ticketSale.model.ts` — add `peachCheckoutId`.
- Modify: `src/services/payments/index.ts` — register `CardProcessor`.
- Modify: `src/services/ticket.service.ts` — add `initiateCardPurchase`, `finalizeCardSale`, `getCardSaleByCheckoutId`.
- Modify: `src/controllers/public.controller.ts` — `initiateCardPurchase`, `getCardStatus`, card in `getPaymentMethods`.
- Modify: `src/routes/public.route.ts` — card initiate + status routes.
- Modify: `src/app.ts` — mount `card.route.ts`.
- Modify: `.env.example` — additive Peach keys.

**landing (`carrot-tickets-website`):**
- Modify: `src/types/index.ts` — `PaymentMethodId` += `'card'`, add `CardInitiateResponse`.
- Modify: `src/services/api.ts` — `initiateCardPayment`, `checkCardPaymentStatus`.
- Modify: `src/components/PurchaseModal.tsx` — card method + widget injection.
- Create: `src/pages/PaymentResultPage.tsx` — result page.
- Modify: `src/App.tsx` — `/payment-result` route.

---

## Task 1: Peach auth spike (production)

Resolve the one undocumented detail: how `entityId`+`username`+`password` authenticate. A prepare-checkout call only CREATES a checkout id; it does not charge anyone, so it is safe to run against prod.

**Files:**
- Create (throwaway): `src/scripts/peachAuthSpike.ts`

**Interfaces:**
- Produces: confirmed value of `PeachClient.getAccessToken()` semantics consumed by Task 3.

- [ ] **Step 1: Write the spike script**

```typescript
// src/scripts/peachAuthSpike.ts — THROWAWAY. Probes Peach COPYandPAY auth on prod.
// Run: PEACH_ENTITY_ID=... PEACH_PASSWORD=... npx ts-node -r tsconfig-paths/register src/scripts/peachAuthSpike.ts
const BASE = process.env['PEACH_BASE_URL'] || 'https://card.peachpayments.com';
const entityId = process.env['PEACH_ENTITY_ID']!;
const password = process.env['PEACH_PASSWORD']!; // dashboard "password" — hypothesised Bearer token

async function prepare(bearer: string) {
  const body = new URLSearchParams({
    entityId, amount: '1.00', currency: process.env['CARD_CURRENCY'] || 'ZAR',
    paymentType: 'DB', integrity: 'true',
  });
  const res = await fetch(`${BASE}/v1/checkouts`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${bearer}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}\n${text}\n`);
  return res.ok;
}

(async () => {
  console.log('--- Hypothesis A: Bearer = dashboard password (static access token) ---');
  const okA = await prepare(password);
  if (okA) { console.log('AUTH CONFIRMED: Bearer = PEACH_PASSWORD'); return; }
  console.log('Hypothesis A failed. Inspect the response body above for the error code/realm.');
  console.log('If it indicates a token exchange is required, capture the auth-service URL from the');
  console.log('error or the Peach dashboard and implement getAccessToken() as the token-exchange variant in Task 3.');
})();
```

- [ ] **Step 2: Run the spike against prod**

Run (substitute real prod values; do NOT commit them):
```bash
PEACH_BASE_URL=https://card.peachpayments.com \
PEACH_ENTITY_ID=<entityId> \
PEACH_PASSWORD=<password> \
CARD_CURRENCY=ZAR \
npx ts-node -r tsconfig-paths/register src/scripts/peachAuthSpike.ts
```
Expected (Hypothesis A success): `HTTP 200` (or 201) with JSON containing `"id": "<checkoutId>"` and `result.code` ≈ `000.200.100`. Console prints `AUTH CONFIRMED: Bearer = PEACH_PASSWORD`.

If Hypothesis A fails: read the response body. A `401`/`800.900.x` realm error means a token exchange is required — note the auth-service URL, and in Task 3 implement `getAccessToken()` using the token-exchange variant (provided inline in Task 3, Step 3b). Either way, record the confirmed method here before continuing.

- [ ] **Step 3: Delete the throwaway script**

```bash
rm src/scripts/peachAuthSpike.ts
```

- [ ] **Step 4: Commit the decision note**

No code remains, so record the outcome in the plan/spec instead of committing the script. Add one line to the spec's auth section stating the confirmed method (e.g. "Confirmed: Bearer = dashboard password, no token exchange"). Then:
```bash
git add docs/superpowers/specs/2026-06-25-peach-card-payments-design.md
git commit -m "docs: record confirmed Peach COPYandPAY auth method"
```

---

## Task 2: Add CARD payment method + cardEnabled config toggle

**Files:**
- Modify: `src/interfaces/ticket.interface.ts:11-15`
- Modify: `src/models/paymentMethodConfig.model.ts`
- Modify: `src/services/paymentConfig.service.ts`
- Test: `src/services/__tests__/paymentConfig.card.test.ts` (create)

**Interfaces:**
- Produces: `PaymentMethod.CARD = 'card'`; `PaymentConfig.cardEnabled: boolean` (default `false`) on the object returned by `PaymentConfigService.get()` / `.update()`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/__tests__/paymentConfig.card.test.ts
import { PaymentConfigService } from '@services/paymentConfig.service';
import { PaymentMethodConfig } from '@models/paymentMethodConfig.model';

jest.mock('@models/paymentMethodConfig.model');

describe('PaymentConfigService cardEnabled', () => {
  afterEach(() => jest.clearAllMocks());

  it('defaults cardEnabled to false when unset', async () => {
    (PaymentMethodConfig.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(null) });
    const cfg = await PaymentConfigService.get();
    expect(cfg.cardEnabled).toBe(false);
  });

  it('returns cardEnabled from the stored doc', async () => {
    (PaymentMethodConfig.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve({ cardEnabled: true }) });
    const cfg = await PaymentConfigService.get();
    expect(cfg.cardEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/paymentConfig.card.test.ts -t cardEnabled`
Expected: FAIL — `cfg.cardEnabled` is `undefined`.

- [ ] **Step 3: Add the enum value**

In `src/interfaces/ticket.interface.ts`, change the `PaymentMethod` enum to:
```typescript
export enum PaymentMethod {
  CASH = 'cash',
  KESHLESS_WALLET = 'keshless_wallet',
  MTN_MOMO = 'mtn_momo',
  CARD = 'card'
}
```

- [ ] **Step 4: Add cardEnabled to the model**

In `src/models/paymentMethodConfig.model.ts`, add `cardEnabled: boolean;` to the interface (after `mtnMomoEnabled`) and to the schema:
```typescript
  cardEnabled: { type: Boolean, default: false },
```
(Place it directly after the `mtnMomoEnabled` schema line.)

- [ ] **Step 5: Add cardEnabled to PaymentConfigService**

In `src/services/paymentConfig.service.ts`:
- Add `cardEnabled: false,` to `DEFAULTS` (after `mtnMomoEnabled`).
- In both the `get()` and `update()` return objects, add:
  ```typescript
  cardEnabled: doc?.cardEnabled ?? DEFAULTS.cardEnabled,
  ```
  (in `update()` use `doc!.cardEnabled ?? DEFAULTS.cardEnabled`).

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/services/__tests__/paymentConfig.card.test.ts -t cardEnabled`
Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
git add src/interfaces/ticket.interface.ts src/models/paymentMethodConfig.model.ts src/services/paymentConfig.service.ts src/services/__tests__/paymentConfig.card.test.ts
git commit -m "feat(payments): add CARD payment method + cardEnabled config toggle"
```

---

## Task 3: PeachClient

**Files:**
- Create: `src/services/payments/peach.client.ts`
- Test: `src/services/payments/__tests__/peach.client.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces:
  - `class PeachClient` with:
    - `isConfigured(): boolean`
    - `getAccessToken(): Promise<string>`
    - `prepareCheckout(p: { amount: number; currency: string; merchantTransactionId: string }): Promise<{ checkoutId: string; integrity: string }>`
    - `getPaymentStatus(checkoutId: string): Promise<{ code: string; amount?: string; currency?: string; raw: any }>`
  - `function classifyResultCode(code: string): 'success' | 'pending' | 'rejected'`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/payments/__tests__/peach.client.test.ts
import { PeachClient, classifyResultCode } from '@services/payments/peach.client';

describe('classifyResultCode', () => {
  it('classifies success codes', () => {
    expect(classifyResultCode('000.100.110')).toBe('success');
    expect(classifyResultCode('000.000.000')).toBe('success');
  });
  it('classifies pending codes', () => {
    expect(classifyResultCode('000.200.000')).toBe('pending');
  });
  it('classifies everything else as rejected', () => {
    expect(classifyResultCode('800.100.151')).toBe('rejected');
    expect(classifyResultCode('100.396.101')).toBe('rejected');
  });
});

describe('PeachClient', () => {
  const OLD = process.env;
  beforeEach(() => {
    process.env = { ...OLD, CARD_PAYMENTS_ENABLED: 'true', PEACH_BASE_URL: 'https://card.peachpayments.com',
      PEACH_ENTITY_ID: 'ent123', PEACH_PASSWORD: 'tok456', CARD_CURRENCY: 'ZAR' };
  });
  afterEach(() => { process.env = OLD; jest.restoreAllMocks(); });

  it('isConfigured true only when enabled + entityId + password present', () => {
    expect(new PeachClient().isConfigured()).toBe(true);
    process.env['CARD_PAYMENTS_ENABLED'] = 'false';
    expect(new PeachClient().isConfigured()).toBe(false);
  });

  it('prepareCheckout posts form body and returns checkoutId + integrity', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ id: 'chk_1', integrity: 'sha-xyz', result: { code: '000.200.100' } }),
      text: async () => '',
    } as any);
    const r = await new PeachClient().prepareCheckout({ amount: 50, currency: 'ZAR', merchantTransactionId: 'TKT-1' });
    expect(r).toEqual({ checkoutId: 'chk_1', integrity: 'sha-xyz' });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://card.peachpayments.com/v1/checkouts');
    expect((opts as any).method).toBe('POST');
    const body = (opts as any).body.toString();
    expect(body).toContain('entityId=ent123');
    expect(body).toContain('amount=50.00');
    expect(body).toContain('currency=ZAR');
    expect(body).toContain('paymentType=DB');
  });

  it('prepareCheckout throws on non-ok', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' } as any);
    await expect(new PeachClient().prepareCheckout({ amount: 50, currency: 'ZAR', merchantTransactionId: 'x' }))
      .rejects.toThrow(/Peach prepareCheckout failed: HTTP 401/);
  });

  it('getPaymentStatus returns code, amount, currency', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ result: { code: '000.100.110' }, amount: '50.00', currency: 'ZAR' }),
    } as any);
    const s = await new PeachClient().getPaymentStatus('chk_1');
    expect(s.code).toBe('000.100.110');
    expect(s.amount).toBe('50.00');
    expect(s.currency).toBe('ZAR');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/payments/__tests__/peach.client.test.ts`
Expected: FAIL — module `peach.client` not found.

- [ ] **Step 3a: Implement PeachClient (Hypothesis A — Bearer = password)**

Use this if Task 1 confirmed Hypothesis A:
```typescript
// src/services/payments/peach.client.ts
const SUCCESS_RE = /^(000\.000\.|000\.100\.1|000\.[36]|000\.400\.000)/;
const PENDING_RE = /^(000\.200|800\.400\.5|100\.400\.500)/;

export function classifyResultCode(code: string): 'success' | 'pending' | 'rejected' {
  if (SUCCESS_RE.test(code)) return 'success';
  if (PENDING_RE.test(code)) return 'pending';
  return 'rejected';
}

export class PeachClient {
  private baseUrl = process.env['PEACH_BASE_URL'] || 'https://card.peachpayments.com';
  private entityId = process.env['PEACH_ENTITY_ID'] || '';
  private password = process.env['PEACH_PASSWORD'] || '';

  isConfigured(): boolean {
    return process.env['CARD_PAYMENTS_ENABLED'] === 'true' && !!this.entityId && !!this.password;
  }

  // Hypothesis A: the dashboard "password" IS the COPYandPAY Bearer access token.
  async getAccessToken(): Promise<string> {
    return this.password;
  }

  async prepareCheckout(p: { amount: number; currency: string; merchantTransactionId: string }): Promise<{ checkoutId: string; integrity: string }> {
    const token = await this.getAccessToken();
    const body = new URLSearchParams({
      entityId: this.entityId,
      amount: p.amount.toFixed(2),
      currency: p.currency,
      paymentType: 'DB',
      integrity: 'true',
      merchantTransactionId: p.merchantTransactionId,
    });
    const res = await fetch(`${this.baseUrl}/v1/checkouts`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Peach prepareCheckout failed: HTTP ${res.status} ${t}`);
    }
    const data: any = await res.json();
    if (!data.id) throw new Error(`Peach prepareCheckout returned no checkout id: ${JSON.stringify(data.result)}`);
    return { checkoutId: data.id, integrity: data.integrity };
  }

  async getPaymentStatus(checkoutId: string): Promise<{ code: string; amount?: string; currency?: string; raw: any }> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl}/v1/checkouts/${encodeURIComponent(checkoutId)}/payment?entityId=${encodeURIComponent(this.entityId)}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Peach getPaymentStatus failed: HTTP ${res.status} ${t}`);
    }
    const data: any = await res.json();
    return { code: data?.result?.code, amount: data?.amount, currency: data?.currency, raw: data };
  }
}
```

- [ ] **Step 3b: (ONLY if Task 1 showed a token exchange is required) replace getAccessToken**

Replace the `getAccessToken()` body and add the token-cache fields. Use the auth-service URL confirmed in Task 1:
```typescript
  private clientId = process.env['PEACH_USERNAME'] || '';
  private token?: { value: string; expiresAt: number };

  async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const res = await fetch(`${process.env['PEACH_AUTH_URL']}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: this.clientId, clientSecret: this.password, merchantId: this.entityId }),
    });
    if (!res.ok) throw new Error(`Peach token failed: HTTP ${res.status}`);
    const d: any = await res.json();
    this.token = { value: d.access_token, expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
```
If using 3b, also add `PEACH_AUTH_URL=` and `PEACH_USERNAME=` to `.env.example` in Step 5.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/payments/__tests__/peach.client.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Add additive env keys to .env.example**

Append to `.env.example` (do not remove anything):
```
# Peach Payments (card via COPYandPAY)
CARD_PAYMENTS_ENABLED=false
PEACH_BASE_URL=https://card.peachpayments.com
PEACH_ENTITY_ID=
PEACH_USERNAME=
PEACH_PASSWORD=
CARD_CURRENCY=ZAR
CARD_RESULT_URL=
```

- [ ] **Step 6: Commit**

```bash
git add src/services/payments/peach.client.ts src/services/payments/__tests__/peach.client.test.ts .env.example
git commit -m "feat(payments): add PeachClient for COPYandPAY"
```

---

## Task 4: CardProcessor + registry registration

**Files:**
- Create: `src/services/payments/card.processor.ts`
- Modify: `src/services/payments/index.ts`
- Test: `src/services/payments/__tests__/card.processor.test.ts`

**Interfaces:**
- Consumes: `PaymentMethod.CARD` (Task 2), `PaymentProcessor` interface (`src/services/payments/types.ts`).
- Produces: `class CardProcessor implements PaymentProcessor`; registered so `getProcessor(PaymentMethod.CARD)` returns it.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/payments/__tests__/card.processor.test.ts
import { getProcessor } from '@services/payments';
import { PaymentMethod } from '@interfaces/ticket.interface';

describe('CardProcessor', () => {
  it('is registered for CARD', () => {
    expect(getProcessor(PaymentMethod.CARD).method).toBe(PaymentMethod.CARD);
  });
  it('charge() throws — card is async-only', async () => {
    await expect(getProcessor(PaymentMethod.CARD).charge({ method: PaymentMethod.CARD, amount: 1, description: 'x' }))
      .rejects.toThrow(/async/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/payments/__tests__/card.processor.test.ts`
Expected: FAIL — `Unsupported payment method: card`.

- [ ] **Step 3: Implement CardProcessor**

```typescript
// src/services/payments/card.processor.ts
import { PaymentMethod } from '@interfaces/ticket.interface';
import { ChargeInput, ChargeResult, PaymentProcessor } from './types';

export class CardProcessor implements PaymentProcessor {
  method = PaymentMethod.CARD;
  isConfigured() { return true; }

  // Card is async (Peach hosted widget): TicketService.initiateCardPurchase drives
  // prepare-checkout directly. charge() must NEVER be reached via the synchronous
  // sellTickets path — that path treats non-failed as COMPLETED and would mint
  // tickets without confirmed payment.
  async charge(_input: ChargeInput): Promise<ChargeResult> {
    throw new Error('Card is async — use TicketService.initiateCardPurchase, not the synchronous charge path');
  }
}
```

- [ ] **Step 4: Register it**

In `src/services/payments/index.ts`, add the import and registry entry:
```typescript
import { CardProcessor } from './card.processor';
```
and inside the `processors` map add:
```typescript
  [PaymentMethod.CARD]: new CardProcessor(),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/services/payments/__tests__/card.processor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/payments/card.processor.ts src/services/payments/index.ts src/services/payments/__tests__/card.processor.test.ts
git commit -m "feat(payments): register async-only CardProcessor"
```

---

## Task 5: TicketSale.peachCheckoutId field

**Files:**
- Modify: `src/models/ticketSale.model.ts` (after the `momoReferenceId` block, ~line 81)

**Interfaces:**
- Produces: `peachCheckoutId?: string` persisted + indexed on TicketSale.

- [ ] **Step 1: Add the field to the interface + schema**

In `src/models/ticketSale.model.ts`, find the `momoReferenceId` schema block and add directly after it:
```typescript
  peachCheckoutId: {
    type: String,
    sparse: true,
    index: true,
    trim: true
  },
```
If the file has a separate TS interface for the sale document, add `peachCheckoutId?: string;` next to `momoReferenceId?: string;`.

- [ ] **Step 2: Verify the project compiles**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/models/ticketSale.model.ts
git commit -m "feat(payments): add peachCheckoutId to TicketSale"
```

---

## Task 6: TicketService.initiateCardPurchase

**Files:**
- Modify: `src/services/ticket.service.ts` (add near the MoMo methods, after `initiateMomoPurchase`)
- Test: `src/services/__tests__/ticket.card.test.ts`

**Interfaces:**
- Consumes: `PeachClient` (Task 3), `PaymentMethod.CARD` (Task 2), `peachCheckoutId` (Task 5), existing `EventService.checkTicketAvailability`, `ReservationService.reserve`, `buildSaleSnapshot`, `MOMO_TTL_MS`.
- Produces: `TicketService.initiateCardPurchase(p): Promise<{ checkoutId: string; integrity: string; saleId: string; expiresAt: Date }>` and `TicketService.getCardSaleByCheckoutId(checkoutId): Promise<TicketSale | null>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/__tests__/ticket.card.test.ts
import { TicketService } from '@services/ticket.service';
import { PaymentStatus } from '@interfaces/ticket.interface';

jest.mock('@services/payments/peach.client', () => {
  const prepareCheckout = jest.fn();
  const getPaymentStatus = jest.fn();
  return {
    classifyResultCode: jest.requireActual('@services/payments/peach.client').classifyResultCode,
    PeachClient: jest.fn().mockImplementation(() => ({
      isConfigured: () => true, prepareCheckout, getPaymentStatus,
    })),
    __mock: { prepareCheckout, getPaymentStatus },
  };
});

// Minimal model/service mocks — mirror the style of the existing momo test file.
// (Reuse the same mongoose-model mocking helpers the repo's ticket.service tests use.)

describe('initiateCardPurchase', () => {
  it('creates a PENDING card sale, reserves inventory, and returns the checkoutId', async () => {
    // Arrange availability + event + reservation mocks to succeed; prepareCheckout → { checkoutId, integrity }.
    // Act
    const r = await TicketService.initiateCardPurchase({
      eventId: '000000000000000000000001', ticketTypeId: '000000000000000000000002',
      quantity: 1, customerPhone: '+26878422613',
    } as any);
    // Assert
    expect(r.checkoutId).toBeDefined();
    expect(r.integrity).toBeDefined();
    expect(r.saleId).toBeDefined();
  });
});
```

Note: model setup mirrors `src/services/__tests__` momo tests. Open the existing momo test in that folder and copy its `Event`/`TicketSale`/`ReservationService` mock scaffold verbatim, swapping `momoClient` for the `PeachClient` mock above.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/ticket.card.test.ts -t initiateCardPurchase`
Expected: FAIL — `TicketService.initiateCardPurchase is not a function`.

- [ ] **Step 3: Add the PeachClient import + instance**

In `src/services/ticket.service.ts`:
- Add import: `import { PeachClient, classifyResultCode } from '@services/payments/peach.client';`
- Near `private static momoClient = new MtnMomoClient();` add: `private static peachClient = new PeachClient();`

- [ ] **Step 4: Implement initiateCardPurchase + getCardSaleByCheckoutId**

Add after `initiateMomoPurchase` (mirrors it; card has no payer phone). `merchantTransactionId` = `sale.saleId`:
```typescript
  static async initiateCardPurchase(p: {
    eventId: string;
    ticketTypeId: string;
    quantity: number;
    customerPhone: string;
    customerName?: string;
    vendorId?: string;
    soldBy?: string;
    soldByType?: 'vendor' | 'reseller-operator';
    resellerId?: string;
    hubId?: string;
    resellerCommissionPercent?: number;
    channel?: SalesChannel;
  }): Promise<{ checkoutId: string; integrity: string; saleId: string; expiresAt: Date }> {
    if (!this.peachClient.isConfigured()) throw new Error('Card payments are not available');

    const avail = await EventService.checkTicketAvailability(p.eventId, p.ticketTypeId, p.quantity);
    if (!avail.available) throw new Error(avail.message || 'Tickets not available');
    const tt = avail.ticketTypeData!;
    const totalAmount = tt.price * p.quantity;

    const event = await Event.findById(p.eventId);
    if (!event) throw new Error('Event not found');

    const soldByType = p.soldByType ?? 'vendor';
    const mappedSoldByType = SOLD_BY_TYPE_MAP[soldByType];
    const channel = p.channel ?? deriveChannel(mappedSoldByType);
    const vendorId = p.vendorId ?? event.vendorId;
    const soldBy = p.soldBy ?? event.vendorId;

    const econ = await this.buildSaleSnapshot({
      totalAmount,
      paymentMethod: PaymentMethod.CARD,
      mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent,
    });
    const resellerAttribution = {
      ...(p.resellerId ? { resellerId: p.resellerId } : {}),
      ...(p.hubId ? { hubId: p.hubId } : {}),
    };

    const sale = new TicketSale({
      eventId: p.eventId,
      vendorId,
      ticketIds: [],
      quantity: p.quantity,
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      totalAmount,
      paymentMethod: PaymentMethod.CARD,
      paymentStatus: PaymentStatus.PENDING,
      soldBy,
      soldByType: mappedSoldByType,
      channel,
      ...resellerAttribution,
      ...econ,
      soldAt: new Date(),
    });
    await sale.save();

    const { expiresAt } = await ReservationService.reserve({
      eventId: p.eventId,
      ticketTypeId: p.ticketTypeId,
      quantity: p.quantity,
      saleId: sale._id.toString(),
      ttlMs: this.MOMO_TTL_MS,
    });
    sale.reservationExpiresAt = expiresAt;

    try {
      const currency = process.env['CARD_CURRENCY'] || 'ZAR';
      const { checkoutId, integrity } = await this.peachClient.prepareCheckout({
        amount: totalAmount,
        currency,
        merchantTransactionId: sale.saleId,
      });
      sale.peachCheckoutId = checkoutId;
      await sale.save();
      return { checkoutId, integrity, saleId: sale._id.toString(), expiresAt };
    } catch (err) {
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      throw err;
    }
  }

  static async getCardSaleByCheckoutId(checkoutId: string): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ peachCheckoutId: checkoutId });
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/services/__tests__/ticket.card.test.ts -t initiateCardPurchase`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/ticket.service.ts src/services/__tests__/ticket.card.test.ts
git commit -m "feat(payments): TicketService.initiateCardPurchase"
```

---

## Task 7: TicketService.finalizeCardSale

**Files:**
- Modify: `src/services/ticket.service.ts` (add after `finalizeMomoSale`)
- Test: `src/services/__tests__/ticket.card.test.ts` (extend)

**Interfaces:**
- Consumes: `peachClient.getPaymentStatus`, `classifyResultCode`, `buildTicket`, `ReservationService.confirm/release`, `EventService.updateTicketsSold`, `SmsService.sendTicketConfirmation`.
- Produces: `TicketService.finalizeCardSale(checkoutId): Promise<{ status: 'completed' | 'failed' | 'pending' }>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to src/services/__tests__/ticket.card.test.ts
describe('finalizeCardSale', () => {
  it('returns pending while Peach status is pending', async () => {
    // sale PENDING; getPaymentStatus → { code: '000.200.000' }
    const r = await TicketService.finalizeCardSale('chk_pending');
    expect(r.status).toBe('pending');
  });

  it('releases reservation and fails on a rejected result', async () => {
    // sale PENDING; getPaymentStatus → { code: '800.100.151' }
    const r = await TicketService.finalizeCardSale('chk_rejected');
    expect(r.status).toBe('failed');
    // expect ReservationService.release called, sale.paymentStatus FAILED
  });

  it('refuses to mint when amount/currency mismatch', async () => {
    // sale totalAmount 50 ZAR; getPaymentStatus → success code but amount '10.00'
    const r = await TicketService.finalizeCardSale('chk_mismatch');
    expect(r.status).toBe('failed');
  });

  it('mints tickets on confirmed success', async () => {
    // sale 50 ZAR; getPaymentStatus → { code:'000.100.110', amount:'50.00', currency:'ZAR' }
    const r = await TicketService.finalizeCardSale('chk_ok');
    expect(r.status).toBe('completed');
  });

  it('is idempotent — second call returns completed without re-minting', async () => {
    // sale already COMPLETED
    const r = await TicketService.finalizeCardSale('chk_done');
    expect(r.status).toBe('completed');
  });
});
```
(Populate the mock returns described in each comment using the same scaffold as Task 6.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/services/__tests__/ticket.card.test.ts -t finalizeCardSale`
Expected: FAIL — `TicketService.finalizeCardSale is not a function`.

- [ ] **Step 3: Implement finalizeCardSale**

Add after `finalizeMomoSale` (mirrors it; the amount stored by Peach is a string, compare numerically):
```typescript
  static async finalizeCardSale(checkoutId: string): Promise<{ status: 'completed' | 'failed' | 'pending' }> {
    const sale = await TicketSale.findOne({ peachCheckoutId: checkoutId });
    if (!sale) throw new Error('Sale not found for checkout');

    if (sale.paymentStatus !== PaymentStatus.PENDING) {
      return { status: sale.paymentStatus === PaymentStatus.COMPLETED ? 'completed' : 'failed' };
    }

    const { code, amount, currency } = await this.peachClient.getPaymentStatus(checkoutId);
    const outcome = classifyResultCode(code || '');
    if (outcome === 'pending') return { status: 'pending' };

    const reservation = await TicketReservation.findOne({ saleId: sale._id });
    const ticketTypeId = reservation?.ticketTypeId;

    if (outcome === 'rejected') {
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    // success — verify the EXACT amount + currency before minting (no silent honour of a mismatch)
    const expectedCurrency = process.env['CARD_CURRENCY'] || 'ZAR';
    const confirmedAmount = Number(amount);
    if (!Number.isFinite(confirmedAmount) || confirmedAmount !== sale.totalAmount || currency !== expectedCurrency) {
      console.error('[card finalize] amount/currency mismatch — refusing to mint', {
        checkoutId,
        expected: { amount: sale.totalAmount, currency: expectedCurrency },
        confirmed: { amount, currency },
      });
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    const claimed = await TicketSale.findOneAndUpdate(
      { _id: sale._id, paymentStatus: PaymentStatus.PENDING },
      { $set: { paymentStatus: PaymentStatus.COMPLETED } },
      { new: true }
    );
    if (!claimed) return { status: 'completed' };

    const event = await Event.findById(sale.eventId);
    const ticketTypeDoc = event?.ticketTypes.find((t: any) => t._id?.toString() === ticketTypeId);
    const tickets: ITicket[] = [];
    for (let i = 0; i < sale.quantity; i++) {
      const t = this.buildTicket({
        eventId: sale.eventId,
        vendorId: sale.vendorId,
        ticketType: ticketTypeDoc?.name || 'Ticket',
        price: sale.totalAmount / sale.quantity,
        customerName: sale.customerName,
        customerPhone: sale.customerPhone,
        saleId: sale._id,
      });
      await t.save();
      tickets.push(t);
    }

    claimed.ticketIds = tickets.map(t => t._id as mongoose.Types.ObjectId);
    await claimed.save();

    await ReservationService.confirm(sale._id.toString());
    if (ticketTypeId) {
      await EventService.updateTicketsSold(sale.eventId.toString(), ticketTypeId, sale.quantity, sale.totalAmount);
    }

    if (sale.customerPhone && event) {
      SmsService.sendTicketConfirmation(
        sale.customerPhone,
        tickets.map(t => ({ ticketId: t.ticketId, eventName: event.name, eventDate: event.eventDate.toISOString(), venue: event.venue })),
      ).catch(err => console.error('[SMS] card confirmation threw', err));
    }

    return { status: 'completed' };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/services/__tests__/ticket.card.test.ts -t finalizeCardSale`
Expected: PASS (all five cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/ticket.service.ts src/services/__tests__/ticket.card.test.ts
git commit -m "feat(payments): TicketService.finalizeCardSale with idempotent mint + amount guard"
```

---

## Task 8: Public API surface — methods list, initiate, status, webhook

**Files:**
- Modify: `src/controllers/public.controller.ts`
- Modify: `src/routes/public.route.ts`
- Create: `src/controllers/card.controller.ts`
- Create: `src/routes/card.route.ts`
- Modify: `src/app.ts`
- Test: `src/routes/__tests__/card.route.test.ts`

**Interfaces:**
- Consumes: `TicketService.initiateCardPurchase`, `finalizeCardSale`, `getCardSaleByCheckoutId`, `PeachClient.isConfigured`, `PaymentConfigService.get`.
- Produces routes:
  - `GET /api/public/payment-methods` → includes `'card'` when enabled+configured.
  - `POST /api/public/purchase/card` (buyer-auth) → `{ checkoutId, integrity, saleId, expiresAt }`.
  - `GET /api/public/purchase/card/:checkoutId/status` (buyer-auth) → `{ status }`.
  - `POST /api/public/purchase/card/webhook` (unauth) → `{ ok: true }` always 200.

- [ ] **Step 1: Write the failing route test**

```typescript
// src/routes/__tests__/card.route.test.ts
import request from 'supertest';
import app from '@/app';
import { TicketService } from '@services/ticket.service';

jest.mock('@services/ticket.service');

describe('card webhook', () => {
  it('always returns 200 and calls finalizeCardSale with the checkout id', async () => {
    (TicketService.finalizeCardSale as jest.Mock).mockResolvedValue({ status: 'completed' });
    const res = await request(app).post('/api/public/purchase/card/webhook').send({ id: 'chk_1' });
    expect(res.status).toBe(200);
    expect(TicketService.finalizeCardSale).toHaveBeenCalledWith('chk_1');
  });

  it('returns 200 even when finalize throws (no retry storm)', async () => {
    (TicketService.finalizeCardSale as jest.Mock).mockRejectedValue(new Error('boom'));
    const res = await request(app).post('/api/public/purchase/card/webhook').send({ id: 'chk_2' });
    expect(res.status).toBe(200);
  });
});
```
(Confirm the app import path matches the existing momo route test — copy its import + supertest setup.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/card.route.test.ts`
Expected: FAIL — route 404.

- [ ] **Step 3: Add card to getPaymentMethods**

In `src/controllers/public.controller.ts`:
- Add import: `import { PeachClient } from '@services/payments/peach.client';`
- In `getPaymentMethods`, after the MoMo push, add:
  ```typescript
      if (cfg.cardEnabled && new PeachClient().isConfigured()) methods.push('card');
  ```

- [ ] **Step 4: Add the card initiate + status controllers**

In `src/controllers/public.controller.ts`, add a validation schema near `momoInitiateSchema`:
```typescript
const cardInitiateSchema = Joi.object({
  eventId: Joi.string().hex().length(24).required(),
  ticketTypeId: Joi.string().hex().length(24).required(),
  quantity: Joi.number().integer().min(1).max(10).required(),
  customerName: Joi.string().max(100).optional(),
});
```
and two methods (mirror `initiateMomoPurchase` / `getMomoStatus`):
```typescript
  static async initiateCardPurchase(req: Request, res: Response): Promise<any> {
    const { error, value } = cardInitiateSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const customerPhone = (req as any).ticketsUser?.userPhone as string | undefined;
    if (!customerPhone) return ApiResponseUtil.unauthorized(res, 'Please sign in to buy a ticket');
    try {
      const r = await TicketService.initiateCardPurchase({ ...value, customerPhone, channel: SalesChannel.ONLINE });
      return ApiResponseUtil.success(res, r);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Could not start card payment', 400);
    }
  }

  static async getCardStatus(req: Request, res: Response): Promise<any> {
    try {
      const buyerPhone = (req as any).ticketsUser?.userPhone as string | undefined;
      if (!buyerPhone) return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
      const checkoutId = req.params['checkoutId']!;
      const sale = await TicketService.getCardSaleByCheckoutId(checkoutId);
      if (!sale || normalizePhone(sale.customerPhone || '') !== normalizePhone(buyerPhone)) {
        return ApiResponseUtil.notFound(res, 'Payment not found');
      }
      const result = await TicketService.finalizeCardSale(checkoutId);
      return ApiResponseUtil.success(res, result);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Status check failed', 400);
    }
  }
```

- [ ] **Step 5: Add the buyer-auth routes**

In `src/routes/public.route.ts`, after the momo routes add:
```typescript
/**
 * @route POST /api/public/purchase/card  — initiate a card checkout (Peach COPYandPAY)
 * @route GET  /api/public/purchase/card/:checkoutId/status — verify + finalize
 * @access Buyer (Bearer buyer token)
 */
router.post('/purchase/card', authenticateBuyer, PublicController.initiateCardPurchase);
router.get('/purchase/card/:checkoutId/status', authenticateBuyer, PublicController.getCardStatus);
```

- [ ] **Step 6: Add the unauthenticated webhook controller + route**

```typescript
// src/controllers/card.controller.ts
import { Request, Response } from 'express';
import { TicketService } from '@services/ticket.service';

export class CardController {
  // Peach webhook: extract the checkout id and finalize idempotently.
  // Always 200 so Peach does not retry-storm.
  static async webhook(req: Request, res: Response): Promise<any> {
    const checkoutId = req.body?.id || req.body?.checkoutId || req.body?.payload?.id;
    if (!checkoutId) return res.status(200).json({ ok: true });
    try {
      await TicketService.finalizeCardSale(checkoutId);
    } catch (e) {
      console.error('[card webhook]', e);
    }
    return res.status(200).json({ ok: true });
  }
}
```
```typescript
// src/routes/card.route.ts
import { Router } from 'express';
import { CardController } from '@controllers/card.controller';

const router = Router();
router.post('/webhook', CardController.webhook);
export default router;
```
In `src/app.ts`, mount it under the public purchase namespace (match how `momo.route` is mounted). If momo is mounted at `/api/momo`, mount card webhook at `/api/public/purchase/card`:
```typescript
import cardRoutes from '@routes/card.route';
// ...
app.use('/api/public/purchase/card', cardRoutes);
```
This yields `POST /api/public/purchase/card/webhook`. Ensure this `app.use` is registered AFTER the public router OR that the public router does not also define `/purchase/card/webhook` (it does not).

- [ ] **Step 7: Run test to verify it passes**

Run: `npx jest src/routes/__tests__/card.route.test.ts`
Expected: PASS (both cases).

- [ ] **Step 8: Run the full backend test suite + typecheck**

Run: `npx jest && npx tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/controllers/public.controller.ts src/routes/public.route.ts src/controllers/card.controller.ts src/routes/card.route.ts src/app.ts src/routes/__tests__/card.route.test.ts
git commit -m "feat(payments): public card initiate/status routes + Peach webhook"
```

---

## Task 9: Frontend — types + api client

**Files:**
- Modify: `landing/src/types/index.ts`
- Modify: `landing/src/services/api.ts`

**Interfaces:**
- Produces: `PaymentMethodId` includes `'card'`; `CardInitiateResponse { checkoutId: string; integrity: string; saleId: string; expiresAt: string }`; `api.initiateCardPayment(data)`, `api.checkCardPaymentStatus(checkoutId)`.

- [ ] **Step 1: Extend types**

In `landing/src/types/index.ts`:
```typescript
export type PaymentMethodId = 'keshless_wallet' | 'mtn_momo' | 'card';
```
and add:
```typescript
export interface CardInitiateResponse {
  checkoutId: string;
  integrity: string;
  saleId: string;
  expiresAt: string;
}
```

- [ ] **Step 2: Add api functions**

In `landing/src/services/api.ts`, after `checkMomoPaymentStatus`, add (mirror its token handling; import `CardInitiateResponse` and reuse `MomoStatusResponse` for status):
```typescript
  // Initiate a card payment (Peach COPYandPAY). Requires buyer token.
  async initiateCardPayment(data: {
    eventId: string;
    ticketTypeId: string;
    quantity: number;
    customerName?: string;
  }): Promise<CardInitiateResponse> {
    const token = getBuyerToken();
    if (!token) throw new ApiError(401, 'Please sign in to continue');
    const res = await fetch(`${API_BASE_URL}/api/public/purchase/card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    const json = await res.json().catch(() => ({ message: 'An error occurred' }));
    if (!res.ok) throw new ApiError(res.status, json.message || 'Could not start card payment');
    return json.data ?? json;
  },

  // Verify + finalize a card payment after the Peach redirect. Requires buyer token.
  async checkCardPaymentStatus(checkoutId: string): Promise<MomoStatusResponse> {
    const token = getBuyerToken();
    if (!token) throw new ApiError(401, 'Please sign in to continue');
    const res = await fetch(`${API_BASE_URL}/api/public/purchase/card/${checkoutId}/status`,
      { headers: { 'Authorization': `Bearer ${token}` } });
    const json = await res.json().catch(() => ({ message: 'An error occurred' }));
    if (!res.ok) throw new ApiError(res.status, json.message || 'Status check failed');
    return json.data ?? json;
  },
```
Add `CardInitiateResponse` to the type import at the top of the file.

- [ ] **Step 3: Verify the build**

Run: `cd landing && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd landing && git add src/types/index.ts src/services/api.ts
git commit -m "feat(checkout): card payment api client + types"
```

---

## Task 10: Frontend — PurchaseModal card method + widget

**Files:**
- Modify: `landing/src/components/PurchaseModal.tsx`

**Interfaces:**
- Consumes: `api.initiateCardPayment`, `CardInitiateResponse`.
- Produces: a `'card'` selectable method and a `'card_widget'` state rendering the Peach widget. The widget form `action` = `${window.location.origin}/payment-result?ref={checkoutId}`.

- [ ] **Step 1: Add the card_widget state + widget config**

In `PurchaseModal.tsx`:
- Extend the state union: `type PurchaseState = 'login' | 'verify' | 'form' | 'loading' | 'momo_pending' | 'card_widget' | 'success' | 'error';`
- Add a const for the widget base URL near the top of the component:
  ```typescript
  const PEACH_WIDGET_BASE = import.meta.env.VITE_PEACH_WIDGET_BASE || 'https://card.peachpayments.com';
  ```
- Add state: `const [cardCheckout, setCardCheckout] = useState<{ checkoutId: string; integrity: string } | null>(null);`

- [ ] **Step 2: Add the card branch to handlePay**

At the start of `handlePay` (before the MoMo branch), add:
```typescript
    if (method === 'card') {
      setErrorMessage('');
      setState('loading');
      try {
        const { checkoutId, integrity } = await api.initiateCardPayment({
          eventId,
          ticketTypeId: ticketType.id,
          quantity,
          customerName: customerName.trim() || undefined,
        });
        setCardCheckout({ checkoutId, integrity });
        setState('card_widget');
      } catch (error) {
        setErrorMessage(error instanceof ApiError ? error.message : 'Could not start card payment. Please try again.');
        setState('error');
      }
      return;
    }
```

- [ ] **Step 3: Add the card method selector button**

In the method selector block (where `keshless_wallet` and `mtn_momo` buttons render), add a third button:
```tsx
                    <button
                      type="button"
                      onClick={() => setMethod('card')}
                      className={`flex-1 flex items-center justify-center gap-2 rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors ${
                        method === 'card'
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:border-primary/50'
                      }`}
                    >
                      <CreditCard className="h-4 w-4" />
                      Card
                    </button>
```
Also update the submit button label ternary to show `Pay E{total} by card` when `method === 'card'`.

- [ ] **Step 4: Render the Peach widget in the card_widget state**

Add a new `AnimatePresence` branch after `momo_pending`. It injects the Peach script once and renders the widget form whose `action` is the result page:
```tsx
          {state === 'card_widget' && cardCheckout && (
            <motion.div key="card_widget" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <CreditCard className="h-5 w-5 text-primary" /> Pay by card
                </DialogTitle>
                <DialogDescription>Enter your card details below. Your payment is processed securely by Peach Payments.</DialogDescription>
              </DialogHeader>
              <PeachWidget checkoutId={cardCheckout.checkoutId} integrity={cardCheckout.integrity} base={PEACH_WIDGET_BASE} />
            </motion.div>
          )}
```
Add a small `PeachWidget` component at the bottom of the same file:
```tsx
function PeachWidget({ checkoutId, integrity, base }: { checkoutId: string; integrity: string; base: string }) {
  useEffect(() => {
    const script = document.createElement('script');
    script.src = `${base}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(checkoutId)}`;
    if (integrity) { script.integrity = integrity; script.crossOrigin = 'anonymous'; }
    script.async = true;
    document.body.appendChild(script);
    return () => { document.body.removeChild(script); };
  }, [checkoutId, integrity, base]);

  const action = `${window.location.origin}/payment-result?ref=${encodeURIComponent(checkoutId)}`;
  return (
    <form className="paymentWidgets mt-4" action={action} data-brands="VISA MASTER" />
  );
}
```
(`useEffect` is already imported at the top of the file.)

- [ ] **Step 5: Verify the build**

Run: `cd landing && npx tsc --noEmit && npx vite build`
Expected: builds with no errors.

- [ ] **Step 6: Commit**

```bash
cd landing && git add src/components/PurchaseModal.tsx
git commit -m "feat(checkout): card method + embedded Peach widget in PurchaseModal"
```

---

## Task 11: Frontend — PaymentResultPage + route

**Files:**
- Create: `landing/src/pages/PaymentResultPage.tsx`
- Modify: `landing/src/App.tsx`

**Interfaces:**
- Consumes: `api.checkCardPaymentStatus`.
- Produces: route `/payment-result` that verifies the card payment and shows the outcome.

- [ ] **Step 1: Create the result page**

```tsx
// landing/src/pages/PaymentResultPage.tsx
import { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '@/services/api';

type View = 'checking' | 'success' | 'failed';

export function PaymentResultPage() {
  const [params] = useSearchParams();
  const [view, setView] = useState<View>('checking');
  const [message, setMessage] = useState('Confirming your payment…');
  const polls = useRef(0);

  // Peach appends resourcePath=/v1/checkouts/{id}/payment; we also pass ?ref={checkoutId}.
  const refParam = params.get('ref');
  const resourcePath = params.get('resourcePath') || '';
  const checkoutId = refParam || resourcePath.match(/checkouts\/([^/]+)\/payment/)?.[1] || '';

  useEffect(() => {
    if (!checkoutId) { setView('failed'); setMessage('Missing payment reference.'); return; }
    let stop = false;
    const tick = async () => {
      try {
        const { status } = await api.checkCardPaymentStatus(checkoutId);
        if (stop) return;
        if (status === 'completed') { setView('success'); return; }
        if (status === 'failed') { setView('failed'); setMessage('Your card payment was not completed.'); return; }
        if (++polls.current > 20) { setView('failed'); setMessage('Payment timed out. If you were charged, check My Tickets.'); return; }
        setTimeout(tick, 3000);
      } catch (e) {
        if (stop) return;
        if (++polls.current > 20) { setView('failed'); setMessage('Could not confirm payment. If you were charged, check My Tickets.'); return; }
        setTimeout(tick, 3000);
      }
    };
    tick();
    return () => { stop = true; };
  }, [checkoutId]);

  return (
    <div className="max-w-md mx-auto py-20 px-4 text-center">
      {view === 'checking' && (<><Loader2 className="h-14 w-14 text-primary animate-spin mx-auto" /><p className="mt-4 text-lg font-medium">{message}</p></>)}
      {view === 'success' && (<>
        <CheckCircle2 className="h-14 w-14 text-green-500 mx-auto" />
        <h1 className="mt-4 text-2xl font-bold text-green-600">Payment Successful!</h1>
        <p className="text-muted-foreground mt-2">Your tickets are issued and an SMS is on its way.</p>
        <Link to="/my-tickets" className="inline-block mt-6 rounded-lg bg-primary px-6 py-3 text-white font-medium">View My Tickets</Link>
      </>)}
      {view === 'failed' && (<>
        <XCircle className="h-14 w-14 text-destructive mx-auto" />
        <h1 className="mt-4 text-2xl font-bold text-destructive">Payment Failed</h1>
        <p className="text-muted-foreground mt-2">{message}</p>
        <Link to="/" className="inline-block mt-6 rounded-lg border px-6 py-3 font-medium">Back to events</Link>
      </>)}
    </div>
  );
}
```

- [ ] **Step 2: Register the route**

In `landing/src/App.tsx`, add the import and route:
```tsx
import { PaymentResultPage } from '@/pages/PaymentResultPage';
// inside <Routes>:
<Route path="/payment-result" element={<PaymentResultPage />} />
```

- [ ] **Step 3: Verify the build**

Run: `cd landing && npx tsc --noEmit && npx vite build`
Expected: builds with no errors.

- [ ] **Step 4: Commit**

```bash
cd landing && git add src/pages/PaymentResultPage.tsx src/App.tsx
git commit -m "feat(checkout): card payment result page + route"
```

---

## Task 12: Deploy, live charge verification, enable

**Files:** none (operational).

- [ ] **Step 1: Bind Peach secrets + env on Cloud Run (ADDITIVE)**

Activate the deployer SA, then add secrets/env to the prod service WITHOUT wiping existing bindings. First confirm the service's runtime SA and create the secrets:
```bash
gcloud config configurations activate deployer
gcloud config set project contracts-470406
# Create secrets (one-time)
printf '%s' '<entityId>' | gcloud secrets create CARROT_TICKETS__PEACH_ENTITY_ID --data-file=- 2>/dev/null || \
  printf '%s' '<entityId>' | gcloud secrets versions add CARROT_TICKETS__PEACH_ENTITY_ID --data-file=-
printf '%s' '<password>' | gcloud secrets create CARROT_TICKETS__PEACH_PASSWORD --data-file=- 2>/dev/null || \
  printf '%s' '<password>' | gcloud secrets versions add CARROT_TICKETS__PEACH_PASSWORD --data-file=-
```
Grant the service's runtime SA `roles/secretmanager.secretAccessor` on both secrets (look up the SA first):
```bash
SA=$(gcloud run services describe carrot-tickets-api --region=europe-west1 --format='value(spec.template.spec.serviceAccountName)')
for S in CARROT_TICKETS__PEACH_ENTITY_ID CARROT_TICKETS__PEACH_PASSWORD; do
  gcloud secrets add-iam-policy-binding $S --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
done
```

- [ ] **Step 2: Update the service env ADDITIVELY**

Card stays OFF for now (`CARD_PAYMENTS_ENABLED=false`) so the deploy is safe; enable after the live charge test:
```bash
gcloud run services update carrot-tickets-api --region=europe-west1 \
  --update-secrets=PEACH_ENTITY_ID=CARROT_TICKETS__PEACH_ENTITY_ID:latest,PEACH_PASSWORD=CARROT_TICKETS__PEACH_PASSWORD:latest \
  --update-env-vars=CARD_PAYMENTS_ENABLED=false,PEACH_BASE_URL=https://card.peachpayments.com,CARD_CURRENCY=ZAR,CARD_RESULT_URL=https://<landing-domain>/payment-result
```

- [ ] **Step 3: Deploy api + landing**

Deploy the api via its trigger (per project convention), then the landing site via Cloudflare Pages (push to `main`):
```bash
gcloud builds triggers run <carrot-tickets-api-trigger> --branch=main --project=contracts-470406
# landing:
cd landing && git push origin main   # Cloudflare Pages auto-deploys prod branch main
```
Set `VITE_PEACH_WIDGET_BASE=https://card.peachpayments.com` in the Pages project env if not defaulting.

- [ ] **Step 4: Flip card ON in prod**

```bash
gcloud run services update carrot-tickets-api --region=europe-west1 --update-env-vars=CARD_PAYMENTS_ENABLED=true
```
Then enable the admin toggle (dashboard Settings → payment methods, or directly set `cardEnabled: true` on the global `PaymentMethodConfig`).

- [ ] **Step 5: Live end-to-end charge (no buyers active)**

On the live site: open an event → choose Card → complete a real card payment in the widget → confirm the redirect lands on `/payment-result` → confirm it shows success and the ticket appears under My Tickets, with an SMS to `+26878422613`. Watch logs:
```bash
gcloud run services logs read carrot-tickets-api --region=europe-west1 --limit=80
```
Verify: a TicketSale with `paymentMethod: 'card'`, `paymentStatus: 'completed'`, populated `peachCheckoutId`, and minted `ticketIds`.

- [ ] **Step 6: (Optional) Register the webhook**

In the Peach dashboard → Webhooks → add `https://<api-domain>/api/public/purchase/card/webhook`. Trigger a second test charge and confirm the webhook also resolves the sale (idempotent — no double-mint).

---

## Self-Review

**Spec coverage:**
- Enum `CARD` → Task 2. PeachClient (prepare/status/auth/regex) → Task 3. CardProcessor throws → Task 4. `peachCheckoutId` → Task 5. `initiateCardPurchase` → Task 6. `finalizeCardSale` (idempotent + amount/currency guard) → Task 7. `cardEnabled` toggle + payment-methods gate → Tasks 2 & 8. Buyer-auth initiate/status routes + webhook → Task 8. Env additive → Task 3 (.env.example) + Task 12 (Cloud Run). Frontend types/api → Task 9. PurchaseModal + widget → Task 10. PaymentResultPage → Task 11. Currency ZAR 1:1 → Task 6 (`CARD_CURRENCY`). Prod deploy + live charge + enable → Task 12. Auth uncertainty → Task 1 spike. Webhook → Task 8 + Task 12. All spec sections covered.

**Placeholder scan:** No "TBD"/"add error handling"-style placeholders. Test scaffolds in Tasks 6/7 reference "copy the momo test mock scaffold" — this is a concrete instruction pointing at a real existing file, with the assertions fully written; acceptable because the repo's model-mock helpers must be reused verbatim for consistency.

**Type consistency:** `prepareCheckout` returns `{ checkoutId, integrity }` (Task 3) consumed identically in Tasks 6/10. `getPaymentStatus` returns `{ code, amount, currency, raw }` (Task 3) consumed in Task 7. `initiateCardPurchase` returns `{ checkoutId, integrity, saleId, expiresAt }` (Task 6) consumed by controller (Task 8) → api `CardInitiateResponse` (Task 9). `finalizeCardSale` returns `{ status }` (Task 7) consumed by controller + webhook (Task 8) → `MomoStatusResponse` reused on the client (Task 9/11). `classifyResultCode` defined in Task 3, used in Task 7. Names consistent throughout.
