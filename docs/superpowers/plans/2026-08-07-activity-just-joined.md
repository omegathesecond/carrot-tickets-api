# Activity "Just Joined" Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a seventh activity-feed source that surfaces new buyer signups as actor-only rows reading "Jane joined Carrot Tickets".

**Architecture:** The feed is a read-time fan-in merge — each source returns `{ candidates, nextBefore }` and `activityFeed/index.ts` merges them newest-first with a per-source cursor watermark. This adds one source (`joinCandidates`, reading `Buyer.createdAt`) plus the one structural change it forces: `target` becomes nullable end-to-end, because a join has no target where the other six rows all do.

**Tech Stack:** TypeScript, Express, Mongoose/MongoDB (api); React + Vite + Vitest + Testing Library (landing).

**Spec:** [docs/superpowers/specs/2026-08-07-activity-just-joined-design.md](../specs/2026-08-07-activity-just-joined-design.md)

## Global Constraints

- **Buyers only.** Source reads the `Buyer` collection; Vendors are out of scope.
- **`everyone` tab only.** `joinCandidates` returns empty when `opts.actorIds` is set (the following tab).
- **Copy: "joined Carrot Tickets"**, rendered client-side. The server never builds prose.
- **Nullable target, not a fake self-target.** `ActivityItem.target: ActivityTarget | null`; join rows emit no target.
- **No silent fallbacks** (global CLAUDE.md rule): the feed's existing loud invariants stay; join adds no swallowed errors.
- **Verify landing with `npm run build`**, not just `tsc --noEmit` — the Pages build (`tsc -b`) catches `noUnusedLocals` the plain check misses.

## Repos & worktrees (two repos)

- **Tasks 1–2 (api):** already in the isolated worktree
  `contracts/carrot-tickets/api-just-joined-wt`, branch `feat/activity-just-joined`
  (off api `main`). Work here directly.
- **Task 3 (landing):** the landing repo is a **separate** git repo whose prod
  branch is **`master`** (not `main`). Its main checkout is on an unrelated dirty
  branch, so create a fresh worktree first:
  ```bash
  cd contracts/carrot-tickets/landing
  git worktree add -b feat/activity-just-joined ../landing-just-joined-wt master
  ```
  Do all Task 3 work in `contracts/carrot-tickets/landing-just-joined-wt`.

## File Structure

**api** (`api-just-joined-wt/`):
- Modify `src/models/buyer.model.ts` — add a `createdAt` recency index.
- Modify `src/services/activityFeed/types.ts` — `'join'` type, `join:'j'` key, `j?` cursor, nullable/optional target.
- Modify `src/services/activityFeed/sources.ts` — add `joinCandidates`.
- Modify `src/services/activityFeed/index.ts` — register the source in the merge.
- Modify `src/services/activityFeed/hydrate.ts` — tolerate a target-less candidate.
- Modify tests: `src/services/__tests__/activityIndexes.test.ts`, `src/services/activityFeed/__tests__/sources.test.ts`, `.../hydrate.test.ts`, `.../activityFeed.test.ts`.

**landing** (`landing-just-joined-wt/`):
- Modify `src/types/activity.ts` — `'join'` type, nullable target.
- Modify `src/components/activity/ActivityRow.tsx` — verb, static label, null-safety.
- Modify `src/components/activity/__tests__/ActivityRow.test.tsx`.

---

## Task 1: `Buyer.createdAt` recency index (api)

The join source scans `Buyer` by `{ createdAt: { $lt } }` sorted newest-first; `Buyer` currently has no such index. Add it and assert it alongside the other activity-source indexes.

**Files:**
- Modify: `src/models/buyer.model.ts` (after the existing index declarations, ~line 153)
- Test: `src/services/__tests__/activityIndexes.test.ts`

**Interfaces:**
- Produces: a declared `{ createdAt: -1 }` index on the `Buyer` model.

- [ ] **Step 1: Write the failing test**

In `src/services/__tests__/activityIndexes.test.ts`, add `import { Buyer } from '@models/buyer.model';` to the imports, and add this assertion inside the existing `it('declares a newest-first index on every source the activity feed scans', ...)` block:

```ts
    // Join source: joinCandidates() scans Buyer by createdAt newest-first.
    expect(hasIndex(Buyer, { createdAt: -1 })).toBe(true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/activityIndexes.test.ts -t "declares a newest-first index"`
