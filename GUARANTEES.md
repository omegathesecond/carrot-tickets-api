# Guarantee request tracking

Guarantees are records only. No guarantee endpoint invokes a payment, ledger,
wallet, reservation, payout, or transfer operation. Marking Paid records an
admin's action after the existing external approval/payment process.

- Organizers: Event → Guarantee, beside Financials. Create or edit requests up
  to `EventFinancialsService.getEventFinancials().custody.availableNow`, the
  same available ticket-sales balance Financials displays. Balance failures
  block submission; payout-specific eligibility rules are not applied.
- Providers: dashboard home and Guarantees navigation show addressed requests.
  The website enables its existing Switch to dashboard affordance for services
  accounts. Providers accept/reject with an optional note.
- Admins: Payouts → Guarantee requests — admin review. Only provider-accepted
  requests enter this queue. Admins mark Pending, Paid or Rejected with a note.
- Requested → Accepted / Provider rejected / Withdrawn. Accepted and Pending
  permit admin Pending / Paid / Rejected. Paid, Rejected, Provider rejected and
  Withdrawn are terminal. Edits/uploads stop after the first provider response.
- Agreements: PDF up to 5 MB, stored privately in the request document and
  excluded from JSON lists. Download requires the owner, current selected
  provider or a live-authorized Carrot super-admin. Changing provider removes
  the prior agreement and revokes that provider's request access.
- Every edit, upload and status action appends timestamped actor/note history.
  Request changes and both vendor inbox notifications commit in one MongoDB
  transaction. Optimistic concurrency rejects competing stale changes.

Routes are mounted at `/api/guarantees`. They reuse existing tickets session,
owner and super-admin middleware. No new environment variables or external
storage configuration are needed; MongoDB transaction support is required,
matching the existing payout workflow.

Verify with `npm run build` and
`npm test -- --runInBand src/routes/__tests__/guarantee.route.test.ts src/routes/__tests__/eventPayout.route.test.ts`.
The dashboard and website changes must be released with the API changes.
