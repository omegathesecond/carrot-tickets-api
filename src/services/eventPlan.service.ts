import { Types } from 'mongoose';
import { EventPlan, IEventPlan, PlanVisibility, PlanJoinPolicy } from '@models/eventPlan.model';
import { EventPlanMember, IEventPlanMember, PlanAttendanceStatus } from '@models/eventPlanMember.model';
import { EventPlanReaction } from '@models/eventPlanReaction.model';
import { EventPlanMessage } from '@models/eventPlanMessage.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { BlockService } from '@services/block.service';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { toggleReactionGeneric } from '@services/reactions.service';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import type { SocialActor } from '@utils/socialActor.util';
import { updatesR2 } from '@utils/updatesR2';

const COVER_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const COVER_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type PlanViewerReactions = { liked: boolean; saved: boolean };

const displayName = (b: IBuyer | null | undefined): string => b?.username ?? b?.name ?? 'Someone';

type BuyerSummary = { id: string; name: string | null; username: string | null; avatarUrl: string | null };

const buyerSummary = (b: any): BuyerSummary => ({
  id: String(b._id),
  name: b.name ?? null,
  username: b.username ?? null,
  avatarUrl: b.avatarUrl ?? null,
});

export interface CreatePlanInput {
  /** Exactly one of eventId / manualEvent must be given (spec §2). */
  eventId?: string;
  manualEvent?: { name: string; date?: string | Date; location?: string };
  name: string;
  description?: string;
  visibility?: PlanVisibility;
  joinPolicy?: PlanJoinPolicy;
  meetingPoint?: string;
  meetingTime?: string | Date;
  transport?: { method?: string; provider?: string; seats?: number; costEstimate?: number; notes?: string };
  inviteeIds?: string[];
}

export interface UpdatePlanInput {
  name?: string;
  description?: string;
  joinPolicy?: PlanJoinPolicy;
  meetingPoint?: string;
  meetingTime?: string | Date | null;
  meetingConfirmed?: boolean;
  transport?: { method?: string; provider?: string; seats?: number; costEstimate?: number; notes?: string } | null;
  transportConfirmed?: boolean;
}

export class EventPlanService {
  private static async loadPlan(planId: string): Promise<IEventPlan> {
    if (!HEX24.test(planId)) throw new HttpError(400, 'Invalid plan id');
    const plan = await EventPlan.findById(planId);
    if (!plan) throw new HttpError(404, 'Plan not found');
    return plan;
  }

  private static async memberRow(planId: string, buyerId: string): Promise<IEventPlanMember | null> {
    return EventPlanMember.findOne({ planId, buyerId });
  }

  /** Private-plan visibility: only the admin or an invited/accepted member may
   *  even know the plan exists (spec §3 — "only invited users can find, open"). */
  private static canView(plan: IEventPlan, viewerId: string | null, member: IEventPlanMember | null): boolean {
    if (plan.visibility === 'public') return true;
    if (!viewerId) return false;
    if (String(plan.adminId) === viewerId) return true;
    return Boolean(member && ['invited', 'accepted'].includes(member.status));
  }

  /** Full participation (member list, attendance, conversation, arrangements) —
   *  spec §3/§4: accepted members and the admin only, on EITHER visibility. */
  private static canParticipate(plan: IEventPlan, viewerId: string | null, member: IEventPlanMember | null): boolean {
    if (!viewerId) return false;
    if (String(plan.adminId) === viewerId) return true;
    return Boolean(member && member.status === 'accepted');
  }

  private static isAdmin(plan: IEventPlan, viewerId: string | null): boolean {
    return Boolean(viewerId && String(plan.adminId) === viewerId);
  }

  /** Batch viewer like/save lookup for a set of plans — one query regardless
   *  of list size, mirrors update.service#getViewerReactions so the same
   *  reaction row is the single source of truth everywhere a plan renders
   *  (Home feed, event detail, profile/My Plans all read through here or
   *  through getDetail, never a locally-cached flag). */
  private static async viewerReactionsByPlan(
    planIds: (string | Types.ObjectId)[],
    actor: SocialActor | null
  ): Promise<Map<string, PlanViewerReactions>> {
    const map = new Map<string, PlanViewerReactions>();
    if (!actor || planIds.length === 0) return map;
    const rows = await EventPlanReaction.find({ planId: { $in: planIds }, actorType: actor.type, buyerId: actor.id }).lean();
    for (const r of rows as any[]) {
      const key = String(r.planId);
      const entry = map.get(key) ?? { liked: false, saved: false };
      if (r.type === 'like') entry.liked = true;
      if (r.type === 'save') entry.saved = true;
      map.set(key, entry);
    }
    return map;
  }

  private static async assertAdmin(plan: IEventPlan, buyer: IBuyer): Promise<void> {
    if (String(plan.adminId) !== String(buyer._id)) throw new HttpError(403, 'Only the plan administrator can do this');
  }

  // ---------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------