Expected: FAIL — `expect(received).toBe(true)` received `false` (index not declared yet).

- [ ] **Step 3: Add the index**

In `src/models/buyer.model.ts`, after the 2dsphere index line (`buyerSchema.index({ location: '2dsphere' });`), add:

```ts
// Recency index for the activity feed's "just joined" source: joinCandidates()
// queries { createdAt: { $lt } } sorted newest-first. Must match the live DB
// (autoIndex) — see the partial-index note above.
buyerSchema.index({ createdAt: -1 });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/__tests__/activityIndexes.test.ts -t "declares a newest-first index"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/models/buyer.model.ts src/services/__tests__/activityIndexes.test.ts
git commit -m "feat(activity): index Buyer.createdAt for the just-joined source"
```

---

## Task 2: `joinCandidates` source + nullable-target plumbing (api)

The type union, cursor key, source function, merge registration, and hydrate guard are type-coupled: adding `'join'` to `ActivityType` forces `index.ts`'s `Record<ActivityType, SourceResult>` to include it, and making `ActivityCandidate.target` optional forces `hydrate.ts` to guard it. So they land together, then real behavior is filled in test-first.

**Files:**
- Modify: `src/services/activityFeed/types.ts`
- Modify: `src/services/activityFeed/sources.ts`
- Modify: `src/services/activityFeed/index.ts`
- Modify: `src/services/activityFeed/hydrate.ts`
- Test: `src/services/activityFeed/__tests__/sources.test.ts`, `.../hydrate.test.ts`, `.../activityFeed.test.ts`

**Interfaces:**
- Consumes: `SourceOpts { before?: Date; limit: number; actorIds?: string[] | null }`, `SourceResult { candidates: ActivityCandidate[]; nextBefore: Date | null }`, helpers `windowed(base, opts)` and `scanFloor(fetched, limit, at)` — all already exported/defined in `sources.ts`.
- Produces: `joinCandidates(opts: SourceOpts): Promise<SourceResult>`; `ActivityType` gains `'join'`; `SOURCE_KEYS.join === 'j'`; `ActivityItem.target: ActivityTarget | null`; `ActivityCandidate.target` optional.

### Cycle A — scaffold the types + empty source (keeps the build green)

- [ ] **Step 1: Edit `types.ts`**

- Add `'join'` to the `ActivityType` union:
  ```ts
  export type ActivityType =
    | 'like_event'
    | 'like_post'
    | 'follow'
    | 'going'
    | 'post'
    | 'event'
    | 'join';
  ```
- Add the cursor key to `SOURCE_KEYS` (before the closing `} as const;`):
  ```ts
    event: 'e',
    join: 'j',
  ```
- Add `j?: string;` to the `ActivityCursor` interface (alongside the other keys).
- Make the candidate target optional:
  ```ts
  export interface ActivityCandidate {
    type: ActivityType;
    sourceId: string;
    sortAt: Date;
    actor: { kind: 'buyer' | 'organizer'; id: string };
    // Optional: a join is actor-only and carries no target.
    target?: { kind: 'event' | 'post' | 'buyer' | 'organizer'; id: string };
  }
  ```
- Make the hydrated item target nullable:
  ```ts
  export interface ActivityItem {
    type: ActivityType;
    id: string;
    sortAt: string; // ISO
    actor: ActivityActor;
    target: ActivityTarget | null;
  }
  ```

- [ ] **Step 2: Add an empty `joinCandidates` to `sources.ts`**

At the end of `sources.ts`, add the source returning nothing for now (real body — and the `Buyer` import it needs — arrive in Cycle B, so nothing is imported-but-unused at this commit):
```ts
export async function joinCandidates(opts: SourceOpts): Promise<SourceResult> {
  // Filled in Cycle B.
  void opts;
  return { candidates: [], nextBefore: null };
}
```

- [ ] **Step 3: Register the source in `index.ts`**

- Add to the import from `./sources`: `joinCandidates`
  ```ts
  import { likeEventCandidates, likePostCandidates, followCandidates, postCandidates, eventCandidates, joinCandidates } from './sources';
  ```
- Add it to the `Promise.all` array and destructuring:
  ```ts
  const [likeEvents, likePosts, follows, going, posts, events, joins] = await Promise.all([
    likeEventCandidates(per('like_event')),
    likePostCandidates(per('like_post')),
    followCandidates(per('follow')),
    goingCandidates(per('going')),
    postCandidates(per('post')),
    eventCandidates(per('event')),
    joinCandidates(per('join')),
  ]);
  ```
