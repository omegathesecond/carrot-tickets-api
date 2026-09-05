# Easier product and menu entry: scan a barcode, upload images, pick a category

**Date:** 2026-09-05
**Status:** Design — approved in chat, pending spec review
**Surfaces:** `carrot-tickets-dashboard`, `carrot-tickets-api`

## Problem

Three fields in the organizer dashboard are typed by hand when they should not be.

### A barcode is 13 digits typed off a bottle

Adding a product to a cashless event's catalogue means reading an EAN/UPC off the packaging and typing it into a plain `<Input>` (`EventCataloguePanel.tsx:430`). Thirteen digits, transcribed under time pressure, into a field whose whole purpose is to be matched exactly — the POS resolves a scanned barcode against this value client-side, so one wrong digit means the handheld never finds the product and the operator falls back to hunting a tile grid.

The handheld already scans. `mobile_scanner` has been in the POS since the basket work, and `scan_barcode_sheet.dart` matches EAN/UPC against the fetched catalogue. The dashboard has no camera capability at all: no barcode dependency in `package.json`, no `getUserMedia` anywhere in `src`.

### Images are a URL you have to host yourself, or no field at all

The menu form asks for an "Image URL" (`EventMenuTab.tsx:487`) and renders a preview from whatever string is typed. To put a photo of a burger on the preorder menu, an organizer must first upload that photo somewhere else and paste a link.

The catalogue form is worse: it has no image field at all. `Product.imageUrl` exists on the model, the POS basket renders it, and the API already accepts it — `createProductSchema` and `updateProductSchema` both validate `imageUrl` as a URI (`stock.validator.ts:25,36`) — but the dashboard has never offered a way to set it, so every product tile in the POS is text-only.

Both gaps exist even though the API has uploaded event media to R2 since the poster/thumbnail/gallery work.

### A category is free text with an invisible picker

Menu categories are per-event groupings — "Starters", "Cold Drinks" — and deliberately free-form: `menuItem.model.ts:10` documents `category` as "a free-text grouping", and there is an index on `{eventId, section, category, displayOrder}` that uses it for ordering. The form renders `<Input list="menu-category-options">` (`:467`), an HTML datalist fed by the categories already used on this event.

A datalist is invisible. It looks exactly like a text box, so nobody discovers the suggestions, and the result is "Drinks" and "drinks" as two groups on one menu. The capability is already there; the affordance is not.

## Non-goals

- **A vendor picker on the menu, and the event-vendor concept behind it.** Deferred to its own design, deliberately. The dashboard has no list of third-party vendors to pick from: `Vendor` is the organizer account (`Event.vendorId`), `Merchant` is a cashless stall with a ledger account and commission rate — the organizer's own bars — and the menu's `vendorName` is a free string with no model at all. Pointing menu items at a `Merchant` would force every third-party food vendor into the organizer's own stall list and set them up to take tap-to-pay money. That conflation is the thing to avoid, so the vendor picker waits for a real "vendors under this event" entity.
- **Barcodes on menu items.** Menu items have no barcode field and do not need one; they are preorder listings, not stocked SKUs.
- **Replacing the typed barcode input.** Scanning is added beside it, never instead of it — a laptop with no camera, or a page served without HTTPS, must keep working exactly as it does now.
- **A fixed category enum.** The model's per-event free-text grouping is kept.

## Design

### 1. Barcode: scan it, or photograph it

A new `<BarcodeField>` in the dashboard replaces the bare `<Input>` at `EventCataloguePanel.tsx:430`. It renders the same text input — always editable, always the source of truth — plus two buttons:

- **Scan** opens a small camera view and decodes continuously until it reads a barcode, then closes and fills the field.
- **Photo** opens the file picker (`<input type="file" accept="image/*" capture="environment">`) and decodes the still image. On a phone this offers the camera directly; on a laptop it takes a photo dragged in from a phone.

Both paths decode through `@zxing/browser`, which reads from a live `MediaStream` and from a static image with the same decoder. One dependency, one code path.

**Degradation is explicit, never silent.** The Scan button is hidden when `navigator.mediaDevices?.getUserMedia` is absent — which covers a laptop with no webcam and any non-HTTPS origin, since browsers gate camera access on a secure context. The Photo button needs only a file input and stays. When the camera is present but permission is denied, the field says so rather than appearing broken. When a decode finds nothing, it says the image had no readable barcode. Neither case clears or overwrites what the organizer typed.

A decoded value lands in the same state the typed value does, so the existing validation (`:222` — at least 3 characters) and the existing uniqueness handling (the API answers 11000 with "A product with that barcode already exists at this event") apply unchanged.

### 2. Item images: upload instead of paste, and a field where there was none

`R2Service.getEventMediaFolder`'s `mediaType` union gains `'menu-item'` and `'product'` — distinct folders, so a menu photo and a product photo can never collide, and either can be cleaned up independently. `uploadEventMedia` is otherwise unchanged. An `itemImageUpload` multer config joins the others in `media.middleware.ts`, matching `posterUpload`'s limits and image-only filter; both routes share it, since the constraints are identical.