  static async create(admin: IBuyer, input: CreatePlanInput): Promise<IEventPlan> {
    const name = (input.name || '').trim();
    if (!name) throw new HttpError(400, 'Plan name is required');
    if (name.length > 100) throw new HttpError(400, 'Plan name is too long');

    const hasEventId = Boolean(input.eventId);
    const hasManualEvent = Boolean(input.manualEvent?.name?.trim());
    if (hasEventId === hasManualEvent) {
      throw new HttpError(400, 'Provide either an existing Carrot event or a manually-entered event, not both or neither');
    }

    let eventId: string | undefined;
    let manualEvent: { name: string; date?: Date; location?: string } | undefined;
    if (hasEventId) {
      if (!HEX24.test(input.eventId!)) throw new HttpError(400, 'Invalid event id');
      const event = await Event.findById(input.eventId).select('_id');
      if (!event) throw new HttpError(404, 'Event not found');
      eventId = input.eventId;
    } else {
      const manualName = input.manualEvent!.name.trim();
      if (!manualName) throw new HttpError(400, 'Event or trip name is required');
      if (manualName.length > 150) throw new HttpError(400, 'Event or trip name is too long');
      manualEvent = {
        name: manualName,
        date: input.manualEvent!.date ? new Date(input.manualEvent!.date) : undefined,
        location: input.manualEvent!.location?.trim() || undefined,
      };
    }

    const visibility: PlanVisibility = input.visibility === 'private' ? 'private' : 'public';
    const joinPolicy: PlanJoinPolicy = input.joinPolicy === 'request' ? 'request' : 'open';

    const adminId = String(admin._id);
    const inviteeIds = [...new Set((input.inviteeIds || []).map(String))].filter(
      (id) => HEX24.test(id) && id !== adminId
    );

    const plan = await EventPlan.create({
      eventId,
      manualEvent,
      adminId: admin._id,
      name,
      description: input.description?.trim() || undefined,
      visibility,
      joinPolicy,
      meetingPoint: input.meetingPoint?.trim() || undefined,
      meetingTime: input.meetingTime ? new Date(input.meetingTime) : undefined,
      transport: EventPlanService.sanitizeTransport(input.transport),
    });

    await EventPlanMember.create({
      planId: plan._id,
      buyerId: admin._id,
      role: 'admin',
      status: 'accepted',
      joinedAt: new Date(),
    });

    if (inviteeIds.length > 0) {
      await EventPlanService.inviteMembers(admin, String(plan._id), inviteeIds, plan);
    }

    return plan;
  }

