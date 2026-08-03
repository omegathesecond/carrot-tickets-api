# Carrot Tickets Dev Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an isolated dev/staging environment (API + database + frontends) so payments can be tested end to end without touching production data.

**Architecture:** A second Cloud Run service `carrot-tickets-api-dev` on its own Mongo database and its own JWT secret, fronted by `dev-api.carrottickets.com`, with two dedicated Cloudflare Pages projects (`dev.carrottickets.com`, `dev-manage.carrottickets.com`) behind Cloudflare Access. All deploys come from a `dev` branch in each repo. One code change is required: a real SMS delivery gate, because the existing `SMS_ENABLED` env var is read nowhere.

**Tech Stack:** Node/TypeScript + Express + Mongoose, MongoDB Atlas, Google Cloud Run + Cloud Build (project `contracts-470406`, region `europe-west1`), Cloudflare Pages + Access (contracts account).

**Spec:** `docs/superpowers/specs/2026-08-03-dev-environment-design.md`

## Global Constraints

- **Cloudflare = the CONTRACTS account only** — `Turings.noble@gmail.com`, account `9f074c8dd70baaa27e08c1602bdec69a`. Never the Omevision/hiyebo token; it authenticates against a different account.
- **gcloud = the deployer SA** — `gcloud --configuration=deployer`, project `contracts-470406`, region `europe-west1`. Never `gcloud auth login`.
- **Env/secret updates on an EXISTING service are additive** — `--update-env-vars` / `--update-secrets`. Never `--set-env-vars` / `--set-secrets`, which wipe every other binding. (`--env-vars-file` on *initial creation* is fine; there is nothing to preserve.)
- **Never print a secret value** to stdout, a log, a commit, or a plan file. Pipe it; don't echo it.
- **Dev must never share production's `JWT_SECRET`** — a dev-minted token would authenticate against production.
- **Dev must never share production's database.**
- **No silent fallbacks** (repo-wide rule): a failure surfaces through the normal error channel. The one deliberate exception added here is the SMS allow-list skip, which is configured intent, not failure — it logs plainly and returns `false`.
- Production behaviour must be unchanged by Task 1. `SMS_ENABLED` defaults to **on**.

---

### Task 1: SMS delivery gate

The only code change in this plan. `SMS_ENABLED`, `SEND_PURCHASE_SMS`, `SEND_EVENT_REMINDER_SMS` and `SEND_CANCELLATION_SMS` are set on the production Cloud Run service but read nowhere in `src/` — only `SMS_SENDER_ID` is used. Setting `SMS_ENABLED=false` today changes nothing. This task makes the switch real and adds an allow-list so dev can send to one number without texting real buyers.

**Files:**
- Create: `src/utils/smsPolicy.util.ts`
- Create: `src/utils/__tests__/smsPolicy.util.test.ts`
- Modify: `src/services/sms.service.ts` (add the gate at the top of `private static async send`)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `normalizePhone` from `@utils/phone.util`.
- Produces: `shouldSendSms(phoneNumber: string): { send: boolean; reason?: string }` — consumed by `SmsService.send`. Reads `process.env` at CALL time (not module load) so tests can vary env without `jest.resetModules()`.

- [ ] **Step 1: Write the failing test**

Create `src/utils/__tests__/smsPolicy.util.test.ts`:

```typescript
import { shouldSendSms } from '@utils/smsPolicy.util';

describe('shouldSendSms', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD }; });
  afterEach(() => { process.env = OLD; });

  it('sends by default when nothing is configured (production behaviour)', () => {
    delete process.env['SMS_ENABLED'];
    delete process.env['SMS_ALLOWLIST'];
    expect(shouldSendSms('+26878422613').send).toBe(true);
  });

  it('blocks everything when SMS_ENABLED is exactly "false"', () => {
    process.env['SMS_ENABLED'] = 'false';
    const r = shouldSendSms('+26878422613');
    expect(r.send).toBe(false);
    expect(r.reason).toMatch(/disabled/i);
  });

  it('treats any other SMS_ENABLED value as enabled — fail OPEN, never silently mute prod', () => {
    process.env['SMS_ENABLED'] = 'yes';
    expect(shouldSendSms('+26878422613').send).toBe(true);
  });

  it('allows only allow-listed numbers when SMS_ALLOWLIST is set', () => {
    process.env['SMS_ALLOWLIST'] = '+26878422613';
    expect(shouldSendSms('+26878422613').send).toBe(true);
    const blocked = shouldSendSms('+26876000000');
    expect(blocked.send).toBe(false);
    expect(blocked.reason).toMatch(/allow-list/i);
  });

  it('matches allow-list entries through normalizePhone, so local and E.164 forms agree', () => {
    process.env['SMS_ALLOWLIST'] = '78422613';           // local form configured
    expect(shouldSendSms('+26878422613').send).toBe(true); // E.164 at call site
  });

  it('ignores blank entries and whitespace in the allow-list', () => {
    process.env['SMS_ALLOWLIST'] = ' +26878422613 , ,';
    expect(shouldSendSms('+26878422613').send).toBe(true);
    expect(shouldSendSms('+26876000000').send).toBe(false);
  });

  it('an empty SMS_ALLOWLIST means "no allow-list", not "block everything"', () => {
    process.env['SMS_ALLOWLIST'] = '';
    expect(shouldSendSms('+26876000000').send).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/utils/__tests__/smsPolicy.util.test.ts`
