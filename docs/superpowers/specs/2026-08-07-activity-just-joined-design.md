# Activity "Just Joined" Source — Design

Date: 2026-08-07
Status: Approved (brainstorm), pending implementation plan
Area: `api/src/services/activityFeed/*`, `landing/src/components/activity/*`
Builds on: [2026-07-31-activity-page-design.md](./2026-07-31-activity-page-design.md)

## Goal

Add a seventh source to the public `/activity` feed that surfaces **new buyer
signups**, rendering as rows that read **"Jane joined Carrot Tickets"**, merged
newest-first alongside the existing six sources (likes, follows, going, posts,
event announcements).

This is real data only — it shares no code with the synthetic homepage ticker
(`GET /api/public/activity`). It extends the real-only feed endpoint
`GET /api/public/activity-feed`.

## Locked decisions

1. **Buyers only.** "Users who just joined" means consumer signups. Organizers
   (Vendors) are out of scope — they are "organizers/brands", not "users", and
   would need a separate source if ever wanted.
2. **`everyone` tab only.** A join has no follow relationship, so the source
   contributes nothing to the `following` tab.
3. **Nullable target, not a fake self-target.** A join is actor-only; `target`
   becomes `ActivityTarget | null` across api + landing rather than inventing a
   self-referential target.
4. **Copy: "joined Carrot Tickets".** Rendered client-side (server never builds
   prose), consistent with the existing verb map.
5. **No time cutoff.** Old joins sink naturally in the newest-first merge, the
   same no-cutoff contract every other source follows. No "X people joined"
   aggregation, no join-only tab.

## Why `Buyer.createdAt` is a clean signal

- The **only** production path that creates a `Buyer` is self-service
  registration: `BuyerAuthService.registerWithOtp` (OTP-verified handle +
  password). See `api/src/services/buyerAuth.service.ts`.
- POS ticket sales create `Ticket` rows keyed by `customerPhone`, **not**
  `Buyer` accounts — so this source is never flooded by sales.
- The public signup form (`landing/src/components/BuyerAuthPanel.tsx`)
  **requires a name**, so virtually every join row has a real display name.
  Rare nameless/legacy buyers degrade gracefully (see Rendering).

Therefore `Buyer.createdAt` marks a genuine new user. No new field, no
backfill, no write-path change.

## Architecture: additive fan-in

The feed is a read-time fan-in merge: each source independently returns
`SourceResult = { candidates, nextBefore }`, and
`activityFeed/index.ts` merges them newest-first with one cursor watermark per
source. Adding a source is therefore purely additive — write one
`joinCandidates()`, register it in the `Promise.all` and the `results` record,
add its cursor key. The other six sources are untouched.

## Backend

### New type + cursor key — `activityFeed/types.ts`

- Add `'join'` to the `ActivityType` union.
- Add `join: 'j'` to `SOURCE_KEYS` (short key keeps the base64 cursor small).
- Add `j?: string` to `ActivityCursor`.
- **Make target optional/nullable:**
  - `ActivityCandidate.target` becomes optional (`target?: {...}`).
  - `ActivityItem.target` becomes `ActivityTarget | null`.

### New source — `activityFeed/sources.ts`

`joinCandidates(opts: SourceOpts): Promise<SourceResult>`:

- **Following tab short-circuit:** if `opts.actorIds` is set, return
  `{ candidates: [], nextBefore: null }` — joins have no follow semantics, so the
  source is simply empty on that tab.
- Otherwise query the `Buyer` collection with the shared windowed shape:
  `windowed({}, opts)` (i.e. `createdAt: { $lt: before }` when a watermark is
  set), `.sort({ createdAt: -1 }).limit(opts.limit).select('createdAt').lean()`.
- `nextBefore = scanFloor(rows, opts.limit, r => r.createdAt)` — identical
  scan-floor contract as the other sources.
- Map each row to a candidate with **no target**:
  ```ts
  {
    type: 'join',
    sourceId: String(r._id),
    sortAt: r.createdAt,
    actor: { kind: 'buyer', id: String(r._id) },
    // target omitted — join is actor-only
  }
  ```

**Suspension is NOT filtered here.** Like the other actor-driven sources (follow,
post, going), join emits all fetched buyers as candidates and lets `hydrate.ts`
drop suspended actors in the single, shared gating point. Because join applies no
post-fetch filter, `candidates.length === rows.length`, so the scan-floor /
cursor-advance logic in `index.ts` holds unchanged.

### Register the source — `activityFeed/index.ts`

- Import `joinCandidates`; add `joinCandidates(per('join'))` to the `Promise.all`.
- Add `join` to the `results: Record<ActivityType, SourceResult>` map.
- The existing cursor-advance loop iterates `Object.keys(SOURCE_KEYS)`, so once
  `join: 'j'` is in `SOURCE_KEYS` the loop, the `exhausted` check, and the
  watermark handling all pick it up with no further change.

