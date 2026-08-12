# Per-account ticket limit ("one ticket per person") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable, per-event cap on how many active tickets one buyer identity may hold for an event, enforced across every sale channel, so The Legends Cup 2027 can run "one ticket per person".

**Architecture:** One optional event field `maxTicketsPerAccount` (absent = unlimited). Enforcement lives in the single shared gate `EventService.checkTicketAvailability`, which every sale path already calls. The gate gains an optional `buyer` identity argument; when the event has a positive cap and an identity is supplied, it counts the buyer's active tickets for the event (keyed on `buyerId` OR normalized `customerPhone`) and rejects when `existing + requested > cap`. Callers pass the buyer identity they already hold. No dashboard UI; activation is a manual script.

**Tech Stack:** Node.js + TypeScript, Mongoose (MongoDB), Jest + `mongodb-memory-server` (via `src/__tests__/helpers/mongo`).

## Global Constraints

- **No backward-incompatible changes.** `maxTicketsPerAccount` is optional; absent/0 = unlimited, so every existing event behaves identically. (CLAUDE.md: don't break compatibility without asking.)
- **DRY.** Reuse the existing gate `EventService.checkTicketAvailability`, the canonical `normalizePhone` (`@utils/phone.util`), and the `buyerId → phone` identity precedence. Do not add a new identity concept or a second enforcement site.
- **Fail loudly, no silent fallbacks.** The gate returns `{ available: false, message }`; callers already surface that (throw / 4xx). Never mint a ticket that violates the cap by swallowing the check.
- **Enforce PRE-CHARGE only.** `sellTickets` runs the gate before any debit; the three `initiate*` methods run it before redirecting to pay. The post-payment `finalize*Sale` mint paths are NOT changed — blocking after capture would take money and give no ticket, and no automated refund is wired. (Resolves the spec's open "finalize" question.)
- **Identity key:** `buyerId` when present OR normalized `customerPhone`. A caller with neither (POS walk-up, wristband, reseller allocation) is skipped — an account rule can't bind an identity that doesn't exist.
- **Active ticket** = `status NOT IN {refunded, cancelled}`.
- **Commit after every task.** End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Run tests with:** `npx jest <path>` from the `api-peraccount-wt` repo root.

---

### Task 1: Event model — add the `maxTicketsPerAccount` field

**Files:**
- Modify: `src/interfaces/event.interface.ts` (after `ticketTypes: ITicketType[];`, line ~65)
- Modify: `src/models/event.model.ts` (after the `ticketTypes` schema block, line ~126)
- Test: `src/models/__tests__/eventMaxTicketsPerAccount.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `IEvent.maxTicketsPerAccount?: number` — read by Task 2's gate.

- [ ] **Step 1: Write the failing test**

Create `src/models/__tests__/eventMaxTicketsPerAccount.test.ts`:

```ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

const DAY = 86400000;

async function seedEvent(extra: Record<string, unknown>) {
  const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org-cap' });
  return Event.create({
    vendorId: vendor._id,
    name: 'Cap Event',
    venue: 'V',
    eventDate: new Date(Date.now() + DAY),
    startTime: new Date(Date.now() + DAY),
    endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'GA', price: 100, quantity: 500, sold: 0 }],
    ...extra,
  });
}

