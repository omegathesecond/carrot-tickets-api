# Remove legacy generated username suffixes

The username release needs a data migration, not just a code deployment.
`ensureUsername` only renews a buyer when they open their own social profile;
public lists otherwise continue showing inactive buyers' stored numeric handles.

After review, run `npm run backfill:usernames` once against each release target
(dev and production), using its existing MONGODB_URI credential in process memory.
Do not claim delivery until the command succeeds and its updated count is retained.
This implement-stage change does not execute a production migration.

The migration streams existing non-customized three-digit generated handles,
uses the existing username generator and unique index, and leaves customized
handles and numbers belonging to the display name intact. Conditional writes
preserve concurrent name/username edits. Duplicate-key collisions retry; other
failures stop with a nonzero exit. A repeated successful run reports zero updates.
Buyer IDs and relationships do not change. No aliases or compatibility layer are
created for old handles.

Verify an affected buyer in an authenticated profile and a public list after the
migration. Client acceptance remains a separate step.
