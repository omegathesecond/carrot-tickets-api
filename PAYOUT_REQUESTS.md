# Event payout requests

Organiser owners can request a payout from **Event → Financials → Event payout** after
`endTime`. The server calculates the full eligible balance, checks the amount
confirmed by the organiser, and reserves the event with a unique partial index
while a request is pending or approved. Other staff cannot access bank details
or submit requests. Admins review requests at **Payouts**.

Confirmed sale snapshots are the source of truth. Reseller allocation-block
resales are excluded because those proceeds belong to the reseller, matching
the existing organiser revenue rules. Payout eligibility subtracts
refunds, recorded fees, already paid amounts and fees owed on organiser-held
sales; unremitted reseller funds and money held by the organiser are excluded.
Refunds currently retain the original sale fees (the existing refund writer does
not reverse fees). The adjustment line reconciles any difference between frozen
organiser proceeds and gross less recorded fees/refunds. No funds are sent by
this flow: an administrator must complete the transfer externally, then attest
to completion and record a date and reference. Balance changes block approval
or payment; decline the request so the organiser can submit the revised amount.
Approved requests can also be declined before payment is recorded.

Bank snapshots and saved bank details use the existing AES-256-GCM encryption
utility and `OPERATOR_PIN_ENCRYPTION_KEY`, with a separate `payout-bank:<vendor>`
authentication context. The existing key must be configured on the runtime;
missing/invalid keys fail requests. No new secret binding is required. Rotation
must preserve or re-encrypt bank records as well as operator PIN records.
All normal responses mask account numbers. Only super-admin request detail
responses contain the full account; responses set `Cache-Control: no-store`.
Saved-bank reads return a version that must match when reused. Changing saved
details never changes a previously submitted request's bank snapshot.

The existing database transaction support is required. A decision and the vendor
inbox notification commit together; notification failure rolls back the decision.
No best-effort notification fallback is used. New model indexes initialise before
submission and failures propagate. No data migration is required for the new
collections.

The old admin period-close route is removed to prevent a second payout workflow
from reserving the same sales. Existing period previews and mark-paid routes
remain available for existing obligations. Any event with sales covered by an
existing period payout is blocked from requesting again and requires manual
reconciliation by Carrot; old records are never silently ignored or converted.

Validation: `npm run build`; `npm test -- --runInBand src/routes/__tests__/eventPayout.route.test.ts`.
