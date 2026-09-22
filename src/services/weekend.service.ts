import { Types } from 'mongoose';
import { WeekendStatus, IWeekendStatus, IWeekendStatusMedia, IWeekendPlanMediaItem } from '@models/weekendStatus.model';
import { updatesR2 } from '@utils/updatesR2';
import { WeekendRequest, IWeekendRequest } from '@models/weekendRequest.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventPlan } from '@models/eventPlan.model';
import { EventStatus } from '@interfaces/event.interface';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { FollowService } from '@services/follow.service';
import { BlockService } from '@services/block.service';
import { NearbyService, NEARBY_DEFAULT_RADIUS_KM } from '@services/nearby.service';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { toBuyerSummary, BuyerSummary } from '@utils/buyerSummary.util';
import { currentWeekendWindow, nextWeekendWindow } from '@utils/weekendWindow.util';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import {
  WeekendStatusType,
  WeekendAudience,
  WEEKEND_STATUS_TYPES,
  WEEKEND_AUDIENCES,
  WEEKEND_STATUS_LABELS,
  HAS_PLANS_STATUS_TYPES,
  LOOKING_FOR_PLANS_STATUS_TYPES,
  WEEKEND_MESSAGE_MAXLEN,
  WeekendPlanMediaType,
  WEEKEND_PLAN_MEDIA_TYPES,
  WEEKEND_PLAN_MEDIA_MAX,
  WeekendRequestKind,
  WEEKEND_REQUEST_KINDS,
  WEEKEND_REQUEST_KINDS_REQUIRING_EVENT,
  WEEKEND_REQUEST_KIND_LABELS,
  WEEKEND_REQUEST_MESSAGE_MAXLEN,
} from '@interfaces/weekend.interface';

const displayName = (b: IBuyer): string => b.username ?? b.name ?? 'Someone';

/**
 * Matches a `profile_widget` row OR a row from before the `source` field
 * existed — every WeekendStatus created pre-migration (see the model's class
 * doc comment). Mongoose schema defaults never retroactively apply to
 * documents already in the database, only to newly-created ones, so a flat
 * `{source:'profile_widget'}` equality would silently stop matching every
 * pre-existing "My Weekend" row. Never matches a `plan_post` row (those are
 * always created post-migration with `source` explicitly set).
 */
const PROFILE_WIDGET_FILTER = { $or: [{ source: 'profile_widget' }, { source: { $exists: false } }] };

export interface WeekendEventSummary {
  id: string;
  name: string;
  eventDate: Date;
  endTime: Date;
  venue: string;
  posterUrl: string | null;
}

async function loadEventSummary(eventId: Types.ObjectId | string): Promise<WeekendEventSummary | null> {
  const event = await Event.findById(eventId).select('name eventDate endTime venue posterUrl');
  if (!event) return null;
  return { id: String(event._id), name: event.name, eventDate: event.eventDate, endTime: event.endTime, venue: event.venue, posterUrl: event.posterUrl ?? null };
}

function eventSummaryFromDoc(event: any): WeekendEventSummary {
  return { id: String(event._id), name: event.name, eventDate: event.eventDate, endTime: event.endTime, venue: event.venue, posterUrl: event.posterUrl ?? null };
}

export interface WeekendMediaSummary {
  url: string;
  width: number;
  height: number;
}

export interface WeekendPlanMediaItemDto {
  id: string;
  url: string;
  width: number;
  height: number;
  type: WeekendPlanMediaType;
}

export interface WeekendStatusDto {
  id: string;
  statusType: WeekendStatusType;
  statusLabel: string;
  message: string | null;
  audience: WeekendAudience;
  event: WeekendEventSummary | null;
  media: WeekendMediaSummary | null;
  /** spec §3: never inferred — only true when a genuine completed ticket
   *  transaction exists for the STATUS OWNER on the linked event. */
  hasConfirmedTicket: boolean;
  weekendStart: Date;
  weekendEnd: Date;
  updatedAt: Date;
}

/** The "+Add" composer's create/update/get response — a `plan_post` row's
 *  full detail, including everything an Edit prefill needs that the compact
 *  feed card DTO deliberately omits (audience, selectedViewers, the full
 *  media set, forNextWeekend). */
export interface WeekendPlanDto {
  id: string;
  statusType: WeekendStatusType;
  statusLabel: string;
  message: string | null;
  audience: WeekendAudience;
  selectedViewers: BuyerSummary[];
  event: WeekendEventSummary | null;
  media: WeekendPlanMediaItemDto[];
  hasConfirmedTicket: boolean;
  forNextWeekend: boolean;
  weekendStart: Date;
  weekendEnd: Date;
  createdAt: Date;
  updatedAt: Date;
}

function mediaSummary(media: IWeekendStatusMedia | undefined): WeekendMediaSummary | null {
  return media ? { url: media.url, width: media.width ?? 0, height: media.height ?? 0 } : null;
}

function planMediaItemDto(item: IWeekendPlanMediaItem): WeekendPlanMediaItemDto {
  return { id: String(item._id), url: item.url, width: item.width ?? 0, height: item.height ?? 0, type: item.type };
}

/** Unifies a doc's media into one array regardless of which flow created it
 *  (spec §9's Home-card carousel shows media from EITHER source the same
 *  way): a `plan_post` row's `planMedia` array as-is, or a `profile_widget`
 *  row's single legacy `media` attachment wrapped as a one-item array. */
function combinedMediaItems(doc: IWeekendStatus): WeekendPlanMediaItemDto[] {
  if (doc.source === 'plan_post') return doc.planMedia.map(planMediaItemDto);
  return doc.media ? [{ id: 'legacy', url: doc.media.url, width: doc.media.width ?? 0, height: doc.media.height ?? 0, type: 'image' }] : [];
}