- Add it to the `results` record:
  ```ts
  const results: Record<ActivityType, SourceResult> = {
    like_event: likeEvents,
    like_post: likePosts,
    follow: follows,
    going,
    post: posts,
    event: events,
    join: joins,
  };
  ```

- [ ] **Step 4: Guard the target in `hydrate.ts`**

- In the id-collection loop, skip target reads when there is no target:
  ```ts
  for (const c of candidates) {
    (c.actor.kind === 'buyer' ? buyerIds : vendorIds).add(c.actor.id);
    if (!c.target) continue; // join rows are actor-only
    if (c.target.kind === 'buyer') buyerIds.add(c.target.id);
    if (c.target.kind === 'organizer') vendorIds.add(c.target.id);
    if (c.target.kind === 'event') eventIds.add(c.target.id);
    if (c.target.kind === 'post') postIds.add(c.target.id);
  }
  ```
- In the build loop, distinguish "no target expected" (keep, emit `null`) from "target failed to resolve" (drop):
  ```ts
  const items: ActivityItem[] = [];
  for (const c of candidates) {
    const actor = buildActor(c.actor);
    if (!actor) continue;
    // A candidate MAY legitimately have no target (a join is actor-only). Only
    // drop the row when a target IS expected but fails to resolve.
    let target: ActivityTarget | null = null;
    if (c.target) {
      target = buildTarget(c.target);
      if (!target) continue;
    }
    items.push({ type: c.type, id: `${c.type}:${c.sourceId}`, sortAt: c.sortAt.toISOString(), actor, target });
  }
  return items;
  ```

- [ ] **Step 5: Run the full suite — build compiles, nothing regresses**

Run: `npx jest src/services/activityFeed`
Expected: PASS (join emits nothing yet, so existing behavior is unchanged and the build type-checks).

- [ ] **Step 6: Commit the scaffold**

```bash
git add src/services/activityFeed/types.ts src/services/activityFeed/sources.ts src/services/activityFeed/index.ts src/services/activityFeed/hydrate.ts
git commit -m "feat(activity): scaffold join source + nullable target plumbing"
```

### Cycle B — real `joinCandidates` body

- [ ] **Step 7: Write the failing source tests**

In `src/services/activityFeed/__tests__/sources.test.ts`, add `joinCandidates` to the import from `../sources`, then add:

```ts
  it('joinCandidates returns recent buyers newest-first as actor-only rows', async () => {
    const older = await Buyer.create({ phone: '+26878100020', password: 'password123', name: 'Older' });
    // Backdate via the raw driver (timestamps: true strips createdAt from $set).
    await Buyer.collection.updateOne({ _id: older._id }, { $set: { createdAt: new Date(Date.now() - 5 * DAY) } });
    const newer = await Buyer.create({ phone: '+26878100021', password: 'password123', name: 'Newer' });

    const { candidates: rows } = await joinCandidates({ limit: 20 });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.type).toBe('join');
    expect(rows[0]!.actor).toEqual({ kind: 'buyer', id: String(newer._id) });
    expect(rows[0]!.target).toBeUndefined();
    expect(rows.map((r) => r.actor.id)).toEqual([String(newer._id), String(older._id)]);
  });

  it('joinCandidates honours the before watermark', async () => {
    const older = await Buyer.create({ phone: '+26878100022', password: 'password123' });
    await Buyer.collection.updateOne({ _id: older._id }, { $set: { createdAt: new Date(Date.now() - 5 * DAY) } });
    const newer = await Buyer.create({ phone: '+26878100023', password: 'password123' });

    const { candidates: rows } = await joinCandidates({ limit: 20, before: newer.createdAt as Date });
    expect(rows.map((r) => r.actor.id)).toEqual([String(older._id)]);
  });

  it('joinCandidates contributes nothing on the following tab (actorIds set)', async () => {
    await Buyer.create({ phone: '+26878100024', password: 'password123' });
    const { candidates, nextBefore } = await joinCandidates({
      limit: 20, actorIds: [String(new mongoose.Types.ObjectId())],
    });
    expect(candidates).toHaveLength(0);
    expect(nextBefore).toBeNull();
  });
```

- [ ] **Step 8: Run to verify they fail**

