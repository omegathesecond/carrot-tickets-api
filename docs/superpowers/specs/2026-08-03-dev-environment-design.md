# Carrot Tickets dev environment — Design

**Date:** 2026-08-03
**Status:** Approved (pending spec review)
**Goal:** A real staging environment so payments — DeltaPay sandbox first — can be
tested end to end without touching production data.

---

## 1. Why

There is currently **no** non-production environment. Two findings established this:

- `keshless-tickets-api` looks like a dev service but points at the **same Atlas
  cluster and the same database** (`keshless-tickets`) as production. Its only real
  differences are `NODE_ENV=development` and `CORS_ORIGINS=*`. It is a second,
  permissively-CORS'd front door onto live data, last deployed 2026-06-23.
- Local development proxies to the **live production API** (`landing/.env.development.local`
  sets `VITE_API_BASE_URL=http://localhost:5173`, and Vite forwards `/api` to prod).

So any payment test today mints real tickets and writes real sales rows.

## 2. Non-goals

- Not a load/performance environment.
- No seeded test data in this pass (events/buyers created by hand). A seed script is
  a candidate follow-up.
- Not a second region or any HA posture.
- No change to how production deploys.

---

## 3. Topology

| Piece | Dev | Prod (unchanged) |
|---|---|---|
| API service | `carrot-tickets-api-dev` (Cloud Run, europe-west1, contracts-470406) | `carrot-tickets-api` |
| API hostname | `dev-api.carrottickets.com` | `api.carrottickets.com` |
| Database | `carrot-tickets-dev` (same Atlas cluster) | `keshless-tickets` |
| Landing | `dev.carrottickets.com` — Pages project `carrot-tickets-landing-dev` | `carrottickets.com` |
| Dashboard | `dev-manage.carrottickets.com` — Pages project `carrot-tickets-admin-dev` | `manage.carrottickets.com` |
| Deploys from | branch `dev` | `main` (api, dashboard) / `master` (landing) |

### Why dedicated dev Pages projects rather than preview deployments

Preview deployments mint a new hostname per deploy, which is exactly the churn we want
to avoid, and Pages custom domains attach to a project's **production branch**. Giving
each dev project a production branch of `dev` yields one stable custom domain per
surface, per-project environment variables (no risk of dev config leaking into the
production project), and clean Access targeting.

---

## 4. Isolation invariants

These are the properties that make the environment safe. Each is a hard requirement.

1. **Separate `JWT_SECRET`.** The single most important line here. If dev reused
   production's secret, a token minted in dev would authenticate against production.
   Generate independently (`openssl rand -hex 32`).
2. **Separate database.** Test purchases must never appear in real sales, revenue
   reports, or settlement figures.
3. **Scoped `CORS_ORIGINS`** — the dev frontends plus `localhost`. `corsOrigins.util`
   already rejects dangerously-broad wildcards at boot; that mechanism is reused, not
   worked around. Never `*`.
4. **No production provider credentials in dev.** Every payment provider runs against
   its sandbox, with dev-specific secrets.

---

## 5. Environment variables

Production carries ~50 env vars **directly on the Cloud Run service** (the repo's
`cloudbuild.yaml` is dead — the live trigger uses Google's auto-generated deploy
config with no `--set-env-vars`, so values persist across deploys). Dev is built by
copying that set and overriding:

| Variable | Dev value |
|---|---|
| `NODE_ENV`, `SENTRY_ENVIRONMENT` | `development` |
| `MONGODB_URI` | same cluster, database `carrot-tickets-dev` |
| `JWT_SECRET` | freshly generated, dev-only |
| `CORS_ORIGINS` | `https://dev.carrottickets.com,https://dev-manage.carrottickets.com,http://localhost:5173` |
| `SERVER_NAME` | `carrot-tickets-api-dev` |
| `CARD_RESULT_URL`, `MTN_MOMO_CALLBACK_URL`, `DELTAPAY_RETURN_URL`, `DELTAPAY_CALLBACK_URL` | dev host |
| `CARD_RESULT_PAGE_URL` / `PAYMENT_RESULT_PAGE_URL` | `https://dev.carrottickets.com/payment-result` |
| `SMS_ENABLED` / `SMS_ALLOWLIST` | `true` / `+26878422613` (see §7) |
| `API_DOCS_ENABLED` | `true` — docs are useful in dev; they stay off in prod |

All updates use `--update-env-vars` / `--update-secrets` (additive). Never
`--set-env-vars`, which wipes every other binding.

Media (R2) initially shares the production bucket. Rationale: uploads are additive and
keyed by id, so dev cannot corrupt prod objects, and a separate bucket adds credentials
and CDN wiring for little gain. Revisit if dev ever needs destructive media tests.

---

## 6. Payment providers in dev

