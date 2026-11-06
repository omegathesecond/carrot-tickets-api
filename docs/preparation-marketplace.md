# Prepare for the Event

Implemented across carrot-tickets-api and carrot-tickets-website on
`omevision/task-1793914868019-qfr18c-suggested-service`.
The provider dashboard lives in the website's existing service-provider profile
(Attendee requests tab), also available at `/services/requests`.
The separate organizer/admin dashboard repository is unchanged.

## Behavior

- Ticket holders enter from purchase success (including redirect payment
  results), or Preparing for [event] in their ticket wallet.
- `/preparing/:eventId` has the checklist, service requests, offer terms,
  acceptance, and ticket-holder companion requests.
- Multiple selected services create separate requests with common initial
  budget/date/location. If a later save fails, completed saves remain visible
  and the failure is explicit; the form closes to avoid resubmitting them.
- Requests are open to matching active service providers, or restricted to
  explicitly invited matching providers. Companion interest requires another
  ticket for the same event. Buyer contact handles and competing offers are
  never returned to providers/other attendees.
- Editing a looking request clears stale offers and notifies responders.
  Looking requests can be removed. Booked requests keep their accepted terms;
  the attendee must contact the provider about changes/cancellation.
- Offer acceptance records a booking. No payment/deposit/refund is executed.
  Deposits and cancellation terms are shown before acceptance. Existing
  messaging, provider profiles/portfolio and reviews remain available.
- Request/offer changes and inbox notifications commit atomically in Mongo
  transactions. Optimistic document versions prevent concurrent booking or
  offer writes from silently overwriting one another.

## API

Buyer authentication is required for `/api/public/events/:eventId/preparation`
(GET/POST), `/:id` (PATCH/DELETE), `/:id/accept` (POST),
`/api/public/events/:eventId/companions` (GET) and
`/api/public/preparation/:id/interest` (POST).
Every buyer operation rechecks live ticket ownership via the existing
id/phone/email ticket ownership utility.

Provider routes are `/api/tickets/services/preparation` (GET) and
`/api/tickets/services/preparation/:id/offers` (POST). Both require
MANAGE_ENQUIRIES and an active, visible service-provider account. Eligibility
(category and invitation) is enforced again on every offer and acceptance.
Provider filters: category, event (name), eventId, location (literal substring),
budget (minimum), date. Lists return up to 100 recent matches.

Boot initializes missing preparation categories using `$setOnInsert` only;
existing administrator labels, ordering and disabled categories are preserved.
No credentials, environment bindings or payment configuration are changed.

## Verification

- API `npm run build`; website `npm run build`.
- Focused API suite: preparation.service, ticketHolder.util,
  notification.model (20 tests); preparation suite re-run after final service
  cleanup (10 tests).
- Website: PreparationPage, MyTicketsPage, PaymentResultPage.yoco,
  notificationLink; includes partial-save error handling.
- Changed-file ESLint and git diff whitespace checks. Existing app.ts has
  two any-type warnings; no changed-file lint errors.
- Local Mongo integration tests require a permitted localhost listener.
  Website cache writes use a writable dependency-cache overlay on TMPDIR;
  shared dependencies remain untouched.

No production posting, payment, deployment, merge or client acceptance was
performed during implementation. Review and deployment are subsequent stages.
