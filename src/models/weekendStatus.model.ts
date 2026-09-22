import { Schema, model, Document, Types } from 'mongoose';
import { WeekendStatusType, WeekendAudience, WEEKEND_STATUS_TYPES, WEEKEND_AUDIENCES, WEEKEND_MESSAGE_MAXLEN } from '@interfaces/weekend.interface';

/**
 * "My Weekend" status / "Who Has Plans This Weekend" plan — one collection,
 * two disjoint entry points distinguished by `source`:
 *
 *  - `profile_widget`: the ORIGINAL "My Weekend" profile section. ONE row
 *    per buyer, upserted on every update (spec: a buyer may "update, replace
 *    or remove their status at any time") — WeekendService.upsertStatus/
 *    getOwnStatus/removeStatus/getForViewer all filter on this source so
 *    they only ever touch/see their own singular row, never one of the
 *    buyer's plan_post rows below.
 *  - `plan_post`: the "+Add" Instagram-style composer under "Who Has Plans
 *    This Weekend". MANY rows per buyer — every successful Post creates a
 *    brand-new row with its own id (never upserted), so a buyer can have any
 *    number of active plans at once. WeekendService.createPlan/updatePlan/
 *    removePlan/getPlan all filter on this source.
 *
 * The two never collide: `upsertStatus`'s `findOneAndUpdate({buyerId,
 * source:'profile_widget'})` can never land on / clobber a `plan_post` row,
 * and vice versa. The Home-feed queries (rankedCandidates/getWhoHasPlansPage/
 * ownCardsIfActive) deliberately do NOT filter on `source` — both kinds of
 * row are equally "a person's weekend plan" to a viewer scrolling the feed.
 *
 * `activeUntil` is the single field every "is this still showing" query
 * filters on (`activeUntil: { $gt: now }`): a general status/plan gets
 * `weekendEnd`; an event-linked one instead gets the event's `endTime`
 * (spec §19's two different expiry rules collapsed into one comparable
 * field) — see WeekendService.upsertStatus/buildCommonFields for how it's
 * computed, and WeekendService.sweepCancelledEventLinks for what happens
 * when the linked event itself gets cancelled/deleted.
 */
export interface IWeekendStatusMedia {
  url: string;
  width: number;
  height: number;
}

export type WeekendPlanMediaType = 'image' | 'video';

/** One item in a `plan_post` row's media set (spec §5/§6: multiple optional
 *  pictures/videos, reorderable, each removable/replaceable). Uploaded
 *  directly to R2 (no transcode pipeline — see WeekendService.presignPlanMediaUpload's
 *  doc comment for why), so `ready` the moment the client's PUT succeeds;
 *  there is no `processing`/`failed` status to track server-side, unlike
 *  Update/Story media. Array order IS display order — the first item is the
 *  cover (spec §6 "choose the main or cover media" is just reordering to
 *  index 0, not a separate flag). Keeps its own `_id` (schema default) so
 *  the client can reference/reorder/remove a specific item stably.
 */
export interface IWeekendPlanMediaItem {
  _id: Types.ObjectId;
  url: string;
  width: number;
  height: number;
  type: WeekendPlanMediaType;
}

export type WeekendStatusSource = 'profile_widget' | 'plan_post';

export interface IWeekendStatus extends Document {
  buyerId: Types.ObjectId;
  /** See the class doc comment above — `plan_post` rows are never unique per buyer. */
  source: WeekendStatusSource;
  /** Set only on `plan_post` rows, from the client's create request (spec:
   *  "prevent accidental duplicates caused by repeated clicks or network
   *  retries") — WeekendService.createPlan treats a repeat create carrying
   *  the same id as idempotent (returns the existing row) instead of
   *  creating a second one. Sparse-unique per buyer — see the schema index. */
  clientRequestId?: string;
  statusType: WeekendStatusType;
  message?: string;
  eventId?: Types.ObjectId;
  audience: WeekendAudience;
  /** Only meaningful when audience='selected'. */
  selectedViewerIds: Types.ObjectId[];
  /** A single attached photo on a `profile_widget` row (My Weekend form's
   *  "Add photo or video" field). Video is not supported here — see
   *  WeekendService.presignMediaUpload — so this is always an image today.
   *  Untouched by the plan_post flow, which uses `planMedia` instead. */
  media?: IWeekendStatusMedia;
  /** The `plan_post` flow's media set — see IWeekendPlanMediaItem. Always
   *  empty on a `profile_widget` row. */
  planMedia: Types.DocumentArray<IWeekendPlanMediaItem>;
  /** Whether this row targets next weekend rather than the current one
   *  (spec's "Weekend scheduling control"). Stored explicitly (rather than
   *  re-derived by comparing `weekendStart` to `currentWeekendWindow()`) so
   *  an edit's prefill is unambiguous even right at a weekend boundary. */
  forNextWeekend: boolean;
  weekendStart: Date;
  weekendEnd: Date;
  activeUntil: Date;
  createdAt: Date;
  updatedAt: Date;
}

const weekendStatusMediaSchema = new Schema<IWeekendStatusMedia>(
  {
    url: { type: String, required: true },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
  },
  { _id: false }
);

const weekendPlanMediaItemSchema = new Schema<IWeekendPlanMediaItem>({
  url: { type: String, required: true },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },
  type: { type: String, enum: ['image', 'video'], required: true },
});

const weekendStatusSchema = new Schema<IWeekendStatus>(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    source: { type: String, enum: ['profile_widget', 'plan_post'], required: true, default: 'profile_widget' },
    clientRequestId: { type: String },
    statusType: { type: String, enum: WEEKEND_STATUS_TYPES, required: true },
    message: { type: String, trim: true, maxlength: WEEKEND_MESSAGE_MAXLEN },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event' },
    audience: { type: String, enum: WEEKEND_AUDIENCES, required: true, default: 'public' },
    selectedViewerIds: { type: [Schema.Types.ObjectId], default: [] },
    media: { type: weekendStatusMediaSchema },
    planMedia: { type: [weekendPlanMediaItemSchema], default: [] },
    forNextWeekend: { type: Boolean, default: false },
    weekendStart: { type: Date, required: true },
    weekendEnd: { type: Date, required: true },
    activeUntil: { type: Date, required: true },
  },
  { timestamps: true }
);

// "Who Has Plans This Weekend" / "Looking for Plans" home-feed queries: active
// rows only, most-recently-updated first (so a renewed/edited status resurfaces).
weekendStatusSchema.index({ activeUntil: 1, updatedAt: -1 });
// Event-linked status lookups (event cancelled/ended sweep, "who else is going").
weekendStatusSchema.index({ eventId: 1, activeUntil: 1 });
// "My Weekend" profile widget (getOwnStatus/upsertStatus/removeStatus) and the
// "+Add" composer's own-plans lookups both filter buyerId+source+activeUntil.
weekendStatusSchema.index({ buyerId: 1, source: 1, activeUntil: 1 });
// Idempotent plan creation (spec: no duplicate plans from a double-click or a
// retried request). A `partialFilterExpression` (not `sparse: true`) — the
// legacy sparse-index option only reliably excludes documents where the
// field is truly absent, and is easy to trip into indexing a stored `null`
// as a real value (the MongoDB driver serializes an explicitly-assigned
// `undefined` to BSON null); the partial filter is unambiguous either way.
weekendStatusSchema.index(
  { buyerId: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } }
);

export const WeekendStatus = model<IWeekendStatus>('WeekendStatus', weekendStatusSchema);
