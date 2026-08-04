# DeltaPay Hosted Checkout — Integration & Registration

Carrot Tickets accepts DeltaPay via DeltaPay's **Hosted Checkout**. The code is
complete and deployed behind an off-by-default switch; it goes live once DeltaPay
provisions the integration and issues an API key.

- Design spec: [`docs/superpowers/specs/2026-08-03-deltapay-hosted-checkout-design.md`](superpowers/specs/2026-08-03-deltapay-hosted-checkout-design.md)
- Provider docs: https://deltacrypt.github.io/deltapay-api-docs/common_usecases/hosted_checkout/

---

## Part 1 — Details to send DeltaPay

Everything below is what DeltaPay needs from us to provision the integration.

> **Sending this to DeltaPay?** Use the ready-made pack in
> [`docs/deltapay-onboarding/`](deltapay-onboarding/README.md) — it repeats this
> section in a send-as-is form and ships the logo files in `assets/` alongside it.

### Integration configuration

| Field | Value |
|---|---|
| **Platform type** | `custom_website` |
| **Allowed return domains** | `api.carrottickets.com` (production) **and** `dev-api.carrottickets.com` (sandbox/testing) — both must be allow-listed in one request. DeltaPay validates `return_url` against the allow-list in sandbox exactly as in production, so pre-launch testing against DeltaPay's **sandbox** uses `dev-api.carrottickets.com` with the method toggled off for buyers. |
| **Default return URL** | `https://api.carrottickets.com/api/public/purchase/deltapay/return` |
| **Session callback URL** | `https://api.carrottickets.com/api/public/purchase/deltapay/callback` |
| **Display name** | `Carrot Tickets` |
| **Brand colour** | `#FF6B35` — Carrot coral, `hsl(16 100% 60%)`; white (`#FFFFFF`) text on it |
| **Logo** | `docs/deltapay-onboarding/assets/carrot-tickets-logo-horizontal.png` (1280×853, transparent PNG). Square slots: `carrot-tickets-icon-square.png` (500×500) |
| **Accepted payer identifiers** | Both (phone number **and** username) |
| **Retry limit** | `3` (DeltaPay's default) |
| **Currency** | SZL |
| **Support contact** | support@carrottickets.com |

The return URL and callback URL sit on `api.carrottickets.com` in production and on
`dev-api.carrottickets.com` in sandbox, so **both domains must be allow-listed** —
DeltaPay validates `return_url` against the allowed-domain list at session creation,
in sandbox exactly as in production.

Note: the production endpoints are live now. The sandbox endpoints on
`dev-api.carrottickets.com` go live with the dev environment.

> Note on the return URL: it points at our **API**, not our website. Our storefront
> is a static site that cannot finalise a payment, so DeltaPay returns the buyer to
> a server endpoint that calls `verify-return` and then redirects them onward to
> `https://carrottickets.com/payment-result`.

### Business / account details

These come from the existing Carrot Tickets legal entity and should be supplied by
whoever handles the commercial relationship:

- Registered legal entity name and registration number
- The DeltaPay business account that ticket revenue settles into
- Authorised account administrators (AAAs) for the account resolution
- Technical contact for integration issues
- Preferred key-issuance route: **DeltaPay generates the key** (simplest), or grant
  a nominated Carrot user the `create_api_key` / `view_api_keys` / `revoke_api_key`
  permissions so we generate it ourselves (avoids emailing a live secret)

### What we need back from DeltaPay

1. **API key** for Hosted Checkout (`x-api-key`). Send it through a secure channel,
   not plain email — it authenticates every request.
2. **Confirmation of the base URLs** for our integration:
   - Sandbox/dev: `https://api.dev.deltacrypt.net`
   - Production: `https://api.prod.deltacrypt.net`
3. **Confirmation that the return + callback domains are allow-listed.**
4. A **sandbox/test wallet** (phone number or username with test balance) so we can
   run an end-to-end purchase before enabling the method for buyers.

---

## Part 2 — Go-live checklist (our side)

Once the key arrives:

1. Store the secret (never in the repo):
   ```bash
   printf '%s' 'THE_KEY' | gcloud --configuration=deployer secrets create CARROT_TICKETS__DELTAPAY_API_KEY --data-file=- --project=contracts-470406
   ```
2. Bind it to the Cloud Run service **additively** — `--update-secrets`, never
   `--set-secrets` (which wipes every other binding):
   ```bash
   gcloud --configuration=deployer run services update carrot-tickets-api --region=europe-west1 --project=contracts-470406 --update-secrets=DELTAPAY_API_KEY=CARROT_TICKETS__DELTAPAY_API_KEY:latest
   ```
3. Set the non-secret env vars, also additively (`--update-env-vars`):
   `DELTAPAY_ENABLED=true`, `DELTAPAY_BASE_URL=https://api.prod.deltacrypt.net`,
   `DELTAPAY_RETURN_URL=…/deltapay/return`, `DELTAPAY_CALLBACK_URL=…/deltapay/callback`.
4. Confirm the service's runtime service account has
   `roles/secretmanager.secretAccessor` on the new secret — check the **actual**
   `spec.template.spec.serviceAccountName`, which may not be the default Compute SA.
5. Flip **Settings → Payment Methods → DeltaPay** on in the dashboard. The method
   only appears at checkout when the env switch **and** this toggle are both on.
6. Run one real low-value purchase end to end and confirm: buyer redirected →
   pays → returns → ticket minted → SMS received → sale visible in the dashboard
   with method "DeltaPay".

---

## Part 3 — How it works (for whoever maintains this)

### Endpoints we expose

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/public/purchase/deltapay` | Buyer token | Create the sale + checkout session; returns `checkoutUrl` |
| `GET /api/public/purchase/deltapay/:sessionId/status` | Buyer token | Poll; also finalises on success |
| `GET /api/public/purchase/deltapay/return` | None (DeltaPay redirect) | Finalises server-side, then 302s to the result page |
| `POST /api/public/purchase/deltapay/callback` | None (DeltaPay push) | Trigger to verify; always answers 200 |

### Endpoints we call

- `POST /v1/hosted-checkout/sessions` — create session
- `GET /v1/hosted-checkout/sessions/{id}/verify-return` — authoritative outcome

### Safety properties worth preserving

- **`verify-return` is the only proof of payment.** The buyer's return redirect
  proves nothing — they can hit that URL by hand. Never mint on a redirect alone.
- **The session callback carries no outcome and no signature** — just
  `{ checkout_session_id }`. It is a trigger to go check, never evidence. (The
  RSA-PSS signature scheme in DeltaPay's docs belongs to the separate C2B/IPN
  callbacks, which we do not use.)
- **Exact amount guard.** `finalizeDeltapaySale` refuses to mint unless the amount
  DeltaPay reports equals what we charged.
- **Atomic claim.** Minting happens behind a `findOneAndUpdate` on
  `paymentStatus: PENDING`, so the return + callback + poll racing each other
  cannot produce duplicate tickets.
- **Unknown status ⇒ pending, never success.** A new provider-side status can
  never mint tickets; the reservation sweep resolves it safely.
- **12-minute inventory hold** vs DeltaPay's 10-minute session expiry — the hold
  must always outlive the session, never the reverse.
- **No silent fallbacks.** Any provider failure releases the hold, fails the sale
  and surfaces the error to the buyer.

### Fees and currency

DeltaPay is SZL-native; amounts are sent as plain Emalangeni with no conversion.
The buyer-paid service fee is **E5 per ticket** by default (matching MoMo),
editable in dashboard Settings, applied to online checkout only — POS and reseller
sales stay at face value.
