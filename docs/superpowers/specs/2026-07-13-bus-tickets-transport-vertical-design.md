# Bus Tickets — Transport Vertical for Carrot (2026-07-13)

Bring Keshless Travels' bus/shuttle ticketing into Carrot Tickets as a native, first-class
vertical, converted from its Postgres/Prisma origins to Carrot's Mongo stack. Bus operators
become Carrot **Vendors**; conductors sell seats on the existing **POS / reseller app**.

Source system ported from: `~/Documents/omevision/contracts/keshless/keshless-travels`
(a mature shuttle booking system: ShuttleOperator → Route → Trip → Seat → Booking →
BoardingScan, with seat maps, return tickets, roles, and operator withdrawals).

---

## 1. Decisions locked in brainstorming

| Question | Decision |
|---|---|
| Where does bus logic live? | **Native rebuild in Carrot** — port the Travels domain, convert to Carrot's stack. Not an integration with the live Travels backend, not a Flutter-app copy. |
| Which selling channel for v1? | **The existing Carrot POS / reseller app** (`pos-app`). Conductor sells + prints + boards on the ZCS handheld. Online self-service is deferred. |
| Who owns the routes/trips (inventory) and gets paid? | **Bus operator = Vendor** (like an event organizer). Conductors sell on the POS as **ResellerOperator**s, earning commission. Max reuse of vendor + reseller + payout machinery. |
| Seat granularity? | **Full fidelity** — port all three schemes (`SEQUENTIAL`, `ROW_LETTER`, `PASSENGER_COUNT`); each VehicleType picks its scheme. |
| Data-model approach? | **Approach A (parallel domain) with DEDICATED `BookingSale`/`BoardingScan` collections.** Reuse the payment *processor* layer + POS shell, but keep bus sales/scans in their own collections — do **not** overload the live `TicketSale`/`TicketScan`. |

---

## 2. Approach A — parallel domain, dedicated sale/scan collections, reused payment processors

