import { Schema, model, Document, Types } from 'mongoose';

export type ReportTargetType = 'message' | 'buyer';
export type ReportStatus = 'open' | 'resolved' | 'dismissed';

/**
 * A buyer-filed report against a channel message or another buyer (Plan 7
 * Task 3 — platform-wide social moderation queue, tickets:moderate_social
 * admin-only). Exactly one of messageId/targetBuyerId is set, matching
 * targetType — same exactly-one-container shape as Message's
 * channelId/dmThreadId invariant (see message.model.ts).
 *
 * Dedupe: a reporter can only have ONE OPEN report against the same
 * message/buyer at a time. Enforced by the two partial unique indexes below
 * (mirrors notification.model.ts's event-reminder dedupe pattern) — once a
 * report is resolved/dismissed (status leaves 'open'), the reporter is free
 * to file again. The `$exists` guard on each partial filter keeps the two
 * target shapes from colliding with each other's absent field (an open
 * buyer-target report has no messageId, and vice versa).
 */
export interface IReport extends Document {
  reporterId: Types.ObjectId;
  targetType: ReportTargetType;
  messageId?: Types.ObjectId;
  targetBuyerId?: Types.ObjectId;
  reason: string;
  status: ReportStatus;
  resolvedBy?: string; // ticketsUser id (vendorId or sub-user userId) — plain string, mirrors approvedBy on resellerCommissionWithdrawal.model.ts (not a single Mongoose ref: super-admin tokens carry no real vendor row)
  resolvedAt?: Date;
  resolutionNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

const reportSchema = new Schema<IReport>(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
    targetType: { type: String, enum: ['message', 'buyer'], required: true },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message' },
    targetBuyerId: { type: Schema.Types.ObjectId, ref: 'Buyer' },
    reason: { type: String, required: true, trim: true, minlength: 1, maxlength: 500 },
    status: { type: String, enum: ['open', 'resolved', 'dismissed'], required: true, default: 'open' },
    resolvedBy: { type: String },
    resolvedAt: { type: Date },
    resolutionNote: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

// Exactly one target per report, matching its targetType.
reportSchema.pre('validate', function (next) {
  const hasMessage = Boolean(this.messageId);
  const hasBuyer = Boolean(this.targetBuyerId);
  if (hasMessage === hasBuyer) {
    return next(new Error('Report must have exactly one of messageId or targetBuyerId'));
  }
  if (this.targetType === 'message' && !hasMessage) {
    return next(new Error("targetType 'message' requires messageId"));
  }
  if (this.targetType === 'buyer' && !hasBuyer) {
    return next(new Error("targetType 'buyer' requires targetBuyerId"));
  }
  next();
});

// Admin queue: GET /api/tickets/reports?status=open&before&limit.
reportSchema.index({ status: 1, createdAt: -1 });

reportSchema.index(
  { reporterId: 1, messageId: 1 },
  { unique: true, partialFilterExpression: { status: 'open', messageId: { $exists: true } } }
);
reportSchema.index(
  { reporterId: 1, targetBuyerId: 1 },
  { unique: true, partialFilterExpression: { status: 'open', targetBuyerId: { $exists: true } } }
);

export const Report = model<IReport>('Report', reportSchema);
