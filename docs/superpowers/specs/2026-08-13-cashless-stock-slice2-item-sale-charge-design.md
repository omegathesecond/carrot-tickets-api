# Cashless Stock — Slice 2: Item-Sale Charge (Design)

**Date:** 2026-08-13
**Status:** Design — awaiting review
**Branch (base):** `feat/cashless-stock-sale` off `feat/cashless-cashier` @105d3dc (Slice 1 merged), worktree per repo. Merge onto the cashless line, not `main`.
**Repos:** `api` only (this slice is backend). POS UI is Slice 5; dashboard reporting is Slice 4.
**Builds on:** `2026-08-12-cashless-stock-management-design.md` (parent design, §3 approach A + §6.1 the sale flow) and Slice 1 (catalogue + `StockService.applyMovement`, merged @105d3dc).

---

## 1. Why / scope

Slice 1 built the stock ledger and the sole-writer `StockService.applyMovement` (atomic CAS, hard-block-at-zero, caller-session join). Slice 2 makes a **vendor tap sell specific products and deduct their stock in the same atomic breath as the wallet debit** — turning the amount-only `MerchantService.charge` into an itemised sale, without touching the money ledger's shape.

In scope (api only):
1. `MerchantCharge` gains `items[]` + `staffName?` (additive).
2. `MerchantService.charge` accepts `items` (server-priced) and decrements per-product stock inside its existing transaction; an out-of-stock line hard-blocks the whole tap (rolls back the wallet debit).
3. The `POST /api/merchant/charge` validator/controller accept the itemised body and map an out-of-stock decline to a distinct HTTP status.
4. The amount-only path is preserved (decision #5, already approved), recorded un-itemised.

Out of scope: POS product-picker/basket UI (Slice 5), stock reporting / un-itemised revenue split (Slice 4), transfers/counts/alerts (Slice 3).

## 2. Locked decisions (from the approved parent design + tactical)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Basket atomicity | **All-or-nothing.** A basket is one tap in one transaction: if ANY line is out of stock, the whole tap declines (names the offending product), nothing is committed — no partial charge, no partial decrement. |
| 2 | Pricing authority | **Server-authoritative.** With `items`, the server looks up each product's catalogue `price` (this event) and computes `amount = Σ price×qty`. A client-supplied `amount` is never trusted for an itemised sale (the validator forbids sending both). |
| 3 | Amount-only path | **Kept (approved decision #5).** The charge still accepts `{ bandUid, amount, clientTxnId }` with no items — no stock touched, no `items` stored (reads as un-itemised). The validator requires **exactly one** of `amount` or `items`. |
| 4 | `staffName` | **Accepted + stored in Slice 2** (backend-ready) on both itemised and amount-only charges; the POS captures it in Slice 5. Optional, free-text, length-capped. |
| 5 | Ordering / atomicity | Stock decrement happens **inside the existing `withTransaction`, after the wallet CAS debit and before the ledger post**; a `StockDeclinedError` aborts the transaction, so the wallet debit is rolled back and money never commits without stock (the reviewer's Slice-2 requirement). |
| 6 | Fee / money ledger | **Unchanged.** Fee = `floor(amount × commissionPercent / 100)` on the total `amount` (= Σ lineTotal); the three ledger legs (`wallet +amount`, `merchant −net`, `fees −fee`) are identical to today. `MerchantCharge.amount` stays the ledger-authoritative total. |
| 7 | Duplicate lines | The service **merges duplicate `productId`s** (sums qty) before pricing/decrementing, so `items[]` holds one row per product and stock is decremented once per product. |

Currency/units unchanged: money integer ZAR cents, stock integer base units.

## 3. The extended charge flow

Endpoint unchanged: `POST /api/merchant/charge` (merchant JWT; `merchantId`/`eventId` from the token, never the body).

`MerchantService.charge` extended params: `{ merchantId, eventId, walletId, bandUid, clientTxnId, amount?, items?, staffName? }` — `amount` XOR `items` (controller/validator enforce; the service also asserts). Flow (one `session.withTransaction`, idempotent on `{merchantId, clientTxnId}` exactly as today):

```
0. Idempotency pre-check {merchantId, clientTxnId} → return stored charge (now incl. items) on replay.  [unchanged]
1. If items: merge duplicate productIds; load Products by id (eventId === this event, active);
     any missing/foreign/inactive → throw (400-class error, nothing written);
     compute lineTotal = price × qty, amount = Σ lineTotal; assert amount ≤ MAX_CHARGE_CENTS.
   Else (amount-only): amount = params.amount (validated), items = undefined.   [today's behavior]
2. session.withTransaction:
   a. Merchant active check.                                            [unchanged]
   b. Wallet CAS debit { balance ≥ amount } → null ⇒ WalletDeclinedError (402).   [unchanged]
   c. If items: for each merged line →
        StockService.applyMovement({ eventId, merchantId, productId, delta: -qty,
          reason: 'sale', refType: 'merchant_charge', refId: clientTxnId,
          byType: 'Merchant', by: merchantId, session })
        → throws StockDeclinedError on insufficient stock ⇒ transaction ABORTS ⇒
          wallet debit (b) rolls back ⇒ error propagates.  [NEW — the hard block]
   d. LedgerService.post(wallet +amount, merchant −net, fees −fee).     [unchanged]
   e. MerchantCharge.create({ …, amount, fee, netAmount, items?, staffName? }).  [+items/+staffName]
3. E11000 on {merchantId, clientTxnId} → re-read winner (concurrent duplicate).  [unchanged]
```

Because (b)→(e) are one transaction, an out-of-stock line at (c) rolls back the wallet debit at (b): the attendee is never charged for a tap that didn't fully land. `StockDeclinedError` must **propagate** out of `charge` (it is not the E11000 case and must not be swallowed).

The `items[]` snapshot stored on the charge: `[{ productId, name, unitPrice, qty, lineTotal }]` — `name`/`unitPrice` are captured at sale time so a later catalogue edit can't rewrite history (mirrors the economic-snapshot-per-row convention the codebase already uses on `MerchantCharge`/`TicketSale`).

## 4. Data model change — `MerchantCharge` (additive)

```
IMerchantCharge += {
  items?: [{ productId: ObjectId, name: string, unitPrice: number (cents), qty: number (int ≥1), lineTotal: number (cents) }]
  staffName?: string
}
```
Both optional; existing amount-only rows remain valid and read as un-itemised (no backfill — called out per the no-silent-back-compat rule). `amount` stays required and stays `= Σ lineTotal` for itemised sales. No index change.

## 5. Validator change — `chargeSchema`

`amount` becomes optional; add `items` and `staffName`; require exactly one of `amount`/`items`:
```
chargeSchema = Joi.object({
  bandUid: uid.required(),
  clientTxnId: Joi.string().trim().required(),
  staffName: Joi.string().trim().max(80).optional(),
  amount: Joi.number().integer().min(1).max(MAX_CHARGE_CENTS),                    // existing amount-only path
  items: Joi.array().items(Joi.object({
    productId: Joi.string().trim().required(),
    qty: Joi.number().integer().min(1).max(MAX_QTY_PER_LINE).required(),
  })).min(1).max(MAX_LINES),                                                      // NEW itemised path
}).xor('amount', 'items');
```
`MAX_LINES` (e.g. 50) and `MAX_QTY_PER_LINE` (e.g. 1000) are defense-in-depth caps so a basket can't be pathologically large or overflow the `amount` ceiling.

## 6. Controller change — decline mapping

`MerchantController.charge` validates the extended schema, passes `items`/`staffName` through, and adds one decline mapping:
- `WalletDeclinedError` → **402** `{ reason, currentBalance }` (unchanged).
- `StockDeclinedError` → **409** `{ reason: 'insufficient_stock', productId, available }` (NEW — so the POS shows "SOLD OUT: <product>" distinctly from an insufficient-balance 402).
- product-resolution errors (unknown/foreign/inactive product, empty/oversized basket) → 400.

Success response includes the itemised breakdown when present: `{ newBalance, amount, fee, merchantNet, items? }`.

## 7. Concurrency & atomicity

- The transaction now spans **wallet (1 doc) + N ProductStock docs + ledger + charge**. The wallet is low-contention (one band taps serially); a **hot product's `ProductStock` is the new contention point** (every sale of the popular beer touches the same doc). Concurrent sales of the same product conflict at the storage layer → `WriteConflict` (a `TransientTransactionError`), which `session.withTransaction` **retries automatically**. Correctness is preserved (the single-doc CAS still guarantees no oversell); throughput on a single hot product is bounded by serialized commits, which is acceptable for event-bar volumes.
- Stock decrement MUST be inside the transaction (not before it): decrementing outside and then failing the wallet debit would leak stock (sold-but-not-paid). Approach A (both in one transaction) is the only correct shape.

## 8. Testing (TDD; existing Jest + `connectLedgerTestDb`; adversarial money+stock paths)

1. **Itemised happy path:** basket (2×beer @2500 + 1×water @1500) → `amount` 6500, wallet debited once, `ProductStock.onHand` down by 2 and 1, `MerchantCharge.items` snapshot correct, ledger legs balanced.
2. **Out-of-stock hard block (full rollback):** basket with one line exceeding stock → 409/`StockDeclinedError(productId, available)`; wallet balance UNCHANGED, NO stock decremented on any line, NO charge row, NO ledger postings.
3. **No-oversell concurrency:** N parallel itemised taps buying the last K of a product (each a funded band) → exactly K succeed; `onHand` → 0; only the K successful wallets are debited.
4. **Idempotent replay:** repeat an itemised charge (same `{merchantId, clientTxnId}`) → stock + money applied exactly once; returns the stored `items`.
5. **Amount-only path preserved:** `{ amount }` charge still succeeds, touches no stock, stores no `items`, reads un-itemised; existing merchantCharge tests stay green.
6. **Server pricing / xor:** sending both `amount` and `items` → 400; `amount` is computed from the catalogue, never from client input; a client under-price attempt has no effect.
7. **Product resolution:** unknown / different-event / inactive product, empty basket, over-cap basket → 400, nothing written.
8. **Ledger invariant:** the §3-money identity still holds after an itemised charge (money ledger unchanged); `staffName` persists on the row.

## 9. Delivery

- Fresh worktree on `feat/cashless-stock-sale` off `feat/cashless-cashier` @105d3dc. Merge onto the cashless line.
- Deploy topology unchanged (`gcloud run deploy carrot-tickets-api --source .`; realtime shares the image).
- **Fail loudly:** an out-of-stock line is a real 409 the POS shows; a product-resolution failure is a real 400; no silent fallback to an amount-only charge when items fail to resolve.
- Run `security-pentest-reviewer` over the extended charge (it now mutates stock as well as money) before go-live.

## 10. Open questions

- **Cash-funded drawdown vs stock:** unchanged — the wallet CAS still draws `cashFundedBalance` first; stock is orthogonal. No interaction.
- **Receive idempotency** (a Slice-1 deferred): out of scope here; Slice 2 only reads stock via the sale path. Flagged in memory for whoever wires the dashboard receive button.
