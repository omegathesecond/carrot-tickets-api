# Activity Page — Design

**Date:** 2026-07-31
**Repos:** `carrot-tickets-api` (`api/`, branch `main`), `carrot-tickets-website` (`landing/`, branch `master`)
**Status:** Design approved, pending spec review

## Goal

A public Activity page at `/activity` showing the live pulse of the platform —
who liked what, who followed who, who is going to what events, and what
organisers just posted or announced. Reachable from the desktop sidebar and the
mobile header. The point is traction: a first-time, signed-out visitor should
land on a page that proves Carrot is busy.

## Locked decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | Feed scope | Two tabs — **Following** and **Everyone** |
| 2 | Signed-out access | **Fully public**, both tabs visible (Following prompts sign-in) |
| 3 | Activity types | Likes (events + posts), follows, going, new posts + new events |
| 4 | Data honesty | **Real rows only**, no time cutoff — page back through history so the feed reads full without fabrication |
| 5 | Mobile placement | **Pulse icon in the mobile header**, next to the bell |
| 6 | Desktop placement | Sidebar nav item, slotted **third** (after Discover) |
| 7 | "Going" definition | **Community join OR live ticket** — same union `GoingService` already uses |

## Architecture: read-time merge

Query the six existing source collections directly, interleave by timestamp,
hydrate actors and targets in batch. No new model, no writes to instrument, no
backfill.

Rejected alternatives:

- **Denormalized `ActivityEvent` collection** (fan-out-on-write). Faster at
  scale, but needs six write paths instrumented, a backfill to have any history
  at all, and it drifts — a deleted post leaves an orphan row needing a sweep.
  Decision 4 (page back through all history) is free with read-time merge and
  costs a backfill here. If volume ever justifies this, the read-time service
  becomes the backfill script.
- **Extending `Notification`.** Rejected: notification rows are per-recipient,
  so a global feed would need one row per viewer.

At Carrot's current volume the read cost is irrelevant. The scaling trigger is
documented under *Operational notes* below.

## Backend

### Endpoint

```
GET /api/public/activity-feed?tab=everyone|following&cursor=<opaque>&limit=30
```

Mounted on the **public** router — no auth required, per decision 2.
`tab=following` resolves the viewer from the request and returns `401` when
there is no session (it cannot be answered anonymously). `tab` defaults to
`everyone`. `limit` is clamped to `[1, 50]`.

Named `activity-feed`, not `activity`: `GET /api/public/activity` already exists
and serves the homepage ticker, which deliberately blends synthetic purchases
(user-approved exception, 2026-07-09). That endpoint is untouched, and the new
one shares none of its code — this feed is real-only.

### Response

```jsonc
{
  "success": true,
  "data": {
    "items": [
      {
        "type": "like_event",          // like_event | like_post | follow | going | post | event
        "id": "…",                     // stable per-row id, "<type>:<sourceDocId>"
        "sortAt": "2026-07-31T09:12:04.000Z",
        "actor":  { "kind": "buyer",  "id": "…", "name": "Sipho",     "username": "sipho", "avatarUrl": null, "href": "/u/sipho" },
        "target": { "kind": "event",  "id": "…", "name": "Winter Fest", "imageUrl": "…",   "href": "/event/winter-fest-<id>" }
      }
    ],
    "nextCursor": "eyJ…"               // null when the history is exhausted
  }
}
```

`actor.kind` is `buyer` or `organizer`; `target.kind` is `event`, `post`, `buyer`
or `organizer`. The client renders the sentence from `type` — no server-built
prose, so copy changes never need a deploy.

### Sources

| `type` | Collection | Filter | `sortAt` | Reads as |
|---|---|---|---|---|
| `like_event` | `EventReaction` | `type:'like'` | `createdAt` | *Sipho liked **Winter Fest*** |
| `like_post` | `UpdateReaction` | `type:'like'` | `createdAt` | *Sipho liked **@KingDerby**'s post* |
| `follow` | `Follow` | — | `createdAt` | *Sipho followed **@KingDerby*** |
| `going` | `Membership` ∪ `Ticket` | see below | see below | *Sipho is going to **Winter Fest*** |
| `post` | `Update` | not deleted | `createdAt` | ***@KingDerby** posted* |
| `event` | `Event` | `status: PUBLISHED` | `publishedAt ?? createdAt` | ***@KingDerby** announced **Winter Fest*** |