### Hydration — `activityFeed/hydrate.ts`

The current loop drops any candidate whose target fails to resolve
(`if (!target) continue`). That must now distinguish **"no target expected"**
(a join — keep the row, emit `target: null`) from **"target failed to resolve"**
(a broken ref — still drop):

```ts
const actor = buildActor(c.actor);
if (!actor) continue;                 // suspended / missing actor → drop (unchanged)

let target: ActivityTarget | null = null;
if (c.target) {                       // a target was expected
  target = buildTarget(c.target);
  if (!target) continue;              // expected but unresolved → drop (unchanged)
}
items.push({ type: c.type, id: `${c.type}:${c.sourceId}`, sortAt: c.sortAt.toISOString(), actor, target });
```

A join's actor is the buyer; a suspended buyer therefore yields `actor === null`
and the row is dropped, exactly like every other source. No new suspension code.

### New index — `Buyer`

`Buyer` currently has no `createdAt` index (only partial-unique phone/email and a
2dsphere). Add:

```ts
buyerSchema.index({ createdAt: -1 });
```

so the windowed `{ createdAt: { $lt } }` + newest-first sort is index-backed,
matching what every other activity source relies on. This must match the live DB
(autoIndex) — see the existing partial-index note in `buyer.model.ts`.

### Response shape impact

The only response change is `target` gaining `null` as a possible value for
`'join'` rows. All existing rows keep a non-null target. This is a coordinated
api + landing change in the same repo (landing types updated in lockstep), not a
back-compat shim.

## Frontend (`landing/`)

### Types — `src/types/activity.ts`

- Add `'join'` to `ActivityType`.
- `ActivityItem.target` becomes `ActivityTarget | null`.

### Rendering — `src/components/activity/ActivityRow.tsx`

- `verb()`: add `case 'join': return 'joined';`.
- Treat join like `'post'` for target suppression: it renders no target *link*.
  Instead, for `type === 'join'` render a static, non-interactive trailing label
  **"Carrot Tickets"** after the verb, so the sentence reads
  "**Jane** joined **Carrot Tickets**".
- Guard the trailing thumbnail against a null target: it already only renders
  when `target.imageUrl` is truthy, so a `null` target must short-circuit to no
  thumbnail. Update the render + `targetLinkable`/`targetName` computations to be
  null-safe.
- Nameless / username-less buyers reuse the existing fallbacks unchanged: name
  falls back to "Carrot user", and a buyer with no username is rendered as a
  plain, non-clickable name (the `actorLinkable` branch already handles this).

### Feed plumbing

`ActivityPage.tsx` / `activityApi.ts` need no shape-specific change — they render
whatever items come back. Confirm the `'join'` row displays on the `everyone`
tab and does not appear on `following`.

## Testing

Extend existing suites (no new files unless a suite doesn't exist):

- `api/src/services/__tests__/activityIndexes.test.ts`: assert
  `hasIndex(Buyer, { createdAt: -1 })`.
- `api/src/services/activityFeed/__tests__/sources.test.ts`:
  - join returns recent buyers newest-first with correct `sortAt`/actor and no
    target;
  - `scanFloor` behavior (full page publishes a floor, short page returns
    `nextBefore: null`);
  - **following tab** (`actorIds` set) returns empty.
- `api/src/services/activityFeed/__tests__/hydrate.test.ts`:
  - a join candidate (no target) hydrates to an item with `target: null` and is
    NOT dropped;
  - a join whose buyer is `socialSuspendedAt` IS dropped;
  - a non-join candidate with an unresolvable target is still dropped (regression
    guard for the `if (c.target)` split).
- `api/src/services/activityFeed/__tests__/activityFeed.test.ts`:
  - join merges in newest-first among the seven sources;
  - the cursor advances/records the `j` watermark and the source paginates
    without losing or duplicating rows;
  - `exhausted`/`nextCursor: null` still correct with the seventh source.
- `landing/src/components/activity/__tests__/ActivityRow.test.tsx`:
  - a join row renders "<name> joined Carrot Tickets", no dead target link, no
    trailing thumbnail;
  - a username-less join renders a non-clickable name.
- `landing/src/pages/__tests__/ActivityPage.test.tsx`: join rows appear on
  `everyone`.

## Verification (before claiming done)

- `npm test` green in `api/` and `npm run build` + tests in `landing/`
  (per the "verify landing with npm run build" memory — `tsc --noEmit` misses
  the Pages-build failures).
- Manual: hit `GET /api/public/activity-feed?tab=everyone` on dev and confirm a
  recent signup shows as a join row; confirm `tab=following` shows none.

## Out of scope (YAGNI)

- Organizer/vendor "joined" rows.
- Any aggregation ("3 people joined").
- A dedicated join-only tab or filter.
- Time-window cutoffs.
- Notifications / push for joins.
