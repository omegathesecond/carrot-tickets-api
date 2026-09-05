# Item image upload endpoints — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dashboard upload an image for a menu item or a catalogue product, so neither has to be hosted elsewhere and pasted as a URL.

**Architecture:** Two new routes on the existing `/api/media` router, following the poster/thumbnail/gallery pattern exactly — same middleware chain, same R2 service, same response envelope. They differ from their siblings in one way: they do **not** write the URL onto any document. They return it, and the dashboard saves it through the normal menu-item / product update call, which already accepts `imageUrl`.

**Tech Stack:** Node + TypeScript, Express, multer, Cloudflare R2 (`R2Service`), Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-09-05-menu-and-catalogue-entry-design.md` §2

## Global Constraints

- **No model or validator changes.** `MenuItem.imageUrl` and `Product.imageUrl` already exist, and `createProductSchema` / `updateProductSchema` already validate `imageUrl` as a URI (`stock.validator.ts:25,36`). If you find yourself editing a model or a validator, stop — the task has been misread.
- **These routes store a file and return a URL. Nothing else.** They must not write to a `MenuItem` or a `Product`. Ownership of the resulting URL belongs to the caller's next save.
- **Distinct R2 folders per media type**, so a menu photo and a product photo can never collide with each other or with a poster.
- **One implementation, two routes.** Keep the one-route-per-media-type convention the file already has, but do not duplicate the upload body — parameterise it.
- **No silent fallbacks.** A rejected file, a missing file, or an event the caller does not own each returns a real status with a message.
- Run tests with `npx jest <path>` from the worktree root. `node_modules` is a symlink into a shared install — never `git clean -xfd`, `git stash push -u`, or `git rm -r node_modules`.

---

### Task 1: The two upload endpoints

**Files:**
- Modify: `src/utils/r2.service.ts:147` (`getEventMediaFolder` media-type union)
- Modify: `src/middleware/media.middleware.ts` (add a size limit + an `itemImageUpload` config)
- Modify: `src/controllers/media.controller.ts` (one shared implementation, two thin entry points)
- Modify: `src/routes/media.route.ts` (two routes)
- Test: `src/routes/__tests__/mediaItemImage.route.test.ts` (create)

**Interfaces:**
- Consumes: `R2Service.uploadEventMedia`, `R2Service.deleteEventMediaByUrl` (both existing, unchanged).
- Produces:
  - `POST /api/media/events/:eventId/menu-item` and `POST /api/media/events/:eventId/product`, each accepting a single file under the field name `image`
  - both respond `{ media: { key, url, type } }` inside the standard success envelope
  - `getEventMediaFolder` accepts `'menu-item'` and `'product'`

- [ ] **Step 1: Write the failing test**

Create `src/routes/__tests__/mediaItemImage.route.test.ts`. Read `src/routes/__tests__/` for the vendor-token helper this suite family uses (`signVendorToken` from `@/__tests__/helpers/auth`) and match how a sibling media or event-owned route test seeds an owned event — do not invent a new fixture.

```ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { R2Service } from '@utils/r2.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// R2 is not reachable from a test run, and this suite is about routing,
// ownership and file validation — not about object storage. Stub the one
// call the controller makes and assert on what it was asked to store.
jest.mock('@utils/r2.service', () => {
  const actual = jest.requireActual('@utils/r2.service');
  return {
    ...actual,
    R2Service: {
      ...actual.R2Service,
      uploadEventMedia: jest.fn().mockResolvedValue({
        key: 'events/e1/menu-item/123-burger.jpg',
        url: 'https://cdn.example/events/e1/menu-item/123-burger.jpg',
      }),
      deleteEventMediaByUrl: jest.fn().mockResolvedValue(undefined),
    },
  };
});

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe.each([
  ['menu-item', 'menu-item'],
  ['product', 'product'],
])('POST /api/media/events/:eventId/%s', (segment, mediaType) => {
  it('stores the file under its own media type and returns the url', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(String(vendorId));

    const res = await request(app)
      .post(`/api/media/events/${eventId}/${segment}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('image', png, 'burger.png');

    expect(res.status).toBe(200);
    expect(res.body.data.media.url).toMatch(/^https?:\/\//);
    // The media type is what keeps a product photo out of the menu folder.
    expect(R2Service.uploadEventMedia).toHaveBeenCalledWith(
      String(eventId), mediaType, 'burger.png', expect.any(Buffer), 'image/png',
    );
  });

  it('never writes the url onto a document — it only returns it', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(String(vendorId));

    const res = await request(app)
      .post(`/api/media/events/${eventId}/${segment}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('image', png, 'burger.png');

    // Saving the url is the caller's next request, not this one's business.
    expect(res.body.data.menuItem).toBeUndefined();
    expect(res.body.data.product).toBeUndefined();
  });

  it('refuses an event the caller does not own', async () => {
    const { eventId } = await seedPublishedEvent({});
    const someoneElse = signVendorToken('64b000000000000000000a01');

    const res = await request(app)
      .post(`/api/media/events/${eventId}/${segment}`)
      .set('Authorization', `Bearer ${someoneElse}`)
      .attach('image', png, 'burger.png');

    expect([403, 404]).toContain(res.status);
  });

  it('rejects a non-image file', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(String(vendorId));

    const res = await request(app)
      .post(`/api/media/events/${eventId}/${segment}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('not an image'), 'notes.txt');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('rejects a request with no file at all', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({});
    const token = signVendorToken(String(vendorId));

    const res = await request(app)
      .post(`/api/media/events/${eventId}/${segment}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

it('keeps the two media types in separate folders', () => {
  const actual = jest.requireActual('@utils/r2.service').R2Service;
  expect(actual.getEventMediaFolder('e1', 'menu-item'))
    .not.toEqual(actual.getEventMediaFolder('e1', 'product'));
});
```

If `seedPublishedEvent` does not return an event the media routes' `validateEventAccess` accepts, read that middleware and seed whatever it checks — adjust the fixture usage, never the middleware.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/mediaItemImage.route.test.ts`
Expected: FAIL — both routes 404, because they do not exist.

- [ ] **Step 3: Widen the media-type union**

In `src/utils/r2.service.ts:147`:

```ts
  static getEventMediaFolder(
    eventId: string,
    mediaType: 'poster' | 'thumbnail' | 'gallery' | 'qrcode' | 'menu-item' | 'product',
  ): string {
    return `events/${eventId}/${mediaType}`;
  }
```

`uploadEventMedia`'s own `mediaType` parameter is typed with the same union literal — widen it identically there, or extract the union to a named type and use it in both. Either is fine; do not leave the two out of step.

- [ ] **Step 4: Add the multer config**

In `src/middleware/media.middleware.ts`, add a size limit beside the others:

```ts
  itemImage: 5 * 1024 * 1024,   // 5MB for menu item and product photos
```

and one upload config that both routes share, since their constraints are identical:

```ts
export const itemImageUpload = multer({
  storage,
  limits: {
    fileSize: FILE_SIZE_LIMITS.itemImage,
    files: 1,
  },
  fileFilter: createFileFilter(ALLOWED_IMAGE_TYPES, 'image'),
});
```

- [ ] **Step 5: Add one shared controller implementation**

In `src/controllers/media.controller.ts`, add a private helper and two thin entry points. The helper mirrors `uploadPoster`'s ownership check, and deliberately stops before the "write it onto the document" step that its siblings do:

```ts
  /**
   * Store an image belonging to something sold at this event, and return its
   * URL. Unlike the poster/thumbnail routes, this writes to NO document: the
   * dashboard saves the returned url through the normal menu-item or product
   * update, which already accepts `imageUrl`. Keeping the two apart means an
   * upload can never half-succeed against a record.
   */
  private static async uploadItemImage(
    req: Request,
    res: Response,
    mediaType: 'menu-item' | 'product',
  ): Promise<any> {
    try {
      const { eventId } = req.params;
      const ticketsUser = (req as any).ticketsUser;
      const file = req.file;

      if (!eventId) return ApiResponseUtil.validationError(res, 'Event ID is required');
      if (!file) return ApiResponseUtil.validationError(res, 'No file uploaded');

      const query: any = { _id: eventId };
      if (!ticketsUser.isSuperAdmin) query.vendorId = ticketsUser.vendorId;
      const event = await Event.findOne(query);
      if (!event) return ApiResponseUtil.notFound(res, 'Event not found');

      const { key, url } = await R2Service.uploadEventMedia(
        eventId,
        mediaType,
        file.originalname || mediaType,
        file.buffer,
        file.mimetype,
      );

      ApiResponseUtil.success(res, { media: { key, url, type: mediaType } }, 'Image uploaded successfully');
    } catch (error: any) {
      console.error(`Upload ${mediaType} image error:`, error);
      ApiResponseUtil.error(res, error.message || 'Failed to upload image');
    }
  }

  /** POST /api/media/events/:eventId/menu-item */
  static async uploadMenuItemImage(req: Request, res: Response): Promise<any> {
    return MediaController.uploadItemImage(req, res, 'menu-item');
  }

  /** POST /api/media/events/:eventId/product */
  static async uploadProductImage(req: Request, res: Response): Promise<any> {
    return MediaController.uploadItemImage(req, res, 'product');
  }
```

- [ ] **Step 6: Mount the two routes**

In `src/routes/media.route.ts`, beside the existing ones, with the same middleware chain:

```ts
/**
 * @route   POST /api/media/events/:eventId/menu-item
 * @desc    Upload an image for a menu item; returns the url, writes no document
 * @access  Private (Vendor)
 * @body    multipart/form-data with 'image' field
 * @limits  5MB, JPEG/PNG/WEBP
 */
router.post(
  '/events/:eventId/menu-item',
  authenticateTickets,
  validateEventAccess,
  itemImageUpload.single('image'),
  handleMulterError,
  validateFileUpload,
  MediaController.uploadMenuItemImage,
);

/**
 * @route   POST /api/media/events/:eventId/product
 * @desc    Upload an image for a catalogue product; returns the url, writes no document
 * @access  Private (Vendor)
 * @body    multipart/form-data with 'image' field
 * @limits  5MB, JPEG/PNG/WEBP
 */
router.post(
  '/events/:eventId/product',
  authenticateTickets,
  validateEventAccess,
  itemImageUpload.single('image'),
  handleMulterError,
  validateFileUpload,
  MediaController.uploadProductImage,
);
```

Add `itemImageUpload` to the existing import from `@middleware/media.middleware`.

- [ ] **Step 7: Run the tests**

Run: `npx jest src/routes/__tests__/mediaItemImage.route.test.ts`
Expected: PASS.

- [ ] **Step 8: Confirm the sibling routes still work**

Run: `npx jest --testPathPattern="media"`
Expected: PASS — the union widening and the shared multer config must not disturb poster/thumbnail/gallery/qrcode.

- [ ] **Step 9: Commit**

```bash
git add src/utils/r2.service.ts src/middleware/media.middleware.ts src/controllers/media.controller.ts src/routes/media.route.ts src/routes/__tests__/mediaItemImage.route.test.ts
git commit -m "feat(media): upload an image for a menu item or a catalogue product"
```

---

### Task 2: Verify and ship

**Files:** none — verification only.

- [ ] **Step 1: Typecheck and lint**

Run: `npm run build`, then `npx eslint` over the four changed source files.
Expected: build clean; **no NEW** eslint errors. The repo carries a pre-existing baseline (57 errors / 1422 warnings on `main`) — compare against it rather than treating the total as yours.

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: green. If `yoco.route.test.ts` fails on `Port … already in use`, that is a known mongodb-memory-server worker collision — re-run that file alone to confirm before treating it as a regression.

- [ ] **Step 3: Confirm no new env keys**

Run: `git diff origin/main...HEAD -- src | grep -E "^\+.*process\.env" || echo none`
Expected: `none` — R2 credentials are already bound on the running revision.

- [ ] **Step 4: Land**

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

Then tie the serving revision to the commit — the revision pins a digest while the build tags a sha, so join them:

```bash
gcloud run services describe carrot-tickets-api --region=europe-west1 --project=contracts-470406 --format='json(status.traffic)'   # take the entry with latestRevision:true, NOT traffic[0]
gcloud artifacts docker tags list <repo-path> --filter="tag:<full-sha>" --format='value(tag,version)'
gcloud run revisions describe <rev> --region=europe-west1 --project=contracts-470406 --format='value(spec.containers[0].image)'
```

Health via the in-app browser (curl is blocked in auto mode): `https://carrot-tickets-api-y5bs5km2gq-ew.a.run.app/health`.

---

## What this plan does NOT cover

The dashboard side — the barcode field, the category picker, and the two image fields that consume these endpoints — is `2026-09-05-menu-and-catalogue-entry-dashboard.md`. Its category and barcode tasks are independent of this plan; **its two image tasks require this to be deployed.**
