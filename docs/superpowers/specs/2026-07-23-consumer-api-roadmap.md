# Carrot Tickets — Consumer API Roadmap (redesign → prod)

**Date:** 2026-07-23
**Author:** brainstorming session (Laslie + Claude)
**Repo (primary):** `carrot-tickets-api` — Express + TypeScript + **Mongoose (MongoDB)**. Also touches `carrot-tickets-dashboard` and `landing/` (consumer web).
**Base URLs:** `api.carrottickets.com` (REST), `realtime.carrottickets.com` (socket.io). Envelope: `{ success, data, message }`. Buyer social = `/api/social/*` + `/api/dm/*` (`authenticateBuyer`); vendor = `/api/tickets/*` (`authenticateTickets`).

## Goal

Close the backend gaps so the king-derby ("PINSAVE") visual redesign can ship **without demo data** — the redesigned `Topics`, `Suggested`, `Nearby`, `Calendar` pages + desktop Sidebar lists currently render pure `landing/src/lib/demoData.ts`, which violates the no-fake-data rule and blocks prod. Plus one net-new capability: **self-sold (external-link) events**.

This is a *roadmap* across all gaps, deliberately decomposed — each Phase 3 subsystem gets its own spec → plan → build cycle.

## Decisions locked in this session

- **Scope style:** roadmap-first (this doc), then drill into slice #1.
- **Launch cut line:** **Phase 1 + Phase 2** must be done before the redesign ships. Phase 3 (Stories / Nearby / Topics) is **gate-vs-build TBD** — revisit after slice #1 is spec'd and we see the pace.
- **Self-sold events:** **external-link only** — `Event.ticketing ∈ {'carrot','external'}`; an `external` event carries an `externalTicketUrl`. No "at the door / offline" mode.
- **Never infer data:** category defaults to "Other" (organizer sets it); no faked live-attendee counts, no guessed categories.

## Already real (no work — for reference)

Events list/search/detail, all payments (keshless/momo/peach), Discover `/api/public/feed` (for-you/following/events tabs) + every post interaction (like/save/share/view/compose), **Hot This Week** (derived from `event.recentSales`), event quick-view community bits (Going = `community.memberCount`, Members, Topics = channels, "I'm Here" = join, Media), DMs + realtime (buyer & brand), notification inbox + Web Push, follow/block/friends/presence, buyer profile (self + public + Posts tab), organizer profiles, reviews.

---

## Slice A — Self-sold (external-link) events  *(NEW; independent; cross-repo)*

An organizer lists an event on Carrot for **discovery + the social layer**, but sells tickets themselves. Carrot never processes the sale.

**Data model (`event.model.ts`):**
- `ticketing: 'carrot' | 'external'` — default `'carrot'` (all existing events).
- `externalTicketUrl?: string` — required + must be `https://…` when `ticketing==='external'`.
- `ticketTypes[]` becomes optional/absent for `external` (price still allowed as **display-only** so cards/badges can show "from E___" if the organizer enters it).

**api:**
- **Guard rails (fail loudly):** `POST /public/purchase[/momo|/peach-card]` and the in-app `/api/tickets/purchase` must **reject** any event with `ticketing!=='carrot'` → `409 { message: 'This event is sold externally' }`. Never silently no-op.
- Public serialization (`GET /public/events[/:id]`, feed slices) exposes `ticketing` + `externalTicketUrl`.
- Validation on event create/edit: `external` requires a valid https URL; `carrot` requires ≥1 ticket type (unchanged).
- **Community gating relaxed:** today "I'm Here"/join verifies a *Carrot* ticket. External events have no Carrot ticket → their community join is **open / self-attested** (no `verify-ticket` step). Spec detail for Slice A's own plan.

**dashboard:** event create/edit gets a ticketing-mode toggle. `external` → show the URL field, hide/disable Carrot ticket-type + payout config (keep optional display price).

**landing:** `EventPage` / `PurchaseModal` branch on `ticketing`:
- `carrot` → existing checkout.
- `external` → primary CTA "Get Tickets" opens `externalTicketUrl` in a new tab (`rel="noopener noreferrer"`); no PurchaseModal.
- Feed/EventCard/quick-view show an "External" / "Buy on organizer site" affordance.