  private static sanitizeTransport(t?: CreatePlanInput['transport'] | null) {
    if (!t) return undefined;
    const out: Record<string, unknown> = {};
    if (t.method?.trim()) out.method = t.method.trim();
    if (t.provider?.trim()) out.provider = t.provider.trim();
    if (typeof t.seats === 'number' && t.seats >= 0) out.seats = t.seats;
    if (typeof t.costEstimate === 'number' && t.costEstimate >= 0) out.costEstimate = t.costEstimate;
    if (t.notes?.trim()) out.notes = t.notes.trim();
    return Object.keys(out).length > 0 ? out : undefined;
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  /** Public "Plans With Friends" section for an event: active public plans,
   *  plus any active private plan the viewer is invited to or a member of. */
  static async listForEvent(eventId: string, viewerId: string | null): Promise<any[]> {
    if (!HEX24.test(eventId)) throw new HttpError(400, 'Invalid event id');

    const visibleFilter: any[] = [{ visibility: 'public' }];
    let memberByPlan = new Map<string, IEventPlanMember>();
    if (viewerId) {
      const rows = await EventPlanMember.find({
        buyerId: viewerId,
        status: { $in: ['invited', 'accepted'] },
      });
      memberByPlan = new Map(rows.map((r) => [String(r.planId), r]));
      if (rows.length > 0) visibleFilter.push({ _id: { $in: rows.map((r) => r.planId) } });
    }

    const plans = await EventPlan.find({ eventId, status: 'active', $or: visibleFilter }).sort({ _id: -1 });
    return EventPlanService.toCards(plans, viewerId, memberByPlan);
  }

  private static async toCards(
    plans: IEventPlan[],
    viewerId: string | null,
    memberByPlan?: Map<string, IEventPlanMember>
  ): Promise<any[]> {
    if (plans.length === 0) return [];
    const adminIds = [...new Set(plans.map((p) => String(p.adminId)))];
    const admins = await Buyer.find({ _id: { $in: adminIds } }).select('name username avatarUrl');
    const adminById = new Map(admins.map((b: any) => [String(b._id), b]));

    const planIds = plans.map((p) => p._id);
    const counts = await EventPlanMember.aggregate([
      { $match: { planId: { $in: planIds }, status: 'accepted' } },
      { $group: { _id: '$planId', count: { $sum: 1 } } },
    ]);
    const countByPlan = new Map(counts.map((c: any) => [String(c._id), c.count]));

    let myMembers = memberByPlan;
    if (!myMembers) {
      myMembers = new Map();
      if (viewerId) {
        const rows = await EventPlanMember.find({ planId: { $in: planIds }, buyerId: viewerId });
        myMembers = new Map(rows.map((r) => [String(r.planId), r]));
      }
    }

    const reactionsByPlan = await EventPlanService.viewerReactionsByPlan(
      planIds,
      viewerId ? { type: 'buyer', id: viewerId } : null
    );

    return plans.map((p) => {
      const member = myMembers!.get(String(p._id)) || null;
      return {
        id: String(p._id),
        eventId: p.eventId ? String(p.eventId) : null,
        manualEvent: p.manualEvent
          ? { name: p.manualEvent.name, date: p.manualEvent.date ?? null, location: p.manualEvent.location ?? null }
          : null,
        name: p.name,
        description: p.description ?? null,
        visibility: p.visibility,
        joinPolicy: p.joinPolicy,
        status: p.status,
        coverImage: p.coverImage ?? null,
        admin: buyerSummary(adminById.get(String(p.adminId)) ?? { _id: p.adminId }),
        memberCount: countByPlan.get(String(p._id)) ?? (EventPlanService.isAdmin(p, viewerId) ? 1 : 0),
        meetingPoint: p.meetingPoint ?? null,
        meetingTime: p.meetingTime ?? null,
        transport: p.transport
          ? { seats: p.transport.seats ?? null, costEstimate: p.transport.costEstimate ?? null }
          : null,
        // Social engagement (public plans only — see EventPlanService.toggleReaction).
        likeCount: p.likeCount ?? 0,
        saveCount: p.saveCount ?? 0,
        shareCount: p.shareCount ?? 0,
        commentCount: p.commentCount ?? 0,
        viewerReactions: reactionsByPlan.get(String(p._id)) ?? { liked: false, saved: false },
        viewer: {
          isAdmin: EventPlanService.isAdmin(p, viewerId),
          memberStatus: member ? member.status : null,
        },
        createdAt: p.createdAt,
      };
    });
  }

  static async getDetail(planId: string, viewerId: string | null): Promise<any> {
    const plan = await EventPlanService.loadPlan(planId);
    const member = viewerId ? await EventPlanService.memberRow(planId, viewerId) : null;
    if (!EventPlanService.canView(plan, viewerId, member)) throw new HttpError(404, 'Plan not found');

    const canParticipate = EventPlanService.canParticipate(plan, viewerId, member);
    const isAdmin = EventPlanService.isAdmin(plan, viewerId);

    const [admin, event, memberCount, reactionsByPlan] = await Promise.all([
      Buyer.findById(plan.adminId).select('name username avatarUrl'),
      plan.eventId ? Event.findById(plan.eventId).select('name eventDate startTime venue status posterUrl') : Promise.resolve(null),
      EventPlanMember.countDocuments({ planId, status: 'accepted' }),
      EventPlanService.viewerReactionsByPlan([plan._id], viewerId ? { type: 'buyer', id: viewerId } : null),
    ]);

    let members: any[] = [];
    // Member list (with attendance) is visible to anyone who can view a PUBLIC
    // plan (spec §4), but only to accepted members/admin on a PRIVATE plan.
    const canSeeMembers = plan.visibility === 'public' ? true : canParticipate;
    if (canSeeMembers) {
      const rows = await EventPlanMember.find({ planId, status: 'accepted' }).sort({ joinedAt: 1 });
      const buyers = await Buyer.find({ _id: { $in: rows.map((r) => r.buyerId) } }).select('name username avatarUrl');
      const byId = new Map(buyers.map((b: any) => [String(b._id), b]));
      members = rows
        .map((r) => {
          const b = byId.get(String(r.buyerId));
          if (!b) return null;
          return { ...buyerSummary(b), role: r.role, attendance: r.attendance, memberId: String(r._id) };
        })
        .filter(Boolean);
    }

    // Unread Posts count (spec §5 — "Unread-content counts"): only meaningful
    // for a participant, since non-members never had a lastReadAt to begin
    // with and can't post anyway.
    let unreadCount = 0;
    if (canParticipate) {
      unreadCount = await EventPlanMessage.countDocuments({
        planId,
        deletedAt: { $exists: false },
        createdAt: { $gt: member?.lastReadAt ?? new Date(0) },
      });
    }

    return {
      id: String(plan._id),
      eventId: plan.eventId ? String(plan.eventId) : null,
      manualEvent: plan.manualEvent
        ? { name: plan.manualEvent.name, date: plan.manualEvent.date ?? null, location: plan.manualEvent.location ?? null }
        : null,
      name: plan.name,
      description: plan.description ?? null,
      visibility: plan.visibility,
      joinPolicy: plan.joinPolicy,
      status: plan.status,
      coverImage: plan.coverImage ?? null,
      admin: buyerSummary(admin ?? { _id: plan.adminId }),
      memberCount,
      meetingPoint: plan.meetingPoint ?? null,
      meetingTime: plan.meetingTime ?? null,
      meetingConfirmed: plan.meetingConfirmed,
      // Transport figures (seats/cost) are public-safe on a public plan
      // (spec §4); full arrangement detail requires participation.
      transport: plan.visibility === 'public' || canParticipate ? plan.transport ?? null : null,
      transportConfirmed: plan.transportConfirmed,
      event: event
        ? {
            id: String(event._id),
            name: event.name,
            eventDate: event.eventDate,
            startTime: event.startTime,
            venue: event.venue,
            posterUrl: event.posterUrl ?? null,
          }
        : null,
      // Social engagement (public plans only — see EventPlanService.toggleReaction).
      likeCount: plan.likeCount ?? 0,
      saveCount: plan.saveCount ?? 0,
      shareCount: plan.shareCount ?? 0,
      commentCount: plan.commentCount ?? 0,
      viewerReactions: reactionsByPlan.get(String(plan._id)) ?? { liked: false, saved: false },
      viewer: {
        isAdmin,
        memberStatus: member ? member.status : null,
        memberId: member ? String(member._id) : null,
        canParticipate,
        unreadCount,
      },
      members: canSeeMembers ? members : [],
    };
  }

  /** Admin-only: pending invitations and join requests, so the admin can
   *  cancel/approve/decline them (spec §4/§7). Never exposed to non-admins —
   *  a plan's pending invitee list is not public data. */
  static async getPending(admin: IBuyer, planId: string): Promise<{ invited: any[]; requested: any[] }> {
    const plan = await EventPlanService.loadPlan(planId);
    await EventPlanService.assertAdmin(plan, admin);

    const rows = await EventPlanMember.find({ planId, status: { $in: ['invited', 'requested'] } }).sort({ _id: -1 });
    const buyers = await Buyer.find({ _id: { $in: rows.map((r) => r.buyerId) } }).select('name username avatarUrl');
    const byId = new Map(buyers.map((b: any) => [String(b._id), b]));

    const toRow = (r: IEventPlanMember) => ({ memberId: String(r._id), ...buyerSummary(byId.get(String(r.buyerId)) ?? { _id: r.buyerId }) });
    return {
      invited: rows.filter((r) => r.status === 'invited').map(toRow),
      requested: rows.filter((r) => r.status === 'requested').map(toRow),
    };
  }

  static async getMine(buyer: IBuyer, section: 'upcoming' | 'invitations' | 'past'): Promise<any[]> {
    const buyerId = String(buyer._id);
    if (section === 'invitations') {
      const rows = await EventPlanMember.find({ buyerId, status: { $in: ['invited', 'requested'] } }).sort({ _id: -1 });
      const plans = await EventPlan.find({ _id: { $in: rows.map((r) => r.planId) }, status: 'active' });
      const memberByPlan = new Map(rows.map((r) => [String(r.planId), r]));
      return EventPlanService.toCards(plans, buyerId, memberByPlan);
    }

    const rows = await EventPlanMember.find({ buyerId, status: 'accepted' });
    if (rows.length === 0) return [];
    const planIds = rows.map((r) => r.planId);
    const plans = await EventPlan.find({ _id: { $in: planIds } });
    const events = await Event.find({ _id: { $in: plans.filter((p) => p.eventId).map((p) => p.eventId) } }).select('eventDate');
    const eventDateById = new Map(events.map((e) => [String(e._id), e.eventDate]));
    const now = new Date();

    const filtered = plans.filter((p) => {
      // A manually-entered trip with no date given is treated as always
      // upcoming (there's nothing to compare against) unless cancelled.
      const eventDate = p.eventId ? eventDateById.get(String(p.eventId)) : p.manualEvent?.date;
      const isPast = p.status === 'cancelled' || (eventDate ? eventDate < now : false);
      return section === 'past' ? isPast : !isPast;
    });
    filtered.sort((a, b) => String(b._id).localeCompare(String(a._id)));
    const memberByPlan = new Map(rows.map((r) => [String(r.planId), r]));
    return EventPlanService.toCards(filtered, buyerId, memberByPlan);
  }

  /**
   * Home feed "Event Plan" cards (ticket: Public Plans must be discoverable
   * through the Home feed). A live query over visibility/status — never a
   * stored "published to feed" flag — so a plan that flips to private or
   * gets cancelled disappears from the very next feed fetch with no extra
   * bookkeeping ("remove it immediately"), and a plan flipped from private
   * to public becomes eligible the same way. `excludeIds` is the feed's
   * per-session "don't repeat" cursor (mirrors Vote's `v`, feed.service.ts).
   */
  static async getFeedCards(limit: number, excludeIds: string[], viewerBuyerId: string | null): Promise<any[]> {
    if (limit <= 0) return [];
    const query: any = { visibility: 'public', status: 'active' };
    if (excludeIds.length) query._id = { $nin: excludeIds.filter((id) => HEX24.test(id)).map((id) => new Types.ObjectId(id)) };
    const plans = await EventPlan.find(query).sort({ _id: -1 }).limit(limit);
    if (plans.length === 0) return [];

    const planIds = plans.map((p) => p._id);
    const eventIds = [...new Set(plans.filter((p) => p.eventId).map((p) => String(p.eventId)))];
    const adminIds = [...new Set(plans.map((p) => String(p.adminId)))];

    const [events, admins, counts, memberRows, viewerRows, reactionsByPlan] = await Promise.all([
      Event.find({ _id: { $in: eventIds } }).select('name eventDate venue posterUrl'),
      Buyer.find({ _id: { $in: adminIds } }).select('name username avatarUrl'),
      EventPlanMember.aggregate([
        { $match: { planId: { $in: planIds }, status: 'accepted' } },
        { $group: { _id: '$planId', count: { $sum: 1 } } },
      ]),
      // Small "overlapping avatars" sample (spec: home feed card) — earliest
      // joiners first, capped per-plan below to avoid over-fetching.
      EventPlanMember.find({ planId: { $in: planIds }, status: 'accepted' }).sort({ joinedAt: 1 }).select('planId buyerId'),
      viewerBuyerId
        ? EventPlanMember.find({ planId: { $in: planIds }, buyerId: viewerBuyerId }).select('planId status')
        : Promise.resolve([] as IEventPlanMember[]),
      EventPlanService.viewerReactionsByPlan(planIds, viewerBuyerId ? { type: 'buyer', id: viewerBuyerId } : null),
    ]);

    const eventById = new Map(events.map((e: any) => [String(e._id), e]));
    const adminById = new Map(admins.map((b: any) => [String(b._id), b]));
    const countByPlan = new Map(counts.map((c: any) => [String(c._id), c.count]));
    const viewerStatusByPlan = new Map(viewerRows.map((r: any) => [String(r.planId), r.status]));

    const sampleBuyerIdsByPlan = new Map<string, string[]>();
    for (const row of memberRows as any[]) {
      const key = String(row.planId);
      const arr = sampleBuyerIdsByPlan.get(key) ?? [];
      if (arr.length < 5) arr.push(String(row.buyerId));
      sampleBuyerIdsByPlan.set(key, arr);
    }
    const sampleBuyers = await Buyer.find({ _id: { $in: [...new Set([...sampleBuyerIdsByPlan.values()].flat())] } }).select('avatarUrl');
    const avatarByBuyer = new Map(sampleBuyers.map((b: any) => [String(b._id), b.avatarUrl ?? null]));

    return plans
      .map((p) => {
        // An event-linked plan whose event was deleted has nothing to attach
        // to — drop it rather than surface a broken card. A manually-entered
        // trip has no such dependency and always renders.
        const event = p.eventId ? eventById.get(String(p.eventId)) : null;
        if (p.eventId && !event) return null;
        return {
          type: 'plan' as const,
          id: String(p._id),
          sortAt: p.createdAt.toISOString(),
          visibility: 'public' as const,
          name: p.name,
          description: p.description ?? null,
          coverImage: p.coverImage ?? null,
          admin: buyerSummary(adminById.get(String(p.adminId)) ?? { _id: p.adminId }),
          memberCount: countByPlan.get(String(p._id)) ?? 0,
          memberAvatars: (sampleBuyerIdsByPlan.get(String(p._id)) ?? []).map((id) => avatarByBuyer.get(id) ?? null),
          meetingPoint: p.meetingPoint ?? null,
          meetingTime: p.meetingTime ?? null,
          transport: p.transport
            ? { method: p.transport.method ?? null, seats: p.transport.seats ?? null, costEstimate: p.transport.costEstimate ?? null }
            : null,
          joinPolicy: p.joinPolicy,
          event: event
            ? {
                id: String(event._id),
                name: event.name,
                eventDate: event.eventDate,
                venue: event.venue,
                posterUrl: event.posterUrl ?? null,
              }
            : null,
          manualEvent: p.manualEvent
            ? { name: p.manualEvent.name, date: p.manualEvent.date ?? null, location: p.manualEvent.location ?? null }
            : null,
          // Social engagement (public plans only — see EventPlanService.toggleReaction).
          likeCount: p.likeCount ?? 0,
          saveCount: p.saveCount ?? 0,
          shareCount: p.shareCount ?? 0,
          commentCount: p.commentCount ?? 0,
          viewerReactions: reactionsByPlan.get(String(p._id)) ?? { liked: false, saved: false },
          viewer: {
            isAdmin: viewerBuyerId ? String(p.adminId) === viewerBuyerId : false,
            memberStatus: viewerBuyerId ? viewerStatusByPlan.get(String(p._id)) ?? null : null,
          },
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }

  // ---------------------------------------------------------------------
  // Social engagement — Public plans only (like a normal post). Distinct
  // from the plan's members-only conversation (EventPlanMessage): any
  // signed-in user may like/save/share/comment on a Public plan without
  // joining it, matching Update's post-engagement model. A Private plan
  // never exposes these, regardless of the viewer's membership.
  // ---------------------------------------------------------------------

  private static assertPublicActive(plan: IEventPlan): void {
    if (plan.visibility !== 'public' || plan.status !== 'active') {
      throw new HttpError(403, 'Only public plans support this');
    }
  }

  static async toggleReaction(
    planId: string,
    actor: SocialActor,
    type: 'like' | 'save'
  ): Promise<{ active: boolean; likeCount: number; saveCount: number }> {
    const plan = await EventPlanService.loadPlan(planId);
    EventPlanService.assertPublicActive(plan);
    const { active } = await toggleReactionGeneric({
      reactionModel: EventPlanReaction,
      targetModel: EventPlan,
      targetField: 'planId',
      targetId: planId,
      actor,
      type,
      counterField: type === 'like' ? 'likeCount' : 'saveCount',
    });
    const p = await EventPlan.findById(planId).select('likeCount saveCount').lean();
    return { active, likeCount: (p as any)?.likeCount ?? 0, saveCount: (p as any)?.saveCount ?? 0 };
  }

  static async recordShare(planId: string): Promise<{ shareCount: number }> {
    const plan = await EventPlanService.loadPlan(planId);
    EventPlanService.assertPublicActive(plan);
    const p = await EventPlan.findByIdAndUpdate(planId, { $inc: { shareCount: 1 } }, { new: true }).select('shareCount').lean();
    return { shareCount: (p as any)?.shareCount ?? 0 };
  }

  // ---------------------------------------------------------------------
  // Admin actions
  // ---------------------------------------------------------------------

  static async update(admin: IBuyer, planId: string, patch: UpdatePlanInput): Promise<IEventPlan> {
    const plan = await EventPlanService.loadPlan(planId);
    await EventPlanService.assertAdmin(plan, admin);

    let arrangementsChanged = false;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new HttpError(400, 'Plan name is required');
      plan.name = name;
    }
    if (patch.description !== undefined) plan.description = patch.description.trim() || undefined;
    if (patch.joinPolicy !== undefined) plan.joinPolicy = patch.joinPolicy;
    if (patch.meetingPoint !== undefined) {
      plan.meetingPoint = patch.meetingPoint?.trim() || undefined;
      arrangementsChanged = true;
    }
    if (patch.meetingTime !== undefined) {
      plan.meetingTime = patch.meetingTime ? new Date(patch.meetingTime) : undefined;
      arrangementsChanged = true;
    }
    if (patch.meetingConfirmed !== undefined) {
      plan.meetingConfirmed = patch.meetingConfirmed;
      arrangementsChanged = true;
    }
    if (patch.transport !== undefined) {
      plan.transport = patch.transport ? (EventPlanService.sanitizeTransport(patch.transport) as any) : undefined;
      arrangementsChanged = true;
    }
    if (patch.transportConfirmed !== undefined) {
      plan.transportConfirmed = patch.transportConfirmed;
      arrangementsChanged = true;
    }

    await plan.save();

    if (arrangementsChanged) {
      const memberIds = await EventPlanService.acceptedMemberIds(planId, String(admin._id));
      if (memberIds.length > 0) {
        NotificationDispatcher.dispatchAsync(
          memberIds,
          'plan_arrangement_updated',
          plan.name,
          'Meeting or transport arrangements were updated',
          { planId: String(plan._id), eventId: plan.eventId ? String(plan.eventId) : undefined },
          String(admin._id)
        );
      }
    }
    return plan;
  }

  /** Step 1 of the cover-photo upload (mirrors Posts' presign/finalize —
   *  updatesR2 is already wired for Trip Plan media). Admin-only: the cover
   *  is part of the plan's own presentation, not member-contributed content. */
  static async presignCoverUpload(
    admin: IBuyer,
    planId: string,
    ext: string,
    contentType: string
  ): Promise<{ rawKey: string; uploadUrl: string }> {
    const plan = await EventPlanService.loadPlan(planId);
    await EventPlanService.assertAdmin(plan, admin);
    const cleanExt = ext.replace(/^\./, '').toLowerCase();
    if (!COVER_EXTS.has(cleanExt) || !COVER_CONTENT_TYPES.has(contentType)) {
      throw new HttpError(400, 'Cover photo must be a JPEG, PNG or WEBP image');
    }
    const rawKey = updatesR2.rawKey(cleanExt);
    const uploadUrl = await updatesR2.presignPut(rawKey, contentType);
    return { rawKey, uploadUrl };
  }

  /** Step 2 — client has PUT the file to `uploadUrl`; persist the resulting
   *  public URL as the plan's cover. */
  static async finalizeCoverUpload(admin: IBuyer, planId: string, rawKey: string): Promise<IEventPlan> {
    const plan = await EventPlanService.loadPlan(planId);
    await EventPlanService.assertAdmin(plan, admin);
    if (!/^updates\/raw\/[a-z0-9._-]+$/i.test(rawKey)) throw new HttpError(400, 'Invalid upload reference');
    plan.coverImage = updatesR2.publicUrl(rawKey);
    await plan.save();
    return plan;
  }

  static async removeCover(admin: IBuyer, planId: string): Promise<IEventPlan> {
    const plan = await EventPlanService.loadPlan(planId);
    await EventPlanService.assertAdmin(plan, admin);
    plan.coverImage = undefined;
    await plan.save();
    return plan;
  }

  private static async acceptedMemberIds(planId: string, excludeId?: string): Promise<string[]> {
    const rows = await EventPlanMember.find({ planId, status: 'accepted' }).select('buyerId');
    return rows.map((r) => String(r.buyerId)).filter((id) => id !== excludeId);
  }

  static async changeVisibility(
    admin: IBuyer,
    planId: string,
    visibility: PlanVisibility,
    confirmed: boolean
  ): Promise<IEventPlan> {
    const plan = await EventPlanService.loadPlan(planId);
    await EventPlanService.assertAdmin(plan, admin);
    if (visibility !== 'public' && visibility !== 'private') throw new HttpError(400, 'Invalid visibility');
    if (plan.visibility === visibility) return plan;
    if (!confirmed) throw new HttpError(400, 'Confirmation is required to change plan visibility');

    plan.visibility = visibility;
    if (visibility === 'public' && !plan.joinPolicy) plan.joinPolicy = 'open';
    await plan.save();

    const memberIds = await EventPlanService.acceptedMemberIds(planId, String(admin._id));
    if (memberIds.length > 0) {
      NotificationDispatcher.dispatchAsync(
        memberIds,
        'plan_visibility_changed',
        plan.name,
        visibility === 'private' ? 'This plan is now private' : 'This plan is now public',
        { planId: String(plan._id), eventId: plan.eventId ? String(plan.eventId) : undefined, visibility },
        String(admin._id)
      );
    }
    return plan;
  }

  static async cancel(admin: IBuyer, planId: string): Promise<void> {
    const plan = await EventPlanService.loadPlan(planId);
    await EventPlanService.assertAdmin(plan, admin);
    if (plan.status === 'cancelled') return;
    plan.status = 'cancelled';
    plan.cancelledAt = new Date();
    await plan.save();

    const memberIds = await EventPlanService.acceptedMemberIds(planId, String(admin._id));
    if (memberIds.length > 0) {
      NotificationDispatcher.dispatchAsync(
        memberIds,
        'plan_cancelled',
        plan.name,
        'This plan was cancelled by its administrator',
        { planId: String(plan._id), eventId: plan.eventId ? String(plan.eventId) : undefined },
        String(admin._id)
      );
    }
  }

  // ---------------------------------------------------------------------
  // Membership
  // ---------------------------------------------------------------------

  static async inviteMembers(
    admin: IBuyer,
    planId: string,
    buyerIds: string[],
    preloadedPlan?: IEventPlan
  ): Promise<{ invited: string[]; skipped: string[] }> {
    const plan = preloadedPlan ?? (await EventPlanService.loadPlan(planId));
    if (!preloadedPlan) await EventPlanService.assertAdmin(plan, admin);

    const adminId = String(admin._id);
    const targets = [...new Set(buyerIds.map(String))].filter((id) => HEX24.test(id) && id !== adminId);
    if (targets.length === 0) return { invited: [], skipped: [] };

    const buyers = await Buyer.find({ _id: { $in: targets } }).select('_id');
    const validTargets = new Set(buyers.map((b) => String(b._id)));

    const invited: string[] = [];
    const skipped: string[] = [];

    for (const targetId of targets) {
      if (!validTargets.has(targetId)) {
        skipped.push(targetId);
        continue;
      }
      if (await BlockService.isBlockedEitherWay(adminId, targetId)) {
        skipped.push(targetId);
        continue;
      }
      const existing = await EventPlanMember.findOne({ planId: plan._id, buyerId: targetId });
      if (existing && ['invited', 'requested', 'accepted'].includes(existing.status)) {
        skipped.push(targetId); // duplicate invite/membership — spec §7
        continue;
      }
      if (existing) {
        existing.status = 'invited';
        existing.invitedBy = admin._id as any;
        existing.respondedAt = undefined;
        existing.joinedAt = undefined;
        existing.removedAt = undefined;
        existing.leftAt = undefined;
        await existing.save();
      } else {
        await EventPlanMember.create({
          planId: plan._id,
          buyerId: targetId,
          role: 'member',
          status: 'invited',
          invitedBy: admin._id,
        });
      }
      invited.push(targetId);
    }

    if (invited.length > 0) {
      NotificationDispatcher.dispatchAsync(
        invited,
        'plan_invite',
        displayName(admin),
        `invited you to "${plan.name}"`,
        { planId: String(plan._id), eventId: plan.eventId ? String(plan.eventId) : undefined },
        adminId
      );
    }
    return { invited, skipped };
  }

  static async cancelInvite(admin: IBuyer, planId: string, memberId: string): Promise<void> {
    const plan = await EventPlanService.loadPlan(planId);
    await EventPlanService.assertAdmin(plan, admin);
    if (!HEX24.test(memberId)) throw new HttpError(400, 'Invalid member id');
    const row = await EventPlanMember.findOne({ _id: memberId, planId: plan._id });
    if (!row || row.status !== 'invited') throw new HttpError(404, 'Pending invitation not found');
    await EventPlanMember.deleteOne({ _id: row._id });
  }

  static async removeMember(admin: IBuyer, planId: string, memberId: string): Promise<void> {
    const plan = await EventPlanService.loadPlan(planId);
    await EventPlanService.assertAdmin(plan, admin);
    if (!HEX24.test(memberId)) throw new HttpError(400, 'Invalid member id');
    const row = await EventPlanMember.findOne({ _id: memberId, planId: plan._id });
    if (!row || row.status !== 'accepted') throw new HttpError(404, 'Member not found');
    if (String(row.buyerId) === String(admin._id)) throw new HttpError(400, 'The administrator cannot remove themselves — cancel the plan instead');
    row.status = 'removed';
    row.removedAt = new Date();
    await row.save();

    NotificationDispatcher.dispatchAsync(
      [String(row.buyerId)],
      'plan_member_removed',
      plan.name,
      'You were removed from this plan',
      { planId: String(plan._id), eventId: plan.eventId ? String(plan.eventId) : undefined },
      String(admin._id)
    );
  }

  static async respondToInvite(buyer: IBuyer, memberId: string, accept: boolean): Promise<void> {
    if (!HEX24.test(memberId)) throw new HttpError(400, 'Invalid invitation id');
    const row = await EventPlanMember.findById(memberId);
    if (!row || String(row.buyerId) !== String(buyer._id)) throw new HttpError(404, 'Invitation not found');
    if (row.status !== 'invited') throw new HttpError(409, 'This invitation is no longer pending');

    const plan = await EventPlan.findById(row.planId);
    if (!plan) throw new HttpError(404, 'Plan not found');

    row.status = accept ? 'accepted' : 'declined';
    row.respondedAt = new Date();
    if (accept) row.joinedAt = new Date();
    await row.save();

    NotificationDispatcher.dispatchAsync(
      [String(plan.adminId)],
      accept ? 'plan_invite_accepted' : 'plan_invite_declined',
      displayName(buyer),
      accept ? `accepted your invitation to "${plan.name}"` : `declined your invitation to "${plan.name}"`,
      { planId: String(plan._id), eventId: plan.eventId ? String(plan.eventId) : undefined },
      String(buyer._id)
    );
  }

  static async requestToJoin(buyer: IBuyer, planId: string): Promise<PlanAttendanceStatus | void> {
    const plan = await EventPlanService.loadPlan(planId);
    if (plan.status !== 'active') throw new HttpError(409, 'This plan is no longer active');
    if (plan.visibility !== 'public') throw new HttpError(403, 'This plan is invitation-only');
    const buyerId = String(buyer._id);
    if (buyerId === String(plan.adminId)) return;
    if (await BlockService.isBlockedEitherWay(buyerId, String(plan.adminId))) {
      throw new HttpError(403, 'You cannot join this plan');
    }

    const existing = await EventPlanMember.findOne({ planId: plan._id, buyerId });
    if (existing?.status === 'accepted') return;
    if (existing?.status === 'requested' && plan.joinPolicy === 'request') return;
    if (existing?.status === 'invited') {
      // Already invited — joining is equivalent to accepting (spec §7: prevent duplicates).
      return EventPlanService.respondToInvite(buyer, String(existing._id), true);
    }

    if (plan.joinPolicy === 'open') {
      if (existing) {
        existing.status = 'accepted';
        existing.joinedAt = new Date();
        existing.respondedAt = new Date();
        await existing.save();
      } else {
        await EventPlanMember.create({ planId: plan._id, buyerId, role: 'member', status: 'accepted', joinedAt: new Date() });
      }
      return;
    }

    // request policy
    if (existing) {
      existing.status = 'requested';
      existing.respondedAt = undefined;
      await existing.save();
    } else {
      await EventPlanMember.create({ planId: plan._id, buyerId, role: 'member', status: 'requested' });
    }
    NotificationDispatcher.dispatchAsync(
      [String(plan.adminId)],
      'plan_join_request',
      displayName(buyer),
      `wants to join "${plan.name}"`,
      { planId: String(plan._id), eventId: plan.eventId ? String(plan.eventId) : undefined },
      buyerId
    );
  }

  static async respondToRequest(admin: IBuyer, memberId: string, approve: boolean): Promise<void> {
    if (!HEX24.test(memberId)) throw new HttpError(400, 'Invalid request id');
    const row = await EventPlanMember.findById(memberId);
    if (!row || row.status !== 'requested') throw new HttpError(404, 'Join request not found');
    const plan = await EventPlan.findById(row.planId);
    if (!plan) throw new HttpError(404, 'Plan not found');
    await EventPlanService.assertAdmin(plan, admin);

    row.status = approve ? 'accepted' : 'declined';
    row.respondedAt = new Date();
    if (approve) row.joinedAt = new Date();
    await row.save();

    NotificationDispatcher.dispatchAsync(
      [String(row.buyerId)],
      approve ? 'plan_join_approved' : 'plan_join_declined',
      plan.name,
      approve ? 'Your request to join was approved' : 'Your request to join was declined',
      { planId: String(plan._id), eventId: plan.eventId ? String(plan.eventId) : undefined },
      String(admin._id)
    );
  }

  static async leave(buyer: IBuyer, planId: string): Promise<void> {
    const plan = await EventPlanService.loadPlan(planId);
    const buyerId = String(buyer._id);
    if (buyerId === String(plan.adminId)) throw new HttpError(400, 'The administrator cannot leave — cancel the plan instead');
    const row = await EventPlanMember.findOne({ planId: plan._id, buyerId });
    if (!row || row.status !== 'accepted') throw new HttpError(404, 'You are not a member of this plan');
    row.status = 'left';
    row.leftAt = new Date();
    await row.save();
  }

  // ---------------------------------------------------------------------
  // Attendance
  // ---------------------------------------------------------------------

  static async vote(buyer: IBuyer, planId: string, attendance: PlanAttendanceStatus): Promise<void> {
    if (!['going', 'maybe', 'cant_go'].includes(attendance)) throw new HttpError(400, 'Invalid attendance value');
    const plan = await EventPlanService.loadPlan(planId);
    if (plan.status !== 'active') throw new HttpError(409, 'This plan is closed');
    const event = await Event.findById(plan.eventId).select('eventDate');
    if (event && event.eventDate < new Date()) throw new HttpError(409, 'This event has already happened');

    const buyerId = String(buyer._id);
    const row = await EventPlanMember.findOne({ planId: plan._id, buyerId });
    if (!row || row.status !== 'accepted') throw new HttpError(403, 'Only plan members can vote');
    row.attendance = attendance;
    row.attendanceUpdatedAt = new Date();
    await row.save();
  }

  // ---------------------------------------------------------------------
  // Shared access helpers reused by EventPlanMessageService
  // ---------------------------------------------------------------------

  static async loadForAccess(planId: string): Promise<IEventPlan> {
    return EventPlanService.loadPlan(planId);
  }

  static async accessFor(plan: IEventPlan, viewerId: string | null): Promise<{ canView: boolean; canParticipate: boolean }> {
    const member = viewerId ? await EventPlanService.memberRow(String(plan._id), viewerId) : null;
    return {
      canView: EventPlanService.canView(plan, viewerId, member),
      canParticipate: EventPlanService.canParticipate(plan, viewerId, member),
    };
  }
}

export type { PlanAttendanceStatus, PlanVisibility, PlanJoinPolicy };