Run: `npx jest src/services/activityFeed/__tests__/sources.test.ts -t joinCandidates`
Expected: FAIL — the newest-first test gets `[]` (length 0 ≠ 2) from the empty scaffold.

- [ ] **Step 9: Implement the real body**

At the top of `sources.ts`, add the Buyer import next to the other model imports:
```ts
import { Buyer } from '@models/buyer.model';
```
Then replace the scaffold `joinCandidates` in `sources.ts` with:

```ts
export async function joinCandidates(opts: SourceOpts): Promise<SourceResult> {
  // A join has no follow relationship, so it belongs only to the "everyone"
  // tab. On the "following" tab (actorIds set) this source is simply empty.
  if (opts.actorIds) return { candidates: [], nextBefore: null };

  const rows = await Buyer.find(windowed({}, opts))
    .sort({ createdAt: -1 })
    .limit(opts.limit)
    .select('createdAt')
    .lean();
  const nextBefore = scanFloor(rows, opts.limit, (r) => r.createdAt as Date);
  const candidates = rows.map((r) => ({
    type: 'join' as const,
    sourceId: String(r._id),
    sortAt: r.createdAt as Date,
    actor: { kind: 'buyer' as const, id: String(r._id) },
    // no target — a join is actor-only
  }));
  return { candidates, nextBefore };
}
```

- [ ] **Step 10: Run to verify they pass**

Run: `npx jest src/services/activityFeed/__tests__/sources.test.ts -t joinCandidates`
Expected: PASS (all three).

- [ ] **Step 11: Commit**

```bash
git add src/services/activityFeed/sources.ts src/services/activityFeed/__tests__/sources.test.ts
git commit -m "feat(activity): joinCandidates reads new buyer signups (everyone-tab only)"
```

### Cycle C — hydrate keeps join rows, still drops broken ones

- [ ] **Step 12: Write the hydrate tests**

In `src/services/activityFeed/__tests__/hydrate.test.ts`, add:

```ts
  it('keeps a join row (actor only) and emits target: null', async () => {
    const buyer = await Buyer.create({
      phone: '+26878200020', password: 'password123', name: 'New User', username: 'newbie',
    });
    const [item] = await hydrate([{
      type: 'join', sourceId: String(buyer._id), sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
      // no target
    }]);
    expect(item!.type).toBe('join');
    expect(item!.target).toBeNull();
    expect(item!.actor.name).toBe('New User');
    expect(item!.actor.href).toBe('/u/newbie');
  });

  it('drops a join whose buyer is socially suspended', async () => {
    const buyer = await Buyer.create({
      phone: '+26878200021', password: 'password123', username: 'susp', socialSuspendedAt: new Date(),
    });
    const items = await hydrate([{
      type: 'join', sourceId: String(buyer._id), sortAt: at,
      actor: { kind: 'buyer', id: String(buyer._id) },
    }]);
    expect(items).toHaveLength(0);
  });
```

- [ ] **Step 13: Run the hydrate suite**

Run: `npx jest src/services/activityFeed/__tests__/hydrate.test.ts`
Expected: PASS — the Cycle A guard already implements this; these tests lock the behavior. The existing "drops a row whose target no longer resolves" test still passes, proving the expected-but-unresolved branch is intact. If either new test fails, fix the Cycle A hydrate edit.

- [ ] **Step 14: Commit**

```bash
git add src/services/activityFeed/__tests__/hydrate.test.ts
git commit -m "test(activity): join rows hydrate to a null target and gate on suspension"
```

### Cycle D — end-to-end merge + pagination

- [ ] **Step 15: Write the feed integration tests**

In `src/services/activityFeed/__tests__/activityFeed.test.ts`, add (the file already imports `Buyer`, `Follow`, `getActivityFeed`, `DAY`):

