// api/src/services/eventTag.service.ts
import mongoose, { Types } from 'mongoose';
import { EventTag } from '@models/eventTag.model';
import { GateOperator } from '@models/gateOperator.model';
import { Cashier } from '@models/cashier.model';
import { Vendor } from '@models/vendor.model';
import { Wallet } from '@models/wallet.model';
import { WalletService } from '@services/wallet.service';
import { IEventTag, EventTagStatus } from '@interfaces/eventTag.interface';
import { assertValidBandUid, normalizeBandUid } from '@utils/bandUid.util';

/** What happened to ONE tag in a register call — the desk shows this per tap. */
export type RegisterOutcome = 'registered' | 'already_registered' | 'reactivated';

export interface RegisterResult {
  bandUid: string;
  outcome: RegisterOutcome;
  tag: IEventTag;
}

export interface BulkRegisterResult {
  registered: string[];
  alreadyRegistered: string[];
  reactivated: string[];
  /** Rejected inputs, each with the reason — never silently dropped. */
  rejected: Array<{ bandUid: string; reason: string }>;
}

export interface RetireResult {
  tag: IEventTag;
  /** The wallet that was wearing the tag and had its binding released, if any. */
  releasedWalletId: string | null;
}

/** Thrown by assertTagRegistered — the message the operator sees at the desk. */
export const UNREGISTERED_TAG_MESSAGE =
  'This tag is not registered for this event. Register it first at the Register desk.';

export class EventTagService {
  /**
   * Enrol one physical tag into an event's pool.
   *
   * Idempotent by design: a desk operator tapping the same tag twice (a double
   * read, a re-check of a tag they already did) must be told "already done",
   * not handed an error — the outcome discriminates the two so the UI can say
   * which happened. Re-registering a RETIRED tag brings it back rather than
   * leaving the desk unable to explain why a tag in their hand won't enrol.
   */
  static async registerTag(params: {
    eventId: string;
    bandUid: string;
    registeredBy?: string;
  }): Promise<RegisterResult> {
    const bandUid = assertValidBandUid(params.bandUid);
    const eventId = new Types.ObjectId(params.eventId);

    const existing = await EventTag.findOne({ eventId, bandUid });
    if (existing) {
      if (existing.status === 'active') {
        return { bandUid, outcome: 'already_registered', tag: existing };
      }
      existing.status = 'active';
      existing.registeredAt = new Date();
      if (params.registeredBy) existing.registeredBy = params.registeredBy;
      existing.set('retiredAt', undefined);
      existing.set('retiredReason', undefined);
      await existing.save();
      return { bandUid, outcome: 'reactivated', tag: existing };
    }

    try {
      const tag = await EventTag.create({
        eventId,
        bandUid,
        status: 'active',
        registeredAt: new Date(),
        ...(params.registeredBy ? { registeredBy: params.registeredBy } : {}),
      });
      return { bandUid, outcome: 'registered', tag };
    } catch (err: any) {
      // Two desks enrolled the same tag at the same instant. The unique index is
      // what makes exactly one of them the creator; the loser re-reads and
      // reports the same "already registered" a sequential second tap would get.
      if (err?.code !== 11000) throw err;
      const raced = await EventTag.findOne({ eventId, bandUid });
      if (!raced) throw err; // duplicate on some OTHER index — surface it
      return { bandUid, outcome: 'already_registered', tag: raced };
    }
  }

  /**
   * Enrol a whole batch — the dashboard's paste-a-list path, for an organizer
   * who got a UID list with their tag order instead of tapping each one.
   *
   * A bad uid in the middle does NOT abort the batch and does NOT vanish: it
   * lands in `rejected` with its reason, so the operator sees exactly which of
   * the 500 lines they need to fix.
   */
  static async registerTags(params: {
    eventId: string;
    bandUids: string[];
    registeredBy?: string;
  }): Promise<BulkRegisterResult> {
    const result: BulkRegisterResult = {
      registered: [], alreadyRegistered: [], reactivated: [], rejected: [],
    };

    // De-duplicate the INPUT so one line repeated twice in a pasted list is not
    // reported as both "registered" and "already registered".
    const seen = new Set<string>();
    for (const raw of params.bandUids) {
      const normalized = normalizeBandUid(raw);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      try {
        const one = await EventTagService.registerTag({
          eventId: params.eventId,
          bandUid: raw,
          ...(params.registeredBy ? { registeredBy: params.registeredBy } : {}),
        });
        if (one.outcome === 'registered') result.registered.push(one.bandUid);
        else if (one.outcome === 'reactivated') result.reactivated.push(one.bandUid);
        else result.alreadyRegistered.push(one.bandUid);
      } catch (err: any) {
        result.rejected.push({ bandUid: String(raw), reason: err?.message || 'could not be registered' });
      }
    }

    return result;
  }

