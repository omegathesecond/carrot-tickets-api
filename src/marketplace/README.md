# Marketplace

- Public: `/api/marketplace/options`, `/opportunities`, `/opportunities/:id`.
- Vendor owners: private profiles, default business, compliance documents and applications.
- Organiser owners (current `events` or `both` account; service providers and transport-only accounts cannot manage listings): `/manage/opportunities` and `/manage/applications/:id`.
- Carrot superadmins can review all opportunities and their applications; another organiser cannot.
- Documents live in MongoDB, not the public media bucket. PDF/JPEG/PNG files are limited to 5 MB and served as authenticated attachments with `Cache-Control: private, no-store`. Uploading/replacing/removing a profile document retains historical application versions.
- Opportunities support individual-date applications or regular trading across all listed dates. Capacity is per date, or per regular-trader opportunity. A unique partial index prevents multiple active applications per business/opportunity/scope; declined applications may be resubmitted.
- Application snapshots include business details, selected certificates and commercial terms. Dates/scope/commercial terms/compliance requirements cannot change after an application is submitted; descriptive fields, deadlines and capacity can be edited (capacity cannot fall below approved count).
- Decisions and payment-status updates write in-app vendor notifications in the same transaction. Payment status is an organiser-maintained record; this feature does not collect or reconcile gateway payments.
- MongoDB replica-set transactions are required, as in the existing cashless ledger. There is no transaction fallback. Marketplace indexes are explicitly ensured before the first database request; index creation failure rejects the request.
- Existing collections are unchanged; no secret/env changes or data backfill is required.

Validation: `npm test -- --runInBand src/marketplace/__tests__/marketplace.test.ts`, `npm run build`.

Service-provider matching: authenticated vendor owners can request
`/api/marketplace/matched-opportunities` with the same filters/pagination as
`/opportunities`. It matches any saved `Vendor.serviceCategories` identifier or
its current catalogue label (exact, case-insensitive), before pagination. An
account with no saved categories receives no matches. Other filters still apply;
lookup failures surface as errors. The website defaults service providers to
this view and lets them clear “Match my service categories” to browse all markets.

The service-login task includes the existing Marketplace feature commits as a
dependency because Marketplace has not yet landed on production branches.

Website: Services → Marketplace → **List Stall Opportunity** opens organiser drafts and management. Publish exposes a listing in the existing public marketplace; pause stops applications; close is permanent. Applications, private certificates, approval decisions and organiser-recorded stall-fee payment status stay attached to the opportunity.