```ts
  it('surfaces a new buyer signup as a join row on the everyone tab', async () => {
    const buyer = await Buyer.create({
      phone: '+26878300001', password: 'password123', name: 'Fresh', username: 'fresh',
    });
    const { items } = await getActivityFeed({ tab: 'everyone', limit: 30 });
    const join = items.find((i) => i.type === 'join');
    expect(join).toBeDefined();
    expect(join!.actor.id).toBe(String(buyer._id));
    expect(join!.target).toBeNull();
  });

  it('omits join rows from the following tab', async () => {
    const viewer = await Buyer.create({ phone: '+26878300002', password: 'password123', username: 'viewer' });
    const followed = await Buyer.create({ phone: '+26878300003', password: 'password123', username: 'followed' });
    await Follow.create({ followerType: 'buyer', followerId: viewer._id, targetType: 'buyer', targetId: followed._id });
    const { items } = await getActivityFeed({
      tab: 'following', limit: 30, viewer: { type: 'buyer', id: String(viewer._id) } as any,
    });
    expect(items.some((i) => i.type === 'join')).toBe(false);
  });

  it('paginates join rows without loss or duplication', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await Buyer.create({ phone: `+2687840100${i}`, password: 'password123', username: `jb${i}` });
      await Buyer.collection.updateOne({ _id: b._id }, { $set: { createdAt: new Date(Date.now() - i * DAY) } });
      ids.push(String(b._id));
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await getActivityFeed({ tab: 'everyone', limit: 2, cursor });
      page.items.filter((i) => i.type === 'join').forEach((i) => seen.add(i.actor.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
  });
```

Note on the `viewer` cast: the following-tab path only reads `viewer.type` and `viewer.id` (see `index.ts`), so a minimal `{ type, id }` is sufficient; `as any` keeps the test from depending on the full `SocialActor` shape. If existing following-tab tests in this file build a richer viewer, mirror that instead of the cast.

- [ ] **Step 16: Run to verify behavior**

Run: `npx jest src/services/activityFeed/__tests__/activityFeed.test.ts`
Expected: PASS. The everyone/following tests exercise the Cycle A/B wiring; the pagination test proves the shared cursor loop advances the new `j` watermark without dropping or repeating a buyer. If the pagination test loops to the `guard` cap, the `j` watermark isn't advancing — revisit the `index.ts` registration.

- [ ] **Step 17: Run the whole api activity suite + typecheck**

Run: `npx jest src/services/activityFeed src/services/__tests__/activityIndexes.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 18: Commit**

```bash
git add src/services/activityFeed/__tests__/activityFeed.test.ts
git commit -m "test(activity): join rows merge into everyone tab and paginate cleanly"
```

---

## Task 3: Render "joined Carrot Tickets" (landing)

Frontend renders the join sentence. `target` becomes nullable in the landing types too, and `ActivityRow` gains the verb, a static trailing label, and null-safety around every target read.

**Files:**
- Modify: `src/types/activity.ts`
- Modify: `src/components/activity/ActivityRow.tsx`
- Test: `src/components/activity/__tests__/ActivityRow.test.tsx`

**Prerequisite:** create the landing worktree (see "Repos & worktrees" above) and run all steps inside `contracts/carrot-tickets/landing-just-joined-wt`.

**Interfaces:**
- Consumes: the api response where a `'join'` item has `target: null`.
- Produces: an `ActivityRow` that renders `<actor> joined Carrot Tickets` with no target link and no thumbnail.

- [ ] **Step 1: Write the failing render tests**

In `src/components/activity/__tests__/ActivityRow.test.tsx`, add:

```tsx
  it('renders a join as "joined Carrot Tickets" with no target link', () => {
    renderRow(row({ type: 'join', id: 'join:1', target: null }));
    expect(screen.getByText('Sipho')).toBeInTheDocument();
    expect(screen.getByText(/joined/)).toBeInTheDocument();
    const label = screen.getByText('Carrot Tickets');
    expect(label).toBeInTheDocument();
    expect(label.closest('a')).toBeNull(); // static, not a link
  });

  it('renders a username-less join actor as non-clickable text', () => {
    renderRow(row({
      type: 'join', id: 'join:2', target: null,
      actor: { kind: 'buyer', id: 'b9', name: 'No Handle', username: null, avatarUrl: null, href: '/u/b9' },
    }));
    expect(screen.getByText('No Handle').closest('a')).toBeNull();
  });
```

(The shared `row()` helper already casts `as ActivityItem`, so `target: null` type-checks once the type change in Step 3 lands. It won't compile until then — that's the failing state.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/activity/__tests__/ActivityRow.test.tsx`
Expected: FAIL — a type error on `target: null` (type not yet nullable) and/or "Carrot Tickets" / "joined" not found.

- [ ] **Step 3: Make the landing type nullable**

In `src/types/activity.ts`:
- Add `'join'` to the union:
  ```ts
  export type ActivityType = 'like_event' | 'like_post' | 'follow' | 'going' | 'post' | 'event' | 'join';
  ```
