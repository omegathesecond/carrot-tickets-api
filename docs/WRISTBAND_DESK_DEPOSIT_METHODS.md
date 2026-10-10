# Wristband deposits recorded at a desk

DeltaPay and Mobile Money deposits record payments **already completed on a separate device**. The POS does not initiate or verify provider payments. Staff must confirm the receipt before tapping the band to credit it. These methods are independent of online ticket checkout configuration and credentials.

## Deposit contract

Keep `POST /api/cashier/topup` and `POST /api/reseller/wallets/topup`, their existing request fields, integer-cent amounts, and success/error responses. Existing `method: "cash"` and `method: "card"` requests are unchanged. The accepted methods now also include `"deltapay"` and `"mobile_money"`; no new required fields are introduced.

Cashier deposits require the corresponding current grant, checked on every request:

| Method | Admin grant | Cashier permission | Float location |
| --- | --- | --- | --- |
| Cash | `topup_cash` | `cashier:cash_topup` | `cash_desk` |
| Card / POS | `topup_card` | `cashier:card_topup` | `card_desk` |
| DeltaPay | `topup_deltapay` | `cashier:deltapay_topup` | `deltapay_desk` |
| Mobile Money | `topup_mobile_money` | `cashier:mobile_money_topup` | `mobile_money_desk` |

Existing grants do not authorize either new method. Retry safety remains scoped to wallet plus `clientTxnId`; changing amount, event or method on a replay returns 409 without another credit. Only cash deposits increase cash-funded balance and cashier cash-to-collect. External receipts are neither cash nor card in the ledger or reports.

## Released APK compatibility

POS v1.8.3 understands only cash/card deposit labels in its own transaction history. It rejects unfamiliar labels, so merely extending the old endpoint would break a history screen even though deposits still succeed.

As approved, `GET /api/cashier/transactions` continues to return cash/card deposits and withdrawals, with its summary calculated from that same supported scope. The method filter runs before the history limit: newer external receipts cannot displace older cash/card rows. The endpoint must not reclassify external receipts as cash/card.

The updated POS uses **`GET /api/cashier/transactions/all-methods`** for all four methods. Both endpoints share the same service, authentication, cashier isolation, event filter and pagination. The dashboard uses the complete service/report view. Actual wallet balances include every completed deposit, including when read by an older POS.

Existing report fields `cashTopups` and `cardTopups` retain their meaning. Additive fields `deltapayTopups` and `mobileMoneyTopups` expose external receipt totals per cashier and event, including cash control. `cashOnHand` remains cash deposits minus cash withdrawals and confirmed cash handovers. Older POS cash-control screens ignore the new fields and still receive the correct cash amount.

## Rollout

1. Deploy the API supporting the extended methods, grants, float tags, report fields and new history endpoint.
2. Deploy the dashboard before granting new-method access so its logs can label the new receipts.
3. Build and distribute an updated signed POS only after an explicit APK build request. Its parsers require the API's new report fields and history endpoint; do not release it ahead of the API.
4. Admins enable each assigned method under Event → Cashless → Cashiers → cashier profile. No existing grants are automatically broadened.
5. Install the updated app at desks recording DeltaPay/Mobile Money. The shipped app can continue cash/card work; it cannot select the new methods and its own history remains cash/card-only.

Desk mode remains selected between customers. Changing mode requires a separate action and confirmation; no method changes are permitted while a payment is processing or its response is uncertain.
