# Application photo posts

New stall applications publish their experience photos as ordinary image posts within the application transaction. A photo reused by the same account is published only once, and rerunning the backfill does not restore a removed post.

After deploying the API, run `npx ts-node -r tsconfig-paths/register src/scripts/backfillApplicationPhotoPosts.ts` with `MONGODB_URI` pointing to the target environment. Run separately for each environment. This explicitly publishes photos from existing submitted applications; it is resumable and fails if an application's owner cannot be uniquely resolved as a buyer or vendor. Do not run against production until the release has been reviewed and authorized.
