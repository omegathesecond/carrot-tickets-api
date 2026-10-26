# Cashless purchase charges

Organizers configure the charge in **Event → Settings → Cashless → Charge per purchase**. Choose no charge, a fixed amount in the event currency, or a percentage. Save changes with **Save purchase charge**. The setting is available on cashless events and uses the existing event edit permission and ownership checks.

API settings use `purchaseCharge: null` to disable, `{type: "fixed", value: 250}` for 2.50 in integer cents, or `{type: "percentage", value: 5}` for 5%. Percentages accept up to two decimal places and round half up to the nearest cent. The charge applies once per payment, including a whole table bill covering multiple stalls. The surcharge belongs to the organizer and does not reduce stall earnings or change Carrot's commission.

The POS requests a server quote and shows the surcharge and total before the customer taps. Payment requests must include the reviewed `quotedTotal`. A changed total returns 409 without taking money. Quote failures surface as errors and prevent payment. Charge retries replay the original amount even after the organizer changes the setting.

The ledger records organizer revenue separately in its event-scoped `organizer` account. Event totals, transaction details, wallet history and POS confirmations show the surcharge. Stall gross sales and stock reports exclude it. Organizer payouts are not added by this change; the new account records the amount owed.

## Coordinated release

These changes are local on `feat/cashless-purchase-charges` in the API, dashboard and POS worktrees. No environment has been deployed or migrated.

1. Initialize existing events and charge records by running `npm run migrate:purchase-charges` with the target environment's explicit `MONGODB_URI`. This is idempotent; it sets missing event settings to null and missing charge amounts to zero. The current checked-in cashless models use Mongoose; this script follows that implementation and must not be pointed at a Postgres URL.
2. Release the updated API, dashboard and POS together. The API requires `quotedTotal` on till and table payments; old POS payment requests are rejected. There is no compatibility path.
3. Verify organizer save/reload and one purchase on the target environment. POS app launch and APK build require the user's explicit request.

Validation: API and dashboard production builds, purchase-setting UI tests, till and table payment tests, accounting/reconciliation and stock reporting regressions, POS quote confirmation/shortfall widget tests, and static Dart analysis. The tests use temporary local databases only.
