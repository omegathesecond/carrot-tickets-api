# Profile picture posts

Buyer profile uploads now atomically save the avatar URL and publish a regular,
ready image Update authored by the buyer. The existing profile, Home and Discover
post queries/renderers handle these posts; no special layout or feed type is used.
Replacing/removing an avatar retains its file because photo posts may reference it.
Organizer business logos are not buyer profile pictures and are unchanged.

After deploying this change to the intended environment, run once with that
environment's existing MongoDB connection configuration:

```sh
npm run backfill:profile-picture-posts
```

The command requires MONGODB_URI, reports created/skipped counts and exits nonzero
on failure. It is not run during startup or build. This implementation stage does
not execute data writes against dev or production; run it during the reviewed
release. It cursors buyers with a nonempty avatar URL, leaving buyers, existing
posts, captions and moderation state untouched. It reuses the current image URL
without downloading or modifying it.

The timestamp embedded by R2Service.generateMediaKey in buyer avatar filenames is
used as the original upload date. Other filenames use the post creation time;
Buyer.updatedAt is not an upload timestamp. Unknown image dimensions use the same
0/0 convention as existing image Updates.

A deterministic Update _id for buyer ID + avatar URL uses MongoDB's existing unique
_id index to make retries and concurrent runs idempotent. Existing photo posts
referencing the same image by that author are skipped, including removed posts.
The script never restores a removed post. A future upload generates a new URL and
therefore a new post. No schema migration or additional index is required.

Uploads use the same MongoDB transaction mechanism as existing transactional API
features; a post failure rolls back the avatar URL change and returns an API error.
