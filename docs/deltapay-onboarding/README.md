# Carrot Tickets — DeltaPay Hosted Checkout onboarding pack

Everything DeltaPay needs to provision our Hosted Checkout integration. Send this
file together with the two logo files in `assets/`.

> This is the source document. A rendered PDF of it, plus the logos, is shared with
> DeltaPay at:
> https://drive.google.com/drive/folders/10mf08FmcZ6Amoxn2VGclQgGNUh0Ag9DB
> Edit this file, re-render, and re-upload to that same folder so the link stays valid.

---

## 1. Integration configuration

| Field | Value |
|---|---|
| **Merchant / product name** | Carrot Tickets |
| **Website** | https://carrottickets.com |
| **Platform type** | `custom_website` |
| **Display name** (shown on the checkout page) | `Carrot Tickets` |
| **Accepted payer identifiers** | Both — phone number **and** username |
| **Retry limit** | 3 (DeltaPay default) |
| **Currency** | SZL |
| **Support contact** | support@carrottickets.com |

## 2. Domains and URLs to allow-list

There are **two** domains to allow-list — production and sandbox/testing:

| Purpose | Value |
|---|---|
| **Allowed return domain (production)** | `api.carrottickets.com` |
| **Allowed return domain (sandbox/testing)** | `dev-api.carrottickets.com` |
| **Default return URL (production)** | `https://api.carrottickets.com/api/public/purchase/deltapay/return` |
| **Default return URL (sandbox)** | `https://dev-api.carrottickets.com/api/public/purchase/deltapay/return` |
| **Session callback URL (production)** ("webhook") | `https://api.carrottickets.com/api/public/purchase/deltapay/callback` |
| **Session callback URL (sandbox)** | `https://dev-api.carrottickets.com/api/public/purchase/deltapay/callback` |

Sandbox testing runs against **your sandbox** (`https://api.dev.deltacrypt.net`) with
return/callback URLs on `dev-api.carrottickets.com`; production runs against
**your production** (`https://api.prod.deltacrypt.net`) with return/callback URLs on
`api.carrottickets.com`. Both hosts need to be allow-listed in this one request —
you validate `return_url` against the allow-list in sandbox exactly as in production,
so allow-listing only the production host would fail sandbox testing. The payment
method stays hidden from buyers behind a feature switch until the sandbox test
passes.

### All Carrot Tickets domains, for reference

| Domain | What it is | Relevant to this integration |
|---|---|---|
| `api.carrottickets.com` | Production API (Google Cloud Run) | **Yes — allow-list this (production)** |
| `dev-api.carrottickets.com` | Development API (Google Cloud Run) | **Yes — allow-list this (sandbox/testing)** |
| `carrottickets.com` | Public storefront (static site) | Buyers land back here after we finalise; no DeltaPay traffic |
| `manage.carrottickets.com` | Organizer dashboard | No |
| `realtime.carrottickets.com` | Realtime/chat gateway | No |
| `cdn.carrottickets.com` | Media CDN | No |

> The return URL points at our **API**, not our website. Our storefront is a static
> site and cannot finalise a payment, so DeltaPay returns the buyer to a server
> endpoint that calls `verify-return` and then forwards them to
> `https://carrottickets.com/payment-result`.

### Endpoint specification

For your team's testing:

| | Return URL | Session callback |
|---|---|---|
| **Method** | `GET` | `POST` |
| **Auth** | None — public | None — public |
| **Expects** | `?checkout_session_id=<uuid>` in the query string | JSON body `{"checkout_session_id": "<uuid>"}` |
| **Responds** | `302` redirect to our result page | `200` with `{"status":"received"}` |
| **On error** | Still `302`s to the result page | Still `200` — we never return non-200, so retries are never triggered by us |

Both endpoints are publicly reachable over HTTPS. **No IP allow-listing is required
on our side** — DeltaPay can call them from any address.

> The production return and callback endpoints are **live now** on
> `api.carrottickets.com`. The sandbox endpoints on `dev-api.carrottickets.com` go
> live with our dev environment. You can allow-list both domains now — no need to
> wait for either to respond.

---

## 3. Branding

### Brand colour

| Token | Value | Use |
|---|---|---|
| **Brand colour (primary)** | `#FF6B35` | **This is the value for the `brand_colour` setup field** — buttons, links, active states |
| Primary, HSL | `hsl(16, 100%, 60%)` | Same colour, if HSL is preferred |
| Text on brand colour | `#FFFFFF` | White — never dark text on the coral |
| Ink / body text | `#1A1A1A` | Headings and body copy |
| Page background | `#FFFFFF` | |
| Neutral surface | `#F7F7F7` | Cards, muted panels |
| Hairline / border | `#F0F0F0` | Separators — we keep these near-invisible |
| Muted text | `#6B6B6B` | Secondary labels |

If only one colour can be configured, use **`#FF6B35`**.

### Logo files (in `assets/`)

| File | Dimensions | Background | Use |
|---|---|---|---|
| `carrot-tickets-logo-horizontal.png` | 1280 × 853 | Transparent (PNG alpha) | **Preferred** — full lock-up: carrot-ticket mark + "CarrotTickets" wordmark + "Your ticket to every event" strapline |
| `carrot-tickets-icon-square.png` | 500 × 500 | Transparent (PNG alpha) | Square/compact slots — the carrot-ticket mark only, no wordmark |

Both are PNG with a transparent background, so they sit correctly on a white or
light checkout page. Use the **horizontal** file wherever the slot is wider than
tall; use the **square icon** for avatar-style or square slots.

Notes for placement:
- The horizontal file has generous built-in whitespace — please don't add much more
  padding around it.
- Wordmark colours are part of the artwork: "Carrot" in `#FF6B35`, "Tickets" in
  `#1A1A1A`. Please don't recolour, rotate, or apply effects to the mark.
- If you need a different format or a tighter crop (SVG, white-on-dark version,
  specific pixel dimensions), tell us the exact spec and we'll supply it.

---

## 4. Business / account details

To be completed by Carrot Tickets before sending:

- [ ] Registered legal entity name and registration number
- [ ] DeltaPay business account that ticket revenue settles into
- [ ] Authorised account administrators (AAAs) named in the account resolution
- [ ] Technical contact for integration issues
- [ ] Preferred key-issuance route — **DeltaPay generates the key** (simplest), or
      grant a nominated Carrot user `create_api_key` / `view_api_keys` /
      `revoke_api_key` so we generate it ourselves and no live secret is emailed

---

## 5. What we need back from DeltaPay

1. **The Hosted Checkout API key** (`x-api-key`), sent through a secure channel —
   not plain email.
2. **Confirmation of our base URLs**: sandbox `https://api.dev.deltacrypt.net`,
   production `https://api.prod.deltacrypt.net`.
3. **Confirmation that both `api.carrottickets.com` (production) and
   `dev-api.carrottickets.com` (sandbox/testing) are allow-listed** as return
   domains (each covers its own return URL and session callback).
4. **A sandbox test wallet** (phone number or username with test balance) so we can
   complete a full purchase before enabling DeltaPay for real buyers.

---

Our integration is already built and tested against the Hosted Checkout spec
(`POST /v1/hosted-checkout/sessions` → redirect → `GET …/verify-return`). It is
switched off pending the items above; once the key and allow-listing land we can be
live the same day.