`save`-type reactions are **excluded** from both reaction sources. A save is a
private filing action, not a public signal.

### The `going` union and its dedupe rule

"Going" is the union `GoingService` already defines — reuse that contract, do
not restate it:

- **`Membership`** where `bannedAt` does not exist → `communityId` → `Community.eventId`.
  Joining is a deliberate act available to any signed-in buyer; ticket
  verification gates *channels*, not the join itself
  (`communityMembership.service.ts:57`). This is the row behind the existing
  "Going" button on `EventPage.tsx:453`.
- **`Ticket`** where `status ∈ {SOLD, CHECKED_IN}` → `customerPhone` → `Buyer.phone`.
  Matches `GoingService`'s live-ticket contract exactly.

**Timestamp and dedupe.** A person who both joined and holds a ticket produces
two rows for one (buyer, event) pair. Deduping only within the current page
leaves duplicates across pages, because the twin row may sit hundreds of rows
deeper. The rule is therefore page-independent:

> A going row's `sortAt` is `min(membership.createdAt, earliest live ticket.createdAt)`
> for that (buyer, event) pair. It is emitted **once**, from whichever source
> produced the minimum. A candidate row from the other source is suppressed.

Suppression is one batched `$in` lookup per direction per page — no cross-page
state. The resulting timestamp honestly marks the moment the person first
became going.

`Ticket.createdAt` is the timestamp, **not** `updatedAt` — `updatedAt` moves on
gate check-in, which would resurface an old row as if it were new.

Rows are phrased "is going to", never "bought a ticket", and carry no amount,
quantity or payment method. A ticket whose `customerPhone` matches no `Buyer`
(POS walk-up sale) yields no actor and is skipped.

### Exclusions, applied to every source

- Actors with `socialSuspendedAt` set.
- Events that are not `PUBLISHED`.
- Deleted posts, and rows whose target no longer resolves.

**Ended events are deliberately NOT excluded.** `notEndedFilter` is a
*discovery-window* filter — it exists to keep an event on the grid until it
finishes (`eventVisibility.util.ts`). Activity is history, not discovery, and
applying it here would gut decision 4: page back a few months and every
`like_event`, `going` and `event` row would disappear, leaving a feed of only
follows and posts. "Sipho liked Winter Fest" remains true after Winter Fest
ends, and `/event/<slug>` still resolves, so the row and its link stay honest.
- `tab=following`: actors outside the viewer's `Follow` edges. Both
  `targetType` values count — a followed buyer and a followed organiser are
  equally sources of activity.

**Blocks are not filtered server-side.** This codebase's convention is
client-side hiding via `GET /api/social/me/blocks` (`block.model.ts:5`), and the
activity page follows it. Introducing server-side block filtering on one
endpoint only would be an inconsistency, not an improvement.

### Cursor

The `feed.service.ts` idiom: a base64url-encoded JSON object holding one
watermark per source, e.g. `{ "le": "<iso>", "lp": "<iso>", "f": "…", … }`. Each
source is queried with `createdAt < watermark`, over-fetched to `limit`, merged
desc by `sortAt`, and the next cursor records the last consumed position **per
source**. A malformed cursor decodes to `{}` (start from newest) rather than
throwing — matching `decode()` at `feed.service.ts:21`.

Per decision 4 there is no time cutoff: paging continues until every source is
exhausted, at which point `nextCursor` is `null`.

### Query shape

Six source queries plus batched hydration (`$in` per referenced model) — a
fixed ~10 queries per page regardless of page length or history depth.

### New indexes

Every existing index on the source collections is shaped for point lookups
(`{eventId, actorType, buyerId, type}` unique, `{targetType, targetId}`, …),
because nothing until now has asked "what happened most recently across
everything". A global newest-first scan is a new access pattern, and five of the
six sources have no index serving it:

```js
ticketSchema.index({ status: 1, createdAt: -1 });          // ticket.model.ts
membershipSchema.index({ createdAt: -1 });                 // membership.model.ts
followSchema.index({ createdAt: -1 });                     // follow.model.ts
eventReactionSchema.index({ type: 1, createdAt: -1 });     // eventReaction.model.ts
updateReactionSchema.index({ type: 1, createdAt: -1 });    // updateReaction.model.ts
eventSchema.index({ status: 1, publishedAt: -1 });         // event.model.ts
```

`Update` needs nothing — `{'media.status':1, status:1, createdAt:-1}` already
covers it, since Discover was the first feature to need recency.

