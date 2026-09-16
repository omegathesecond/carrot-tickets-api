import { Schema, model, Document, Types } from 'mongoose';

export type PlanVisibility = 'public' | 'private';
/** Only meaningful when visibility='public' — a private plan is always invite-only. */
export type PlanJoinPolicy = 'open' | 'request';
export type PlanStatus = 'active' | 'cancelled';

export interface IPlanTransportInfo {
  method?: string;
  provider?: string;
  seats?: number;
  costEstimate?: number;
  notes?: string;
}

/**
 * A trip/event that isn't a real Carrot listing (Trip Plan spec §2 — "Enter
 * an event or trip that is not listed on Carrot"). Only ever set when
 * `eventId` is absent; never creates a real Event/ticket product. A manual
 * plan is otherwise identical to an event-linked one (members, arrangements,
 * posts, etc. all work the same way against `EventPlan._id`).
 */
export interface IManualEventInfo {
  name: string;
  date?: Date;
  location?: string;
}

/**
 * "Trip Plan" (formerly "Event Plan") — a group plan a buyer creates around
 * a Carrot event OR a manually-entered trip/event to coordinate meeting up,
 * voting attendance, chatting and arranging transport with invited (or, if
 * public, self-joined) friends.
 *
 * Exactly one of `eventId` / `manualEvent` is ever set — see
 * EventPlanService.create. This is a rename + feature extension of the
 * original Event Plan model, not a new plan type: every existing plan keeps
 * its `eventId`, members, messages, reactions and arrangements untouched.
 *
 * Visibility is the single access-control switch (spec §3/§4): 'private'
 * plans are invitation-only everywhere (event page, search, profiles); a
 * 'public' plan is readable by anyone viewing the event, but only accepted
 * members (EventPlanMember status='accepted') may write to it. See
 * EventPlanService.assertViewAccess / assertMemberAccess for the enforcement.
 */
export interface IEventPlan extends Document {
  eventId?: Types.ObjectId;
  manualEvent?: IManualEventInfo;
  adminId: Types.ObjectId; // creator, always also an EventPlanMember with role='admin'
  name: string;
  description?: string;
  visibility: PlanVisibility;
  joinPolicy: PlanJoinPolicy;
  status: PlanStatus;
  meetingPoint?: string;
  meetingTime?: Date;
  /** Distinguishes an admin-confirmed arrangement from a member's suggestion (spec §10). */
  meetingConfirmed: boolean;
  transport?: IPlanTransportInfo;
  transportConfirmed: boolean;
  cancelledAt?: Date;
  /** Social engagement (public plans only — see EventPlanService.toggleReaction/
   *  recordShare) — kept in sync the same way Update's counters are: an
   *  atomic $inc alongside the reaction row, never recomputed from a count()
   *  on read. */
  likeCount: number;
  saveCount: number;
  shareCount: number;
  commentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const transportSchema = new Schema<IPlanTransportInfo>(
  {
    method: { type: String, trim: true, maxlength: 60 },
    provider: { type: String, trim: true, maxlength: 100 },
    seats: { type: Number, min: 0 },
    costEstimate: { type: Number, min: 0 },
    notes: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const manualEventSchema = new Schema<IManualEventInfo>(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 150 },
    date: { type: Date },
    location: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false }
);

const eventPlanSchema = new Schema<IEventPlan>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', index: true },
    manualEvent: { type: manualEventSchema },
    adminId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 1000 },
    visibility: { type: String, enum: ['public', 'private'], required: true, default: 'public' },
    joinPolicy: { type: String, enum: ['open', 'request'], required: true, default: 'open' },
    status: { type: String, enum: ['active', 'cancelled'], required: true, default: 'active' },
    meetingPoint: { type: String, trim: true, maxlength: 200 },
    meetingTime: { type: Date },
    meetingConfirmed: { type: Boolean, default: false },
    transport: { type: transportSchema },
    transportConfirmed: { type: Boolean, default: false },
    cancelledAt: { type: Date },
    likeCount: { type: Number, default: 0 },
    saveCount: { type: Number, default: 0 },
    shareCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Belt-and-suspenders alongside EventPlanService.create's own check: a plan
// is either linked to a real Carrot event or carries a manually-entered one,
// never both and never neither (spec §2 — a manual entry "must not create a
// fake Carrot event listing").
eventPlanSchema.pre('validate', function (next) {
  const hasEvent = Boolean(this.eventId);
  const hasManual = Boolean(this.manualEvent);
  if (hasEvent === hasManual) {
    next(new Error('A plan must have either eventId or manualEvent, not both or neither'));
    return;
  }
  next();
});

// Public "Plans With Friends" section on the event page: active, public plans
// for an event, newest first.
eventPlanSchema.index({ eventId: 1, visibility: 1, status: 1, _id: -1 });
// Admin's own plans (My Plans → manage).
eventPlanSchema.index({ adminId: 1, status: 1, _id: -1 });

export const EventPlan = model<IEventPlan>('EventPlan', eventPlanSchema);
