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
