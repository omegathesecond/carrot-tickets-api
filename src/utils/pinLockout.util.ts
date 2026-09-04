// api/src/utils/pinLockout.util.ts
import { Model, Types } from 'mongoose';

/**
 * PIN lockout bookkeeping shared by every PIN-login population (gate, cashier,
 * reseller till, stall operator — see applyOperatorCredentials for the fields).
 *
 * Both writes go to the SERVER as single atomic updates, never through a loaded
 * document. The old shape was read → bcrypt compare → `failedPinAttempts = n+1`
 * → save(): a read-modify-write with no version guard, so N wrong guesses in
 * flight together all read 0 and all wrote 1 — an attacker only had to send
 * their guesses in parallel and the lock never engaged. Here the increment is
 * `$add` on the stored value inside one update pipeline, so N concurrent
 * failures reach N and the Nth one locks.
 */

export const MAX_PIN_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

export interface PinLockoutState {
  failedPinAttempts: number;
  lockedUntil: Date | null;
}

/**
 * Count one wrong PIN against `id` and lock the row once the count reaches the
 * threshold. Returns the state AFTER this attempt.
 *
 * The counter is kept at the threshold while a lock is live rather than reset
 * to 0 — the row then says why it is locked. A lock that has already EXPIRED
 * starts a fresh window: the next miss counts as 1, not 6, so someone who sat
 * out the lock gets their attempts back instead of being re-locked on the
 * first typo.
 */
export async function recordFailedPinAttempt(
  model: Model<any>,
  id: Types.ObjectId | string,
): Promise<PinLockoutState> {
  const now = new Date();
  const lockUntil = new Date(now.getTime() + LOCK_MINUTES * 60 * 1000);
  // `$type` rather than a null comparison: a missing field and an explicit
  // null must both read as "no lock", and BSON ordering would otherwise rank
  // either of them below every Date and satisfy `$lte`.
  const lockExpired = {
    $and: [{ $eq: [{ $type: '$lockedUntil' }, 'date'] }, { $lte: ['$lockedUntil', now] }],
  };

  const updated = await model.findOneAndUpdate(
    { _id: id },
    [
      {
        $set: {
          failedPinAttempts: {
            $cond: [lockExpired, 1, { $add: [{ $ifNull: ['$failedPinAttempts', 0] }, 1] }],
          },
          lockedUntil: { $cond: [lockExpired, null, '$lockedUntil'] },
        },
      },
      {
        // Sees the count written by the stage above.
        $set: {
          lockedUntil: {
            $cond: [{ $gte: ['$failedPinAttempts', MAX_PIN_ATTEMPTS] }, lockUntil, '$lockedUntil'],
          },
        },
      },
    ],
    { new: true, projection: { failedPinAttempts: 1, lockedUntil: 1 } },
  ).lean<PinLockoutState | null>();

  // The row was just loaded by the caller; nothing here means it vanished
  // between the read and this write. Surface that rather than pretend the
  // attempt was counted.
  if (!updated) throw new Error('Operator not found');
  return { failedPinAttempts: updated.failedPinAttempts ?? 0, lockedUntil: updated.lockedUntil ?? null };
}

/** A successful login: clear the counter and any lock, stamp lastLoginAt. */
export async function clearPinLockout(model: Model<any>, id: Types.ObjectId | string): Promise<void> {
  await model.updateOne(
    { _id: id },
    { $set: { failedPinAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } },
  );
}
