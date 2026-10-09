# Vendor balance checks and sale reversals

In the POS **Charge** tab, **Check balance** starts a band scan and shows the event-scoped balance. It does not quote or debit a payment, change the basket, or expose the customer's details and purchase history.

In **Takings**, eligible direct till purchases have **Reverse sale**. The vendor enters a reason and their own six-digit PIN, chooses whether all itemised goods return to stock, then scans the same band used for the sale. This cancels the full payment, including the original organiser charge. A corrected purchase is a new sale. The receipt prominently shows the remaining balance, with the returned amount below it. Takings and the selling screen's stock count refresh after success.

The API requires an active operator at the owning stall and reuses the existing PIN lockout. It restores the original cash-funded debit portion alongside the wallet balance, posts opposite merchant/fee/organiser ledger entries, and optionally returns stock within one database transaction. It preserves the original charge and records the operator, reason, timestamp, stock decision and reversal ledger reference. Retries with the same operator, reason and stock decision return the existing reversal; competing requests cannot refund twice. A cancelled sale cannot be replayed as a successful new charge.

Organiser charge totals, vendor earnings and financial stock reports exclude reversed payments. Tag history retains the purchase and adds a separate refund. The dashboard transaction log shows the reversal's actor, reason, time and stock decision.

## Limits

- Only direct till purchases recorded by this API release contain the exact funding split required for a reversal. Older transactions remain visible but cannot be reversed; the API never guesses their cash/card split.
- Table payments span multiple stall legs and cannot be reversed individually. Whole-table reversals are outside this release.
- The original band must still be active and attached to the original wallet. A replacement band cannot authorize this workflow.
- This is a full cancellation, not a partial refund or cash payout.

## Release order

Release the API before distributing the updated POS. The new POS requires reversal eligibility in transaction responses and the balance/reversal routes; it has no compatibility adapter. No historical funding backfill or new environment variables are required. Dashboard changes add reversal audit presentation. APK builds and app launches require an explicit user request.

Implementation and automated checks are local on `feat/vendor-reversal-and-balance`; production deployment and a real band tap have not been verified for these features.
