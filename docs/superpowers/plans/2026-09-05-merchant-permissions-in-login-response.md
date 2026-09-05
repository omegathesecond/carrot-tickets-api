# Merchant login returns its permission set — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return the stall operator's derived permission set in the `/operator/login` response body, so the POS can decide what to show without decoding a JWT in Dart.

**Architecture:** `MerchantAuthService.login` already computes `deriveMerchantPermissions(operator.grants)` for the token payload. This adds the same array to the `operator` object it returns, mirroring how `GateOperatorAuthService.login` already returns `grants` and a derived `isRegisterDesk` in its body for exactly this reason.

**Tech Stack:** Node + TypeScript, Express, Mongoose, Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-09-05-merchant-stock-controller-grant-design.md` (§4 — "the POS decides what to show from `permissions`")

## Why this is its own plan

The shipped API mints `permissions` **into the JWT only**. The POS `MerchantOperator` model has no permissions field and `lib/api.dart` reads no capability list anywhere — the gate side routes off the `type` string, not a grant. So today the POS's only route to "does this person hold `manage_stock`?" is base64-decoding a JWT in Dart.

The final whole-branch review of the API slice named this as the most likely follow-up the POS work would demand. It is one line of production code, but it **must be deployed to prod before a POS build can rely on it**, which is why it is sequenced ahead of the POS plan rather than folded into it.

## Global Constraints

- **Additive only.** No existing response field changes name, type, or meaning. An older POS build must keep working untouched.
- **The response body is a rendering hint, never authorization.** The server still derives permissions per request in `authenticateMerchant`; nothing about this change may suggest the client's copy is trusted.
- **`merchant:charge` stays the floor** — every operator's array contains it.
- Run tests with `npx jest <path>` from the repo root.
- Work in a worktree off `origin/main`; `node_modules` is a symlink into a shared install — never `git clean -xfd`, `git stash push -u`, or `git rm -r node_modules`.

---

### Task 1: Return `permissions` on merchant login

**Files:**
- Modify: `src/services/merchantAuth.service.ts` (the returned `operator` object)
- Test: `src/services/__tests__/merchantAuthGrants.test.ts` (append)

**Interfaces:**
- Consumes: `deriveMerchantPermissions(grants)` — already exported from `src/interfaces/operatorGrant.interface.ts`.
- Produces: `login()` returns `operator: { …existing fields, permissions: MerchantPermission[] }`.

- [ ] **Step 1: Write the failing test**

Append to `src/services/__tests__/merchantAuthGrants.test.ts`, reusing that file's existing `seedOperator` helper:

```ts
it('returns the permission set in the response body, not only inside the token', async () => {
  const { loginCode } = await seedOperator([OperatorGrant.MANAGE_STOCK]);
  const { operator } = await MerchantAuthService.login(loginCode, '111111');

  expect(operator.permissions).toEqual([
    MerchantPermission.CHARGE,
    MerchantPermission.MANAGE_STOCK,
  ]);
});

it('gives an ungranted operator the floor alone in the body', async () => {
  const { loginCode } = await seedOperator([]);
  const { operator } = await MerchantAuthService.login(loginCode, '111111');

  expect(operator.permissions).toEqual([MerchantPermission.CHARGE]);
});

it('keeps every pre-existing operator field intact', async () => {
  const { loginCode } = await seedOperator([]);
  const { operator } = await MerchantAuthService.login(loginCode, '111111');

  // Additive change: an older POS build reads these and must not be disturbed.
  expect(operator).toMatchObject({
    merchantId: expect.any(String),
    merchantOperatorId: expect.any(String),
    operatorName: 'Nomsa Shongwe',
    name: 'Sandwich Stall',
    eventId: expect.any(String),
  });
});
```

If `seedOperator` in that file does not already return enough to assert the names above, read it and use the values it actually seeds — do not change the helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/merchantAuthGrants.test.ts`
Expected: FAIL — `operator.permissions` is `undefined` on the first two; the third passes already.

