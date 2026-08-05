# Buyer Email-or-Phone Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Carrot Tickets buyer register and sign in with **email OR phone** (including true email-only accounts, no phone at all), verified by a 6-digit OTP on whichever channel they chose.

**Architecture:** Introduce the Buyer's Mongo `_id` (`buyerId`) as the canonical identity carried in the JWT; demote phone and email to verified *contact handles* that both resolve to it. Email OTPs are sent via the existing "Carrot Tickets" YeboLink workspace (mirroring `SmsService`). Tickets bought while logged in are stamped with `buyerId` (+ `customerEmail`) so "My Tickets" can match by id/phone/email. Hard token cutover: only `buyerId`-bearing buyer tokens are accepted.

**Tech Stack:** Node/TypeScript, Express, Mongoose (MongoDB), Joi, jsonwebtoken, bcrypt, Jest; React + Vite + framer-motion + shadcn/ui on `landing`.

## Global Constraints

- **Spec:** `api/docs/superpowers/specs/2026-08-05-buyer-email-or-phone-identity-design.md` — authoritative.
- **No silent fallbacks** (global rule): OTP send failures (SMS or email) throw a user-facing error. No canned success. Only fire-and-forget telemetry may swallow errors.
- **No unrequested backward compatibility** (global rule): the token change is a deliberate **hard cutover** — do NOT add a legacy `userPhone`-only token acceptance branch. Active buyers re-login once.
- **DRY / YAGNI / TDD:** reuse `SmsService`/`YeboLinkClient` patterns; do NOT build account-linking or "add a second handle" flows.
- **Two repos:** API changes in `api/` (git `main`). Frontend in `landing/` (git `dev`). Commit per-repo.
- **Min password length:** 6 (`MIN_PASSWORD_LENGTH`). **OTP:** 6 digits, 10-min TTL, 5 attempts — unchanged.
- **JWT:** same secret + `app: 'tickets'` claim (`@config/jwt.config` `JWT_SECRET`, verified by `TicketsAuthService.verifyToken`).
- **YeboLink:** key via `YEBOLINK_API_KEY` env (already bound for SMS). Sender/brand: `Carrot Tickets` / `CarrotTix`.
- **Run tests from `api/`:** `npx jest <path>`. TS path aliases (`@models`, `@services`, `@utils`, `@config`) already configured.

---

## File Structure

**API — create:**
- `api/src/services/email.service.ts` — YeboLink-backed buyer email sender (`sendOtp`).
- `api/src/utils/identifier.util.ts` — classify a raw identifier as `sms`(phone) or `email`.

**API — modify:**
- `api/src/models/buyer.model.ts` — phone optional; add email + `*VerifiedAt`; at-least-one invariant.
- `api/src/models/buyerOtp.model.ts` — `phone` → `destination` + `channel`.
- `api/src/models/ticket.model.ts`, `ticketSale.model.ts` — add `customerEmail`, `buyerId`.
- `api/src/services/yebolink.client.ts` — add `sendEmail`.
- `api/src/services/buyerAuth.service.ts` — identifier-based login/register/reset; `signToken(buyer)`.
- `api/src/middleware/ticketsAuth.middleware.ts` — buyer gate on `buyerId`.
- `api/src/utils/buyerRequest.util.ts` — resolve by `buyerId`.
- `api/src/utils/socialActor.util.ts` — buyer branch on `buyerId`.
- `api/src/realtime/socketAuth.ts` — buyer gate/resolve on `buyerId`.
- `api/src/services/ticket.service.ts` — `findTicketsForBuyer`; `purchaseForCustomer` gains `buyerId`/`customerEmail`; MoMo/card/DeltaPay initiate + status carry `buyerId`/`customerEmail`.
- `api/src/controllers/public.controller.ts` — auth handlers accept `identifier`; purchase/status/my-tickets resolve buyer by `buyerId`.
- `api/src/routes/public.route.ts` — update route doc comments.

**Frontend — modify:**
- `landing/src/services/api.ts` (or wherever buyer-auth calls live) — send `identifier`; parse `identity`.
- `landing/src/contexts/BuyerAuthContext.tsx` — store `{ phone?, email? }`.
- `landing/src/components/BuyerAuthPanel.tsx` — identifier input + channel-aware verify/reset copy.

---

## Task 1: Buyer model — email as a peer handle

**Files:**
- Modify: `api/src/models/buyer.model.ts`
- Test: `api/src/models/__tests__/buyer.model.test.ts` (create if absent)

**Interfaces:**
- Produces: `IBuyer.email?: string`, `IBuyer.emailVerifiedAt?: Date`, `IBuyer.phoneVerifiedAt?: Date`; `phone` now optional. Invariant: at least one of `phone`/`email` present.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/models/__tests__/buyer.model.test.ts
import { Buyer } from '@models/buyer.model';

