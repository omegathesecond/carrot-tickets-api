# Buyer-paid service fees (per online payment method) — design

Date: 2026-07-03

Buyers pay a **FLAT service fee (in E) on top of the ticket price**, varying
**per online payment method**, set **globally by super-admin**. Online checkout
only — POS / box-office / reseller sales stay at face value.

> **Revised to flat amounts** (was percentage): launch values MoMo **E5**, Card
> **E10** (card configured but not yet enabled), Keshless **E0**. Seeded as
> `PaymentConfigService` defaults so they're live on deploy; overridable in
> dashboard Settings (an explicit saved value, incl. 0, always wins). Config
> fields: `keshlessServiceFee`, `momoServiceFee`, `cardServiceFee`.

Distinct from the existing `platformFeePercent`, which is a payout DEDUCTION
(organizer absorbs). This new fee is buyer-paid, added on top, and is platform
income.

## 1. Config — extend `PaymentMethodConfig` (`api`)
Add three percent fields, default `0` (no behaviour change until set):
`keshlessServiceFeePercent`, `momoServiceFeePercent`, `cardServiceFeePercent`.
Surface + persist through `PaymentConfigService.get()/update()` and the
super-admin `SettingsController.getPaymentMethods/updatePaymentMethods`.

## 2. Fee math (server = source of truth)
Helper (e.g. `serviceFee.util.ts`):
```
round2(x) = Math.round(x * 100) / 100
serviceFee(method, subtotal, cfg) = round2(subtotal * pct(method) / 100)
```
`subtotal = ticketPrice * quantity`; `amountCharged = subtotal + serviceFee`.
pct map: keshless_wallet→keshlessServiceFeePercent, mtn_momo→momoServiceFeePercent,
card→cardServiceFeePercent. Same rounding client + server.

## 3. Charge amountCharged in the 3 online paths (`ticket.service.ts`)
Keshless wallet purchase, MoMo initiate, Card initiate: charge the gateway
`amountCharged` instead of face `totalAmount`. Keep the Keshless PIN threshold
(`>= 50`) on the **face** subtotal.

## 4. `TicketSale` record
Keep `totalAmount` = **face value** (payouts + revenue analytics unchanged).
Add `serviceFeePercent`, `serviceFeeAmount`, `amountCharged` (= totalAmount +
serviceFeeAmount).

## 5. Callback guards (CRITICAL)
MoMo + card confirmation callbacks currently assert `confirmedAmount ===
sale.totalAmount`. Change to compare against `sale.amountCharged` (fall back to
`totalAmount` when `amountCharged` is absent, for pre-existing sales) — otherwise
every fee-bearing payment is wrongly rejected as an amount mismatch.

## 6. Checkout display (landing `PurchaseModal`)
`getPaymentMethods` also returns `{ serviceFees: { keshless_wallet, mtn_momo,
card } }` (percents). Modal shows Subtotal / Service fee (method, %) / Total,
updating on method switch; the Pay button shows the total. Event detail page keeps
showing face price + a small "+ payment fee at checkout" hint (method unknown
until the modal).

## 7. Admin UI (dashboard Settings)
A "% service fee" input beside each online method (Keshless, MoMo, Card).
Reuses the existing payment-config get/update flow + types.

## Non-goals / untouched
POS app, reseller/box-office sales (face value, no fee). `platformFeePercent`
stays as-is. No per-event overrides. No backward-compat shims; no silent
fallbacks — surface config/charge failures normally.
