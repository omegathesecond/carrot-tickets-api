import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';

const eventId = new mongoose.Types.ObjectId();
const ticketId = () => new mongoose.Types.ObjectId(); // fresh per wallet unless testing collision

describe('Wallet model', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('defaults a new wallet to an active, empty, unbound ZAR wallet', async () => {
    const w = await Wallet.create({ eventId, ticketId: ticketId() });
    expect(w.balance).toBe(0);
    expect(w.cashFundedBalance).toBe(0);
    expect(w.status).toBe('active');
    expect(w.currency).toBe('ZAR');
    expect(w.bandUid).toBeNull();
  });

  it('requires a ticketId', async () => {
    await expect(Wallet.create({ eventId })).rejects.toThrow(/ticketId/);
  });

  it('rejects a negative balance via min:0 on the balance path', async () => {
    // cashFundedBalance is passed as -1 deliberately. It must NOT be left to
    // default to 0: 0 > -1 trips the pre('validate') cross-field hook, which
    // throws first and means min:0 on balance never runs at all — the trap this
    // test previously fell into, passing on the wrong error. -1 > -1 is false,
    // so the hook abstains and path validation is what does the rejecting.
    const err = await Wallet.create({ eventId, ticketId: ticketId(), balance: -1, cashFundedBalance: -1 })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(mongoose.Error.ValidationError);
    const balanceErr = (err as mongoose.Error.ValidationError).errors.balance;
    expect(balanceErr).toBeDefined();
    // `kind` is what pins this to min:0 specifically, rather than to the
    // integerCents validator or the cross-field hook.
    expect(balanceErr?.kind).toBe('min');
  });

  it('rejects a non-integer balance (money is integer cents)', async () => {
    await expect(
      Wallet.create({ eventId, ticketId: ticketId(), balance: 10.5 }),
    ).rejects.toThrow(/^Wallet validation failed: balance: balance must be integer minor units \(ZAR cents\)$/);
  });

  it('names the offending field in the integer-cents message, not always "balance"', async () => {
    // balance 100 keeps the cross-field hook quiet (10.5 > 100 is false) so the
    // only thing that can fire is cashFundedBalance's own integerCents validator.
    await expect(
      Wallet.create({ eventId, ticketId: ticketId(), balance: 100, cashFundedBalance: 10.5 }),
    ).rejects.toThrow(/cashFundedBalance must be integer minor units \(ZAR cents\)/);
  });

  it('rejects cashFundedBalance greater than balance', async () => {
    // Both values are valid integers >= 0 on their own, so the cross-field hook
    // is the only thing that can reject this — asserting the exact message keeps
    // it that way.
    await expect(
      Wallet.create({ eventId, ticketId: ticketId(), balance: 100, cashFundedBalance: 101 }),
    ).rejects.toThrow(/^cashFundedBalance cannot exceed balance$/);
  });

  it('refuses two wallets for the SAME ticket', async () => {
    const t = ticketId();
    await Wallet.create({ eventId, ticketId: t });
    await expect(Wallet.create({ eventId, ticketId: t })).rejects.toMatchObject({ code: 11000 });
  });

  it('allows MANY unbound wallets in one event (distinct tickets)', async () => {
    await Wallet.create({ eventId, ticketId: ticketId() });
    await Wallet.create({ eventId, ticketId: ticketId() });
    await Wallet.create({ eventId, ticketId: ticketId() });
    expect(await Wallet.countDocuments({ eventId, bandUid: null })).toBe(3);
  });

  it('refuses two wallets bound to the same band UID in one event', async () => {
    await Wallet.create({ eventId, ticketId: ticketId(), bandUid: 'AABBCC01' });
    await expect(
      Wallet.create({ eventId, ticketId: ticketId(), bandUid: 'AABBCC01' }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows the same band UID in a DIFFERENT event (wallets are per-event closed-loop)', async () => {
    const other = new mongoose.Types.ObjectId();
    await Wallet.create({ eventId, ticketId: ticketId(), bandUid: 'AABBCC02' });
    const w = await Wallet.create({ eventId: other, ticketId: ticketId(), bandUid: 'AABBCC02' });
    expect(w.bandUid).toBe('AABBCC02');
  });

  it('KNOWN GAP: update operators bypass the invariant — callers must preserve it', async () => {
    // Characterisation test. It documents what the model does NOT enforce, so
    // this is deliberately asserting the drift, not a rejection.
    //
    // pre('validate') and min/validate run on save()/create() only. $inc bypasses
    // them entirely (there is no full document to validate), and update
    // validators cannot express a cross-field check anyway. SP3 (top-up) and SP5
    // (tap-to-pay) mutate via $inc/CAS, so THEY must hold the invariant up.
    //
    // The intended pattern is the single atomic aggregation-pipeline update
    // documented on wallet.model.ts, which decrements both fields together under
    // a CAS filter with a $max:[0, ...] floor on cashFundedBalance.
    //
    // Nothing detects this drift after the fact: ReconciliationService's
    // checkInvariant/checkJournalIntegrity reconcile the ledger and never read
    // Wallet documents.
    const w = await Wallet.create({ eventId, ticketId: ticketId(), balance: 100, cashFundedBalance: 100 });

    const res = await Wallet.updateOne({ _id: w._id }, { $inc: { cashFundedBalance: 50 } });
    expect(res.modifiedCount).toBe(1); // no error, no rejection

    const after = await Wallet.findById(w._id);
    expect(after?.balance).toBe(100);
    expect(after?.cashFundedBalance).toBe(150); // invariant violated, silently
  });
});