All additive, all safe to build in the background, no backfill. Left unadded
these would not fail loudly — the feed would silently collection-scan on every
page and degrade as the collections grow.

## Frontend

### `ActivityPage.tsx` → route `/activity`

Public route, outside any auth guard. Layout:

- Tab strip: **Everyone** | **Following**. Signed-out, Following renders a
  sign-in prompt in place of the list rather than being hidden — it advertises
  that the personalised view exists.
- Rows, infinite scroll on an `IntersectionObserver` sentinel.
- Row anatomy: actor avatar (32px, `DemoAvatar` fallback) → sentence with the
  actor and target as separate links → relative time → 40px rounded target
  thumbnail on the right. Whole row is not one link; the two inner links go to
  different places.

Blocked actors are filtered client-side from `GET /api/social/me/blocks`, reusing
the existing hook.

### Entry points

- **Desktop** — new `Sidebar` item `{ to: '/activity', label: 'Activity', icon: Activity }`,
  slotted third, after Discover. Signed-in only, like the rest of the sidebar.
- **Mobile** — pulse icon in `Navbar`'s header cluster beside the bell, shown to
  signed-out visitors too, since the page is public. `Navbar` is the mobile
  header for both session states (`TopBar` is `hidden md:block`), so this is the
  one place that covers everyone.
- **Desktop signed-out** — the same icon appears in `Navbar`'s desktop cluster,
  which is what anonymous desktop visitors see.

The `BottomNav` tab set is unchanged.

### Liveness

While `document.visibilityState === 'visible'`, poll every 30s for rows newer
than the topmost `sortAt`. New rows are **not** spliced in under the reader — a
"*12 new*" pill appears at the top; tapping it prepends and scrolls to top.
Polling stops when the tab is hidden and resumes on focus.

Not the realtime gateway: it is socket-authenticated (`realtime/socketAuth.ts`),
and this page's primary audience is signed-out.

### States

- **Loading** — skeleton rows matching the row geometry.
- **Error** — a visible error with a retry button. Never a silent empty list;
  a failed fetch must be distinguishable from a quiet platform.
- **Empty** — "Nothing yet — be the first", with a link to Discover. Reached
  only when the platform genuinely has no history, since there is no time window.
- **End of history** — a quiet "You're all caught up" terminator.

## Testing

**Backend**

- Each source maps to the right `type`, `actor` and `target`.
- `save` reactions never appear.
- Going dedupe: a buyer with both a membership and a ticket for one event yields
  exactly one row, at the earlier timestamp, and stays deduped when the twin row
  falls on a later page.
- Going from a ticket whose phone matches no `Buyer` is skipped.
- Suspended actors, unpublished events and deleted posts are excluded.
- An **ended** event's rows are still returned (the `notEndedFilter` regression
  guard).
- Cursor: paging yields no duplicates and no gaps across sources with
  interleaved timestamps; a malformed cursor starts from newest.
- `tab=following` 401s anonymously; returns only followed actors' rows with a
  session; includes both followed buyers and followed organisers.
- `limit` clamping.

**Frontend**

- Renders each row type's sentence and both links.
- Following tab shows the sign-in prompt when signed out.
- Fetch failure renders the error state, not the empty state.
- Blocked actors are filtered out.
- The new-rows pill appears without shifting existing content.

## Operational notes

- **Scaling trigger.** Revisit the denormalized `ActivityEvent` design when a
  single page exceeds ~300ms at p95, or when any source collection passes ~1M
  rows. Until then read-time merge is correct and cheaper to own.
- **Deploy order.** All six indexes are additive; API and website deploy
  independently. Shipping the API first leaves the endpoint unreferenced, which
  is harmless.
- **Untouched.** `GET /api/public/activity` (homepage ticker, synthetic blend)
  and its `generateFakeActivity` helper are not modified.

## Deferred (explicitly out of scope for v1)

- Type-filter chips (All / Likes / Follows / Going / Posts).
- Grouping ("3 people liked Winter Fest").
- Realtime push over the socket gateway.
- Any per-user privacy control over appearing in the feed. No such control
  exists today — `IBuyer` has `dmPrivacy` but no profile-visibility flag, and
  every one of these edges is already publicly readable through existing
  surfaces (public who's-going roster, follower lists, like counts). This page
  changes *exposure*, not *permission*. If a privacy toggle is ever wanted, it
  belongs on the profile and should suppress the actor across all these
  surfaces at once, not just here.