describe('Buyer identity invariant', () => {
  it('rejects a buyer with neither phone nor email', () => {
    const b = new Buyer({ password: 'secret6' });
    const err = b.validateSync();
    expect(err?.message).toMatch(/phone or email/i);
  });

  it('accepts an email-only buyer', () => {
    const b = new Buyer({ email: 'buyer@example.com', password: 'secret6', emailVerifiedAt: new Date() });
    expect(b.validateSync()).toBeUndefined();
  });

  it('lowercases + trims email', () => {
    const b = new Buyer({ email: '  BUYER@Example.COM ', password: 'secret6', emailVerifiedAt: new Date() });
    expect(b.email).toBe('buyer@example.com');
  });

  it('still accepts a phone-only buyer', () => {
    const b = new Buyer({ phone: '+26878422613', password: 'secret6', phoneVerifiedAt: new Date() });
    expect(b.validateSync()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/models/__tests__/buyer.model.test.ts`
Expected: FAIL (email field/invariant not present).

- [ ] **Step 3: Implement the model change**

In `api/src/models/buyer.model.ts`, update the interface and schema:

```ts
// interface IBuyer — change phone to optional, add fields:
  phone?: string; // normalised, e.g. +26878422613 (optional — email-only buyers have none)
  email?: string; // lowercased, unique among buyers with an email
  emailVerifiedAt?: Date;
  phoneVerifiedAt?: Date;
```

```ts
// schema — phone becomes optional; add email + verifiedAt; keep unique+sparse:
    phone: { type: String, unique: true, sparse: true, index: true, trim: true },
    email: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please enter a valid email address'],
    },
    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date },
```

Add an invariant hook (after the schema is declared, before `model(...)`):

```ts
// At least one contact handle must exist — phone and email are peers, but a
// buyer with neither has no identity to key tickets / tokens off.
buyerSchema.pre('validate', function (next) {
  if (!this.phone && !this.email) {
    next(new Error('A buyer needs a phone or email'));
    return;
  }
  next();
});
```

Update the model doc comment: identity is now `_id`; phone/email are verified handles.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/models/__tests__/buyer.model.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git -C api add src/models/buyer.model.ts src/models/__tests__/buyer.model.test.ts
git -C api commit -m "feat(buyer): add email as a peer identity handle; phone now optional"
```

---

## Task 2: BuyerOtp — channel + destination

**Files:**
- Modify: `api/src/models/buyerOtp.model.ts`
- Test: `api/src/models/__tests__/buyerOtp.model.test.ts` (create)

**Interfaces:**
- Produces: `IBuyerOtp.channel: 'sms' | 'email'`, `IBuyerOtp.destination: string` (replaces `phone`). Same `codeHash`/`expiresAt`/`attempts`/`consumed`/TTL.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/models/__tests__/buyerOtp.model.test.ts
import { BuyerOtp } from '@models/buyerOtp.model';

describe('BuyerOtp channel', () => {
  it('requires channel and destination', () => {
    const otp = new BuyerOtp({ codeHash: 'x', expiresAt: new Date() });
    const err = otp.validateSync();
    expect(err).toBeDefined();
    expect(err?.errors['channel']).toBeDefined();
    expect(err?.errors['destination']).toBeDefined();
  });

  it('accepts an email OTP row', () => {
    const otp = new BuyerOtp({ channel: 'email', destination: 'a@b.com', codeHash: 'x', expiresAt: new Date() });
    expect(otp.validateSync()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/models/__tests__/buyerOtp.model.test.ts`
Expected: FAIL (`channel`/`destination` unknown).

- [ ] **Step 3: Implement**

Rewrite `api/src/models/buyerOtp.model.ts` interface + schema:

```ts
export type OtpChannel = 'sms' | 'email';

export interface IBuyerOtp extends Document {
  channel: OtpChannel;
  destination: string;    // normalised phone OR lowercased email
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumed: boolean;
  createdAt: Date;
}

const buyerOtpSchema = new Schema<IBuyerOtp>(
  {
    channel: { type: String, enum: ['sms', 'email'], required: true },
    destination: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    attempts: { type: Number, default: 0 },
    consumed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

buyerOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
```

Update the doc comment (proves ownership of the phone OR email the buyer is registering).

> **Data note:** rows are TTL-swept within 10 minutes and carry no long-term value, so no migration/backfill of existing `phone`-keyed rows is needed — stale-schema rows simply expire.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/models/__tests__/buyerOtp.model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C api add src/models/buyerOtp.model.ts src/models/__tests__/buyerOtp.model.test.ts
git -C api commit -m "feat(buyerOtp): channel + destination (sms|email)"
```

---

## Task 3: YeboLink email + EmailService

**Files:**
- Modify: `api/src/services/yebolink.client.ts`
- Create: `api/src/services/email.service.ts`
- Test: `api/src/services/__tests__/email.service.test.ts` (create)

**Interfaces:**
- Produces: `YeboLinkClient.sendEmail(to: string, subject: string, html: string, fromName?: string): Promise<YeboLinkSendResult>`; `EmailService.sendOtp(email: string, code: string): Promise<boolean>`.
- Consumes: `getApiKey()`, `YEBOLINK_API_URL` (existing in `yebolink.client.ts`).

> **Verify before wiring:** confirm the YeboLink email payload shape against the `yebolink-implementation` skill / api.yebolink.com docs. Expected: same `POST /api/v1/messages/send` endpoint with `channel: 'email'` and `content: { subject, html, from_name }`. Adjust the body below if the skill specifies different field names, then keep the test's mock in sync.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/services/__tests__/email.service.test.ts
import { EmailService } from '@services/email.service';
import { YeboLinkClient } from '@services/yebolink.client';

jest.mock('@services/yebolink.client');

describe('EmailService.sendOtp', () => {
  const send = YeboLinkClient.sendEmail as jest.Mock;
  beforeEach(() => send.mockReset());

  it('sends the code and returns true on success', async () => {
    send.mockResolvedValue({ messageId: 'm1', status: 'queued' });
    const ok = await EmailService.sendOtp('buyer@example.com', '123456');
    expect(ok).toBe(true);
    const [to, subject, html] = send.mock.calls[0];
    expect(to).toBe('buyer@example.com');
    expect(subject).toMatch(/code/i);
    expect(html).toContain('123456');
  });

  it('returns false when YeboLink throws (caller surfaces the failure)', async () => {
    send.mockRejectedValue(new Error('YeboLink email send failed'));
    const ok = await EmailService.sendOtp('buyer@example.com', '123456');
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/services/__tests__/email.service.test.ts`
Expected: FAIL (`sendEmail`/`EmailService` not defined).

- [ ] **Step 3: Implement `sendEmail` on the client**

Append to the `YeboLinkClient` object in `api/src/services/yebolink.client.ts`:

```ts
  async sendEmail(to: string, subject: string, html: string, fromName = 'Carrot Tickets'): Promise<YeboLinkSendResult> {
    const res = await fetch(`${YEBOLINK_API_URL}/api/v1/messages/send`, {
      method: 'POST',
      headers: { 'X-API-Key': getApiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        channel: 'email',
        content: { subject, html, from_name: fromName },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      data?: { message_id?: string; status?: string };
    };
    if (!res.ok || !body.success) {
      throw new Error(`YeboLink email send failed (${res.status}): ${body.error ?? 'unknown error'}`);
    }
    return { messageId: body.data?.message_id ?? '', status: body.data?.status ?? '' };
  },
```

- [ ] **Step 4: Implement `EmailService`**

```ts
// api/src/services/email.service.ts
/**
 * Email service for Carrot Tickets buyer auth.
 *
 * Buyers who register/sign in with an email prove ownership via a 6-digit OTP,
 * mirroring the SMS OTP flow. Delivery is via the "Carrot Tickets" YeboLink
 * workspace (same key as SMS). Like SmsService.sendOtp, this is NOT
 * fire-and-forget: the caller surfaces a false result to the buyer (no silent
 * fallback — they cannot sign in without the code).
 */
import { YeboLinkClient } from './yebolink.client';

const FROM_NAME = 'Carrot Tickets';

export class EmailService {
  static async sendOtp(email: string, code: string): Promise<boolean> {
    if (!email || !code) return false;
    const subject = `${code} is your Carrot Tickets code`;
    const html =
      `<div style="font-family:system-ui,sans-serif;font-size:16px;color:#1a1a1a">` +
      `<p>Your Carrot Tickets verification code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>` +
      `<p>It expires in 10 minutes. Don't share it with anyone.</p>` +
      `</div>`;
    try {
      await YeboLinkClient.sendEmail(email, subject, html, FROM_NAME);
      console.log(`[Email] OTP dispatched to ${email} via YeboLink`);
      return true;
    } catch (error) {
      console.error('[Email] OTP send failed', error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd api && npx jest src/services/__tests__/email.service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git -C api add src/services/yebolink.client.ts src/services/email.service.ts src/services/__tests__/email.service.test.ts
git -C api commit -m "feat(email): YeboLink-backed buyer OTP email service"
```

---

## Task 4: Identifier classification util

**Files:**
- Create: `api/src/utils/identifier.util.ts`
- Test: `api/src/utils/__tests__/identifier.util.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export type Identifier = { channel: 'sms'; value: string } | { channel: 'email'; value: string };
  export function classifyIdentifier(raw: string): Identifier; // throws Error('Enter a valid phone number or email') if neither
  ```
- Consumes: `normalizePhone`, `isValidPhone` from `@utils/phone.util`.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/utils/__tests__/identifier.util.test.ts
import { classifyIdentifier } from '@utils/identifier.util';

describe('classifyIdentifier', () => {
  it('classifies an email (lowercased, trimmed)', () => {
    expect(classifyIdentifier('  BUYER@Example.com ')).toEqual({ channel: 'email', value: 'buyer@example.com' });
  });

  it('classifies + normalises a phone', () => {
    expect(classifyIdentifier('078422613')).toEqual({ channel: 'sms', value: '+26878422613' });
  });

  it('throws on garbage', () => {
    expect(() => classifyIdentifier('not-a-thing')).toThrow(/valid phone number or email/i);
  });
});
```
> Confirm `normalizePhone('078422613')` yields `+26878422613` in this codebase; if local formatting differs, adjust the expected value (not the logic).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/utils/__tests__/identifier.util.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// api/src/utils/identifier.util.ts
import { normalizePhone, isValidPhone } from '@utils/phone.util';

export type Identifier =
  | { channel: 'sms'; value: string }
  | { channel: 'email'; value: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Classify a raw login identifier as an email or a phone. Email wins if it
 * contains an '@' and matches a basic email shape; otherwise we treat it as a
 * phone and normalise it. Throws a single user-facing error if it is neither.
 */
export function classifyIdentifier(raw: string): Identifier {
  const trimmed = (raw ?? '').trim();
  if (trimmed.includes('@')) {
    const email = trimmed.toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error('Enter a valid phone number or email');
    return { channel: 'email', value: email };
  }
  const phone = normalizePhone(trimmed);
  if (!isValidPhone(phone)) throw new Error('Enter a valid phone number or email');
  return { channel: 'sms', value: phone };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/utils/__tests__/identifier.util.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C api add src/utils/identifier.util.ts src/utils/__tests__/identifier.util.test.ts
git -C api commit -m "feat(auth): identifier classification util (phone|email)"
```

---

## Task 5: BuyerAuthService — identifier-based auth + buyerId token

**Files:**
- Modify: `api/src/services/buyerAuth.service.ts`
- Test: `api/src/services/__tests__/buyerAuth.identity.test.ts` (create); keep existing `buyerAuth` tests green (update call sites if they pass raw phone positionally — the new signatures still accept a phone string as the identifier).

**Interfaces:**
- Consumes: `classifyIdentifier`, `Identifier` (Task 4); `EmailService.sendOtp` (Task 3); `SmsService.sendOtp`; `Buyer`, `BuyerOtp` (Tasks 1-2); `JWT_SECRET`.
- Produces:
  ```ts
  type BuyerIdentity = { phone?: string; email?: string };
  type LoginResult =
    | { requiresRegistration: true; channel: 'sms' | 'email'; identifier: string }
    | { requiresRegistration: false; accessToken: string; identity: BuyerIdentity };

  BuyerAuthService.signToken(buyer: IBuyer): string   // { userType:'buyer', app:'tickets', buyerId, userPhone?, userEmail? }
  BuyerAuthService.login(rawIdentifier: string, password: string): Promise<LoginResult>
  BuyerAuthService.requestRegistrationOtp(rawIdentifier: string): Promise<{ channel; identifier: string }>
  BuyerAuthService.registerWithOtp(rawIdentifier: string, code: string, password: string, name?: string): Promise<{ accessToken: string; identity: BuyerIdentity }>
  BuyerAuthService.requestPasswordResetOtp(rawIdentifier: string): Promise<{ channel; identifier: string }>
  BuyerAuthService.resetPassword(rawIdentifier: string, code: string, newPassword: string): Promise<{ accessToken: string; identity: BuyerIdentity }>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// api/src/services/__tests__/buyerAuth.identity.test.ts
import { BuyerAuthService } from '@services/buyerAuth.service';
import { Buyer } from '@models/buyer.model';
import { BuyerOtp } from '@models/buyerOtp.model';
import { EmailService } from '@services/email.service';
import { SmsService } from '@services/sms.service';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';

jest.mock('@services/email.service');
jest.mock('@services/sms.service');

// NB: uses the project's existing in-memory Mongo test harness (see other
// buyerAuth tests for the connect/clear/disconnect hooks) — reuse those.

describe('BuyerAuthService email identity', () => {
  it('signs a token carrying buyerId + userEmail for an email-only buyer', async () => {
    const buyer = await Buyer.create({ email: 'e@x.com', password: 'secret6', emailVerifiedAt: new Date() });
    const token = BuyerAuthService.signToken(buyer);
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    expect(decoded.buyerId).toBe(String(buyer._id));
    expect(decoded.userEmail).toBe('e@x.com');
    expect(decoded.userPhone).toBeUndefined();
  });

  it('registers an email buyer after email OTP', async () => {
    (EmailService.sendOtp as jest.Mock).mockResolvedValue(true);
    const { channel } = await BuyerAuthService.requestRegistrationOtp('new@x.com');
    expect(channel).toBe('email');
    expect(EmailService.sendOtp).toHaveBeenCalled();

    const otp = await BuyerOtp.findOne({ channel: 'email', destination: 'new@x.com' });
    expect(otp).toBeTruthy();
    // Reach into the known test code by re-issuing a deterministic one:
    // (mirror how existing register tests inject/read the code)
  });

  it('logs in an existing email buyer', async () => {
    await Buyer.create({ email: 'log@x.com', password: 'secret6', emailVerifiedAt: new Date() });
    const res = await BuyerAuthService.login('log@x.com', 'secret6');
    expect(res.requiresRegistration).toBe(false);
    if (res.requiresRegistration === false) {
      expect(res.identity.email).toBe('log@x.com');
    }
  });

  it('returns requiresRegistration for an unknown email', async () => {
    const res = await BuyerAuthService.login('ghost@x.com', 'secret6');
    expect(res).toMatchObject({ requiresRegistration: true, channel: 'email', identifier: 'ghost@x.com' });
  });

  it('still logs in an existing phone buyer', async () => {
    await Buyer.create({ phone: '+26878422613', password: 'secret6', phoneVerifiedAt: new Date() });
    const res = await BuyerAuthService.login('+26878422613', 'secret6');
    expect(res.requiresRegistration).toBe(false);
    if (res.requiresRegistration === false) expect(res.identity.phone).toBe('+26878422613');
  });
});
```
> Follow the OTP-injection pattern the existing `buyerAuth` tests already use (they read/seed `BuyerOtp` directly or stub `crypto`). Reuse it verbatim for the register/reset assertions rather than inventing a new one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx jest src/services/__tests__/buyerAuth.identity.test.ts`
Expected: FAIL (new signatures/behaviour absent).

- [ ] **Step 3: Rewrite `BuyerAuthService`**

Key changes to `api/src/services/buyerAuth.service.ts`:

Imports:
```ts
import { EmailService } from '@services/email.service';
import { classifyIdentifier, Identifier } from '@utils/identifier.util';
import { IBuyer } from '@models/buyer.model';
```

Types + token:
```ts
export type BuyerIdentity = { phone?: string; email?: string };

export type LoginResult =
  | { requiresRegistration: true; channel: 'sms' | 'email'; identifier: string }
  | { requiresRegistration: false; accessToken: string; identity: BuyerIdentity };

private static signToken(buyer: IBuyer): string {
  const payload: Record<string, unknown> = {
    userType: 'buyer',
    app: 'tickets',
    buyerId: String(buyer._id),
  };
  if (buyer.phone) payload['userPhone'] = buyer.phone;
  if (buyer.email) payload['userEmail'] = buyer.email;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: BUYER_JWT_EXPIRY } as SignOptions);
}

private static identityOf(buyer: IBuyer): BuyerIdentity {
  return {
    ...(buyer.phone ? { phone: buyer.phone } : {}),
    ...(buyer.email ? { email: buyer.email } : {}),
  };
}

private static findByIdentifier(id: Identifier) {
  return id.channel === 'email'
    ? Buyer.findOne({ email: id.value })
    : Buyer.findOne({ phone: id.value });
}

private static async sendOtpFor(id: Identifier, code: string): Promise<boolean> {
  return id.channel === 'email'
    ? EmailService.sendOtp(id.value, code)
    : SmsService.sendOtp(id.value, code);
}
```

`login`:
```ts
static async login(rawIdentifier: string, password: string): Promise<LoginResult> {
  const id = classifyIdentifier(rawIdentifier);
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const existing = await this.findByIdentifier(id).select('+password');
  if (!existing) {
    return { requiresRegistration: true, channel: id.channel, identifier: id.value };
  }
  const matches = await existing.comparePassword(password);
  if (!matches) throw new Error('Incorrect password. Please try again.');
  existing.lastLoginAt = new Date();
  await existing.save();
  return { requiresRegistration: false, accessToken: this.signToken(existing), identity: this.identityOf(existing) };
}
```

`requestRegistrationOtp` / `requestPasswordResetOtp`: replace the phone-specific bodies with the `id`-based version. Store OTP with `{ channel: id.channel, destination: id.value }`; invalidate prior codes with `BuyerOtp.updateMany({ destination: id.value, consumed: false }, { consumed: true })`; send via `this.sendOtpFor(id, code)`; on `!sent` throw the same user-facing errors. Registration rejects an existing account on that handle; reset requires one.

`registerWithOtp`: after `consumeOtp(id, code)`, create the buyer with the verified handle:
```ts
const buyer = await Buyer.create({
  ...(id.channel === 'sms' ? { phone: id.value, phoneVerifiedAt: new Date() } : { email: id.value, emailVerifiedAt: new Date() }),
  password,
  ...(name ? { name } : {}),
  lastLoginAt: new Date(),
});
return { accessToken: this.signToken(buyer), identity: this.identityOf(buyer) };
```

`resetPassword`: find by identifier, `consumeOtp(id, code)`, set password, save, return `signToken` + `identityOf`.

`consumeOtp(id: Identifier, code: string)`: change the query to `{ channel: id.channel, destination: id.value, consumed: false, expiresAt: { $gt: new Date() } }`. The hash/attempts/timing-safe compare logic is unchanged.

Update the class doc comment: identity is `buyerId`; phone/email are verified handles; email OTPs go via YeboLink.

- [ ] **Step 4: Run the new + existing auth tests**

Run: `cd api && npx jest src/services/__tests__/buyerAuth`
Expected: PASS. Fix any existing test that asserted the old `{ phone }` return shape — update it to the new `{ identity }` / `{ channel, identifier }` shape (behaviour is equivalent for phone).

- [ ] **Step 5: Commit**

```bash
git -C api add src/services/buyerAuth.service.ts src/services/__tests__/buyerAuth.identity.test.ts
git -C api commit -m "feat(buyerAuth): identifier-based login/register/reset; buyerId token"
```

---

## Task 6: Controller handlers + route docs — accept `identifier`

**Files:**
- Modify: `api/src/controllers/public.controller.ts` (`loginBuyer`, `requestBuyerRegistrationOtp`, `registerBuyer`, `forgotPasswordBuyer`, `resetPasswordBuyer`)
- Modify: `api/src/routes/public.route.ts` (doc comments only)
- Test: `api/src/controllers/__tests__/buyerAuth.route.test.ts` (create or extend existing route test)

**Interfaces:**
- Consumes: `BuyerAuthService` new signatures (Task 5).
- Produces: endpoints accept `{ identifier, ... }` ONLY. No legacy `phone`-field fallback — hard cutover, and API + SPA deploy together so no in-flight client sends the old shape (per Global Constraint "No unrequested backward compatibility"; ruled by the human partner 2026-08-05).

- [ ] **Step 1: Write the failing test**

```ts
// api/src/controllers/__tests__/buyerAuth.route.test.ts
import request from 'supertest';
import { app } from '@/app'; // match how other route tests import the app
import { Buyer } from '@models/buyer.model';

describe('POST /api/public/auth/login', () => {
  it('logs in by email', async () => {
    await Buyer.create({ email: 'r@x.com', password: 'secret6', emailVerifiedAt: new Date() });
    const res = await request(app).post('/api/public/auth/login').send({ identifier: 'r@x.com', password: 'secret6' });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.identity.email).toBe('r@x.com');
  });

  it('reports requiresRegistration for an unknown email', async () => {
    const res = await request(app).post('/api/public/auth/login').send({ identifier: 'no@x.com', password: 'secret6' });
    expect(res.status).toBe(200);
    expect(res.body.data.requiresRegistration).toBe(true);
    expect(res.body.data.channel).toBe('email');
  });
});
```
> Match the existing route-test bootstrap (app import path + in-memory Mongo hooks) used elsewhere in `api/src/**/__tests__`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/controllers/__tests__/buyerAuth.route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update the handlers**

Replace the five handler bodies (public.controller.ts:772-868) to read `identifier`:

```ts
static async loginBuyer(req: Request, res: Response): Promise<any> {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return ApiResponseUtil.error(res, 'Email or phone and password are required', 400);
    }
    const result = await BuyerAuthService.login(identifier, password);
    if (result.requiresRegistration) {
      return ApiResponseUtil.success(res, result, 'Verify your email or phone to create your account');
    }
    return ApiResponseUtil.success(res, result, 'Signed in successfully');
  } catch (error: any) {
    console.error('Buyer login error:', error);
    return ApiResponseUtil.error(res, error.message || 'Failed to sign in', 401);
  }
}
```

Apply the same `const { identifier, ... } = req.body` pattern to `requestBuyerRegistrationOtp`, `registerBuyer` (`identifier, code, password, name`), `forgotPasswordBuyer`, and `resetPasswordBuyer` (`identifier, code, password`) — reading `identifier` only, no `phone` fallback. Update the human copy ("email or phone", "we sent a code to your email or phone").

- [ ] **Step 4: Update route doc comments**

In `api/src/routes/public.route.ts` (lines ~219-234) update the `@route` docblocks to show `{ identifier, ... }` and mention both channels. No behavioural route change (handlers unchanged; still `router.post('/auth/login', ...)` etc.).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd api && npx jest src/controllers/__tests__/buyerAuth.route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C api add src/controllers/public.controller.ts src/routes/public.route.ts src/controllers/__tests__/buyerAuth.route.test.ts
git -C api commit -m "feat(public): buyer auth endpoints accept email-or-phone identifier"
```

---

## Task 7: Middleware + identity resolution — hard cutover to buyerId

**Files:**
- Modify: `api/src/middleware/ticketsAuth.middleware.ts` (`authenticateBuyer`, `authenticateCommunityViewer`, `optionalCommunityViewer`)
- Modify: `api/src/utils/buyerRequest.util.ts`
- Modify: `api/src/utils/socialActor.util.ts`
- Modify: `api/src/realtime/socketAuth.ts`
- Test: `api/src/middleware/__tests__/authenticateBuyer.test.ts` (create)

**Interfaces:**
- Consumes: token payload `{ userType:'buyer', buyerId, userPhone?, userEmail? }`.
- Produces: `resolveBuyerFromRequest(req)` resolves the Buyer via `buyerId`.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/middleware/__tests__/authenticateBuyer.test.ts
import { authenticateBuyer } from '@middleware/ticketsAuth.middleware';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

it('accepts a buyerId buyer token', async () => {
  const token = jwt.sign({ userType: 'buyer', app: 'tickets', buyerId: 'abc123' }, JWT_SECRET);
  const req: any = { headers: { authorization: `Bearer ${token}` } };
  const next = jest.fn();
  await authenticateBuyer(req, mockRes(), next);
  expect(next).toHaveBeenCalled();
  expect(req.ticketsUser.buyerId).toBe('abc123');
});

it('rejects a legacy userPhone-only buyer token (hard cutover)', async () => {
  const token = jwt.sign({ userType: 'buyer', app: 'tickets', userPhone: '+26878422613' }, JWT_SECRET);
  const req: any = { headers: { authorization: `Bearer ${token}` } };
  const next = jest.fn();
  const res = mockRes();
  await authenticateBuyer(req, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/middleware/__tests__/authenticateBuyer.test.ts`
Expected: FAIL (legacy token still accepted).

- [ ] **Step 3: Implement the cutover**

`ticketsAuth.middleware.ts` — change the three buyer checks:
- `authenticateBuyer` (line ~162): `if ((decoded as any).userType !== 'buyer' || !(decoded as any).buyerId) { ... 'Invalid buyer token' }`
- `authenticateCommunityViewer` (line ~204): `const isBuyer = decoded.userType === 'buyer' && decoded.buyerId;`
- `optionalCommunityViewer` (line ~238): `const isBuyer = decoded.userType === 'buyer' && decoded.buyerId;`
- Update the docblock at line ~137 to `{ app, userType:'buyer', buyerId, userPhone?, userEmail? }`.

`buyerRequest.util.ts` — resolve by id:
```ts
import { Request } from 'express';
import { Buyer, IBuyer } from '@models/buyer.model';

/** Resolve the signed-in buyer document from the verified token buyerId. */
export async function resolveBuyerFromRequest(req: Request): Promise<IBuyer | null> {
  const buyerId = (req as any).ticketsUser?.buyerId as string | undefined;
  if (!buyerId) return null;
  return Buyer.findById(buyerId);
}
```

`socialActor.util.ts` (line ~22) — branch on buyerId:
```ts
if (user.userType === 'buyer' && user.buyerId) {
  const buyer = await resolveBuyerFromRequest(req);
  if (buyer) return { type: 'buyer', id: String(buyer._id) };
}
```

`realtime/socketAuth.ts` (lines ~25-29) — gate + resolve on buyerId instead of `normalizePhone(decoded.userPhone)`. Load the buyer by `decoded.buyerId` and use its `_id` for the social identity (match whatever the socket layer currently derives from phone — replace the phone lookup with `Buyer.findById(decoded.buyerId)`).

- [ ] **Step 4: Run middleware + affected tests**

Run: `cd api && npx jest src/middleware/__tests__/authenticateBuyer.test.ts src/realtime`
Expected: PASS. Also run `npx jest src/utils` and any social tests that stub `ticketsUser` — update stubs to include `buyerId`.

- [ ] **Step 5: Commit**

```bash
git -C api add src/middleware/ticketsAuth.middleware.ts src/utils/buyerRequest.util.ts src/utils/socialActor.util.ts src/realtime/socketAuth.ts src/middleware/__tests__/authenticateBuyer.test.ts
git -C api commit -m "feat(auth): hard cutover to buyerId identity in middleware + resolvers"
```

---

## Task 8: Ticket + TicketSale — customerEmail + buyerId

**Files:**
- Modify: `api/src/models/ticket.model.ts`, `api/src/models/ticketSale.model.ts`
- Test: `api/src/models/__tests__/ticket.identity.test.ts` (create)

**Interfaces:**
- Produces: `ITicket.customerEmail?`, `ITicket.buyerId?`; `ITicketSale.customerEmail?`, `ITicketSale.buyerId?`. New index on `ticket.buyerId`.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/models/__tests__/ticket.identity.test.ts
import { Ticket } from '@models/ticket.model';
it('accepts a ticket bound to buyerId + customerEmail (no phone)', () => {
  const t = new Ticket({
    ticketId: 'TKT-1', eventId: '000000000000000000000001',
    buyerId: '000000000000000000000002', customerEmail: 'b@x.com',
    // ...fill required fields per the existing schema (ticketType, price, status, vendorId, etc.)
  });
  const err = t.validateSync();
  // Only assert our new fields are accepted; ignore unrelated required-field errors:
  expect(err?.errors?.['customerEmail']).toBeUndefined();
  expect(err?.errors?.['buyerId']).toBeUndefined();
});
```
> Populate the other required fields by copying a valid fixture from an existing ticket test so `validateSync` isn't tripped by unrelated requireds.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/models/__tests__/ticket.identity.test.ts`
Expected: FAIL (fields unknown → cast/strict errors).

- [ ] **Step 3: Implement**

In `ticket.model.ts`, next to `customerPhone` (line ~48):
```ts
  customerEmail: { type: String, trim: true, lowercase: true, index: true },
  buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', index: true, sparse: true },
```
Add to `ITicket`: `customerEmail?: string; buyerId?: Types.ObjectId;` (import `Types` if needed).

Mirror the same two fields in `ticketSale.model.ts` next to its `customerPhone` (line ~42) and `ITicketSale`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/models/__tests__/ticket.identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C api add src/models/ticket.model.ts src/models/ticketSale.model.ts src/models/__tests__/ticket.identity.test.ts
git -C api commit -m "feat(tickets): customerEmail + buyerId owner link on ticket & sale"
```

---

## Task 9: TicketService — match by buyer, stamp identity on purchase

**Files:**
- Modify: `api/src/services/ticket.service.ts`
- Test: `api/src/services/__tests__/ticket.findForBuyer.test.ts` (create)

**Interfaces:**
- Consumes: `IBuyer`.
- Produces:
  ```ts
  TicketService.findTicketsForBuyer(buyer: Pick<IBuyer,'_id'|'phone'|'email'>): Promise<ITicket[]>
  TicketService.findTicketsByCustomerPhone(phone: string): Promise<ITicket[]>  // kept as a thin wrapper (Keshless proxy path)
  ```
  `purchaseForCustomer` params gain optional `customerEmail?: string; buyerId?: string;` and stamp them onto sale + tickets.

- [ ] **Step 1: Write the failing test**

```ts
// api/src/services/__tests__/ticket.findForBuyer.test.ts
import { TicketService } from '@services/ticket.service';
import { Ticket } from '@models/ticket.model';

it('matches tickets by buyerId, phone, or email', async () => {
  const eventId = '000000000000000000000001';
  await Ticket.create({ ticketId: 'A', eventId, buyerId: '000000000000000000000002' /*, +required fixture fields*/ } as any);
  await Ticket.create({ ticketId: 'B', eventId, customerPhone: '+26878422613' /*, +fixture*/ } as any);
  await Ticket.create({ ticketId: 'C', eventId, customerEmail: 'b@x.com' /*, +fixture*/ } as any);

  const found = await TicketService.findTicketsForBuyer({
    _id: '000000000000000000000002' as any, phone: '+26878422613', email: 'b@x.com',
  });
  expect(found.map((t: any) => t.ticketId).sort()).toEqual(['A', 'B', 'C']);
});
```
> Add the required ticket fixture fields (copy from an existing ticket test factory).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/services/__tests__/ticket.findForBuyer.test.ts`
Expected: FAIL (`findTicketsForBuyer` undefined).

- [ ] **Step 3: Implement**

Add to `TicketService`:
```ts
static async findTicketsForBuyer(
  buyer: { _id: any; phone?: string; email?: string }
): Promise<ITicket[]> {
  const or: any[] = [{ buyerId: buyer._id }];
  if (buyer.phone) or.push({ customerPhone: normalizePhone(buyer.phone) });
  if (buyer.email) or.push({ customerEmail: buyer.email.toLowerCase() });
  return Ticket.find({ $or: or })
    .populate('eventId', 'name venue eventDate startTime endTime posterUrl')
    .sort({ createdAt: -1 })
    .lean();
}
```
Keep `findTicketsByCustomerPhone` as-is (still used by the Keshless proxy path in `tickets.controller`).

In `purchaseForCustomer` params add `customerEmail?: string; buyerId?: string;`; when creating the `TicketSale` and each `Ticket`, include `...(params.customerEmail ? { customerEmail: params.customerEmail.toLowerCase() } : {})` and `...(params.buyerId ? { buyerId: params.buyerId } : {})`. Do the same in the MoMo/card/DeltaPay finalize paths that write sales/tickets (grep `new TicketSale`/`Ticket.insertMany`/`Ticket.create` in this file and thread the two fields from the initiate params through to the writes).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx jest src/services/__tests__/ticket.findForBuyer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C api add src/services/ticket.service.ts src/services/__tests__/ticket.findForBuyer.test.ts
git -C api commit -m "feat(tickets): findTicketsForBuyer (id|phone|email) + stamp identity on purchase"
```

---

## Task 10: Purchase controller — resolve buyer, thread identity, fix IDOR

**Files:**
- Modify: `api/src/controllers/public.controller.ts` (`getMyTickets` ~1043; `initiateMomoPurchase`/`getMomoStatus`; `initiateCardPurchase`/`getCardStatus`; `initiateDeltapayPurchase`/`getDeltapayStatus`)
- Modify: `api/src/services/ticket.service.ts` — MoMo/card/DeltaPay `initiate*` params gain `buyerId`/`customerEmail`; `get*SaleBy*`/`finalize*` unchanged except they now carry the stamped fields (from Task 9).
- Test: extend `api/src/controllers/__tests__/buyerAuth.route.test.ts` with a My-Tickets case.

**Interfaces:**
- Consumes: `resolveBuyerFromRequest`, `TicketService.findTicketsForBuyer`.

- [ ] **Step 1: Write the failing test**

```ts
it('GET /api/public/my-tickets returns tickets for an email buyer', async () => {
  const buyer = await Buyer.create({ email: 'mt@x.com', password: 'secret6', emailVerifiedAt: new Date() });
  await Ticket.create({ ticketId: 'Z', eventId: '000000000000000000000001', buyerId: buyer._id /*, +fixture*/ } as any);
  const token = jwt.sign({ userType: 'buyer', app: 'tickets', buyerId: String(buyer._id), userEmail: 'mt@x.com' }, JWT_SECRET);
  const res = await request(app).get('/api/public/my-tickets').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data.map((t: any) => t.ticketId)).toContain('Z');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx jest src/controllers/__tests__/buyerAuth.route.test.ts -t 'my-tickets'`
Expected: FAIL (getMyTickets still phone-keyed).

- [ ] **Step 3: Implement**

`getMyTickets` (public.controller ~1043):
```ts
static async getMyTickets(req: Request, res: Response): Promise<any> {
  try {
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to view your tickets');
    const tickets = await TicketService.findTicketsForBuyer(buyer);
    return ApiResponseUtil.success(res, tickets);
  } catch (error: any) {
    console.error('Get buyer tickets error:', error);
    return ApiResponseUtil.error(res, error.message || 'Failed to fetch tickets');
  }
}
```
Import `resolveBuyerFromRequest` at the top of the controller.

For each of the three **initiate** handlers (MoMo ~907, card ~953, DeltaPay ~999), replace the `userPhone`-only guard with a buyer resolve, and pass identity through:
```ts
const buyer = await resolveBuyerFromRequest(req);
if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to buy a ticket');
const r = await TicketService.initiateMomoPurchase({
  ...value,
  customerPhone: buyer.phone,           // may be undefined for email-only buyers
  customerEmail: buyer.email,
  buyerId: String(buyer._id),
  channel: SalesChannel.ONLINE,
});
```
> Update `TicketService.initiate{Momo,Card,Deltapay}Purchase` param types so `customerPhone` is optional and `customerEmail?`/`buyerId?` exist; carry them into the pending-sale record so `finalize*` stamps them (Task 9).

For each **status** handler (getMomoStatus ~925, getCardStatus ~973, getDeltapayStatus ~1024), replace the phone-equality IDOR check with a buyerId check + legacy phone fallback:
```ts
const buyer = await resolveBuyerFromRequest(req);
if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
const sale = await TicketService.getMomoSaleByReference(referenceId);
const owns = sale && (
  (sale.buyerId && String(sale.buyerId) === String(buyer._id)) ||
  (!sale.buyerId && sale.customerPhone && buyer.phone && normalizePhone(sale.customerPhone) === normalizePhone(buyer.phone))
);
if (!owns) return ApiResponseUtil.notFound(res, 'Payment not found');
```
Apply the identical ownership pattern to card + DeltaPay status.

- [ ] **Step 4: Run tests**

Run: `cd api && npx jest src/controllers/__tests__/buyerAuth.route.test.ts`
Expected: PASS. Then `cd api && npx jest` (full suite) — fix any test stubbing `ticketsUser.userPhone` for buyer purchase/status to include `buyerId`.

- [ ] **Step 5: Commit**

```bash
git -C api add src/controllers/public.controller.ts src/services/ticket.service.ts
git -C api commit -m "feat(purchase): resolve buyer by id; thread email/buyerId; buyerId IDOR checks"
```

---

## Task 11: API green build + full suite

**Files:** none (verification task).

- [ ] **Step 1: Typecheck + build**

Run: `cd api && npx tsc --noEmit` (or the repo's build script, e.g. `npm run build`).
Expected: no type errors. Fix any residual `userPhone`-typed access on buyer tokens.

- [ ] **Step 2: Full test suite**

Run: `cd api && npx jest`
Expected: all green.

- [ ] **Step 3: Commit any fixes**

```bash
git -C api add -A && git -C api commit -m "chore(api): green build + suite for email-or-phone buyer identity"
```

---

## Task 12: Frontend — BuyerAuthContext + api client identity

**Files:**
- Modify: `landing/src/contexts/BuyerAuthContext.tsx`
- Modify: `landing/src/services/api.ts` (buyer-auth request/response mapping)
- Test: `landing/src/contexts/__tests__/BuyerAuthContext.test.tsx` (extend)

**Interfaces:**
- Produces: context stores `identity: { phone?: string; email?: string }`; auth calls POST `{ identifier, ... }` and read `identity` from responses.

- [ ] **Step 1: Write the failing test**

Extend `BuyerAuthContext.test.tsx`: assert that after a successful email login the context exposes `identity.email` and a token, and that `login` posts `{ identifier, password }` (mock the api). Match the existing test's mocking style.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd landing && npx vitest run src/contexts/__tests__/BuyerAuthContext.test.tsx` (or the repo's test runner).
Expected: FAIL.

- [ ] **Step 3: Implement**

- In `api.ts`, change buyer-auth calls to send `{ identifier, ... }` (was `{ phone, ... }`) and to read `identity` (falling back to `{ phone: res.phone }` only if an older server shape is returned — but since API+SPA deploy together this can be the new shape directly).
- In `BuyerAuthContext.tsx`, replace the stored `phone` string with `identity: { phone?; email? }`; update `onAuthenticated`/callbacks to pass identity through. Keep a derived `displayHandle = identity.email ?? identity.phone` for UI.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd landing && npx vitest run src/contexts/__tests__/BuyerAuthContext.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C landing add src/contexts/BuyerAuthContext.tsx src/services/api.ts src/contexts/__tests__/BuyerAuthContext.test.tsx
git -C landing commit -m "feat(buyer-auth): identity {phone|email} in context + identifier api calls"
```

---

## Task 13: Frontend — BuyerAuthPanel identifier UX

**Files:**
- Modify: `landing/src/components/BuyerAuthPanel.tsx`
- Test: `landing/src/components/__tests__/BuyerAuthPanel.test.tsx` (create/extend)

**Interfaces:**
- Consumes: context + api changes (Task 12); `onAuthenticated(token, identity)`.

- [ ] **Step 1: Write the failing test**

Test that the login tab renders a single identifier input (accepts an email), that submitting an email calls the login API with `{ identifier: '<email>' }`, and that the verify step copy reads "sent to your email" when the channel is email. Mock the api layer.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd landing && npx vitest run src/components/__tests__/BuyerAuthPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Replace the `PhoneField`-only input with an **identifier `Input`** (type text, `inputMode` auto) labelled "Email or phone". Keep `PhoneField` behaviour when the value looks like a phone (optional nicety: detect `@` to swap the helper text / keyboard; not required for correctness — the backend classifies authoritatively).
- Track the channel returned by the request-OTP / requiresRegistration responses; render channel-aware verify copy: `Enter the 6-digit code we sent to your ${channel === 'email' ? 'email' : 'phone'}`.
- Mirror the same identifier input + channel copy in the reset (`resetStep`) overlay.
- Update `onAuthenticated` to forward `identity` instead of a bare phone; update the two call sites (`/my-tickets/login` page + `PurchaseModal`) to accept the new signature (they mostly just store the token).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd landing && npx vitest run src/components/__tests__/BuyerAuthPanel.test.tsx`
Expected: PASS. Then run the existing `PurchaseModal.auth.test.tsx` + `BuyerAuthContext.test.tsx` and fix any signature drift.

- [ ] **Step 5: Frontend build + commit**

Run: `cd landing && npm run build` (per the memory: only `npm run build`/`tsc -b` catches Pages-build failures — do NOT rely on `tsc --noEmit`).
Expected: clean build.

```bash
git -C landing add src/components/BuyerAuthPanel.tsx src/components/__tests__/BuyerAuthPanel.test.tsx src/pages/MyTicketsLoginPage.tsx src/components/PurchaseModal.tsx
git -C landing commit -m "feat(buyer-auth): email-or-phone identifier UX in BuyerAuthPanel"
```

---

## Task 14: Wiring, verification & deploy notes

**Files:** none (ops/verification).

- [ ] **Step 1: Confirm YeboLink email is enabled for the workspace**

The `YEBOLINK_API_KEY` env is already bound to the Cloud Run service for SMS. Confirm the "Carrot Tickets" YeboLink workspace has **email** channel enabled and enough credits (per `yebolink-implementation` skill). If a separate email sender identity/domain is required, register it there. **Do not** wipe existing env — if any new var is needed use `gcloud run services update ... --update-env-vars` / `--update-secrets` (additive), per global rules.

- [ ] **Step 2: Dev end-to-end email OTP**

Against dev API, request an email registration OTP and confirm the email arrives + registration completes:
```bash
curl -sS -X POST "$DEV_API/api/public/auth/request-otp" -H 'Content-Type: application/json' -d '{"identifier":"you@example.com"}'
# then, with the emailed code:
curl -sS -X POST "$DEV_API/api/public/auth/register" -H 'Content-Type: application/json' \
  -d '{"identifier":"you@example.com","code":"<CODE>","password":"secret6","name":"Test"}'
```
Expected: `accessToken` + `identity.email`. Then GET `/api/public/my-tickets` with the token → 200.

- [ ] **Step 3: Deploy order**

Deploy **API first** (model + auth + email), verify dev, then build+deploy **landing**. Announce the hard token cutover: currently-signed-in buyers re-login once (expected, per decision 5). Use the `deploy` skill / existing triggers; verify with `check-deploy`.

- [ ] **Step 4: Prod smoke**

One real email signup + one phone signup on prod; confirm both land in "My Tickets" and a purchase status poll works for an email buyer.

---

## Self-Review

**Spec coverage:**
- §1 data model → Tasks 1, 2, 8. ✅
- §2 token & middleware → Tasks 5 (token), 7 (middleware + resolvers). ✅
- §3 auth service + EmailService → Tasks 3, 4, 5, 6. ✅
- §4 purchase / My Tickets → Tasks 9, 10. ✅
- §5 frontend → Tasks 12, 13. ✅
- §6 out of scope (no account-linking / add-second-handle) → honored (not planned). ✅
- Error handling (no silent fallback) → OTP send throws in Task 5; email returns false → controller surfaces (Tasks 3/6). ✅
- Testing section → each task is TDD; Task 11 full suite. ✅
- Migration/rollout (hard cutover, phoneVerifiedAt backfill, deploy order) → Tasks 7, 14. **Gap fixed below.**

**Gap found & fixed:** the spec's "backfill `phoneVerifiedAt` for existing buyers" wasn't its own step. It is low-risk (existing buyers were OTP-verified at creation) and the runtime invariant only checks *presence* of a handle, not verification — so a formal migration is optional. Add it opportunistically:
> Optional one-off (safe to skip): `db.buyers.updateMany({ phone: { $exists: true }, phoneVerifiedAt: { $exists: false } }, { $set: { phoneVerifiedAt: new Date() } })`. Not required for correctness; do it only if a later feature keys off `phoneVerifiedAt`.

**Placeholder scan:** no "TBD/TODO/handle edge cases"; test fixtures that must be copied from existing factories are explicitly flagged (tickets require many fields — the plan says to copy a valid fixture rather than inventing one).

**Type consistency:** `classifyIdentifier`→`Identifier`→`findByIdentifier`/`sendOtpFor`; `LoginResult`/`BuyerIdentity` used consistently in Tasks 5/6/12; `findTicketsForBuyer(buyer)` signature matches its callers in Task 10; token claim `buyerId` consistent across Tasks 5/7/10.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — batch execution with checkpoints in this session.

---

## Task R1 (inserted during execution, 2026-08-05)

Discovered while executing Task 5: making `Buyer.phone` optional (Task 1) broke 4 files at the type level and — more importantly — left `isTicketHolder` and `GoingService` matching tickets by phone only, so email-only buyers would be misrecognized (incl. a latent `{customerPhone: undefined}` match bug in GoingService). Inserted a remediation task, ordered AFTER Task 8 (needs `buyerId`/`customerEmail` on tickets) and BEFORE Task 6.

Scope: shared `buyerTicketOr(buyer)` matcher + `isTicketHolderForBuyer` in `ticketHolder.util.ts`; route `message.service`, `review.service`, `communityMembership.service`, and `GoingService` (single + batch) through it; guard optional `b.phone` in `adminUsers.controller`; green `tsc`. Task 9's `findTicketsForBuyer` REUSES `buyerTicketOr`.

Deferred minor (logged for final review): `activityFeed/going.ts` "who's-going roster" still keys off followed-actors' phones — an email-only followee won't appear in a roster until extended. Degrades gracefully (display completeness), not an auth/data bug.

Full brief: `.superpowers/sdd/2026-08-05-buyer-email-or-phone-identity/task-R1-brief.md`