  /**
   * Pull a tag out of circulation. Idempotent — retiring a retired tag is fine.
   *
   * A retired tag must be dead EVERYWHERE, not just in the register: the money
   * paths (top-up, charge, cash-out, check-in-by-tag) look the wallet up by
   * uid and never consult the register again, so a wallet already wearing the
   * tag would carry on working. If one is, its binding is released here — the
   * balance stays on the wallet (a reissue onto a fresh tag is still possible)
   * and the physical tag stops working at every desk.
   *
   * Release FIRST, then flip the row. If the release fails, the register still
   * says active and the operator retries; if the flip fails after the release,
   * the tag is already dead at every desk and the retry is idempotent. The
   * other order — a retired row with a live binding — is exactly the hole this
   * closes.
   */
  static async retireTag(params: {
    eventId: string;
    bandUid: string;
    reason?: string;
  }): Promise<RetireResult> {
    const bandUid = normalizeBandUid(params.bandUid);
    const eventId = new Types.ObjectId(params.eventId);

    const inRegister = await EventTag.exists({ eventId, bandUid });
    if (!inRegister) throw new Error('That tag is not in this event’s register.');

    let releasedWalletId: string | null = null;
    const wearing = await Wallet.findOne({ eventId, bandUid }).select('_id').lean<{ _id: unknown } | null>();
    if (wearing) {
      await WalletService.unbindBand(String(wearing._id), params.reason ? `retired: ${params.reason}` : 'retired');
      releasedWalletId = String(wearing._id);
    }

    const tag = await EventTag.findOneAndUpdate(
      { eventId, bandUid },
      {
        $set: {
          status: 'retired',
          retiredAt: new Date(),
          ...(params.reason ? { retiredReason: params.reason } : {}),
        },
      },
      { new: true },
    );
    // Vanished between the existence check and the flip: say so rather than
    // report a retire that did not happen.
    if (!tag) throw new Error('That tag is not in this event’s register.');
    return { tag, releasedWalletId };
  }

  /**
   * The gate on every tag that tries to carry money at this event.
   *
   * Throws rather than returning false on purpose: every caller's correct
   * response is to abort loudly, and a boolean invites a caller to shrug it off.
   */
  static async assertTagRegistered(eventId: string | Types.ObjectId, bandUid: string): Promise<void> {
    const uid = normalizeBandUid(bandUid);
    const found = await EventTag.exists({ eventId, bandUid: uid, status: 'active' });
    if (!found) throw new Error(UNREGISTERED_TAG_MESSAGE);
  }

  /** How many tags this event has in circulation, and how many were pulled. */
  static async counts(eventId: string): Promise<{ active: number; retired: number; total: number }> {
    const [active, retired] = await Promise.all([
      EventTag.countDocuments({ eventId, status: 'active' }),
      EventTag.countDocuments({ eventId, status: 'retired' }),
    ]);
    return { active, retired, total: active + retired };
  }

  /** The registry screen — newest enrolment first, optionally filtered/searched. */
  static async list(
    eventId: string,
    opts: { status?: EventTagStatus; q?: string; limit?: number; skip?: number } = {},
  ): Promise<{
    tags: RegistryRow[];
    total: number;
    counts: { active: number; retired: number; total: number };
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const skip = Math.max(opts.skip ?? 0, 0);

    const filter: Record<string, unknown> = { eventId };
    if (opts.status) filter['status'] = opts.status;
    if (opts.q?.trim()) {
      // Search the CANONICAL form: the operator may type `04:A2:B1` or upper
      // case, but the stored uid is normalized, so searching the raw string
      // would find nothing and read as "that tag isn't registered".
      const needle = normalizeBandUid(opts.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter['bandUid'] = { $regex: needle };
    }

    const [tags, total, counts] = await Promise.all([
      EventTag.find(filter).sort({ registeredAt: -1 }).skip(skip).limit(limit).lean<IEventTag[]>(),
      EventTag.countDocuments(filter),
      EventTagService.counts(eventId),
    ]);

    const names = await resolveActorNames(tags.map((t) => t.registeredBy));

    return {
      tags: tags.map((t) => ({
        bandUid: t.bandUid,
        status: t.status,
        registeredAt: t.registeredAt,
        registeredBy: (t.registeredBy && names.get(String(t.registeredBy))) || 'Unknown',
        retiredAt: t.retiredAt ?? null,
        retiredReason: t.retiredReason ?? null,
      })),
      total,
      counts,
    };
  }
}

/** One row of the registry as the dashboard/POS reads it — no mongo ids leaked. */
export interface RegistryRow {
  bandUid: string;
  status: EventTagStatus;
  registeredAt: Date;
  /** Resolved display name of whoever enrolled it, or 'Unknown'. */
  registeredBy: string;
  retiredAt: Date | null;
  retiredReason: string | null;
}

/**
 * id -> display name across the three actor populations that can enrol a tag:
 * a register-desk gate operator, a cashier on the tag desk, or the organizer
 * themself from the dashboard. Mirrors tagReport.service's actorName map — the
 * id alone is meaningless on screen, and each population stores its name under
 * a different field.
 */
async function resolveActorNames(ids: Array<string | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id && mongoose.isValidObjectId(id)))];
  const out = new Map<string, string>();
  if (!unique.length) return out;

  const oids = unique.map((id) => new mongoose.Types.ObjectId(id));
  const [operators, cashiers, vendors] = await Promise.all([
    GateOperator.find({ _id: { $in: oids } }).select('fullName').lean(),
    Cashier.find({ _id: { $in: oids } }).select('fullName').lean(),
    Vendor.find({ _id: { $in: oids } }).select('businessName').lean(),
  ]);
  operators.forEach((o: any) => out.set(String(o._id), o.fullName));
  cashiers.forEach((c: any) => out.set(String(c._id), c.fullName));
  vendors.forEach((v: any) => out.set(String(v._id), v.businessName));
  return out;
}
