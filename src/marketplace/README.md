# Marketplace

- Public: `/api/marketplace/options`, `/opportunities`, `/opportunities/:id`.
- Vendor owners: private profiles, default business, compliance documents and applications.
- Organiser owners: `/manage/opportunities` and `/manage/applications/:id`.
- Carrot superadmins can review all opportunities and their applications; another organiser cannot.
- Documents live in MongoDB, not the public media bucket. PDF/JPEG/PNG files are limited to 5 MB and served as authenticated attachments with `Cache-Control: private, no-store`. Uploading/replacing/removing a profile document retains historical application versions.
- Opportunities support individual-date applications or regular trading across all listed dates. Capacity is per date, or per regular-trader opportunity. A unique partial index prevents multiple active applications per business/opportunity/scope; declined applications may be resubmitted.
- Application snapshots include business details, selected certificates and commercial terms. Dates/scope/commercial terms/compliance requirements cannot change after an application is submitted; descriptive fields, deadlines and capacity can be edited (capacity cannot fall below approved count).
- Decisions and payment-status updates write in-app vendor notifications in the same transaction. Payment status is an organiser-maintained record; this feature does not collect or reconcile gateway payments.
- MongoDB replica-set transactions are required, as in the existing cashless ledger. There is no transaction fallback. Marketplace indexes are explicitly ensured before the first database request; index creation failure rejects the request.
- Existing collections are unchanged; no secret/env changes or data backfill is required.

Validation: `npm test -- --runInBand src/marketplace/__tests__/marketplace.test.ts`, `npm run build`.