describe('Event.maxTicketsPerAccount', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('persists the cap when set', async () => {
    const event = await seedEvent({ maxTicketsPerAccount: 1 });
    const reloaded = await Event.findById(event._id);
    expect(reloaded!.maxTicketsPerAccount).toBe(1);
  });

  it('is undefined by default (unlimited)', async () => {
    const event = await seedEvent({});
    const reloaded = await Event.findById(event._id);
    expect(reloaded!.maxTicketsPerAccount).toBeUndefined();
  });

  it('rejects a cap below 1', async () => {
    await expect(seedEvent({ maxTicketsPerAccount: 0 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/models/__tests__/eventMaxTicketsPerAccount.test.ts`
Expected: FAIL — `maxTicketsPerAccount` is stripped (not in schema), so `toBe(1)` fails and the `min:1` rejection doesn't happen.

- [ ] **Step 3: Add the field to the interface**

In `src/interfaces/event.interface.ts`, immediately after `ticketTypes: ITicketType[]; // Different ticket types`:

```ts
  // Max ACTIVE tickets a single buyer identity may hold for this event, summed
  // across all ticket types. Undefined/absent = unlimited (default). Set to 1
  // for strict "one ticket per person". Enforced in
  // EventService.checkTicketAvailability against buyerId OR normalized
  // customerPhone. No dashboard UI — set via src/scripts/setPerAccountLimit.ts.
  maxTicketsPerAccount?: number;
```

- [ ] **Step 4: Add the field to the schema**

In `src/models/event.model.ts`, immediately after the `ticketTypes: { type: [ticketTypeSchema], default: [] },` block (before the `// Status` comment):

```ts
  // See IEvent.maxTicketsPerAccount. No `default` — absent means unlimited, so
  // every existing event is unaffected. `min: 1` so a stored cap is meaningful.
  maxTicketsPerAccount: {
    type: Number,
    min: [1, 'maxTicketsPerAccount must be at least 1'],
  },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/models/__tests__/eventMaxTicketsPerAccount.test.ts`
Expected: PASS (all 3).

- [ ] **Step 6: Commit**

```bash
git add src/interfaces/event.interface.ts src/models/event.model.ts src/models/__tests__/eventMaxTicketsPerAccount.test.ts
git commit -m "feat(events): add optional maxTicketsPerAccount field

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Enforce the cap in the shared availability gate

**Files:**
- Modify: `src/services/event.service.ts` — imports (top) + `checkTicketAvailability` (line ~588)
- Test: `src/services/__tests__/perAccountLimit.availability.test.ts` (create)

**Interfaces:**
- Consumes: `IEvent.maxTicketsPerAccount` (Task 1); `Ticket` model; `TicketStatus`; `normalizePhone`.
- Produces: new optional 5th parameter on
  `EventService.checkTicketAvailability(eventId, ticketTypeId, quantity, method?, buyer?)`
  where `buyer?: { buyerId?: string | mongoose.Types.ObjectId | null; phone?: string | null }`.
  Return shape is unchanged: `{ available: boolean; message?: string; ticketTypeData?: ITicketType }`.

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/perAccountLimit.availability.test.ts`:

```ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '../event.service';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketStatus } from '@interfaces/ticket.interface';
import { normalizePhone } from '@utils/phone.util';
import mongoose from 'mongoose';

const DAY = 86400000;

async function seedCapEvent(cap?: number) {
  const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org-cap2' });
  const event = await Event.create({
    vendorId: vendor._id,
    name: 'Legends Cup',
    venue: 'V',
    eventDate: new Date(Date.now() + DAY),
    startTime: new Date(Date.now() + DAY),
    endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'GA', price: 100, quantity: 999, sold: 0 }],
    ...(cap ? { maxTicketsPerAccount: cap } : {}),
  });
  return { vendor, event, ticketTypeId: String(event.ticketTypes[0]!._id) };
}

async function giveTicket(
  eventId: string,
  vendorId: string,
  who: { buyerId?: string; customerPhone?: string; status?: TicketStatus },
) {
  return Ticket.create({
    eventId,
    vendorId,
    ticketType: 'GA',
    price: 100,
    buyerId: who.buyerId,
    customerPhone: who.customerPhone,
    status: who.status ?? TicketStatus.SOLD,
  });
}

describe('checkTicketAvailability — per-account cap', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('allows the first ticket for a limit-1 event', async () => {
    const { event, ticketTypeId } = await seedCapEvent(1);
    const buyerId = new mongoose.Types.ObjectId().toString();
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1, undefined, { buyerId });
    expect(r.available).toBe(true);
  });

  it('blocks a second ticket by the same buyerId', async () => {
    const { event, vendor, ticketTypeId } = await seedCapEvent(1);
    const buyerId = new mongoose.Types.ObjectId().toString();
    await giveTicket(String(event._id), String(vendor._id), { buyerId });
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1, undefined, { buyerId });
    expect(r.available).toBe(false);
    expect(r.message).toMatch(/one per person/i);
  });

  it('blocks buying 2 in a single order for a limit-1 event', async () => {
    const { event, ticketTypeId } = await seedCapEvent(1);
    const buyerId = new mongoose.Types.ObjectId().toString();
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 2, undefined, { buyerId });
    expect(r.available).toBe(false);
  });

  it('matches on normalized phone when there is no buyerId', async () => {
    const { event, vendor, ticketTypeId } = await seedCapEvent(1);
    // Real tickets store the NORMALIZED phone (buildTicket normalizes at issue),
    // so seed the normalized form; the gate normalizes the query phone before
    // matching. Querying with a bare local form must still hit the same record.
    await giveTicket(String(event._id), String(vendor._id), { customerPhone: normalizePhone('76000001') });
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1, undefined, { phone: '76000001' });
    expect(r.available).toBe(false);
  });

  it('does NOT count refunded/cancelled tickets', async () => {
    const { event, vendor, ticketTypeId } = await seedCapEvent(1);
    const buyerId = new mongoose.Types.ObjectId().toString();
    await giveTicket(String(event._id), String(vendor._id), { buyerId, status: TicketStatus.REFUNDED });
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1, undefined, { buyerId });
    expect(r.available).toBe(true);
  });

  it('is skipped when no cap is set (a buyer with 5 tickets can buy more)', async () => {
    const { event, vendor, ticketTypeId } = await seedCapEvent(undefined);
    const buyerId = new mongoose.Types.ObjectId().toString();
    for (let i = 0; i < 5; i++) await giveTicket(String(event._id), String(vendor._id), { buyerId });
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1, undefined, { buyerId });
    expect(r.available).toBe(true);
  });

  it('is skipped when no buyer identity is supplied (POS walk-up)', async () => {
    const { event, ticketTypeId } = await seedCapEvent(1);
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1);
    expect(r.available).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/perAccountLimit.availability.test.ts`
Expected: FAIL — the gate ignores the 5th arg, so the "blocks a second ticket" cases return `available: true`.

- [ ] **Step 3: Add imports to `event.service.ts`**

At the top of `src/services/event.service.ts`, change the ticket-interface import and add two lines:

```ts
import { PaymentMethod, TicketStatus } from '@interfaces/ticket.interface';
import { Ticket } from '@models/ticket.model';
import { normalizePhone } from '@utils/phone.util';
```

(The existing line is `import { PaymentMethod } from '@interfaces/ticket.interface';` — add `TicketStatus` to it. Add the other two imports beside the other `@models`/`@utils` imports.)

- [ ] **Step 4: Extend the signature and add the check**

In `checkTicketAvailability`, add the 5th parameter:

```ts
  static async checkTicketAvailability(
    eventId: string,
    ticketTypeId: string,
    quantity: number,
    method?: PaymentMethod,
    buyer?: { buyerId?: string | mongoose.Types.ObjectId | null; phone?: string | null }
  ): Promise<{ available: boolean; message?: string; ticketTypeData?: ITicketType }> {
```

Then, INSIDE the `try`, immediately BEFORE the final `return { available: true, ticketTypeData: ticketTypeObj };`, insert:

```ts
      // Per-account cap ("one ticket per person"). Enforced only when the
      // organizer set a positive maxTicketsPerAccount AND we can identify the
      // buyer (buyerId or a phone). Counts the buyer's ACTIVE tickets for THIS
      // event across all tiers (refunded/cancelled excluded) and rejects if
      // this order would push them over the cap. A caller with no identity
      // (POS walk-up, wristband, reseller allocation) is skipped — an account
      // rule can't bind someone with no account and no phone.
      const cap = event.maxTicketsPerAccount;
      if (typeof cap === 'number' && cap > 0 && buyer) {
        const identityClauses: Array<Record<string, unknown>> = [];
        if (buyer.buyerId) identityClauses.push({ buyerId: buyer.buyerId });
        const normPhone = buyer.phone ? normalizePhone(buyer.phone) : '';
        if (normPhone) identityClauses.push({ customerPhone: normPhone });

        if (identityClauses.length > 0) {
          const held = await Ticket.countDocuments({
            eventId,
            status: { $nin: [TicketStatus.REFUNDED, TicketStatus.CANCELLED] },
            $or: identityClauses,
          });
          if (held + quantity > cap) {
            return {
              available: false,
              message:
                cap === 1
                  ? "You already have your ticket for this event — it's limited to one per person."
                  : `This event is limited to ${cap} tickets per person; you already have ${held}.`,
              ticketTypeData: ticketTypeObj,
            };
          }
        }
      }

```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/services/__tests__/perAccountLimit.availability.test.ts`
Expected: PASS (all 7).

- [ ] **Step 6: Run the existing gate test to confirm no regression**

Run: `npx jest src/services/__tests__/checkTicketAvailability.test.ts`
Expected: PASS (unchanged — those calls pass no `buyer`, so the new block is skipped).

- [ ] **Step 7: Commit**

```bash
git add src/services/event.service.ts src/services/__tests__/perAccountLimit.availability.test.ts
git commit -m "feat(tickets): enforce per-account cap in checkTicketAvailability

Optional buyer identity arg; counts active tickets (buyerId OR normalized
phone) for the event and rejects when existing+requested exceeds the cap.
No-op when the event has no cap or no identity is supplied.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Thread buyer identity into the pre-charge callers

**Files:**
- Modify: `src/services/ticket.service.ts` — 4 call sites of `checkTicketAvailability`:
  `sellTickets` (~line 270), `initiateMomoPurchase` (~1140), `initiateCardPurchase` (~1295), `initiateDeltapayPurchase` (~1439). Leave `issueWristbandBatch` (~714) unchanged (no buyer identity).
- Test: `src/services/__tests__/perAccountLimit.freeClaim.test.ts` (create)

**Interfaces:**
- Consumes: the 5-arg `checkTicketAvailability` from Task 2.
- Produces: no new symbols. `sellTickets`, `claimFreeTicket`, and the three `initiate*` methods now reject a purchase that would exceed the cap, throwing `Error(message)` (sellTickets) or returning the gate's failure (initiate paths) BEFORE any charge.

- [ ] **Step 1: Write the failing test (free-claim path, end-to-end through sellTickets → gate)**

Create `src/services/__tests__/perAccountLimit.freeClaim.test.ts`:

```ts
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketService } from '../ticket.service';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import mongoose from 'mongoose';

const DAY = 86400000;

async function seedFreeCapEvent() {
  const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org-free-cap' });
  const event = await Event.create({
    vendorId: vendor._id,
    name: 'Legends Cup 2027',
    venue: 'V',
    eventDate: new Date(Date.now() + DAY),
    startTime: new Date(Date.now() + DAY),
    endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED,
    maxTicketsPerAccount: 1,
    ticketTypes: [{ name: 'Free GA', price: 0, quantity: 999, sold: 0 }],
  });
  return { event, ticketTypeId: String(event.ticketTypes[0]!._id) };
}

describe('per-account cap — free-claim path', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lets a buyer claim once, then blocks a second free claim', async () => {
    const { event, ticketTypeId } = await seedFreeCapEvent();
    const buyerId = new mongoose.Types.ObjectId().toString();

    const first = await TicketService.claimFreeTicket({
      eventId: String(event._id),
      ticketTypeId,
      quantity: 1,
      buyerId,
      customerPhone: '76000123',
    });
    expect(first.tickets).toHaveLength(1);

    await expect(
      TicketService.claimFreeTicket({
        eventId: String(event._id),
        ticketTypeId,
        quantity: 1,
        buyerId,
        customerPhone: '76000123',
      }),
    ).rejects.toThrow(/one per person/i);
  });

  it('lets a different buyer still claim', async () => {
    const { event, ticketTypeId } = await seedFreeCapEvent();
    await TicketService.claimFreeTicket({
      eventId: String(event._id),
      ticketTypeId,
      quantity: 1,
      buyerId: new mongoose.Types.ObjectId().toString(),
      customerPhone: '76000001',
    });
    const other = await TicketService.claimFreeTicket({
      eventId: String(event._id),
      ticketTypeId,
      quantity: 1,
      buyerId: new mongoose.Types.ObjectId().toString(),
      customerPhone: '76000002',
    });
    expect(other.tickets).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/perAccountLimit.freeClaim.test.ts`
Expected: FAIL on the first test — the second claim currently succeeds because `sellTickets` doesn't yet pass the buyer identity to the gate.

- [ ] **Step 3: Pass identity in `sellTickets`**

In `src/services/ticket.service.ts`, in `sellTickets`, change the availability call (around line 270) from:

```ts
      const availabilityCheck = await EventService.checkTicketAvailability(
        eventId,
        ticketTypeId,
        quantity,
        paymentMethod
      );
```

to:

```ts
      const availabilityCheck = await EventService.checkTicketAvailability(
        eventId,
        ticketTypeId,
        quantity,
        paymentMethod,
        { buyerId: params.buyerId, phone: params.customerPhone }
      );
```

- [ ] **Step 4: Run the free-claim test to verify it passes**

Run: `npx jest src/services/__tests__/perAccountLimit.freeClaim.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Pass identity in the three async initiators**

For each of `initiateMomoPurchase`, `initiateCardPurchase`, `initiateDeltapayPurchase`, the availability call currently looks like:

```ts
    const avail = await EventService.checkTicketAvailability(p.eventId, p.ticketTypeId, p.quantity, PaymentMethod.MTN_MOMO);
```

Add the 5th arg to each (keep each method's existing `PaymentMethod.*` value — `MTN_MOMO`, `PEACH_CARD`, `DELTAPAY` respectively):

```ts
    const avail = await EventService.checkTicketAvailability(
      p.eventId, p.ticketTypeId, p.quantity, PaymentMethod.MTN_MOMO,
      { buyerId: p.buyerId, phone: p.customerPhone }
    );
```

Do the equivalent edit in all three methods. (`p.buyerId` and `p.customerPhone` already exist on each method's param object — verified in the signatures.)

- [ ] **Step 6: Run the full ticket + availability suites to confirm no regression**

Run: `npx jest src/services/__tests__/perAccountLimit.availability.test.ts src/services/__tests__/perAccountLimit.freeClaim.test.ts src/services/__tests__/checkTicketAvailability.test.ts src/services/__tests__/claimFreeTicket.security.test.ts`
Expected: PASS across all.

- [ ] **Step 7: Commit**

```bash
git add src/services/ticket.service.ts src/services/__tests__/perAccountLimit.freeClaim.test.ts
git commit -m "feat(tickets): pass buyer identity to the cap gate on all pre-charge paths

sellTickets (cash/POS/free/Keshless-card) + MoMo/card/DeltaPay initiators now
pass {buyerId, phone} so the per-account cap is enforced before any charge.
finalize* mint paths unchanged — a captured payment always yields a ticket.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Manual activation script (no UI)

**Files:**
- Create: `src/scripts/setPerAccountLimit.ts`

**Interfaces:**
- Consumes: `IEvent.maxTicketsPerAccount` (Task 1). Run manually against dev/prod when the owner says go.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the script**

Create `src/scripts/setPerAccountLimit.ts` (models on `backfillCommunities.ts`'s connect/disconnect pattern):

```ts
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Event } from '../models/event.model';

dotenv.config();

const MONGODB_URI = process.env['MONGODB_URI'];
if (!MONGODB_URI) {
  throw new Error('FATAL: MONGODB_URI is not set');
}

/**
 * One-off ops tool: set (or clear) an event's per-account ticket cap. There is
 * intentionally NO dashboard UI for this field.
 *
 *   npx ts-node src/scripts/setPerAccountLimit.ts <eventId> <cap>
 *   npx ts-node src/scripts/setPerAccountLimit.ts <eventId> unlimited
 *
 * <eventId> is the 24-hex Mongo _id. <cap> is a positive integer, or the
 * literal "unlimited" to remove the cap. Idempotent; prints before/after.
 */
async function main() {
  const [eventId, capArg] = process.argv.slice(2);
  if (!eventId || !capArg) {
    throw new Error('Usage: setPerAccountLimit.ts <eventId> <cap|unlimited>');
  }

  const clearing = capArg.toLowerCase() === 'unlimited';
  const cap = clearing ? undefined : Number(capArg);
  if (!clearing && (!Number.isInteger(cap) || (cap as number) < 1)) {
    throw new Error(`Invalid cap "${capArg}" — must be a positive integer or "unlimited"`);
  }

  await mongoose.connect(MONGODB_URI as string);
  console.log('✅ Connected to MongoDB');

  const event = await Event.findById(eventId).select('name maxTicketsPerAccount');
  if (!event) {
    await mongoose.disconnect();
    throw new Error(`Event ${eventId} not found`);
  }

  console.log(`Event: "${event.name}"`);
  console.log(`  before: maxTicketsPerAccount = ${event.maxTicketsPerAccount ?? '(unlimited)'}`);

  if (clearing) {
    event.set('maxTicketsPerAccount', undefined);
  } else {
    event.maxTicketsPerAccount = cap as number;
  }
  await event.save();

  const reloaded = await Event.findById(eventId).select('maxTicketsPerAccount');
  console.log(`  after:  maxTicketsPerAccount = ${reloaded!.maxTicketsPerAccount ?? '(unlimited)'}`);

  await mongoose.disconnect();
  console.log('✅ Done');
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check the script compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS (no type errors introduced).

- [ ] **Step 3: Commit**

```bash
git add src/scripts/setPerAccountLimit.ts
git commit -m "chore(scripts): add setPerAccountLimit ops script (no UI)

Manually set/clear an event's per-account ticket cap. Used to activate
'one ticket per person' on The Legends Cup 2027 when the owner requests it.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] **Full test suite:** `npx jest` → green (or at least the ticket/event suites, plus no new failures elsewhere).
- [ ] **Build:** `npm run build` → succeeds (catches anything `--noEmit` per-file checks miss).

## Rollout (not a code task — do when ready)

1. Merge `feat/per-account-ticket-limit` and deploy from this worktree:
   `gcloud run deploy carrot-tickets-api --source .` (env preserved; per repo convention). The field is absent on every event, so this deploy changes no behavior.
2. **When the owner says go**, activate on The Legends Cup 2027 (fetch its 24-hex event `_id` first):
   `MONGODB_URI=<prod> npx ts-node src/scripts/setPerAccountLimit.ts <legendsCupEventId> 1`
   Verify the printed `after: maxTicketsPerAccount = 1`, then confirm a second purchase attempt by the same account is blocked.

## Known limitation (documented, by design)

Enforcement is application-level at the pre-charge gate. Two genuinely simultaneous checkouts by the same buyer (e.g. two browser tabs firing MoMo initiations in the same instant, both approved) could each pass the pre-flight and mint — worst case 2 tickets. There is no clean unique-index guarantee (a partial index can't be made conditional on the event's own cap without breaking multi-ticket events). The common case — a buyer who already holds a ticket coming back later, on any channel — is fully blocked. This is a low-stakes business rule, not money integrity; honoring a captured payment (never charge-without-ticket) is the deliberate priority.
