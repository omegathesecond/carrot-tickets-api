# Event cashless fees

Event cashless settings configure `purchaseCharge` and `withdrawalFee` independently. Each accepts null (off), `{type: "fixed", value: cents}`, `{type: "percentage", value: percent}`, or `{type: "tiered", tiers: [{min, max, fee}]}`. Tier amounts and fees use integer cents. A tier includes min and excludes max; tiers start at zero, join exactly and end at max:null. Zero-fee tiers are allowed. At most 50 tiers are accepted. The matching fee applies once to the complete purchase or withdrawal, not progressively to slices. Existing purchase quote, table settlement and reversal paths use the same calculator.

Purchase charges increase the customer total. Withdrawal fees reduce the payout and are owed to the organizer, for cashier cash-outs, office refunds and post-event tag requests. WalletWithdrawal.amount is the wallet debit; feeAmount is retained; payoutAmount is paid to the attendee. Ledger legs are WALLET +amount, FLOAT -payoutAmount, ORGANIZER -feeAmount. Cash desk cash-on-hand deducts only payoutAmount. Cashier totals report cash paid; event withdrawn reports wallet debits, with withdrawalPayouts and withdrawalFees separately.

Cashier and office-refund POST routes accept `{amount, quoteOnly:true}` to obtain a quote without changing money. Submissions require quotedPayoutAmount as well as the existing idempotency key. Tag lookup includes feeAmount and payoutAmount, and submissions require expectedPayoutAmount. Changed quotes fail with 409. Pending tag requests snapshot fees; later changes never reprice them. The fee must be less than the withdrawn amount. Retries preserve the original payout.

## Coordinated release

Before deploying these changes, run `src/scripts/migrate-withdrawal-fees.ts` through ts-node with the target database configured by MONGODB_URI. It fills historical zero-fee WalletWithdrawal and TagWithdrawalRequest rows with feeAmount:0 and payoutAmount:amount, without moving funds or writing ledger entries. Review the modified counts and repeat for each environment being released. This is an explicit data migration, not a runtime fallback. Existing pending requests keep their originally promised payout.

Release the API, dashboard, attendee website and POS together: withdrawal submissions now require an accepted payout quote. Older POS builds cannot submit the new contract. Build and deliver the updated POS APK only with the user's authorization. Do not enable withdrawal fees on a live event until the updated clients are in use. The local tests use synthetic records and do not send payouts, SMS or gateway charges.
