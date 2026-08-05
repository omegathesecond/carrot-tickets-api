# Dev/Staging Environment

Carrot Tickets has a real dev/staging environment: its own Cloud Run API, its own
database, and its own frontends — separate from production top to bottom. This
document is the operational runbook for it.

## The three dev URLs

| Surface | URL | What it is |
|---|---|---|
| API | `https://dev-api.carrottickets.com` | Cloud Run service `carrot-tickets-api-dev` (europe-west1, project `contracts-470406`) |
| Landing / storefront | `https://dev.carrottickets.com` | Cloudflare Pages project `carrot-tickets-landing-dev` |
| Dashboard (organizer/admin) | `https://dev-manage.carrottickets.com` | Cloudflare Pages project `carrot-tickets-admin-dev` |

Production equivalents, for contrast: `api.carrottickets.com`, `carrottickets.com`,
`manage.carrottickets.com`.

## Access control on the two frontends

`dev.carrottickets.com` and `dev-manage.carrottickets.com` sit behind **Cloudflare
Access** (Zero Trust team `omevision-contracts.cloudflareaccess.com`). Anyone who is
not signed in is redirected to a Cloudflare login page and asked for a one-time PIN
emailed to an allow-listed address. As of this writing the allow-list contains exactly
one address: `laslie@hiyebo.com`. To let someone else in, add their email to the
Access policy for both applications in the Cloudflare Zero Trust dashboard — there is
no code change involved.

## The dev API is deliberately NOT behind Access

`dev-api.carrottickets.com` is reachable by anyone, unauthenticated, at the transport
level (its own routes still enforce normal JWT/admin auth). This is intentional, not
an oversight:

- **Payment-provider callbacks are server-to-server.** MTN MoMo's callback and
  DeltaPay's session callback/return hit the API directly with no browser and no
  human identity attached. Cloudflare Access answers unauthenticated requests with a
  login redirect — the callback would just fail, and the failure would look like a
  bug in our integration when it's actually our own gate blocking it.
- **Cross-hostname XHR can't follow an Access login redirect.** The frontends live on
  a different hostname than the API. If the API were behind Access too, a browser
  fetch from the dashboard/storefront to the API would need its own separate Access
  session; an unauthenticated call gets a redirect-to-login response instead of JSON,
  which CORS preflight cannot follow. Every API call would fail opaquely.

The dev API's actual protection is structural, not network-level: it has its own
database (empty of real data) and its own JWT secret, so nothing reachable through it
touches production data or production sessions.

## Deploying dev

