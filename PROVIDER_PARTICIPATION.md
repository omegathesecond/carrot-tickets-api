Service-provider participation in Plans and Share&Earn

These features accept persisted buyer sessions and services-owner vendor sessions.
The existing session resolver checks current account state, credential version,
and permissions. Provider participation requires the live EDIT_BRAND permission;
other vendor verticals and staff access retain their existing restrictions.
Buyer-only routes still use authenticateBuyer.

Plans and referral records already reference participant profiles in the Buyer
collection. A provider gets a separate internal profile linked by sourceVendorId,
with its brand name/photo and no phone, email, or password. This profile is not a
buyer login and never gets a buyer token. It cannot inherit a separate buyer's
plans or rewards through shared contact details. All existing plan membership,
admin, and reward ownership checks operate on that isolated participant ID.

The sourceVendorId partial unique index is explicitly ensured before the first
provider upsert, including when autoIndex is disabled. No backfill or new env
variables are required. Index/database failures propagate as errors.

Website session guards preserve the selected tab and send expired providers to
service-provider sign-in. The business login callback honors that return URL.
The plan detail/post controls resolve the same participant ID used by the API.

Verification: providerParticipation.route.test.ts covers both tabs with live
vendor sessions, concurrent first access, plan creation/ownership, campaign
joining, referral isolation, reward redemption, revoked/expired sessions, buyer
access, and other vendor vertical restrictions. ProviderParticipantTabs.test.tsx
checks both pages send the vendor bearer token and preserve their return URL.
MyTicketsLoginPage.test.tsx exercises signing back into both destinations.

Review follow-up verification (2026-10-17):
- Replaced obsolete phone-only buyer JWT fixtures in all three Plans route
  suites and Share&Earn routes with a shared persisted buyer-session helper
  carrying buyerId and the account's current authVersion.
- Share&Earn organizer fixtures now persist real vendor accounts; the negative
  VIEW_STATS assertion uses a persisted restricted staff session and access row.
- All six relevant API suites pass (76 tests, including the 16-test trip-plan
  rerun): eventPlan, eventPlanSocial, eventPlanTripPlan, shareEarn routes,
  providerParticipation routes, and shareEarn service. Runtime checks used
  isolated ts-jest transpilation; a separate TypeScript check including these
  test files passed. The API production build passed.
- Website provider-tab/login regression suites pass (12 tests), and the
  website production build passed.
- Live staging browser verification was not performed: omevision-testcreds
  carrot-tickets reports no configured test credentials. Provider authentication,
  actions, isolation and expiry were verified through the API and website tests.