Expected: FAIL — `Cannot find module '@utils/smsPolicy.util'`

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/smsPolicy.util.ts`:

```typescript
/**
 * Outbound SMS delivery policy.
 *
 * Two switches, both read at CALL time so a redeploy isn't needed to change
 * them and tests can vary env without module-cache games:
 *
 *   SMS_ENABLED    — set to exactly 'false' to mute all outbound SMS.
 *   SMS_ALLOWLIST  — comma-separated numbers; when non-empty, ONLY these
 *                    receive messages. Used in dev so test purchases can't
 *                    text real buyers or burn gateway credits.
 *
 * Both FAIL OPEN: absent or unparseable config means "send", because silently
 * muting production SMS is far worse than an unexpected send. This mirrors the
 * repo's no-silent-fallback stance — a skipped send is configured intent and is
 * logged plainly, never disguised as success.
 */
import { normalizePhone } from '@utils/phone.util';

export interface SmsPolicyDecision {
  send: boolean;
  reason?: string;
}

export function shouldSendSms(phoneNumber: string): SmsPolicyDecision {
  if (process.env['SMS_ENABLED'] === 'false') {
    return { send: false, reason: 'SMS_ENABLED=false — outbound SMS disabled' };
  }

  const raw = (process.env['SMS_ALLOWLIST'] || '').trim();
  if (!raw) return { send: true };

  const allowed = raw
    .split(',')
    .map((n) => normalizePhone(n.trim()))
    .filter(Boolean);
  if (allowed.length === 0) return { send: true };

  const target = normalizePhone(phoneNumber);
  if (allowed.includes(target)) return { send: true };

  return { send: false, reason: `not on SMS_ALLOWLIST (${allowed.length} entr${allowed.length === 1 ? 'y' : 'ies'})` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/utils/__tests__/smsPolicy.util.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Wire the gate into the single send choke point**

In `src/services/sms.service.ts`, add the import beside the existing ones:

```typescript
import { shouldSendSms } from '@utils/smsPolicy.util';
```

Then insert at the very top of `private static async send(phoneNumber: string, message: string): Promise<boolean> {`, BEFORE the existing `const normalized = normalizePhone(phoneNumber);` line:

```typescript
    // Delivery policy gate. `send` is the single choke point — sendInternational
    // is only ever reached from here — so gating once covers both legs.
    const policy = shouldSendSms(phoneNumber);
    if (!policy.send) {
      console.log(`[SMS] Skipped send to ${phoneNumber}: ${policy.reason}`);
      return false;
    }
```

- [ ] **Step 6: Verify nothing else regressed**

Run: `npx tsc --noEmit && npx jest`
Expected: typecheck clean; all suites pass (242+ suites, 1207+ tests).

- [ ] **Step 7: Document the two variables**

In `.env.example`, replace the existing `SMS_ENABLED` line (or add beneath `SMS_SENDER_ID` if absent) with:

```bash
# Outbound SMS policy. Both fail OPEN — absent config means "send".
# Set to exactly 'false' to mute ALL outbound SMS.
SMS_ENABLED=true
# When non-empty, ONLY these numbers receive SMS (comma-separated, any format —
# matched via normalizePhone). Used in dev so tests can't text real buyers.
SMS_ALLOWLIST=
```

- [ ] **Step 8: Commit**

```bash
git add src/utils/smsPolicy.util.ts src/utils/__tests__/smsPolicy.util.test.ts src/services/sms.service.ts .env.example
git commit -m "feat(sms): make SMS_ENABLED real and add SMS_ALLOWLIST

SMS_ENABLED was set on the production service but read nowhere in src/, so
setting it to false would have silently kept texting buyers. Adds a policy gate
at SmsService.send - the single choke point both the Keshless and YeboLink legs
pass through.

Both switches fail OPEN: absent or unparseable config sends, because silently
muting production SMS is worse than an unexpected send. Production behaviour is
unchanged until SMS_ENABLED/SMS_ALLOWLIST are explicitly set.

SMS_ALLOWLIST exists for the dev environment, so test purchases can reach one
verification number without texting real buyers or burning gateway credits."
```

---

### Task 2: Dev database and dev-only secrets

No code. Creates the isolated database URI and the dev JWT secret. A Mongo database is created implicitly on first write, so "creating" it means deriving a URI with a new database name.

**Files:** none (infrastructure only)

**Interfaces:**
- Produces: Secret Manager secrets `CARROT_DEV__MONGODB_URI` and `CARROT_DEV__JWT_SECRET` in project `contracts-470406`, consumed by Task 3.

- [ ] **Step 1: Derive the dev Mongo URI without printing it**

```bash
gcloud --configuration=deployer run services describe carrot-tickets-api \
  --region=europe-west1 --project=contracts-470406 --format=json \
| python3 -c "
import json,sys,re
s=json.load(sys.stdin)
env={e['name']:e.get('value','') for e in s['spec']['template']['spec']['containers'][0].get('env',[]) if 'value' in e}
uri=env['MONGODB_URI']
dev=re.sub(r'(@[^/]+/)([^?]+)', r'\1carrot-tickets-dev', uri)
assert 'carrot-tickets-dev' in dev and dev!=uri, 'URI rewrite failed - inspect the format by hand'
open('/tmp/carrot-dev-uri','w').write(dev)
print('dev URI written to /tmp/carrot-dev-uri; database name is carrot-tickets-dev')
"
```

- [ ] **Step 2: Confirm the rewrite changed ONLY the database name**

```bash
python3 -c "
import re
d=open('/tmp/carrot-dev-uri').read()
m=re.search(r'@([^/]+)/([^?]+)', d)
print('host unchanged (masked):', m.group(1)[:6]+'…')
print('database:', m.group(2))
assert m.group(2)=='carrot-tickets-dev'
"
```
Expected: `database: carrot-tickets-dev`

- [ ] **Step 3: Store it as a secret and shred the temp file**

```bash
gcloud --configuration=deployer secrets create CARROT_DEV__MONGODB_URI \
  --data-file=/tmp/carrot-dev-uri --project=contracts-470406
rm -f /tmp/carrot-dev-uri
```

- [ ] **Step 4: Generate a dev-only JWT secret**

```bash
openssl rand -hex 32 | tr -d '\n' \
| gcloud --configuration=deployer secrets create CARROT_DEV__JWT_SECRET \
    --data-file=- --project=contracts-470406
```
The value is never printed. It MUST differ from production's — that is the whole point.

- [ ] **Step 5: Grant the runtime service account access**

```bash
SA=$(gcloud --configuration=deployer run services describe carrot-tickets-api \
  --region=europe-west1 --project=contracts-470406 \
  --format='value(spec.template.spec.serviceAccountName)')
echo "runtime SA: $SA"
for s in CARROT_DEV__MONGODB_URI CARROT_DEV__JWT_SECRET; do
  gcloud --configuration=deployer secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor \
    --project=contracts-470406 --quiet
done
```
Check the SA that is printed — Omevision services often use a dedicated runtime SA rather than the default Compute one, and granting the wrong SA produces a deploy that fails with "Permission denied on secret".

- [ ] **Step 6: Verify both secrets exist and are readable**

```bash
gcloud --configuration=deployer secrets versions access latest \
  --secret=CARROT_DEV__JWT_SECRET --project=contracts-470406 | wc -c
```
Expected: `64` (32 hex bytes, no trailing newline). Do not print the value itself.

---

### Task 3: Create the dev Cloud Run service

**Files:** none (infrastructure only)

**Interfaces:**
- Consumes: `CARROT_DEV__MONGODB_URI`, `CARROT_DEV__JWT_SECRET` (Task 2).
- Produces: Cloud Run service `carrot-tickets-api-dev` and its `*.run.app` URL, consumed by Tasks 4, 6, 8.

- [ ] **Step 1: Build the dev env-vars file from production's, with overrides**

```bash
gcloud --configuration=deployer run services describe carrot-tickets-api \
  --region=europe-west1 --project=contracts-470406 --format=json \
| python3 -c "
import json,sys,yaml
s=json.load(sys.stdin)
c=s['spec']['template']['spec']['containers'][0]
env={e['name']:e['value'] for e in c.get('env',[]) if 'value' in e}

# Secret-backed vars are re-bound separately in Step 3; drop any plain copies.
for k in ['MONGODB_URI','JWT_SECRET']:
    env.pop(k, None)

env.update({
  'NODE_ENV':'development',
  'SENTRY_ENVIRONMENT':'development',
  'SERVER_NAME':'carrot-tickets-api-dev',
  'SENTRY_RELEASE':'carrot-tickets-api-dev@1.0.0',
  'CORS_ORIGINS':'https://dev.carrottickets.com,https://dev-manage.carrottickets.com,http://localhost:5173,http://localhost:5174',
  'API_DOCS_ENABLED':'true',
  'SMS_ENABLED':'true',
  'SMS_ALLOWLIST':'+26878422613',
  'CARD_RESULT_URL':'https://dev-api.carrottickets.com/api/public/purchase/peach-card/return',
  'CARD_RESULT_PAGE_URL':'https://dev.carrottickets.com/payment-result',
  'PAYMENT_RESULT_PAGE_URL':'https://dev.carrottickets.com/payment-result',
  'MTN_MOMO_CALLBACK_URL':'https://dev-api.carrottickets.com/api/momo/callback',
  # Card + DeltaPay start OFF in dev; enabled per-provider once sandbox creds land.
  'CARD_PAYMENTS_ENABLED':'false',
  'DELTAPAY_ENABLED':'false',
  'DELTAPAY_BASE_URL':'https://api.dev.deltacrypt.net',
  'DELTAPAY_RETURN_URL':'https://dev-api.carrottickets.com/api/public/purchase/deltapay/return',
  'DELTAPAY_CALLBACK_URL':'https://dev-api.carrottickets.com/api/public/purchase/deltapay/callback',
})
yaml.safe_dump(env, open('/tmp/carrot-dev-env.yaml','w'), default_flow_style=False)
print(f'{len(env)} env vars written')
"
```

- [ ] **Step 2: Eyeball the file before it becomes a service**

```bash
grep -E "NODE_ENV|CORS_ORIGINS|SMS_|DELTAPAY_|MONGODB|JWT" /tmp/carrot-dev-env.yaml
```
Expected: `NODE_ENV: development`, dev CORS origins, `SMS_ALLOWLIST` present, **no `MONGODB_URI` and no `JWT_SECRET`** (those arrive as secrets in Step 3).

- [ ] **Step 3: Create the service off the current production image**

```bash
IMAGE=$(gcloud --configuration=deployer run services describe carrot-tickets-api \
  --region=europe-west1 --project=contracts-470406 \
  --format='value(spec.template.spec.containers[0].image)')
SA=$(gcloud --configuration=deployer run services describe carrot-tickets-api \
  --region=europe-west1 --project=contracts-470406 \
  --format='value(spec.template.spec.serviceAccountName)')

gcloud --configuration=deployer run deploy carrot-tickets-api-dev \
  --image="$IMAGE" \
  --region=europe-west1 --project=contracts-470406 \
  --service-account="$SA" \
  --allow-unauthenticated \
  --env-vars-file=/tmp/carrot-dev-env.yaml \
  --update-secrets=MONGODB_URI=CARROT_DEV__MONGODB_URI:latest,JWT_SECRET=CARROT_DEV__JWT_SECRET:latest,KESHLESS_API_KEY=keshless-tickets-keshless-api-key:latest \
  --quiet
rm -f /tmp/carrot-dev-env.yaml
```

`--allow-unauthenticated` is required: provider callbacks (DeltaPay, MTN) are server-to-server with no identity. Protection is the separate database and JWT secret, not network gating — see spec §8.

- [ ] **Step 4: Verify it is alive and is genuinely a dev environment**

```bash
DEV=$(gcloud --configuration=deployer run services describe carrot-tickets-api-dev \
  --region=europe-west1 --project=contracts-470406 --format='value(status.url)')
echo "dev URL: $DEV"
curl -s -o /dev/null -w "health: %{http_code}\n" "$DEV/health"
curl -s "$DEV/api/public/events?limit=1" | head -c 200; echo
```
Expected: `health: 200`, and the events list is **empty** — proof it is on a fresh database rather than production's.

- [ ] **Step 5: Prove database isolation explicitly**

```bash
PROD=$(curl -s "https://api.carrottickets.com/api/public/events?limit=50" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['data']['events']))")
DEVC=$(curl -s "$DEV/api/public/events?limit=50" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['data']['events']))")
echo "prod events: $PROD | dev events: $DEVC"
[ "$DEVC" = "0" ] && echo "OK: dev database is separate" || echo "!! STOP: dev is reading production data"
```
If dev returns production's events, **stop and fix the URI before going further** — every later step assumes isolation.

---

### Task 4: `dev` branches and the dev Cloud Build trigger

**Files:** none in-repo; creates branches and a trigger.

**Interfaces:**
- Consumes: service `carrot-tickets-api-dev` (Task 3).
- Produces: a `dev` branch in all three repos (consumed by Task 5) and an auto-deploy trigger.

- [ ] **Step 1: Create the `dev` branch in each repo from its production branch**

```bash
cd ~/Documents/omevision/contracts/carrot-tickets/api       && git checkout -b dev main    && git push -u origin dev
cd ~/Documents/omevision/contracts/carrot-tickets/landing   && git checkout -b dev master  && git push -u origin dev
cd ~/Documents/omevision/contracts/carrot-tickets/dashboard && git checkout -b dev main    && git push -u origin dev
```

- [ ] **Step 2: Create the trigger against the CURRENT repo name**

```bash
gcloud --configuration=deployer builds triggers create github \
  --name=carrot-tickets-api-dev \
  --repo-owner=omegathesecond --repo-name=carrot-tickets-api \
  --branch-pattern='^dev$' \
  --build-config=cloudbuild-dev.yaml \
  --region=global --project=contracts-470406
```

If this fails with a repo-connection error, the GitHub App connection is registered under the pre-rename name (`keshless-tickets-api`) — the same quirk that leaves the production trigger's webhook stale. In that case create it with `--repo-name=keshless-tickets-api`; GitHub's rename redirect resolves it to the same repo id.

- [ ] **Step 3: Add the dev build config**

Create `cloudbuild-dev.yaml` in the api repo (the root `cloudbuild.yaml` is dead — it still names `keshless-tickets-api`/`us-central1` and is not used by any trigger):

```yaml
steps:
  - id: Build
    name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '${_IMAGE}', '.', '-f', 'Dockerfile']
  - id: Push
    name: gcr.io/cloud-builders/docker
    args: ['push', '${_IMAGE}']
  - id: Deploy
    name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    entrypoint: gcloud
    args:
      - run
      - services
      - update
      - carrot-tickets-api-dev
      - --platform=managed
      - --image=${_IMAGE}
      - --region=europe-west1
      - --quiet
substitutions:
  _IMAGE: europe-west1-docker.pkg.dev/contracts-470406/cloud-run-source-deploy/carrot-tickets-api/carrot-tickets-api-dev:${COMMIT_SHA}
images: ['${_IMAGE}']
options:
  logging: CLOUD_LOGGING_ONLY
```

The deploy step deliberately carries **no** `--set-env-vars`/`--set-secrets`, so the env wired in Task 3 persists across every dev deploy — matching how production already works.

- [ ] **Step 4: Commit and push to `dev`, then confirm the trigger fired**

```bash
cd ~/Documents/omevision/contracts/carrot-tickets/api
git add cloudbuild-dev.yaml
git commit -m "ci: add dev build config deploying carrot-tickets-api-dev

Env and secrets are wired on the service and intentionally not set here, so
they survive every deploy - same arrangement as production."
git push origin dev
sleep 30
gcloud --configuration=deployer builds list --limit=3 --region=global \
  --project=contracts-470406 --format='table(id,status,substitutions.BRANCH_NAME)'
```
Expected: a build for branch `dev`. If none appears the webhook is stale like production's; deploy dev with `gcloud builds triggers run carrot-tickets-api-dev --branch=dev` and note it in the runbook.

---

### Task 5: Dev Cloudflare Pages projects

Two dedicated projects whose *production branch* is `dev`, so each deploy lands on one stable custom domain instead of a per-deploy preview URL.

**Files:** none in-repo.

**Interfaces:**
- Consumes: the `dev` branches (Task 4).
- Produces: Pages projects `carrot-tickets-landing-dev` and `carrot-tickets-admin-dev`, consumed by Tasks 6 and 7.

- [ ] **Step 1: Fetch the contracts Cloudflare token**

```bash
export CF_TOKEN=$(gcloud --configuration=deployer secrets versions access latest \
  --secret=CONTRACTS_CLOUDFLARE__API_TOKEN --project=contracts-470406)
export CF_ACC=9f074c8dd70baaa27e08c1602bdec69a
```
This is the **contracts** account token, not the Omevision/hiyebo one.

- [ ] **Step 2: Confirm the new token actually has DNS + Access**

```bash
for u in "accounts/$CF_ACC/access/apps" "zones/671d22108d4d17b21b96128f0f27108e/dns_records?per_page=1"; do
  printf "%-46s " "$u"
  curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/$u" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('OK' if d.get('success') else 'DENIED')"
done
```
Expected: both `OK`. If either is `DENIED`, the token lacks a permission — fix it before continuing rather than working around it.

- [ ] **Step 3: Create both dev Pages projects with `dev` as the production branch**

```bash
create_pages () {  # $1=project name  $2=github repo  $3=api base url var value
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACC/pages/projects" \
  -d "{
    \"name\": \"$1\",
    \"production_branch\": \"dev\",
    \"source\": { \"type\": \"github\", \"config\": {
        \"owner\": \"omegathesecond\", \"repo_name\": \"$2\",
        \"production_branch\": \"dev\", \"deployments_enabled\": true }},
    \"build_config\": { \"build_command\": \"npm run build\", \"destination_dir\": \"dist\" },
    \"deployment_configs\": { \"production\": { \"env_vars\": $3 }}
  }" | python3 -c "import json,sys; d=json.load(sys.stdin); print('OK' if d.get('success') else d.get('errors'))"
}

create_pages carrot-tickets-landing-dev carrot-tickets-website \
 '{"VITE_API_BASE_URL":{"value":"https://dev-api.carrottickets.com"},"VITE_DASHBOARD_URL":{"value":"https://dev-manage.carrottickets.com"},"VITE_REALTIME_URL":{"value":"https://realtime.carrottickets.com"}}'

create_pages carrot-tickets-admin-dev carrot-tickets-dashboard \
 '{"VITE_API_URL":{"value":"https://dev-api.carrottickets.com/api"}}'
```

Note the dashboard uses `VITE_API_URL` **with** an `/api` suffix while the landing site uses `VITE_API_BASE_URL` **without** one — they genuinely differ; copying one into the other yields 404s on every call.

- [ ] **Step 4: Verify both projects exist and are pinned to `dev`**

```bash
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACC/pages/projects" \
| python3 -c "
import json,sys
for p in json.load(sys.stdin)['result']:
    if p['name'].endswith('-dev'):
        print(p['name'], '| prod branch:', p.get('production_branch'), '| subdomain:', p.get('subdomain'))
"
```
Expected: both projects listed with production branch `dev`.

---

### Task 6: Custom domains and DNS

**Files:** none.

**Interfaces:**
- Consumes: Cloud Run service (Task 3), Pages projects (Task 5), `CF_TOKEN`/`CF_ACC` (Task 5 Step 1).
- Produces: `dev-api.carrottickets.com`, `dev.carrottickets.com`, `dev-manage.carrottickets.com`.

- [ ] **Step 1: Map the API domain to Cloud Run**

```bash
gcloud --configuration=deployer beta run domain-mappings create \
  --service=carrot-tickets-api-dev --domain=dev-api.carrottickets.com \
  --region=europe-west1 --project=contracts-470406
```
If this fails on domain verification, the deployer SA is not a verified owner of `carrottickets.com`. Verify via the Site Verification API (mint a token with `gcloud --configuration=deployer auth print-access-token --scopes=https://www.googleapis.com/auth/siteverification`, `POST siteVerification/v1/token` for DNS_TXT, add the TXT via the CF token, then `POST siteVerification/v1/webResource?verificationMethod=DNS_TXT`).

- [ ] **Step 2: Add the API CNAME — DNS-only, never proxied**

```bash
ZONE=671d22108d4d17b21b96128f0f27108e
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  -d '{"type":"CNAME","name":"dev-api","content":"ghs.googlehosted.com","proxied":false}' \
| python3 -c "import json,sys; d=json.load(sys.stdin); print('OK' if d.get('success') else d.get('errors'))"
```
`proxied:false` is required — proxying breaks Google's managed-certificate issuance.

- [ ] **Step 3: Attach the frontend custom domains to their Pages projects**

```bash
add_domain () {  # $1=project  $2=fqdn
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACC/pages/projects/$1/domains" \
  -d "{\"name\":\"$2\"}" \
| python3 -c "import json,sys; d=json.load(sys.stdin); print('OK' if d.get('success') else d.get('errors'))"
}
add_domain carrot-tickets-landing-dev dev.carrottickets.com
add_domain carrot-tickets-admin-dev  dev-manage.carrottickets.com
```

- [ ] **Step 4: Add the two frontend CNAMEs — proxied, so Access can front them**

```bash
for pair in "dev:carrot-tickets-landing-dev" "dev-manage:carrot-tickets-admin-dev"; do
  name=${pair%%:*}; proj=${pair##*:}
  sub=$(curl -s -H "Authorization: Bearer $CF_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACC/pages/projects/$proj" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['subdomain'])")
  curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
    -d "{\"type\":\"CNAME\",\"name\":\"$name\",\"content\":\"$sub\",\"proxied\":true}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print('$name ->', 'OK' if d.get('success') else d.get('errors'))"
done
```
These two **must** be proxied (`proxied:true`) — Cloudflare Access only works on proxied hostnames. This is the opposite of the API record in Step 2.

- [ ] **Step 5: Wait for certificates, then verify all three resolve**

Managed certificates take a few minutes to an hour.

```bash
for h in dev-api.carrottickets.com dev.carrottickets.com dev-manage.carrottickets.com; do
  printf "%-34s %s\n" "$h" "$(curl -s -o /dev/null -w '%{http_code}' https://$h/ --max-time 15)"
done
curl -s -o /dev/null -w "dev api health: %{http_code}\n" https://dev-api.carrottickets.com/health
```
Expected eventually: `dev api health: 200`. A 525/526 means the certificate has not issued yet — wait and retry rather than changing configuration.

---

### Task 7: Cloudflare Access on the dev frontends

**Files:** none.

**Interfaces:**
- Consumes: the frontend domains (Task 6), `CF_TOKEN`/`CF_ACC`.
- Requires: the allow-list of email addresses from the user.

**The dev API is deliberately excluded.** Access authenticates humans by redirecting to a login page and setting a cookie; DeltaPay's and MTN's callbacks are server-to-server with no browser, so Access would block them and produce failures caused by our own gate. Browser XHR would fail too — the API is a different hostname, so it would need its own Access session, and CORS preflight cannot follow Access's login redirect.

- [ ] **Step 1: Create an Access application per dev frontend**

```bash
create_app () {  # $1=fqdn  $2=display name
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACC/access/apps" \
  -d "{\"name\":\"$2\",\"domain\":\"$1\",\"type\":\"self_hosted\",\"session_duration\":\"24h\"}" \
| python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result']['id'] if d.get('success') else d.get('errors'))"
}
APP_LANDING=$(create_app dev.carrottickets.com "Carrot Tickets — dev site")
APP_ADMIN=$(create_app dev-manage.carrottickets.com "Carrot Tickets — dev dashboard")
echo "$APP_LANDING $APP_ADMIN"
```

- [ ] **Step 2: Attach an allow-list policy to each**

Substitute the real addresses supplied by the user for the placeholders in `EMAILS`. Do not invent addresses.

```bash
EMAILS='["laslie@hiyebo.com"]'   # <-- replace with the user-supplied list
for APP in "$APP_LANDING" "$APP_ADMIN"; do
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACC/access/apps/$APP/policies" \
  -d "{\"name\":\"Allowed testers\",\"decision\":\"allow\",\"precedence\":1,
       \"include\":[{\"email\":{\"email\":\"PLACEHOLDER\"}}]}" >/dev/null
done
python3 - <<'PY'
import json,os,subprocess
emails=json.loads(os.environ.get('EMAILS','[]'))
print('policy must include:', emails)
PY
```

Build the `include` array from the supplied list — one `{"email":{"email":"..."}}` entry per address — rather than the single placeholder above. Verify the resulting policy in Step 3 before trusting it.

- [ ] **Step 3: Verify the gate actually gates**

```bash
for h in dev.carrottickets.com dev-manage.carrottickets.com; do
  printf "%-34s %s\n" "$h" "$(curl -s -o /dev/null -w '%{http_code}' -L https://$h/ --max-time 15)"
done
curl -s -L https://dev.carrottickets.com/ | grep -oiE "cloudflare access|sign in|one-time pin" | sort -u | head -3
```
Expected: an Access login interstitial, not the app. Then confirm in a browser that an allow-listed address gets in.

- [ ] **Step 4: Confirm Access did NOT leak onto the API**

```bash
curl -s -o /dev/null -w "dev api health (want 200, NOT a login redirect): %{http_code}\n" \
  https://dev-api.carrottickets.com/health
curl -s -X POST -H 'Content-Type: application/json' -d '{}' -o /dev/null -w \
  "dev deltapay callback (want 200): %{http_code}\n" \
  https://dev-api.carrottickets.com/api/public/purchase/deltapay/callback
```
Expected: `200` for both. Anything that looks like an Access redirect means the application's domain matched too broadly — narrow it to the exact frontend hostnames.

---

### Task 8: End-to-end verification and cleanup

**Files:** Create `docs/DEV_ENVIRONMENT.md`

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Verify the full environment against the spec's acceptance list**

```bash
D=https://dev-api.carrottickets.com
printf "health              %s\n" "$(curl -s -o /dev/null -w '%{http_code}' $D/health)"
printf "api-docs (dev: 200) %s\n" "$(curl -s -o /dev/null -w '%{http_code}' $D/api-docs)"
printf "admin (want 401)    %s\n" "$(curl -s -o /dev/null -w '%{http_code}' $D/api/admin/users)"
curl -s $D/api/public/payment-methods | python3 -c "import json,sys; print('methods:', json.load(sys.stdin)['data']['methods'])"
```
`api-docs` should be **200** here (dev sets `API_DOCS_ENABLED=true`) while production stays 404 — a quick proof the two environments really are configured independently.

- [ ] **Step 2: Prove production is untouched**

```bash
printf "prod health            %s\n" "$(curl -s -o /dev/null -w '%{http_code}' https://api.carrottickets.com/health)"
printf "prod api-docs (want 404) %s\n" "$(curl -s -o /dev/null -w '%{http_code}' https://api.carrottickets.com/api-docs)"
curl -s https://api.carrottickets.com/api/public/payment-methods \
 | python3 -c "import json,sys; print('prod methods:', json.load(sys.stdin)['data']['methods'])"
```
Expected: prod healthy, docs still gated, methods unchanged (`mtn_momo`, `peach_card`).

- [ ] **Step 3: Create a test event in dev and confirm it does NOT appear in prod**

Sign in to `dev-manage.carrottickets.com`, create an event named `ZZZ-DEV-ISOLATION-TEST`, publish it, then:

```bash
curl -s "https://dev-api.carrottickets.com/api/public/events?search=ZZZ-DEV" \
 | python3 -c "import json,sys; print('dev  hits:', len(json.load(sys.stdin)['data']['events']))"
curl -s "https://api.carrottickets.com/api/public/events?search=ZZZ-DEV" \
 | python3 -c "import json,sys; print('prod hits:', len(json.load(sys.stdin)['data']['events']))"
```
Expected: `dev hits: 1`, `prod hits: 0`. Anything else means isolation is broken — stop and fix before anyone uses the environment.

- [ ] **Step 4: Write the runbook**

Create `docs/DEV_ENVIRONMENT.md` covering: the three dev URLs; that dev deploys from the `dev` branch and how to promote to production; the dev database name; that `SMS_ALLOWLIST` limits SMS to one number; that the dev API is intentionally public while the frontends are behind Access, and why; and how to enable each payment provider's sandbox as credentials arrive.

- [ ] **Step 5: Retire the impostor service**

Only after Steps 1-3 pass. `keshless-tickets-api` serves **production** data with `CORS_ORIGINS=*` and was last deployed 2026-06-23.

```bash
gcloud --configuration=deployer run services describe keshless-tickets-api \
  --region=europe-west1 --project=contracts-470406 \
  --format='value(status.traffic[0].revisionName,status.url)'
```
Confirm with the user before deleting, then:
```bash
gcloud --configuration=deployer run services delete keshless-tickets-api \
  --region=europe-west1 --project=contracts-470406 --quiet
```

- [ ] **Step 6: Commit the runbook**

```bash
git add docs/DEV_ENVIRONMENT.md
git commit -m "docs: dev environment runbook

Covers the three dev URLs, the dev branch deploy path, database isolation, the
SMS allow-list, and why the dev API is public while the frontends sit behind
Cloudflare Access."
```

---

### Task 9: Add the dev domain to the DeltaPay onboarding pack

Must happen **before** the pack is sent, or DeltaPay allow-lists only production and sandbox testing fails `return_url` validation.

**Files:**
- Modify: `docs/deltapay-onboarding/README.md`
- Modify: `docs/DELTAPAY_INTEGRATION.md`

- [ ] **Step 1: Update the allow-list section of the onboarding pack**

In `docs/deltapay-onboarding/README.md`, change §2 from one allowed domain to two:

| Purpose | Value |
|---|---|
| Allowed return domain (production) | `api.carrottickets.com` |
| Allowed return domain (sandbox/testing) | `dev-api.carrottickets.com` |

State that sandbox testing runs against `https://api.dev.deltacrypt.net` with return/callback URLs on `dev-api.carrottickets.com`, and production against `api.prod.deltacrypt.net` with the production host.

- [ ] **Step 2: Remove the now-stale 404 warning**

The pack currently warns that the return and callback URLs return `404`. That was true before deployment and is now wrong. Replace it with a note that the production endpoints are live and the sandbox endpoints go live with the dev environment.

- [ ] **Step 3: Mirror both changes in the internal doc**

Update the allowed-return-domains row in `docs/DELTAPAY_INTEGRATION.md` to list both hosts, and drop its matching 404 note.

- [ ] **Step 4: Re-render the PDF and re-upload to the same Drive folder**

Re-render from the updated README and upload with the SAME filename so the shared link keeps working:

```bash
cd docs/deltapay-onboarding
rclone copy Carrot-Tickets-DeltaPay-Onboarding.pdf \
  "gdrive:Omevision/Partners/DeltaPay/Carrot Tickets Onboarding/" --stats-one-line
rclone ls "gdrive:Omevision/Partners/DeltaPay/Carrot Tickets Onboarding"
```

- [ ] **Step 5: Commit**

```bash
git add docs/deltapay-onboarding/README.md docs/DELTAPAY_INTEGRATION.md
git commit -m "docs(deltapay): request allow-listing for the dev host too

Sandbox testing needs return/callback URLs on dev-api.carrottickets.com, and
DeltaPay validates return_url against the allow-list in sandbox exactly as in
production - so both hosts must be listed in one request rather than two.

Also drops the note saying the endpoints return 404; they are deployed now."
```

---

## Self-Review

**Spec coverage:** §3 topology → Tasks 3, 5, 6. §4 isolation invariants → Task 2 (JWT + DB), Task 3 Steps 4-5 (verified), Task 3 Step 1 (CORS). §5 env vars → Task 3. §6 providers → Task 3 Step 1 (dev URLs, providers off until creds). §7 SMS gate → Task 1. §8 Zero Trust → Task 7, including the explicit API exclusion check. §9 deploy path → Task 4. §10 retiring `keshless-tickets-api` → Task 8 Step 5. §12 verification → Task 8 Steps 1-3. The spec's DeltaPay allow-list note → Task 9.

**Known gaps, deliberately left:** Peach and MoMo sandbox credentials are not wired — both providers ship disabled in dev (`CARD_PAYMENTS_ENABLED=false`) and are enabled when sandbox credentials exist. The DeltaPay dev key likewise arrives with onboarding, hence `DELTAPAY_ENABLED=false` at creation. Seed data is out of scope per spec §2.

**Type consistency:** `shouldSendSms` is defined in Task 1 Step 3 and consumed in Task 1 Step 5 with matching signature and return shape (`{ send, reason? }`). Secret names `CARROT_DEV__MONGODB_URI` / `CARROT_DEV__JWT_SECRET` are created in Task 2 and referenced identically in Task 3 Step 3. Pages project names `carrot-tickets-landing-dev` / `carrot-tickets-admin-dev` are created in Task 5 and reused verbatim in Tasks 6 and 7.

**Ordering dependency:** Task 9 must complete before the DeltaPay pack is sent, independent of the rest.