- Make the item target nullable:
  ```ts
  export interface ActivityItem {
    type: ActivityType;
    id: string;
    sortAt: string;
    actor: ActivityActor;
    target: ActivityTarget | null;
  }
  ```

- [ ] **Step 4: Update `ActivityRow.tsx`**

- Import `ActivityTarget` (line 3):
  ```tsx
  import type { ActivityItem, ActivityActor, ActivityTarget } from '@/types/activity';
  ```
- Add the verb (in the `verb()` switch, alongside the other cases):
  ```tsx
    case 'join':       return 'joined';
  ```
- Change `targetLabel` to take a non-null target:
  ```tsx
  const targetLabel = (t: ActivityTarget): string =>
    t.name || (t.kind === 'post' ? 'a post' : 'Carrot user');
  ```
- Replace the top of `ActivityRow` (the `showTargetLink` / `targetLinkable` / `targetName` block) with null-safe versions:
  ```tsx
  export function ActivityRow({ item }: { item: ActivityItem }) {
    const { actor, target } = item;
    // "posted" and "joined" are complete sentences without a trailing target
    // link: a post IS its own target; a join has no target at all.
    const showTargetLink = item.type !== 'post' && item.type !== 'join';

    const actorLinkable = actor.kind !== 'buyer' || !!actor.username;
    // target is null on join rows — guard every read of it.
    const targetLinkable = !!target && (target.kind !== 'buyer' || target.href !== `/u/${target.id}`);

    const actorName = displayName(actor);
    const targetName = target ? targetLabel(target) : '';
  ```
- In the sentence `<p>`, after the verb span, render the static join label and guard the target link with `target`:
  ```tsx
        <span className="text-muted-foreground"> {verb(item.type)} </span>
        {item.type === 'join' && <span className="font-semibold">Carrot Tickets</span>}
        {showTargetLink && target && (
          targetLinkable ? (
            <Link to={target.href} className="font-semibold hover:underline">{targetName}</Link>
          ) : (
            <span className="font-semibold">{targetName}</span>
          )
        )}
  ```
- Guard the trailing thumbnail against a null target (replace `{target.imageUrl && (`):
  ```tsx
      {target?.imageUrl && (
        targetLinkable ? (
          <Link to={target.href} className="shrink-0" aria-hidden="true" tabIndex={-1}>
            <img src={target.imageUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
          </Link>
        ) : (
          <span className="shrink-0" aria-hidden="true">
            <img src={target.imageUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
          </span>
        )
      )}
  ```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/components/activity/__tests__/ActivityRow.test.tsx`
Expected: PASS (both new tests plus the existing ones — like_event, going, follow, event — still green).

- [ ] **Step 6: Verify the production build (not just tsc --noEmit)**

Run: `npm run build`
Expected: the Vite/`tsc -b` build succeeds. `targetLabel` is now called with a single arg and `ActivityTarget` is imported/used — confirm no `noUnusedLocals`/unused-import failures. Fix any surfaced by the build.

- [ ] **Step 7: Commit**

```bash
git add src/types/activity.ts src/components/activity/ActivityRow.tsx src/components/activity/__tests__/ActivityRow.test.tsx
git commit -m "feat(activity): render 'joined Carrot Tickets' for new-signup rows"
```

---

## Final verification (before claiming done)

- [ ] api: `cd api-just-joined-wt && npx jest src/services/activityFeed src/services/__tests__/activityIndexes.test.ts && npx tsc --noEmit` — all green.
- [ ] landing: `cd landing-just-joined-wt && npx vitest run src/components/activity && npm run build` — all green.
- [ ] Manual smoke on dev: `GET /api/public/activity-feed?tab=everyone` shows a recent signup as a join row (`type: "join"`, `target: null`); `?tab=following` shows none.

## Self-review notes (coverage against the spec)

- Spec §"New index" → Task 1. §"New source" + §"New type + cursor key" + §"Register the source" → Task 2 Cycle A/B. §"Hydration" → Task 2 Cycle A + Cycle C. §"Response shape impact" (target nullable) → Task 2 Cycle A (api) + Task 3 Step 3 (landing). §"Frontend rendering" → Task 3. §"Testing" bullets → the test steps across Tasks 1–3. §"Everyone-tab only" → Task 2 Step 9 guard + Task 2 Step 15 following-tab test. §"Suspension" → Task 2 Step 12 suspended-join test.