async function toStatusDto(doc: IWeekendStatus): Promise<WeekendStatusDto> {
  const event = doc.eventId ? await loadEventSummary(doc.eventId) : null;
  const hasConfirmedTicket = doc.eventId
    ? Boolean(await Ticket.exists({ eventId: doc.eventId, buyerId: doc.buyerId, status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] } }))
    : false;
  return {
    id: String(doc._id),
    statusType: doc.statusType,
    statusLabel: WEEKEND_STATUS_LABELS[doc.statusType],
    message: doc.message ?? null,
    audience: doc.audience,
    event,
    media: mediaSummary(doc.media),
    hasConfirmedTicket,
    weekendStart: doc.weekendStart,
    weekendEnd: doc.weekendEnd,
    updatedAt: doc.updatedAt,
  };
}

async function toPlanDto(doc: IWeekendStatus): Promise<WeekendPlanDto> {
  const [event, selectedViewers] = await Promise.all([
    doc.eventId ? loadEventSummary(doc.eventId) : Promise.resolve(null),
    doc.selectedViewerIds.length
      ? Buyer.find({ _id: { $in: doc.selectedViewerIds } })
          .select('name username avatarUrl')
          .then((rows) => rows.map((r: any) => toBuyerSummary(r)))
      : Promise.resolve([] as BuyerSummary[]),
  ]);
  const hasConfirmedTicket = doc.eventId
    ? Boolean(await Ticket.exists({ eventId: doc.eventId, buyerId: doc.buyerId, status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] } }))
    : false;
  return {
    id: String(doc._id),
    statusType: doc.statusType,
    statusLabel: WEEKEND_STATUS_LABELS[doc.statusType],
    message: doc.message ?? null,
    audience: doc.audience,
    selectedViewers,
    event,
    media: doc.planMedia.map(planMediaItemDto),
    hasConfirmedTicket,
    forNextWeekend: doc.forNextWeekend,
    weekendStart: doc.weekendStart,
    weekendEnd: doc.weekendEnd,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export interface UpsertWeekendStatusInput {
  statusType: string;
  message?: string;
  eventId?: string;
  audience?: string;
  selectedViewerIds?: string[];
  forNextWeekend?: boolean;
  /** `undefined` = leave the existing attachment untouched (same convention
   *  as every other field here); `null` = explicitly remove it; an object =
   *  replace it. Always an already-uploaded url from presignMediaUpload. */
  media?: { url: string; width?: number; height?: number } | null;
}

/** createPlan/updatePlan input — the "+Add" composer always sends its full,
 *  final media set (add/remove/reorder all happen client-side before Post),
 *  so `media` here is a plain array, not the legacy singular endpoint's
 *  undefined/null/object leave-untouched/clear/replace convention. */
export interface CreatePlanInput {
  statusType: string;
  message?: string;
  eventId?: string;
  audience?: string;
  selectedViewerIds?: string[];
  forNextWeekend?: boolean;
  media?: { url: string; width?: number; height?: number; type: string }[];
  /** Only meaningful on create — see WeekendService.createPlan's doc comment. */
  clientRequestId?: string;
}

export interface WeekendFeedCardDto {
  id: string;
  user: BuyerSummary;
  statusType: WeekendStatusType;
  statusLabel: string;
  message: string | null;
  event: WeekendEventSummary | null;
  media: WeekendMediaSummary | null;
  /** Every attached picture/video, unified across both sources — see
   *  `combinedMediaItems` — for the Home-card carousel (spec §9). */
  mediaItems: WeekendPlanMediaItemDto[];
  otherAttendeeAvatars: (string | null)[];
  weekendStart: Date;
  weekendEnd: Date;
  updatedAt: Date;
  /** True only when this card belongs to the requesting viewer (spec §3: the
   *  owner must recognize their own card and get an Edit/Update action
   *  instead of a "send a request to yourself" one). Always false for a
   *  signed-out viewer or when the card belongs to someone else. */
  isOwner: boolean;
  /** True only for the owner's OWN `plan_post` cards — tells the client to
   *  route "Edit" to the "+Add" composer's edit mode (WeekendService.getPlan/
   *  updatePlan) for THIS SPECIFIC card, instead of the legacy profile-widget
   *  deep link, which only ever edits one singular status and would silently
   *  edit the wrong plan once a buyer has more than one. */
  editableAsPlan: boolean;
}

export interface WeekendRequestRow {
  id: string;
  kind: WeekendRequestKind;
  status: string;
  direction: 'incoming' | 'outgoing';
  message: string | null;
  event: WeekendEventSummary | null;
  other: BuyerSummary;
  createdAt: Date;
  respondedAt: Date | null;
}

export class WeekendService {
  /**
   * Create/replace the buyer's ONE current status (spec §1/§2: "update,
   * replace or remove ... at any time"). A general status expires at the end
   * of the target weekend; an event-linked one instead stays active until
   * the event's `endTime` (spec §19) — computed here into `activeUntil` so
   * every read path is a single flat comparison.
   */
  /**
   * Validation + derived-field computation shared by `upsertStatus` (the
   * profile widget's singular status) and `createPlan`/`updatePlan` (the
   * "+Add" composer's many plans) — one implementation of "what makes a
   * statusType/message/audience/event/schedule combination valid", so the
   * two flows can never quietly drift apart on the rules they enforce.
   */
  private static async buildCommonFields(input: {
    statusType: string;
    message?: string;
    eventId?: string;
    audience?: string;
    selectedViewerIds?: string[];
    forNextWeekend?: boolean;
  }): Promise<{
    statusType: WeekendStatusType;
    message: string | undefined;
    audience: WeekendAudience;
    selectedViewerIds: Types.ObjectId[];
    eventId: Types.ObjectId | undefined;
    forNextWeekend: boolean;
    weekendStart: Date;
    weekendEnd: Date;
    activeUntil: Date;
  }> {
    if (!WEEKEND_STATUS_TYPES.includes(input.statusType as WeekendStatusType)) throw new HttpError(400, 'Invalid status');
    const statusType = input.statusType as WeekendStatusType;
    const audience: WeekendAudience = WEEKEND_AUDIENCES.includes(input.audience as WeekendAudience) ? (input.audience as WeekendAudience) : 'public';

    const message = input.message?.trim().slice(0, WEEKEND_MESSAGE_MAXLEN) || undefined;
    if (statusType === 'custom' && !message) throw new HttpError(400, 'A custom status needs a message');

    let selectedViewerIds: Types.ObjectId[] = [];
    if (audience === 'selected') {
      const ids = (input.selectedViewerIds ?? []).filter((id) => HEX24.test(id));
      if (ids.length === 0) throw new HttpError(400, 'Choose at least one person for "Selected People"');
      selectedViewerIds = ids.map((id) => new Types.ObjectId(id));
    }

    let event: any = null;
    if (statusType === 'going_to_event') {
      if (!input.eventId || !HEX24.test(input.eventId)) throw new HttpError(400, 'Select an upcoming event');
      event = await Event.findById(input.eventId).select('status endTime');
      if (!event) throw new HttpError(404, 'Event not found');
      if (event.endTime.getTime() <= Date.now() || event.status === EventStatus.CANCELLED) {
        throw new HttpError(400, 'That event is no longer upcoming');
      }
    }

    const { start: weekendStart, end: weekendEnd } = input.forNextWeekend ? nextWeekendWindow() : currentWeekendWindow();
    const activeUntil = event ? event.endTime : weekendEnd;

    return {
      statusType,
      message,
      audience,
      selectedViewerIds,
      eventId: event ? event._id : undefined,
      forNextWeekend: Boolean(input.forNextWeekend),
      weekendStart,
      weekendEnd,
      activeUntil,
    };
  }

  static async upsertStatus(buyer: IBuyer, input: UpsertWeekendStatusInput): Promise<WeekendStatusDto> {
    const common = await WeekendService.buildCommonFields(input);

    let media: IWeekendStatusMedia | undefined;
    let clearMedia = false;
    if (input.media === null) {
      clearMedia = true;
    } else if (input.media) {
      const url = String(input.media.url || '');
      const publicBase = process.env['UPDATES_R2_PUBLIC_URL'];
      if (!publicBase || !url.startsWith(publicBase)) throw new HttpError(400, 'Invalid photo — upload it through the weekend media endpoint first');
      media = { url, width: Number(input.media.width) || 0, height: Number(input.media.height) || 0 };
    }

    const doc = await WeekendStatus.findOneAndUpdate(
      { buyerId: buyer._id, ...PROFILE_WIDGET_FILTER },
      {
        $set: {
          source: 'profile_widget',
          statusType: common.statusType,
          message: common.message,
          eventId: common.eventId,
          audience: common.audience,
          selectedViewerIds: common.selectedViewerIds,
          forNextWeekend: common.forNextWeekend,
          weekendStart: common.weekendStart,
          weekendEnd: common.weekendEnd,
          activeUntil: common.activeUntil,
          ...(media ? { media } : {}),
        },
        $unset: {
          ...(common.eventId ? {} : { eventId: '' }),
          ...(clearMedia ? { media: '' } : {}),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return toStatusDto(doc);
  }

  /** image/jpeg|png|webp, video/mp4|quicktime|webm — R2 content-type allow-list
   *  for a `plan_post` media item (spec §5/§6). Direct upload, no transcode
   *  pipeline: see `presignPlanMediaUpload`'s own doc comment for why. */
  private static readonly ALLOWED_PLAN_MEDIA_TYPES: Record<string, { type: WeekendPlanMediaType; ext: string }> = {
    'image/jpeg': { type: 'image', ext: 'jpg' },
    'image/png': { type: 'image', ext: 'png' },
    'image/webp': { type: 'image', ext: 'webp' },
    'video/mp4': { type: 'video', ext: 'mp4' },
    'video/quicktime': { type: 'video', ext: 'mov' },
    'video/webm': { type: 'video', ext: 'webm' },
  };

  /**
   * Presigns an R2 upload for one item of a "+Add" plan's media set.
   * Deliberately NOT the same transcode pipeline Update/Story posts use
   * (@services/transcode.client.ts): that pipeline hands off to a separate
   * transcoder microservice hardcoded to a fixed `'updates' | 'stories' |
   * 'eventPlanMessages'` collection union, so wiring in a 4th collection
   * means changing a service this repo doesn't own/deploy — out of scope
   * here. A plan's video is instead stored exactly as uploaded (no
   * server-side poster frame or rendition) — acceptable for this feature:
   * the client renders its own play-icon overlay over the raw file, same as
   * every other local preview in this app already does.
   */
  static async presignPlanMediaUpload(contentType: string): Promise<{ uploadUrl: string; publicUrl: string; type: WeekendPlanMediaType }> {
    const allowed = WeekendService.ALLOWED_PLAN_MEDIA_TYPES[contentType];
    if (!allowed) throw new HttpError(400, 'Only JPEG/PNG/WEBP photos or MP4/MOV/WEBM videos are supported');
    const key = updatesR2.rawKey(allowed.ext);
    const uploadUrl = await updatesR2.presignPut(key, contentType);
    return { uploadUrl, publicUrl: updatesR2.publicUrl(key), type: allowed.type };
  }

  /**
   * Create a brand-new "+Add" plan (spec: "each successful submission must
   * create a separate plan with its own unique ID" / "do not limit users to
   * one weekend plan at a time") — always an insert, never an upsert, so a
   * buyer's existing plans are untouched.
   *
   * `clientRequestId` (spec: "prevent accidental duplicates caused by
   * repeated clicks or network retries") makes a repeat call with the same
   * id idempotent: if a plan with this (buyerId, clientRequestId) already
   * exists, it's returned as-is instead of creating a second one. The
   * schema's sparse-unique index on the same pair is the authoritative
   * guard for the race where two requests both miss the pre-check.
   */
  static async createPlan(buyer: IBuyer, input: CreatePlanInput): Promise<WeekendPlanDto> {
    const clientRequestId = input.clientRequestId?.trim() || undefined;
    if (clientRequestId) {
      const existing = await WeekendStatus.findOne({ buyerId: buyer._id, source: 'plan_post', clientRequestId });
      if (existing) return toPlanDto(existing);
    }

    const common = await WeekendService.buildCommonFields(input);
    const media = WeekendService.validatePlanMedia(input.media);

    try {
      const doc = await WeekendStatus.create({
        buyerId: buyer._id,
        source: 'plan_post',
        // Only set the key when there's a real value — leaving it truly
        // absent (rather than an explicit `undefined`, which the Mongo
        // driver can serialize as BSON null) is what makes the schema's
        // sparse unique index actually skip plans with no clientRequestId
        // instead of colliding on repeated nulls for the same buyer.
        ...(clientRequestId ? { clientRequestId } : {}),
        statusType: common.statusType,
        message: common.message,
        eventId: common.eventId,
        audience: common.audience,
        selectedViewerIds: common.selectedViewerIds,
        forNextWeekend: common.forNextWeekend,
        weekendStart: common.weekendStart,
        weekendEnd: common.weekendEnd,
        activeUntil: common.activeUntil,
        planMedia: media,
      });
      return toPlanDto(doc);
    } catch (err: any) {
      // Lost the idempotency race (two near-simultaneous submits with the
      // same clientRequestId) — the unique index rejected the second
      // insert. Return the row the first request created instead of
      // surfacing a confusing duplicate-key 500.
      if (err?.code === 11000 && clientRequestId) {
        const existing = await WeekendStatus.findOne({ buyerId: buyer._id, source: 'plan_post', clientRequestId });
        if (existing) return toPlanDto(existing);
      }
      throw err;
    }
  }

  private static async loadOwnPlan(buyer: IBuyer, id: string): Promise<IWeekendStatus> {
    if (!HEX24.test(id)) throw new HttpError(400, 'Invalid plan id');
    const doc = await WeekendStatus.findOne({ _id: id, buyerId: buyer._id, source: 'plan_post' });
    if (!doc) throw new HttpError(404, 'Plan not found');
    return doc;
  }

  /** The "+Add" composer's edit-mode prefill for one specific plan — never
   *  the buyer's "most recent" or "first" plan, always the exact id the
   *  card's Edit action was clicked on. */
  static async getPlan(buyer: IBuyer, id: string): Promise<WeekendPlanDto> {
    return toPlanDto(await WeekendService.loadOwnPlan(buyer, id));
  }

  /** Edits one specific existing plan in place (spec: "use the existing
   *  card's Edit action when the user wants to change that specific plan")
   *  — never creates a new row, never touches the buyer's other plans. */
  static async updatePlan(buyer: IBuyer, id: string, input: CreatePlanInput): Promise<WeekendPlanDto> {
    const doc = await WeekendService.loadOwnPlan(buyer, id);
    const common = await WeekendService.buildCommonFields(input);
    const media = WeekendService.validatePlanMedia(input.media);

    doc.statusType = common.statusType;
    doc.message = common.message;
    doc.eventId = common.eventId;
    doc.audience = common.audience;
    doc.selectedViewerIds = common.selectedViewerIds;
    doc.forNextWeekend = common.forNextWeekend;
    doc.weekendStart = common.weekendStart;
    doc.weekendEnd = common.weekendEnd;
    doc.activeUntil = common.activeUntil;
    doc.planMedia = media as unknown as Types.DocumentArray<IWeekendPlanMediaItem>;
    await doc.save();
    return toPlanDto(doc);
  }

  /** Removes one specific plan (used by the card's own management actions —
   *  never touches the buyer's other plans). */
  static async removePlan(buyer: IBuyer, id: string): Promise<void> {
    await WeekendService.loadOwnPlan(buyer, id);
    await WeekendStatus.deleteOne({ _id: id, buyerId: buyer._id, source: 'plan_post' });
  }

  private static validatePlanMedia(media: { url: string; width?: number; height?: number; type: string }[] | undefined): IWeekendPlanMediaItem[] {
    const items = media ?? [];
    if (items.length > WEEKEND_PLAN_MEDIA_MAX) throw new HttpError(400, `Attach at most ${WEEKEND_PLAN_MEDIA_MAX} pictures or videos`);
    const publicBase = process.env['UPDATES_R2_PUBLIC_URL'];
    return items.map((item) => {
      const url = String(item.url || '');
      if (!publicBase || !url.startsWith(publicBase)) throw new HttpError(400, 'Invalid media — upload it through the plan media endpoint first');
      if (!WEEKEND_PLAN_MEDIA_TYPES.includes(item.type as WeekendPlanMediaType)) throw new HttpError(400, 'Invalid media type');
      return {
        _id: new Types.ObjectId(),
        url,
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        type: item.type as WeekendPlanMediaType,
      } as IWeekendPlanMediaItem;
    });
  }

  /** image/jpeg|png|webp only — video is a known follow-up (needs the same
   *  transcode pipeline `update.service.ts` uses; out of scope here so it
   *  fails loudly rather than silently accepting a file it can't process). */
  private static readonly ALLOWED_MEDIA_TYPES: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };

  static async presignMediaUpload(contentType: string): Promise<{ uploadUrl: string; publicUrl: string }> {
    const ext = WeekendService.ALLOWED_MEDIA_TYPES[contentType];
    if (!ext) throw new HttpError(400, 'Only JPEG, PNG or WEBP photos are supported right now');
    const key = updatesR2.rawKey(ext);
    const uploadUrl = await updatesR2.presignPut(key, contentType);
    return { uploadUrl, publicUrl: updatesR2.publicUrl(key) };
  }

  static async getOwnStatus(buyer: IBuyer): Promise<WeekendStatusDto | null> {
    const doc = await WeekendStatus.findOne({ buyerId: buyer._id, activeUntil: { $gt: new Date() }, ...PROFILE_WIDGET_FILTER });
    return doc ? toStatusDto(doc) : null;
  }

  static async removeStatus(buyer: IBuyer): Promise<void> {
    await WeekendStatus.deleteOne({ buyerId: buyer._id, ...PROFILE_WIDGET_FILTER });
  }

  /**
   * A visitor's view of `username`'s status (spec §4 audience + §20
   * privacy): blocked-either-way and any failed audience check both come
   * back as `hasStatus: false` — a viewer who isn't allowed to see it must
   * not be able to tell an active-but-hidden status apart from none at all.
   */
  static async getForViewer(viewer: IBuyer | null, username: string): Promise<{ username: string; hasStatus: boolean; status: WeekendStatusDto | null }> {
    const owner = await Buyer.findOne({ username: username.toLowerCase() }).select('username');
    if (!owner) throw new HttpError(404, 'User not found');
    const ownerId = String(owner._id);
    const isOwn = Boolean(viewer && String(viewer._id) === ownerId);

    const doc = await WeekendStatus.findOne({ buyerId: owner._id, activeUntil: { $gt: new Date() }, ...PROFILE_WIDGET_FILTER });
    if (!doc) return { username: owner.username!, hasStatus: false, status: null };

    if (!isOwn) {
      if (viewer && (await BlockService.isBlockedEitherWay(String(viewer._id), ownerId))) {
        return { username: owner.username!, hasStatus: false, status: null };
      }
      if (doc.audience === 'only_me') return { username: owner.username!, hasStatus: false, status: null };
      if (doc.audience === 'followers') {
        const followingIds = viewer ? await FollowService.followingIds(String(viewer._id), 'buyer') : [];
        if (!viewer || !followingIds.map(String).includes(ownerId)) {
          return { username: owner.username!, hasStatus: false, status: null };
        }
      }
      if (doc.audience === 'selected') {
        if (!viewer || !doc.selectedViewerIds.map(String).includes(String(viewer._id))) {
          return { username: owner.username!, hasStatus: false, status: null };
        }
      }
    }

    return { username: owner.username!, hasStatus: true, status: await toStatusDto(doc) };
  }

  /** Buyer ids blocked in either direction from `viewerId`, for feed exclusion. */
  private static async blockedEitherWayIds(viewerId: string): Promise<string[]> {
    const [iBlocked, blockedMe] = await Promise.all([BlockService.listBlockedIds(viewerId), BlockService.listBlockerIds(viewerId)]);
    return [...iBlocked, ...blockedMe];
  }

  /** Audience filter usable directly in a Mongo query for a given viewer. */
  private static audienceOrClause(viewerId: string | null, followingIds: string[]): any[] {
    const or: any[] = [{ audience: 'public' }];
    if (viewerId) {
      or.push({ audience: 'followers', buyerId: { $in: followingIds.map((id) => new Types.ObjectId(id)) } });
      or.push({ audience: 'selected', selectedViewerIds: new Types.ObjectId(viewerId) });
    }
    return or;
  }

  /**
   * Shared assembly for both Home-feed rails (spec §5-§8): "Who Has Plans
   * This Weekend" (`HAS_PLANS_STATUS_TYPES`) and "Looking for Plans"
   * (`LOOKING_FOR_PLANS_STATUS_TYPES`) — same audience/block/rotation rules,
   * different status-type bucket, so one implementation serves both rather
   * than duplicating the ranking logic (spec asks they never mix).
   *
   * Ranking (spec §8): followed (a friend is by definition also followed —
   * see FollowService.isFriend — so this single tier covers both "follows"
   * and "friends"), then nearby (only when the viewer shares a location),
   * then everyone else — shuffled WITHIN each tier so a refresh "rotates
   * displayed users" without abandoning the priority order. `excludeIds` is
   * the caller's session "don't repeat" cursor (same shape as Vote/Plan
   * feed cards — see feed.service.ts).
   *
   * Known gap (documented, not silently wrong): spec's tier 3 — "users
   * attending events the viewer saved, followed or viewed" — has no
   * backing signal in this data model yet and is not implemented.
   */
  private static async rankedCandidates(viewer: IBuyer | null, statusTypes: WeekendStatusType[], limit: number, excludeIds: string[]): Promise<IWeekendStatus[]> {
    const viewerId = viewer ? String(viewer._id) : null;
    const now = new Date();
    const [followingIds, excludedBlocked] = await Promise.all([
      viewerId ? FollowService.followingIds(viewerId, 'buyer') : Promise.resolve([] as any[]),
      viewerId ? WeekendService.blockedEitherWayIds(viewerId) : Promise.resolve([] as string[]),
    ]);

    const query: any = {
      activeUntil: { $gt: now },
      statusType: { $in: statusTypes },
      $or: WeekendService.audienceOrClause(viewerId, followingIds.map(String)),
    };
    const excludeBuyerIds = [...(viewerId ? [viewerId] : []), ...excludedBlocked];
    if (excludeBuyerIds.length) query.buyerId = { $nin: excludeBuyerIds.map((id) => new Types.ObjectId(id)) };
    if (excludeIds.length) query._id = { $nin: excludeIds.filter((id) => HEX24.test(id)).map((id) => new Types.ObjectId(id)) };

    const overfetch = Math.max(limit * 4, limit + 10);
    const candidates = await WeekendStatus.find(query).sort({ updatedAt: -1 }).limit(overfetch);
    if (candidates.length === 0) return [];

    let nearbySet = new Set<string>();
    if (viewer?.location?.coordinates) {
      const [lng, lat] = viewer.location.coordinates;
      const nearby = await NearbyService.nearbyPeople({ type: 'buyer', id: String(viewer._id) }, lat, lng, NEARBY_DEFAULT_RADIUS_KM).catch(() => []);
      nearbySet = new Set(nearby.map((n) => n.id));
    }
    const followSet = new Set(followingIds.map(String));

    const tiers: IWeekendStatus[][] = [[], [], []];
    for (const c of candidates) {
      const id = String(c.buyerId);
      const tier = followSet.has(id) ? 0 : nearbySet.has(id) ? 1 : 2;
      tiers[tier]!.push(c);
    }
    for (const bucket of tiers) {
      for (let i = bucket.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bucket[i], bucket[j]] = [bucket[j]!, bucket[i]!];
      }
    }
    return tiers.flat().slice(0, limit);
  }

  private static async toFeedCards(candidates: IWeekendStatus[], viewerId: string | null = null): Promise<WeekendFeedCardDto[]> {
    if (candidates.length === 0) return [];
    const buyerIds = [...new Set(candidates.map((c) => String(c.buyerId)))];
    const eventIds = [...new Set(candidates.filter((c) => c.eventId).map((c) => String(c.eventId)))];
    const [buyers, events] = await Promise.all([
      Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl'),
      eventIds.length ? Event.find({ _id: { $in: eventIds } }).select('name eventDate endTime venue posterUrl') : Promise.resolve([] as any[]),
    ]);
    const buyerById = new Map(buyers.map((b: any) => [String(b._id), b]));
    const eventById = new Map(events.map((e: any) => [String(e._id), e]));

    // "small overlapping profile pictures of other relevant attendees" (spec
    // §6) — other buyers also publicly going to the SAME event, capped at 5.
    const otherGoingByEvent = new Map<string, (string | null)[]>();
    if (eventIds.length) {
      const others = await WeekendStatus.find({
        eventId: { $in: eventIds.map((id) => new Types.ObjectId(id)) },
        statusType: 'going_to_event',
        audience: 'public',
        activeUntil: { $gt: new Date() },
      })
        .select('eventId buyerId')
        .limit(200);
      const otherBuyerIds = [...new Set(others.map((o: any) => String(o.buyerId)))];
      const otherBuyers = await Buyer.find({ _id: { $in: otherBuyerIds } }).select('avatarUrl');
      const avatarById = new Map(otherBuyers.map((b: any) => [String(b._id), b.avatarUrl ?? null]));
      for (const o of others as any[]) {
        const key = String(o.eventId);
        const arr = otherGoingByEvent.get(key) ?? [];
        if (arr.length < 5) arr.push(avatarById.get(String(o.buyerId)) ?? null);
        otherGoingByEvent.set(key, arr);
      }
    }

    return candidates.map((c) => {
      const buyer = buyerById.get(String(c.buyerId));
      const event = c.eventId ? eventById.get(String(c.eventId)) : null;
      const isOwner = viewerId !== null && String(c.buyerId) === viewerId;
      return {
        id: String(c._id),
        user: buyer ? toBuyerSummary(buyer) : { id: String(c.buyerId), username: null, name: null, avatarUrl: null },
        statusType: c.statusType,
        statusLabel: WEEKEND_STATUS_LABELS[c.statusType],
        message: c.message ?? null,
        event: event ? eventSummaryFromDoc(event) : null,
        media: mediaSummary(c.media),
        mediaItems: combinedMediaItems(c),
        otherAttendeeAvatars: c.eventId ? otherGoingByEvent.get(String(c.eventId)) ?? [] : [],
        weekendStart: c.weekendStart,
        weekendEnd: c.weekendEnd,
        updatedAt: c.updatedAt,
        isOwner,
        editableAsPlan: isOwner && c.source === 'plan_post',
      };
    });
  }

  /**
   * ALL of the viewer's own active statuses/plans, as feed cards, regardless
   * of `statusType` bucket (spec §3: whatever they posted through "+ Add"
   * must show up as their own card in "Who Has Plans This Weekend" — the
   * section that flow lives in — even if the status type they picked would
   * normally route to "Looking for Plans" or neither rail for anyone else
   * viewing it). Newest first (spec: "keep the newly created owner's card
   * first") — a buyer can now have any number of `plan_post` rows plus at
   * most one `profile_widget` row, and none of them are ever hidden or
   * replaced by another (spec: "do not replace or remove the user's other
   * active plans"). `rankedCandidates`/the See-All query always exclude the
   * viewer's own buyerId, so these are assembled separately and prepended by
   * the caller.
   */
  private static async ownCardsIfActive(viewer: IBuyer): Promise<WeekendFeedCardDto[]> {
    const docs = await WeekendStatus.find({ buyerId: viewer._id, activeUntil: { $gt: new Date() } }).sort({ createdAt: -1 });
    if (docs.length === 0) return [];
    return WeekendService.toFeedCards(docs, String(viewer._id));
  }

  /**
   * "Who Has Plans This Weekend" (spec §5/§6). The viewer's own active status
   * is prepended first (spec §3) on the initial page only — `excludeIds`
   * non-empty means this is a `loadMore` continuation, which must never
   * re-insert the owner's already-shown card.
   */
  static async getWhoHasPlansCards(viewer: IBuyer | null, limit: number, excludeIds: string[]): Promise<WeekendFeedCardDto[]> {
    const ownCards = viewer && excludeIds.length === 0 ? await WeekendService.ownCardsIfActive(viewer) : [];
    const candidates = await WeekendService.rankedCandidates(viewer, HAS_PLANS_STATUS_TYPES, limit, excludeIds);
    const cards = await WeekendService.toFeedCards(candidates, viewer ? String(viewer._id) : null);
    return [...ownCards, ...cards];
  }

  /** "Looking for Plans" (spec §8, further down the feed — never mixed with the above). */
  static async getLookingForPlansCards(viewer: IBuyer | null, limit: number, excludeIds: string[]): Promise<WeekendFeedCardDto[]> {
    const candidates = await WeekendService.rankedCandidates(viewer, LOOKING_FOR_PLANS_STATUS_TYPES, limit, excludeIds);
    return WeekendService.toFeedCards(candidates, viewer ? String(viewer._id) : null);
  }

  /**
   * The "Who Has Plans This Weekend" See All page: every eligible public
   * (same audience/block rules as the rail) status, cursor-paginated. The
   * viewer's own active status is prepended on the first page only (spec §3
   * — same rule as `getWhoHasPlansCards`; `cursor === null` is "first page").
   * Deliberately NOT `rankedCandidates` — that method overfetches-then-
   * shuffles for a small rail, which has no stable order across pages;
   * this is a plain `updatedAt` desc, `_id` desc sort so a cursor built
   * from the last row of one page is a correct boundary for the next.
   */
  static async getWhoHasPlansPage(
    viewer: IBuyer | null,
    cursor: string | null,
    limit: number
  ): Promise<{ cards: WeekendFeedCardDto[]; nextCursor: string | null }> {
    const viewerId = viewer ? String(viewer._id) : null;
    const ownCards = viewer && !cursor ? await WeekendService.ownCardsIfActive(viewer) : [];
    const now = new Date();
    const [followingIds, excludedBlocked] = await Promise.all([
      viewerId ? FollowService.followingIds(viewerId, 'buyer') : Promise.resolve([] as any[]),
      viewerId ? WeekendService.blockedEitherWayIds(viewerId) : Promise.resolve([] as string[]),
    ]);

    const query: any = {
      activeUntil: { $gt: now },
      statusType: { $in: HAS_PLANS_STATUS_TYPES },
      $or: WeekendService.audienceOrClause(viewerId, followingIds.map(String)),
    };
    const excludeBuyerIds = [...(viewerId ? [viewerId] : []), ...excludedBlocked];
    if (excludeBuyerIds.length) query.buyerId = { $nin: excludeBuyerIds.map((id) => new Types.ObjectId(id)) };

    const decoded = WeekendService.decodeSeeAllCursor(cursor);
    if (decoded) {
      query.$and = [{ $or: [{ updatedAt: { $lt: decoded.updatedAt } }, { updatedAt: decoded.updatedAt, _id: { $lt: decoded.id } }] }];
    }

    const rows = await WeekendStatus.find(query)
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const cards = await WeekendService.toFeedCards(page, viewerId);
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? WeekendService.encodeSeeAllCursor(last.updatedAt, String(last._id)) : null;
    return { cards: [...ownCards, ...cards], nextCursor };
  }

  private static encodeSeeAllCursor(updatedAt: Date, id: string): string {
    return Buffer.from(JSON.stringify({ t: updatedAt.getTime(), id })).toString('base64url');
  }

  private static decodeSeeAllCursor(raw: string | null): { updatedAt: Date; id: Types.ObjectId } | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (typeof parsed.t !== 'number' || typeof parsed.id !== 'string' || !HEX24.test(parsed.id)) return null;
      return { updatedAt: new Date(parsed.t), id: new Types.ObjectId(parsed.id) };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // Private requests (spec §11-§17)
  // ---------------------------------------------------------------------

  static async createRequest(
    sender: IBuyer,
    input: { recipientId: string; kind: string; eventId?: string; eventPlanId?: string; message?: string; weekendStatusId?: string }
  ): Promise<{ id: string; status: string }> {
    if (!WEEKEND_REQUEST_KINDS.includes(input.kind as WeekendRequestKind)) throw new HttpError(400, 'Invalid request kind');
    const kind = input.kind as WeekendRequestKind;
    if (!HEX24.test(input.recipientId)) throw new HttpError(400, 'Invalid recipient');
    const recipientId = input.recipientId;
    const senderId = String(sender._id);
    if (senderId === recipientId) throw new HttpError(400, 'You cannot send this to yourself');

    const recipient = await Buyer.findById(recipientId).select('username');
    if (!recipient || !recipient.username) throw new HttpError(404, 'User not found');
    if (await BlockService.isBlockedEitherWay(senderId, recipientId)) throw new HttpError(403, 'You cannot send this request');

    let eventId: Types.ObjectId | undefined;
    if (input.eventId) {
      if (!HEX24.test(input.eventId)) throw new HttpError(400, 'Invalid event');
      const event = await Event.findById(input.eventId).select('endTime');
      if (!event || event.endTime.getTime() <= Date.now()) throw new HttpError(404, 'Event not found or already over');
      eventId = event._id;
    } else if (WEEKEND_REQUEST_KINDS_REQUIRING_EVENT.includes(kind)) {
      throw new HttpError(400, 'Select an event first');
    }

    let eventPlanId: Types.ObjectId | undefined;
    if (input.eventPlanId) {
      if (!HEX24.test(input.eventPlanId)) throw new HttpError(400, 'Invalid table/plan');
      const plan = await EventPlan.findById(input.eventPlanId).select('_id status');
      if (!plan || plan.status !== 'active') throw new HttpError(404, 'That table/plan is no longer available');
      eventPlanId = plan._id;
    }

    const message = input.message?.trim().slice(0, WEEKEND_REQUEST_MESSAGE_MAXLEN) || undefined;
    const weekendStatusId = input.weekendStatusId && HEX24.test(input.weekendStatusId) ? new Types.ObjectId(input.weekendStatusId) : undefined;

    // Idempotent: an identical still-pending ask is returned instead of piling up duplicates.
    const dupeQuery: any = { senderId, recipientId, kind, status: 'pending' };
    if (eventId) dupeQuery.eventId = eventId;
    const existing = await WeekendRequest.findOne(dupeQuery);
    if (existing) return { id: String(existing._id), status: existing.status };

    const row = await WeekendRequest.create({ senderId, recipientId, kind, eventId, eventPlanId, weekendStatusId, message });

    NotificationDispatcher.dispatchAsync(
      [recipientId],
      'weekend_request_received',
      displayName(sender),
      `${WEEKEND_REQUEST_KIND_LABELS[kind]}${message ? ': "' + message + '"' : ''}`,
      { requestId: String(row._id), kind, eventId: eventId ? String(eventId) : null, senderId },
      senderId
    );
    return { id: String(row._id), status: 'pending' };
  }

  private static async loadRequestFor(id: string, buyerId: string, role: 'sender' | 'recipient'): Promise<IWeekendRequest> {
    if (!HEX24.test(id)) throw new HttpError(400, 'Invalid request id');
    const row = await WeekendRequest.findById(id);
    if (!row) throw new HttpError(404, 'Request not found');
    const owner = role === 'recipient' ? String(row.recipientId) : String(row.senderId);
    if (owner !== buyerId) throw new HttpError(403, 'Not your request');
    return row;
  }

  static async respondToRequest(actor: IBuyer, id: string, accept: boolean): Promise<void> {
    const row = await WeekendService.loadRequestFor(id, String(actor._id), 'recipient');
    if (row.status !== 'pending') throw new HttpError(409, 'This request is no longer pending');
    const updated = await WeekendRequest.findOneAndUpdate(
      { _id: row._id, status: 'pending' },
      { $set: { status: accept ? 'accepted' : 'declined', respondedAt: new Date() } },
      { new: true }
    );
    if (!updated) return;
    NotificationDispatcher.dispatchAsync(
      [String(updated.senderId)],
      'weekend_request_responded',
      displayName(actor),
      accept ? `accepted your ask: ${WEEKEND_REQUEST_KIND_LABELS[updated.kind]}` : `declined your ask: ${WEEKEND_REQUEST_KIND_LABELS[updated.kind]}`,
      { requestId: String(updated._id), kind: updated.kind, status: updated.status },
      String(actor._id)
    );
  }

  static async cancelRequest(sender: IBuyer, id: string): Promise<void> {
    const row = await WeekendService.loadRequestFor(id, String(sender._id), 'sender');
    if (row.status !== 'pending') throw new HttpError(409, 'Only a pending request can be cancelled');
    row.status = 'cancelled';
    row.respondedAt = new Date();
    await row.save();
  }

  static async listRequests(buyer: IBuyer, status?: string): Promise<WeekendRequestRow[]> {
    const me = String(buyer._id);
    const query: any = { $or: [{ senderId: me }, { recipientId: me }] };
    if (status) query.status = status;
    const rows = await WeekendRequest.find(query).sort({ _id: -1 }).limit(100);
    if (rows.length === 0) return [];
    const otherIds = [...new Set(rows.map((r) => (String(r.recipientId) === me ? String(r.senderId) : String(r.recipientId))))];
    const eventIds = [...new Set(rows.filter((r) => r.eventId).map((r) => String(r.eventId)))];
    const [buyers, events] = await Promise.all([
      Buyer.find({ _id: { $in: otherIds } }).select('name username avatarUrl'),
      eventIds.length ? Event.find({ _id: { $in: eventIds } }).select('name eventDate endTime venue posterUrl') : Promise.resolve([] as any[]),
    ]);
    const buyerById = new Map(buyers.map((b: any) => [String(b._id), b]));
    const eventById = new Map(events.map((e: any) => [String(e._id), e]));

    return rows.map((r) => {
      const incoming = String(r.recipientId) === me;
      const otherId = incoming ? String(r.senderId) : String(r.recipientId);
      const other = buyerById.get(otherId);
      const event = r.eventId ? eventById.get(String(r.eventId)) : null;
      return {
        id: String(r._id),
        kind: r.kind,
        status: r.status,
        direction: incoming ? 'incoming' : ('outgoing' as const),
        message: r.message ?? null,
        event: event ? eventSummaryFromDoc(event) : null,
        other: other ? toBuyerSummary(other) : { id: otherId, username: null, name: null, avatarUrl: null },
        createdAt: r.createdAt,
        respondedAt: r.respondedAt ?? null,
      };
    });
  }

  /** spec §19 "remove expired or cancelled events from active plans" — a
   *  cancelled event doesn't naturally age out via `activeUntil` (its
   *  `endTime` may still be in the future), so this is the one case that
   *  needs an explicit sweep rather than a query-time filter. */
  static async sweepCancelledEventLinks(): Promise<void> {
    const linked = await WeekendStatus.find({ eventId: { $ne: null }, activeUntil: { $gt: new Date() } }).select('eventId');
    if (linked.length === 0) return;
    const eventIds = [...new Set(linked.map((l) => String(l.eventId)))];
    const cancelled = await Event.find({ _id: { $in: eventIds }, status: EventStatus.CANCELLED }).select('_id');
    if (cancelled.length === 0) return;
    await WeekendStatus.deleteMany({ eventId: { $in: cancelled.map((e) => e._id) } });
  }
}