Port Travels' domain models as genuinely new Mongo collections. Bus bookings get their own
**`BookingSale`** (money) and **`BoardingScan`** (scans) collections — physically separate
from event data — but the **payment processing** (MoMo/Peach/cash/Keshless charge flows,
service-fee math) is reused from Carrot's existing, record-agnostic processor layer. A `Trip`
is the sellable inventory (buses' answer to `Event`); a `Booking` is a sold seat.

**Why dedicated over overloading `TicketSale`/`TicketScan`:** keeps the live event models and
their queries physically untouched (zero risk to the running events business) and gives buses
clean per-vertical schema + indexes. **Accepted cost:** two reporting/payout paths, and the
webhook must resolve which sale collection owns an incoming payment reference (see §5.8).

**Why Approach A over the alternatives (recorded for posterity):**
- **B — Trip *is* an Event / Booking *is* a Ticket (discriminator):** maximum reuse, but
  contorts the live `Event` model and forces every existing event query to become
  trip-aware — unacceptable risk to the running events business.
- **C — full standalone port (own payment gateway code too):** duplicates the MTN/Peach
  processor layer that already works; contradicts "native in Carrot."

The DRY win is the **payment processor layer** (`services/payments/*`) and the **POS shell**,
not the sale/scan *storage* (which the user chose to keep separate) and not the domain models
(routes/seats are genuinely new concepts).

---

## 3. Travels → Carrot mapping

| Keshless Travels (Postgres/Prisma) | Carrot (Mongo) | Convert how |
|---|---|---|
| `ShuttleOperator` (owner, auth, bank, `accruedRevenue`) | **`Vendor`** (existing) | **Reuse.** Add `businessType: 'transport'`. Bank/payout covered by `OrganizerPayout`. |
| `OperatorUser` (ADMIN/DISPATCHER/DRIVER/CONDUCTOR/STAFF) | **`VendorSubUser`** (dashboard staff) + **`ResellerOperator`** (POS conductors) | **Reuse both.** |
| `VehicleType` (`totalSeats`, `seatNumberingScheme`, `layoutJson`) | **`VehicleType`** | **New** collection (port). |
| `Route` (origin, destination, stops, `farePerSeat`) | **`Route`** | **New** (port). |
| `Trip` (route, vehicle, `departureTime`, capacity, status) | **`Trip`** | **New** — the sellable inventory. |
| `Seat` (`seatNumber`, `isBooked`, `isReserved`) | **`Seat`** | **New** (port). All 3 schemes. |
| `Booking` (passenger, fare, fee, `qrCode`, status, `boardedAt`) | **`Booking`** | **New** (port). |
| *(Travels charged the Keshless wallet directly; no separate sale record)* | **`BookingSale`** (money record) | **New** — mirrors `TicketSale`'s shape (method, amount, fees, `momoReferenceId`/`peachPaymentId`, status) but for bookings. Reuses the payment **processor** layer, not the `TicketSale` collection. |
| `BookingGroup` (return tickets) | `BookingGroup` | **New, deferred to Phase 4.** |
| `BoardingScan` (SUCCESS/ALREADY_BOARDED/WRONG_TRIP/…) | **`BoardingScan`** | **New** — direct port of Travels' model. Not overloaded onto `TicketScan`. |
| `OperatorWithdrawal` | **`OrganizerPayout`** (existing) | **Reuse.** |
| `OtpToken` | existing operator-auth OTP | **Reuse.** |

---

## 4. Phase breakdown

Multi-subsystem feature → decomposed into independent sub-projects, each with its own
spec → plan → build cycle. Dependency chain forces the order (can't sell a trip that
doesn't exist).

| Phase | Scope | Depends on |
|---|---|---|
| **1. Transport API domain + payment/scan wiring** ← *this spec* | New models (VehicleType, Route, Trip, Seat, Booking, BookingSale, BoardingScan); services (availability, atomic seat-claim, sell→BookingSale→pay→confirm via reused processors, booking-flavored finalizers, boarding-scan); vendor CRUD + POS endpoints; `Vendor.businessType` touch; webhook finalize dispatch. | — |
| **2. POS "Buses" flow** (Flutter) | New mode in `pos-app`: route → trip → seat/capacity → passenger → pay (cash/MoMo/Peach) → **print** (reuse ZCS pipeline); + boarding-scan mode. | Phase 1 |
| **3. Vendor dashboard transport UI** (React) | Port Travels' operator pages, Carrot-styled: vehicle types, routes, schedule trips, seat reservations, bookings, boarding board, reports. | Phase 1 |
| **4. Consumer + extras** (deferred) | Online self-service booking on carrottickets.com; **return tickets** (BookingGroup); SMS trip reminders; driver/conductor role scoping; per-seat pricing. | Phases 1–3 |

During Phases 1–2, trips are created via the Phase-1 API (curl/seed) so the POS slice is
testable before the dashboard (Phase 3) exists. **Phases 1 + 2 = a working "create a trip,
sell + print + board it on the handheld" slice.**

---

## 5. Phase 1 — detailed design

### 5.1 New Mongoose models (`api/src/models/transport/`)

All use Mongo `ObjectId`s (Travels' `cuid` string PKs are dropped). Each carries an
app-facing short code where Travels had a `*Ref`/`qrCode`.

**`VehicleType`** — `vendorId` (→ Vendor, indexed), `name`, `totalSeats`, `seatScheme`
`'SEQUENTIAL' | 'ROW_LETTER' | 'PASSENGER_COUNT'` (default `SEQUENTIAL`), `layoutJson?`
(ROW_LETTER geometry), `registrations: string[]`, `isActive`. Unique `(vendorId, name)`.

**`Route`** — `vendorId` (indexed), `name`, `originCity`, `destinationCity`, `stops?`,
`farePerSeat`, `isActive`. Indexes `(vendorId, isActive)`, `(originCity, destinationCity)`.

**`Trip`** — the sellable inventory. `vendorId`, `routeId`, `vehicleTypeId`, `departureTime`,
`arrivalTime?`, `vehicleReg?`, `totalSeats`, `reservedCount` (0), `status`
`'SCHEDULED' | 'BOARDING' | 'DEPARTED' | 'COMPLETED' | 'CANCELLED'` (default `SCHEDULED`),
`reminderSentAt?`. Indexes `(routeId, departureTime)`, `(vendorId, departureTime)`,
`(status, departureTime)`.

**`Seat`** — only for seat-mapped schemes (`SEQUENTIAL`, `ROW_LETTER`). `PASSENGER_COUNT`
trips have **no** Seat rows; availability = `totalSeats − confirmedBookingCount − reservedCount`.
`tripId`, `seatNumber`, `isBooked` (false), `bookingId?` (unique sparse), `isReserved`
(false), `reservedNote?`, `reservedBy?`, `reservedAt?`. Unique `(tripId, seatNumber)`;
indexes `(tripId, isBooked)`, `(tripId, isReserved)`.

**`Booking`** — a sold seat. `bookingRef` (unique short code), `tripId`, `vendorId`,
`passengerName`, `passengerPhone`, `seatNumber?` (null for PASSENGER_COUNT), `fareAmount`,
`platformFee`, `totalAmount`, `saleId` (→ BookingSale), `qrCode` (unique), `status`
`'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'REFUNDED' | 'BOARDED' | 'NO_SHOW'` (default
`PENDING`), `boardedAt?`, `boardedBy?`, `purchasedBy?` (→ buyer/User, sparse). Indexes
`(tripId, status)`, `(vendorId, createdAt)`, `(status, createdAt)`. `qrCode`/`bookingRef`
via the existing generate-and-check short-code pattern (mirror `ticketCode.util`).

**`BookingSale`** — the money record (mirrors `TicketSale`, dedicated to bus bookings).
`saleRef`, `tripId`, `vendorId`, `bookingIds: [→ Booking]`, `quantity`, `customerName?`,
`customerPhone?`, `customerUserId?`, `totalAmount`, `paymentMethod`, `paymentStatus`
(PENDING/COMPLETED/FAILED…, same enum values as TicketSale), `walletTransactionId?`,
`momoReferenceId?` (indexed), `momoFailureReason?`, `peachPaymentId?` (indexed), `soldBy` +
`soldByType` (ResellerOperator/Vendor/VendorSubUser), `salesChannel`. Indexes on
`momoReferenceId`, `peachPaymentId`, `(vendorId, createdAt)`, `(tripId)`.

**`BoardingScan`** — direct port of Travels' model. `bookingId` (→ Booking), `tripId`,
`vendorId`, `scannedBy` + `scannedByType`, `result`
`'SUCCESS' | 'ALREADY_BOARDED' | 'INVALID' | 'WRONG_TRIP' | 'CANCELLED_BOOKING'`, `notes?`,
`scannedAt`. Indexes `(bookingId, scannedAt)`, `(tripId, scannedAt)`, `(scannedBy, scannedAt)`.

### 5.2 Touch to live models

- **`Vendor.businessType`** enum += `'transport'`. **That is the only change to an existing
  model.** `TicketSale`, `TicketScan`, `Ticket`, and `Event` are left **entirely untouched** —
  the whole point of the dedicated-collections decision. No old rows change, no event query
  becomes bus-aware.

### 5.3 Services (`api/src/services/transport/`)

- **`vehicleType.service`** — vendor-scoped CRUD.
- **`route.service`** — vendor-scoped CRUD.
- **`trip.service`**
  - `create` — generate `Seat` rows per the vehicle's scheme (`SEQUENTIAL` → `1..N`;
    `ROW_LETTER` → from `layoutJson`; `PASSENGER_COUNT` → none). Optional
    `reservedSeatNumbers[]` / `reservedCount` at creation (Travels manual reservation).
  - `listForVendor`, `listSellable` (POS: SCHEDULED/BOARDING, not departed), `get`
    (seat map + computed availability), `updateStatus`, `reserveSeat` / `releaseSeat`,
    `setReservedCount` (PASSENGER_COUNT).
- **`booking.service`** — the core:
  - `sellSeat({ tripId, seatNumber?, passenger, paymentMethod, soldBy })`:
    1. Load trip; reject if not SCHEDULED/BOARDING or already departed (`422`).
    2. **Claim capacity atomically** (§5.5). Seat-mapped: conditional `Seat.findOneAndUpdate`.
       PASSENGER_COUNT: capacity-guarded atomic op. No match → `409 Seat unavailable`.
    3. Create `Booking(PENDING)`; compute `fareAmount = route.farePerSeat`, `platformFee` +
       `totalAmount` from the **existing service-fee logic** (`saleEconomics.service` /
       `PaymentMethodConfig`, same as event tickets).
    4. Create a `BookingSale(PENDING)` and drive the charge through the **reused payment
       processor layer** (`services/payments/*` — cash/MoMo/Peach/Keshless), storing
       `momoReferenceId`/`peachPaymentId` on the BookingSale exactly as the ticket path does
       on TicketSale.
    5. Sync methods (cash/wallet) → confirm inline. Async methods (MoMo/Peach) → left PENDING
       until the webhook/poll finalizer runs (§5.4/§5.8).
    6. On confirm → Booking `CONFIRMED` + `qrCode`; accrue vendor payout via `OrganizerPayout`.
       On failure → **release the seat + cancel the booking + fail the sale** and surface the
       error loudly (no silent fallback, per repo rule).
  - `finalizeMomoBooking(referenceId)` / `finalizeCardBooking(paymentId)` /
    `reconcilePendingCardBookings()` — **booking-flavored twins of `ticket.service`'s
    finalizers**: look up the `BookingSale` by reference, verify gateway status + amount,
    idempotent claim, then confirm the Booking(s) + accrue payout (success) or release
    seat + fail (rejection). Same idempotency/claim discipline as the ticket finalizers.
  - `cancel` / `refund` (releases seat, updates payout ledger).
  - `board({ qrCode | bookingRef, scannedBy, tripId })` — validate booking ↔ trip, not
    already boarded, not cancelled → set `BOARDED` + write a `BoardingScan` with `result` ∈
    `SUCCESS | ALREADY_BOARDED | WRONG_TRIP | CANCELLED_BOOKING | INVALID`.

The `services/payments/*` processor layer and `saleEconomics.service` fee math are reused
**as-is**; only the finalize/confirm layer is booking-specific (it confirms Bookings, not
mints Tickets — which is inherent to having a separate Booking model).

### 5.4 Endpoints

**Vendor / dashboard-facing** (auth = Vendor or VendorSubUser, vendor-scoped):
- `POST|GET|PATCH|DELETE /vendor/transport/vehicle-types` (+ `/:id`)
- `POST|GET|PATCH|DELETE /vendor/transport/routes` (+ `/:id`)
- `POST|GET|PATCH /vendor/transport/trips` (+ `/:id`, `/:id/status`,
  `/:id/seats/:seatNumber/reserve` [POST/DELETE], `/:id/reserved-count` [PATCH])
- `GET /vendor/transport/bookings`

**POS-facing** (auth = ResellerOperator):
- `GET /pos/transport/trips?vendorId=&routeId=&date=` — sellable trips
- `GET /pos/transport/trips/:id` — seat map + availability
- `POST /pos/transport/bookings` — sell a seat (`{ tripId, seatNumber?, passenger, paymentMethod }`)
- `POST /pos/transport/board` — boarding scan by QR

**Payment webhooks/returns:** reuse the existing MoMo/Peach webhook + return routes; extend
their handler to dispatch by sale collection (§5.8). (Public/consumer booking endpoints
deferred to Phase 4.)

### 5.5 Correctness — the crux

The single riskiest path is **seat claim under concurrent conductors**. Travels relies on a
Postgres transaction; the Mongo equivalent needing **no** replica-set transaction is a
**conditional single-document `findOneAndUpdate`**:

- **Seat-mapped:** `Seat.findOneAndUpdate({ tripId, seatNumber, isBooked:false,
  isReserved:false }, { $set:{ isBooked:true, bookingId } }, { new:true })`. A `null` result
  means another sale won the seat → `409`.
- **PASSENGER_COUNT:** atomic guarded increment on the trip's sold counter
  (`Trip.findOneAndUpdate({ _id, $expr:{ $lt:[ { $add:['$soldCount','$reservedCount'] },
  '$totalSeats' ] } }, { $inc:{ soldCount:1 } })`); `null` → `409 Trip full`. (Counter field
  finalized in implementation — a `soldCount` on Trip or a guarded count query.)

**Payment-then-confirm** with rollback mirrors Travels: Booking + BookingSale start `PENDING`,
seat is claimed, the charge runs, and on any failure both the seat and the booking/sale are
released.

### 5.6 Error handling (repo rule: fail loudly, never silent-fallback)

- Seat/capacity conflict → `409`. Trip not sellable (departed/cancelled/completed) → `422`.
- Payment failure → surfaced through the normal payment error channel (same as event sales);
  booking + sale + seat rolled back; no canned "success" response.
- Boarding-scan failures return the specific `result` and are persisted for audit.

### 5.7 Testing (jest, existing harness)

- Double-book race: two concurrent `sellSeat` on the same seat → exactly one CONFIRMED, one `409`.
- PASSENGER_COUNT capacity: N+1th sale on an N-seat trip → `409`.
- Happy path: sell → pay → CONFIRMED, `qrCode` issued, payout accrued, `BookingSale` COMPLETED.
- MoMo/Peach async: sale left PENDING on create; `finalizeMomoBooking`/`finalizeCardBooking`
  confirms on success and rolls back seat on rejection; idempotent under double-callback.
- Payment failure → seat released, booking CANCELLED, error surfaced.
- Boarding scan matrix → `result`: SUCCESS / ALREADY_BOARDED / WRONG_TRIP / CANCELLED_BOOKING / INVALID.
- Reserved seat cannot be sold online; release re-opens it.

### 5.8 Payment webhook finalize dispatch (the one new seam)

MoMo/Peach return a payment **reference** with no hint of which collection owns it. Today the
webhook handlers call `ticket.service.finalizeMomoSale` / `finalizeCardSale`, which look up a
`TicketSale`. With a dedicated `BookingSale`, the handler must resolve ownership:

- **Chosen approach:** in the existing MoMo/Peach webhook + poll handlers, first attempt the
  ticket finalizer; if it reports "no sale for this reference", attempt the booking finalizer
  (`finalizeMomoBooking` / `finalizeCardBooking`). Both are idempotent, so ordering is safe.
- Equivalent alternative (implementation's choice): a thin `momoReferenceId`/`peachPaymentId`
  lookup across both collections that dispatches to the right finalizer. Either keeps the two
  verticals' finalize logic separate while sharing one webhook entry point.
- The `reconcilePendingCardSales` sweep gets a `reconcilePendingCardBookings` twin; both run
  on the same cron/task cadence.

---

## 6. Non-goals (Phase 1)

- Online self-service consumer booking (Phase 4).
- Return tickets / `BookingGroup` (Phase 4) — `BookingSale` is modeled with a `bookingIds[]`
  array now so a future return ticket is one sale over two bookings without a schema change.
- Dashboard UI (Phase 3) and POS Flutter UI (Phase 2) — Phase 1 is API only.
- Driver/conductor per-trip assignment scoping (all operator trips visible in v1).
- SMS trip reminders (`reminderSentAt` added but not yet driven).
- Per-seat pricing overrides.

## 7. Open items to confirm at implementation time

- Exact money unit (cents/minor units vs whole Emalangeni) — match whatever `Event`/`Ticket`
  price fields already use.
- Whether the PASSENGER_COUNT capacity guard uses a `soldCount` field on `Trip` or a guarded
  count query.
- Whether bus tickets appear in the buyer-facing "My Tickets" list in Phase 1 (depends on
  whether Phase 1 sets `purchasedBy`) or waits for Phase 4.
- Whether payouts must aggregate `BookingSale` immediately (extend the `OrganizerPayout`
  close/aggregation to UNION event + booking sales) or bus payout reporting can lag to a
  follow-up — the accepted "two payout paths" cost of dedicated collections.