**Effort:** M. Independent of Phases 1–3 — can be built in parallel.
**Open sub-decisions (for Slice A's spec):** community "going" model for external events (open join vs self-RSVP record); whether to track external-CTA click-throughs as analytics; display-price handling.

---

## Phase 1 — Read-side gap-closers  *(reads over existing collections; ~no new models)*

All buyer-authed (`/api/social/*`). Frontend is already built to consume these — each is "supply endpoint + delete the `demoData` import."

| # | Endpoint | Source (exists today) | Response sketch | Unblocks |
|---|----------|----------------------|-----------------|----------|
| 1a | `GET /social/me/saved` | `UpdateReaction(type:'save')` + `EventReaction(type:'like')`¹ | `{ updates:[FeedSlide], events:[EventCard] }` | Profile **Saved** tab |
| 1b | `GET /social/me/going` | `Membership` (join = "I'm Here") ∪ ticket holdings | `{ events:[{...,startsAt,going:true}] }` | Profile **Going** tab |
| 1c | `GET /social/me/calendar?year=` | union of 1a-events + 1b | `{ monthCounts:{Jul:5,…}, events:[{id,name,venue,city,startsAt,price,saved}] }` | **Calendar** page |
| 1d | Home Following/Favorites tabs | `Follow` graph + saved/liked (reuse `feed?tab=following`) | events by followed organizers / saved list | Home tabs (today both show unfiltered list) |
| 1e | `GET /social/suggestions/people` | `Follow` graph (mutual / 2nd-degree) | `[{id,name,username,avatarUrl,bio,city,mutualCount,isFollowing}]` | **Suggested** + Sidebar |
| 1f | `GET /social/suggestions/organizers` | `Vendor` directory ordered by follower/event counts | `[{id,businessName,logoUrl,location,eventCount,followerCount,isFollowing}]` | Suggested + Sidebar |
| 1g | `GET /social/recommendations` | content-based off saves/likes (same category/organizer) | `{ basisEvent:{id,name}, events:[EventCard] }` | "Because you saved X" + "events you might like" |

¹ Events already use `like` as the bookmark toggle (frontend calls `likeEvent` for "Save"), so "saved events" = liked events — **no enum change**.

**Build order within Phase 1:** the saved/going resolver services (1a, 1b) come first — Calendar (1c), Favorites tab (1d) and recommendations basis (1g) compose on top of them.

**Prereq:** run `npm run backfill:social-actor-types` before 1e/1g query `Follow`/`UpdateReaction` (the `*Type` discriminator backfill).

## Phase 2 — Small schema adds

| # | Change | Detail | Unblocks |
|---|--------|--------|----------|
| 2a | `Event.category` | enum field (Music/Art/Food/Tech/Sports/Theater/Comedy/Fashion/Film) + organizer sets on create/edit + backfill existing → `'Other'` (**never inferred**) + `?category=` on `/public/events` & `/public/feed` | Category **chips + poster badges** everywhere (Home + Discover) |
| 2b | `GET /public/events/live` | events where `now ∈ [start,end]` + `liveAttendees` (count from `Membership`/presence in window) | Home **Live Now** real data (kills `DEMO_LIVE_EVENTS`) |

## Phase 3 — Greenfield subsystems  *(each gets its OWN spec; gate-vs-build TBD)*

| # | Subsystem | New surface | Effort |
|---|-----------|-------------|--------|
| 3a | **Topics** | hashtag parse/store from captions → `GET /social/trending`; event Q&A model → `GET /community/:eventId/questions` (+ post/reply/like) | L |
| 3b | **Nearby** (geo) | buyer location opt-in (`PATCH /social/me/location`) + `2dsphere` index on buyers/events + `GET /social/nearby/people?lat&lng&radiusKm` (distanceKm, mutualCount, online, currentEvent) + "Meet Up" action. **Zero coordinates exist today.** | L |
| 3c | **Stories** | ephemeral 24h media collection + seen-state → `GET /social/stories` (today it's an org-logo stand-in) | L |

**Recommendation:** gate these three UIs as "coming soon" for launch; build post-launch in the order 3a → 3b → 3c. Final call deferred (see cut line).

---

## Cross-cutting notes

- **No-fake-data gate:** until Phase 3 ships, `TopicsPage`, `SuggestedPage`, `NearbyPage`, `CalendarPage` and the Sidebar follow-lists must NOT render `demoData` on prod — Phase 1 removes the demo for Suggested/Calendar/Sidebar; Nearby + Topics stay gated until 3a/3b.
- **Frontend wiring is minimal** for Slice A + Phases 1–2 — mostly deleting a `demoData` import and pointing the existing hook at the new endpoint. Category chips (Home + Discover) need `category` threaded into `getEvents`/`getFeed`.
- **Auth:** buyer endpoints under `/api/social` use `authenticateBuyer`; anything a brand also needs mirrors under `/api/tickets/social`.
- **Migration debt:** `Follow`/`UpdateReaction`/`Notification` `*Type` backfill must run before code queries those fields.

## Recommended sequence & launch cut line

```
   ┌─ Slice A (self-sold events) ─┐   (parallel, independent)
   │                               │
Phase 1 (read gap-closers) ──► Phase 2 (category + live) ──►  ✅ SHIP REDESIGN
                                                              (Phase 3 gated "coming soon")
                                                                        │
                                                              Phase 3: 3a Topics → 3b Nearby → 3c Stories
```

## Open decisions (deferred)

1. **Phase 3 gate vs build** before launch (cut line revisit).
2. **Slice A community model** for external events (open join vs self-RSVP going record).
3. **Recommendations depth** (1g): content-based v1 vs later collaborative signals (viewCount exists but unused).
4. **Category assignment** for the ~existing events backfill (all → "Other" and let organizers re-tag, vs a one-time manual pass).

## Next step

Drill into **slice #1** for a detailed implementation plan. Recommended first slice: **Phase 1 (read gap-closers)** — highest unblock-per-risk — or **Slice A** if self-sold events are the more urgent product need. (Pick at plan time.)