- [ ] **Step 3: Add the field**

In `src/services/merchantAuth.service.ts`, the `payload` literal already computes the array. Hoist it to a local so the token and the body cannot diverge, then return it:

```ts
    const permissions = deriveMerchantPermissions((operator as any).grants);

    const payload: MerchantToken = {
      // …unchanged fields…
      permissions,
    };
```

and in the returned `operator` object, after the existing fields:

```ts
      // The POS renders from this (which tabs and actions to show). It is NOT
      // authorization — authenticateMerchant re-derives the same set from the
      // operator row on every request, and that is the only thing the server
      // trusts. Returned here so the client need not decode its own JWT.
      permissions,
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/services/__tests__/merchantAuthGrants.test.ts src/routes/__tests__/merchantCharge.route.test.ts`
Expected: PASS. The charge suite proves the additive change disturbed no existing consumer.

- [ ] **Step 5: Commit**

```bash
git add src/services/merchantAuth.service.ts src/services/__tests__/merchantAuthGrants.test.ts
git commit -m "feat(merchant): return the derived permission set on login so the POS need not decode its token"
```

---

### Task 2: Verify and ship

**Files:** none — verification only.

- [ ] **Step 1: Typecheck and lint**

Run: `npm run build` then `npx eslint src/services/merchantAuth.service.ts`
Expected: build clean; no NEW eslint errors (the repo carries a pre-existing baseline of 57 errors / 1422 warnings on `main` — compare, do not treat the total as yours).

- [ ] **Step 2: Run the merchant surface**

Run: `npx jest src/services/__tests__/merchantAuthGrants.test.ts src/routes/__tests__/merchantCharge.route.test.ts src/routes/__tests__/merchantChargeItems.route.test.ts src/routes/__tests__/merchantTransactions.route.test.ts src/routes/__tests__/merchantStockAccess.route.test.ts src/routes/__tests__/merchantStockWrite.route.test.ts`
Expected: all green.

- [ ] **Step 3: Confirm no new env keys**

Run: `git diff origin/main...HEAD -- src | grep -E "^\+.*process\.env" || echo none`
Expected: `none` — env and secret bindings carry over from the previous Cloud Run revision.

- [ ] **Step 4: Land and deploy**

`main` is prod; the `carrot-tickets-api-main-deploy` trigger fires on push. Other sessions push concurrently, so fetch immediately before landing:

```bash
git fetch origin
git rev-list --count HEAD..origin/main   # must be 0; rebase and re-run the suites if not
git push origin <branch>:main
git push origin <branch>:dev
```

- [ ] **Step 5: Verify the deploy**

Poll discretely — loop-shaped watchers are blocked by the auto-mode classifier:

```bash
gcloud builds list --project=contracts-470406 --limit=3 --format='table(id,status,createTime)'
gcloud builds describe <build-id> --project=contracts-470406 --format='value(status)'
```

Then confirm the serving revision is genuinely your commit (the revision pins a digest, the build tags a sha, so they need joining):

```bash
gcloud run services describe carrot-tickets-api --region=europe-west1 --project=contracts-470406 --format='json(status.traffic)'   # take the entry with latestRevision:true, NOT traffic[0] — tagged revisions sort first
gcloud artifacts docker tags list <repo-path> --filter="tag:<full-sha>" --format='value(tag,version)'
gcloud run revisions describe <rev> --region=europe-west1 --project=contracts-470406 --format='value(spec.containers[0].image)'
```

Health via the in-app browser (curl is blocked in auto mode): `https://carrot-tickets-api-y5bs5km2gq-ew.a.run.app/health` → `{"success":true,"message":"Carrot Tickets API is running"}`.

---

## What this plan does NOT cover

The dashboard grant switch (`2026-09-05-stock-grant-dashboard.md`) and the POS Stock tab (`2026-09-05-stock-grant-pos.md`). The dashboard plan is independent of this one and can run in parallel. **The POS plan depends on this being deployed to prod.**