**There is no Cloud Build trigger for dev, and there never has been one.** Creating
one requires a 2nd-gen (Developer Connect) GitHub connection for the
`contracts-470406` project, which does not exist — the project only has the legacy
1st-gen "classic" GitHub App connection, and a service account cannot use that
connection to *create* a new trigger (only a human's GitHub-linked identity can).
Pushing to `dev` on GitHub does **not** trigger a deploy.

Production is in the same situation: its trigger's webhook is stale, so pushing to
`main` doesn't reliably deploy it either. **For both environments, deploys are a
manual, deliberate action** — nothing here auto-deploys on push. Don't assume a merge
means the service updated; go run the build.

To deploy dev, from a clean checkout of the `dev` branch:

```bash
git checkout dev && git pull
gcloud --configuration=deployer builds submit --config=cloudbuild-dev.yaml \
  --project=contracts-470406 \
  --substitutions=_IMAGE=europe-west1-docker.pkg.dev/contracts-470406/cloud-run-source-deploy/carrot-tickets-api/carrot-tickets-api-dev:$(git rev-parse --short HEAD) .
```

`cloudbuild-dev.yaml` defaults `_IMAGE` to a tag ending in `${COMMIT_SHA}`. That
variable is only populated when Cloud Build is triggered from a connected GitHub
repo — a local `gcloud builds submit` leaves it empty, producing an invalid image
reference (`...carrot-tickets-api-dev:`) that fails at step 0. Always pass
`--substitutions=_IMAGE=...` explicitly as shown above.

`cloudbuild-dev.yaml` (on the `dev` branch — it does not exist on `main`) builds the
image, pushes it to Artifact Registry, and runs `gcloud run services update
carrot-tickets-api-dev --image=... --region=europe-west1`. Note it deliberately does
**not** pass `--set-env-vars` or `--set-secrets` — env/secret bindings on the Cloud
Run service are managed separately (see "wiring a new secret/env var" convention
below) and survive redeploys untouched.

To promote dev to production: merge/PR `dev` into `main` (API, dashboard) or `master`
(landing) through the normal GitHub flow, then run production's equivalent manual
build-and-deploy (its trigger is stale for the same reason dev's doesn't exist).

**Wiring a new secret or env var:** always use `--update-secrets` /
`--update-env-vars` against the Cloud Run service, never `--set-secrets` /
`--set-env-vars` — those replace every existing binding, not just the one you're
adding.

A human still needs to either authorize a 2nd-gen GitHub connection for
`contracts-470406` (Cloud Console → Cloud Build → Connections) or manually create the
`carrot-tickets-api-dev` trigger under their own GitHub-authorized identity
(branch pattern `^dev$`, build config `cloudbuild-dev.yaml`) before dev gets real
push-to-deploy.

## Database

Dev uses database `carrot-tickets-dev` on the **same** Atlas cluster as production
(production is `keshless-tickets`) — separate database, not a separate cluster.

**The dev database is empty.** No production accounts, events, or tickets exist in
it. If you sign in to `dev-manage.carrottickets.com` with a production email/password,
it will not work — you need to sign up fresh on dev. This trips people up every time,
so: don't try to reuse production credentials on dev, create a new account instead.

Isolation between the two databases was verified programmatically as part of this
task by comparing the public events list on both APIs — dev returned 0 events, prod
returned its real 8 events, at the same instant. See the verification table in the
task report for the exact numbers.

## Dev has its own JWT secret

Dev's `JWT_SECRET` is freshly generated and is not shared with production. This
matters beyond hygiene: JWTs are just signed claims, so if dev and production shared a
signing secret, a token minted by the dev API (e.g. by an engineer testing something,
or by anyone who can reach the public dev API) would also be a **valid, accepted
token against the production API**. A separate `JWT_SECRET` means a dev-issued user
session token can never authenticate as a production user.

`SERVICE_KEY` (the shared secret the main Keshless API uses to authenticate
service-to-service calls, see `src/middleware/serviceAuth.middleware.ts`) is a
**separate credential from `JWT_SECRET`** and was previously a byte-identical copy of
production's — meaning dev was effectively a second deployment of a key that fully
authenticates (`permissions: ['all']`) against production. It has since been rotated
to its own random value on `carrot-tickets-api-dev`; production's `SERVICE_KEY` was
not touched.

### What dev DOES intentionally share with production

Not everything is isolated. By design, dev currently shares:

- **The R2 media bucket and CDN** (`UPDATES_R2_*`, `cdn.carrottickets.com`) — dev has
  no separate media bucket yet.
- **YeboLink credits** (`YEBOLINK_API_KEY`) — dev sends real international SMS out of
  the same workspace/credit pool as production.
- **The transcoder** (`TRANSCODER_URL`) — dev media uploads are processed by the same
  Cloud Run transcoder service as production.

**Dev writes to the production media bucket.** Uploading, overwriting, or deleting
media while testing on dev touches real production objects in R2/CDN. Do not run
destructive media tests (bulk delete, overwrite-by-key, etc.) against dev assuming
they're sandboxed — they aren't.

## SMS

`SMS_ALLOWLIST=+26878422613` is set on the dev API. This means dev's SMS sending path
only ever actually delivers to that one number — any other destination is skipped by
the allowlist check (logged per-send, see `sms.service.ts`), regardless of what a
purchase or test entered. This
keeps dev testing from spamming real phone numbers. To test with a different number,
update `SMS_ALLOWLIST` on the `carrot-tickets-api-dev` Cloud Run service (comma-separate
multiple numbers if more than one tester needs to receive dev SMS) — use
`--update-env-vars`, not `--set-env-vars`.

## Payment providers — enabling sandboxes as credentials arrive

| Provider | Dev status | To enable |
|---|---|---|
| MTN MoMo | **Disabled** (`MTN_MOMO_ENABLED=false`). Base URL and target env now point at the MTN sandbox (`https://sandbox.momodeveloper.mtn.com`, target env `sandbox`) — previously they pointed at the live production MTN endpoint (`proxy.momoapi.mtn.com` / `mtnswaziland`), which was a loaded gun even with the enable flag off. | Bind a sandbox `MTN_MOMO_SUBSCRIPTION_KEY` / `MTN_MOMO_API_USER` / `MTN_MOMO_API_KEY` via `--update-secrets`, then set `MTN_MOMO_ENABLED=true`. Never point dev at the production MoMo endpoint. |
| Peach (card) | Disabled (`CARD_PAYMENTS_ENABLED=false`) | Set `CARD_PAYMENTS_ENABLED=true` and bind sandbox Peach credentials via `--update-secrets` once Peach issues them |
| DeltaPay | Wired but disabled (`DELTAPAY_ENABLED=false`); base URL already pointed at the DeltaPay sandbox, `https://api.dev.deltacrypt.net`; callback/return URLs already point at `dev-api.carrottickets.com` | Once DeltaPay provisions the sandbox integration and issues an API key, bind the key via `--update-secrets` and flip `DELTAPAY_ENABLED=true`. Full registration details are in `docs/DELTAPAY_INTEGRATION.md`. |

In every case, flipping a provider on is an `--update-env-vars`/`--update-secrets`
call against `carrot-tickets-api-dev` — never `--set-env-vars`/`--set-secrets`, which
would wipe the other 40+ bindings on the service.

## Production note: `SMS_ENABLED`

While standing up this environment, production's `SMS_ENABLED` was found set to
`'false'` and corrected to `'true'`. It had been a decorative variable (not actually
gating anything) until the SMS gate shipped; once the gate went live, a lingering
`false` value would have silently muted all production SMS on the next deploy — no
error, tickets would just stop sending confirmation texts. If you're looking at this
variable and wondering whether it's safe to flip back to `false` "to be safe," it
isn't — `false` means no SMS goes out to real customers at all. Leave it `true`.

## Verifying the environment yourself

```bash
# dev
curl -s -o /dev/null -w '%{http_code}\n' https://dev-api.carrottickets.com/health          # expect 200
curl -s -o /dev/null -w '%{http_code}\n' https://dev-api.carrottickets.com/api-docs        # expect 301 (redirects to /api-docs/; add -L to follow and expect 200)
curl -s -o /dev/null -w '%{http_code}\n' https://dev-api.carrottickets.com/api/admin/users # expect 401

# prod, for contrast
curl -s -o /dev/null -w '%{http_code}\n' https://api.carrottickets.com/health              # expect 200
curl -s -o /dev/null -w '%{http_code}\n' https://api.carrottickets.com/api-docs            # expect 404 (docs gated in prod)
```

Note: `keshless-tickets-api`, an older Cloud Run service that still serves production
data with `CORS_ORIGINS=*`, has not been retired as part of this work — deleting it
needs explicit sign-off first. Do not treat it as part of the dev environment.