| Provider | Dev configuration |
|---|---|
| **DeltaPay** | `DELTAPAY_BASE_URL=https://api.dev.deltacrypt.net`, dev API key, return/callback on the dev host. **DeltaPay must allow-list `dev-api.carrottickets.com`** — add this to the onboarding pack before sending. |
| **MTN MoMo** | sandbox `MTN_MOMO_TARGET_ENV`, sandbox subscription key / API user / API key as dev secrets |
| **Peach card** | test credentials, or `CARD_PAYMENTS_ENABLED=false` until card testing is wanted |
| **Keshless** | already `dev-api.keshless.com` in both environments — unchanged |

---

## 7. SMS gate (code change)

`SMS_ENABLED`, `SEND_PURCHASE_SMS`, `SEND_EVENT_REMINDER_SMS` and
`SEND_CANCELLATION_SMS` are set on the production service but **read nowhere in the
codebase** — only `SMS_SENDER_ID` is used. They are decorative today, so setting
`SMS_ENABLED=false` would silently keep texting.

Add a single gate in `sms.service.ts`:

- `SMS_ENABLED` — default **true**, so production behaviour is unchanged.
- `SMS_ALLOWLIST` — comma-separated E.164 numbers. When set, only those numbers
  receive messages; everything else is logged and skipped.

Numbers are compared through the existing `normalizePhone` util so `78422613` and
`+26878422613` match. This is a delivery *policy*, not a failure: a skipped send is
logged plainly and does not surface as an error, since it is the configured intent.
Genuine send failures keep throwing exactly as they do now.

---

## 8. Zero Trust

Cloudflare Access protects the two dev **frontends** only:

- `dev.carrottickets.com`
- `dev-manage.carrottickets.com`

Policy: allow-list specific email addresses (to be supplied), one-time PIN.

**The dev API is deliberately NOT behind Access.** Access authenticates humans via a
login redirect and a session cookie:

- DeltaPay's session callback and MTN's callback are server-to-server with no browser
  and no identity — Access would reject them, producing "our callback never arrives"
  failures caused entirely by our own gate.
- The API is on a different hostname from the frontends, so browser XHR would need its
  own Access session; Access answers unauthenticated requests with a redirect to a
  login page, which CORS preflight cannot follow. Every API call would fail opaquely.

The dev API's protection is structural: its own database, its own JWT secret, no real
customer data.

---

## 9. Deploy path

A `dev` branch in each repo:

- **API** — new Cloud Build trigger on `dev` → deploys `carrot-tickets-api-dev`. Note
  the production trigger's GitHub record still carries the pre-rename repo name and
  its webhook is stale, so production deploys are run manually
  (`gcloud builds triggers run`). The dev trigger is created fresh against the current
  repo, so it should fire on push; this gets verified rather than assumed.
- **Landing / dashboard** — the dev Pages projects build from `dev` automatically
  (both existing projects are git-connected, so this mechanism is proven).

Promotion is `dev` → `main`/`master` by normal PR/merge.

---

## 10. Retiring `keshless-tickets-api`

Once dev is verified, delete the service. It serves production data with
`CORS_ORIGINS=*`, has not been deployed since 2026-06-23, and its only remaining
purpose — a non-production-looking URL — is what the new dev environment provides
properly. Deletion happens **after** dev is confirmed working, never before.

---

## 11. Work requiring the user

| Item | Why |
|---|---|
| Cloudflare token (contracts account) with Zone:DNS:Edit, Access: Apps and Policies:Edit, Pages:Edit, Zone:Read | The existing contracts token is Pages-only — DNS and Access both return `Authentication error`. **Must be the contracts account (`Turings.noble@gmail.com`, `9f074c8d…`), never the Omevision/hiyebo token.** |
| Access email list | Who may reach the dev frontends |
| DeltaPay dev API key | Arrives with the onboarding response |
| MoMo sandbox credentials | If MoMo testing is wanted on day one |

Store the token in Secret Manager (`CONTRACTS_CLOUDFLARE__API_TOKEN`, project
`contracts-470406`) rather than pasting it into a transcript.

---

## 12. Verification

The environment is done when, against `dev-api.carrottickets.com`:

1. `/health` returns 200 and the service reports `NODE_ENV=development`.
2. A test event created in the dev dashboard appears **only** in the dev database —
   confirmed absent from production.
3. A DeltaPay sandbox purchase completes end to end: redirect → pay → return →
   ticket minted → sale visible in the dev dashboard.
4. The confirmation SMS reaches the allow-listed number, and a purchase with any other
   phone number logs a skip rather than sending.
5. `dev.carrottickets.com` prompts for Access login; an allow-listed email gets in and
   others do not.
6. Production is untouched: `api.carrottickets.com` still healthy, its payment methods
   unchanged, no dev rows in production collections.

---

## 13. Out of scope

- Seed/fixture data (candidate follow-up).
- Moving the ~50 plaintext env vars into Secret Manager. Worth doing — `MONGODB_URI`,
  `JWT_SECRET`, R2 keys, the VAPID private key, `YEBOLINK_API_KEY` and
  `TRANSCODER_SHARED_SECRET` are all plain values on the service — but it is a separate
  piece of work with its own risk, and bundling it here would make this change hard to
  reason about.
- A dev instance of the realtime gateway or transcoder; dev points at the production
  transcoder or leaves media transcoding unconfigured.