Two new routes:

```
POST /api/media/events/:eventId/menu-item   → { url }
POST /api/media/events/:eventId/product     → { url }
```

They keep the existing one-route-per-media-type convention, but delegate to a single controller implementation parameterised by media type rather than duplicating the upload-and-replace logic twice.

running the same middleware chain its siblings do — `authenticateTickets`, then `validateEventAccess`, then `menuItemUpload.single('image')`, `handleMulterError` and `validateFileUpload`. There is no named-permission guard on these routes; ownership is what `validateEventAccess` enforces, and the controller re-checks it with the same `{ _id: eventId, vendorId }` query `uploadPoster` runs for non-super-admins. It returns the public URL; it does not write to the menu item. The dashboard sets `imageUrl` from that URL through the existing menu-item create/update call, so the API's menu controller needs no change at all.

On the menu form, the "Image URL" input becomes a file input with the preview it already renders. On the catalogue form, an image field is added where none existed, using the same component. Replacing an image on an existing item or product deletes the previous object through `deleteEventMediaByUrl`, the same way `uploadPoster` clears an old poster — best-effort, and a failure to delete never fails the upload.

**Neither model changes.** `MenuItem.imageUrl` and `Product.imageUrl` keep their shapes; only how the dashboard fills them changes. The product validators already accept `imageUrl`, so the catalogue's create/update calls need only start sending it. Items whose image was pasted as an external link keep rendering.

### 3. Category: a picker that looks like one

The category `<Input list=…>` becomes a `<Select>` built from the categories already used on this event's menu — the same set the datalist was feeding — with a final **"+ New category…"** entry that swaps the control for a text input so a new grouping can still be created inline.

This uses only primitives the dashboard already has. It deliberately does not add `cmdk`: the repo has `@radix-ui/react-popover` but no `command.tsx`, and a Select with an escape hatch solves the discoverability problem without a new dependency or a hand-rolled combobox.

Nothing changes server-side. `category` stays a required free-text string, the compound index still orders by it, and an organizer can still invent "Braai Platters" on the spot — they just cannot invent it by accident with the wrong casing.

The import dialog needs no equivalent change: it has no category field, deriving each imported item's category from the source product (`productCategoryLabel(prod.category)`). Its vendor datalist is left alone, since vendors are out of scope.

## Error handling

| Case | Result |
|---|---|
| No camera, or insecure origin | Scan button not rendered; Photo and typing remain |
| Camera permission denied | Inline message naming the cause; field untouched |
| Decode finds no barcode | Inline "no barcode found in that image"; field untouched |
| Decoded barcode already used at this event | Existing 400 from the API surfaces on save, unchanged |
| Image upload rejected (too large, wrong type) | Multer's error surfaces through the form's existing toast; no partial write |
| Old image delete fails on replace | Logged, upload still succeeds — matches `uploadPoster` |
| Upload succeeds, item save fails | The object is orphaned in R2. Accepted: the same window exists for posters today, and an orphan costs storage, not correctness |

No silent fallbacks anywhere: a failed decode, a denied camera and a rejected upload each say what happened.

## Testing

Dashboard (vitest + Testing Library):
- `BarcodeField` renders the text input and hides Scan when `getUserMedia` is absent
- a decoded value populates the field; a failed decode leaves a typed value intact
- permission denial renders the message rather than a dead button
- the category Select lists this event's existing categories, and choosing "+ New category…" reveals an input whose value is what gets saved
- picking an existing category does not send a new one

API (jest + supertest):
- both new routes return a URL for a valid image
- each refuses an event belonging to another vendor, through the same `validateEventAccess` path the sibling upload routes use
- a non-image file is rejected
- `getEventMediaFolder` returns distinct folders for `'menu-item'` and `'product'`, so the two cannot collide with each other or with posters

The camera itself is not tested in jsdom; `getUserMedia` and the decoder are stubbed, and what is asserted is the component's behaviour around them.

## Sequencing

Three independent changes, shippable in any order:

1. **Category picker** — dashboard only, no dependency, no API change. Smallest, ships first.
2. **Item image upload** — the media-type union, the shared multer config, two routes and one shared controller path, then the menu form's swap and the catalogue form's new field. The catalogue half additionally starts sending `imageUrl` on create/update, which the API already accepts.
3. **Barcode scan/photo** — adds `@zxing/browser`; largest, and the only one that needs a device to verify properly.

## Rollout

Nothing to migrate. `MenuItem` and `Product` are untouched; `imageUrl` and `barcode` keep their shapes, and products that have never had an image simply keep rendering without one. The category picker reads values already in the data. An organizer on a browser with no camera sees exactly today's barcode field, and every existing menu item — including any with a pasted external image URL — renders unchanged.
