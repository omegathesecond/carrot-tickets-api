import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';

const eventId = new mongoose.Types.ObjectId().toString();

/** Top up w1 by `amount` cents from `tag`. */
async function topUp(wallet: string, amount: number, tag: FloatTag) {
  await LedgerService.post({
    eventId, refType: 'topup', refId: `t-${wallet}-${amount}`,
    postings: [
      { account: { type: LedgerAccountType.FLOAT }, delta: amount, tag },
      { account: { type: LedgerAccountType.WALLET, ref: wallet }, delta: -amount },
    ],
  });
}

describe('LedgerService balance derivation', () => {
  beforeAll(connectLedgerTestDb, 60000); // replica set: post() commits in a transaction
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('returns 0 for an account with no postings', async () => {
    expect(await LedgerService.floatBalance(eventId)).toBe(0);
    expect(
      await LedgerService.accountBalance(eventId, { type: LedgerAccountType.WALLET, ref: 'nope' }),
    ).toBe(0);
  });

  it('derives a wallet balance as a negative (credit-normal) figure', async () => {
    await topUp('w1', 5000, FloatTag.KESHLESS);
    expect(
      await LedgerService.accountBalance(eventId, { type: LedgerAccountType.WALLET, ref: 'w1' }),
    ).toBe(-5000);
  });

  it('exposes owed as a positive figure', async () => {
    await topUp('w1', 5000, FloatTag.KESHLESS);
    await topUp('w2', 2500, FloatTag.CASH_DESK);
    expect(await LedgerService.totalOwed(eventId, LedgerAccountType.WALLET)).toBe(7500);
  });

  it('splits the float balance by tag', async () => {
    await topUp('w1', 5000, FloatTag.KESHLESS);
    await topUp('w2', 2500, FloatTag.CASH_DESK);
    expect(await LedgerService.floatBalance(eventId)).toBe(7500);
    expect(await LedgerService.floatBalance(eventId, FloatTag.KESHLESS)).toBe(5000);
    expect(await LedgerService.floatBalance(eventId, FloatTag.CASH_DESK)).toBe(2500);
  });

  it('reflects a spend: wallet owed drops, merchant owed rises, fees earned rise', async () => {
    await topUp('w1', 5000, FloatTag.KESHLESS);
    await LedgerService.post({
      eventId, refType: 'charge', refId: 'c1',
      postings: [
        { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: 1000 },
        { account: { type: LedgerAccountType.MERCHANT, ref: 'm1' }, delta: -900 },
        { account: { type: LedgerAccountType.FEES }, delta: -100 },
      ],
    });

    expect(await LedgerService.totalOwed(eventId, LedgerAccountType.WALLET)).toBe(4000);
    expect(await LedgerService.totalOwed(eventId, LedgerAccountType.MERCHANT)).toBe(900);
    expect(await LedgerService.totalOwed(eventId, LedgerAccountType.FEES)).toBe(100);
    // Float is untouched by a spend — money only moved between claims on it.
    expect(await LedgerService.floatBalance(eventId)).toBe(5000);
  });

  it('scopes balances to an event', async () => {
    const other = new mongoose.Types.ObjectId().toString();
    await topUp('w1', 5000, FloatTag.KESHLESS);
    expect(await LedgerService.floatBalance(other)).toBe(0);
  });

  // -0 is arithmetically harmless but Object.is(-0, 0) is false, so it fails
  // toBe(0) — a caller asserting an empty event reads as broken.
  describe('totalOwed returns a positive zero, never -0', () => {
    it('for a type with no postings at all', async () => {
      expect(await LedgerService.totalOwed(eventId, LedgerAccountType.WALLET)).toBe(0);
      expect(await LedgerService.totalOwed(eventId, LedgerAccountType.MERCHANT)).toBe(0);
      expect(await LedgerService.totalOwed(eventId, LedgerAccountType.FEES)).toBe(0);
    });

    it('for postings that net to zero (topped up, then fully spent)', async () => {
      await topUp('w1', 5000, FloatTag.KESHLESS);
      await LedgerService.post({
        eventId, refType: 'charge', refId: 'spend-all',
        postings: [
          { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: 5000 },
          { account: { type: LedgerAccountType.MERCHANT, ref: 'm1' }, delta: -5000 },
        ],
      });

      expect(await LedgerService.totalOwed(eventId, LedgerAccountType.WALLET)).toBe(0);
      expect(
        await LedgerService.accountBalance(eventId, { type: LedgerAccountType.WALLET, ref: 'w1' }),
      ).toBe(0);
    });
  });

  // The session parameter exists so a caller CAN read inside its own
  // transaction. If it were silently dropped, the read would miss the caller's
  // own uncommitted postings and quietly report a stale figure.
  describe('reads join a caller transaction when given a session', () => {
    it('sees the callers own uncommitted postings, which an unsessioned read does not', async () => {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await LedgerService.post({
            eventId, refType: 'topup', refId: 't-sessioned', session,
            postings: [
              { account: { type: LedgerAccountType.FLOAT }, delta: 5000, tag: FloatTag.KESHLESS },
              { account: { type: LedgerAccountType.WALLET, ref: 'w1' }, delta: -5000 },
            ],
          });

          // Inside the txn, with the session: the uncommitted legs are visible.
          expect(await LedgerService.floatBalance(eventId, undefined, session)).toBe(5000);
          expect(await LedgerService.floatBalance(eventId, FloatTag.KESHLESS, session)).toBe(5000);
          expect(
            await LedgerService.accountBalance(
              eventId, { type: LedgerAccountType.WALLET, ref: 'w1' }, session,
            ),
          ).toBe(-5000);
          expect(
            await LedgerService.totalOwed(eventId, LedgerAccountType.WALLET, session),
          ).toBe(5000);
        });
      } finally {
        await session.endSession();
      }

      // Committed: an unsessioned read now agrees.
      expect(await LedgerService.floatBalance(eventId)).toBe(5000);
    });
  });

  describe('rejects reads that would silently report a wrong figure', () => {
    it('throws when a ref is supplied for a singleton account', async () => {
      await topUp('w1', 5000, FloatTag.KESHLESS);
      // Without the guard this matches accountRef: 'x', finds nothing and
      // reports the float as empty while it holds 5000.
      await expect(
        LedgerService.accountBalance(eventId, { type: LedgerAccountType.FLOAT, ref: 'x' }),
      ).rejects.toThrow(/does not take a ref/);
      await expect(
        LedgerService.accountBalance(eventId, { type: LedgerAccountType.FEES, ref: 'x' }),
      ).rejects.toThrow(/does not take a ref/);
    });

    it('throws on an empty-string ref for a singleton account', async () => {
      // Truthiness-based guards let '' through; '' is still a supplied ref.
      await expect(
        LedgerService.accountBalance(eventId, { type: LedgerAccountType.FLOAT, ref: '' }),
      ).rejects.toThrow(/does not take a ref/);
    });

    it('throws when a ref is missing for an entity account', async () => {
      await expect(
        LedgerService.accountBalance(eventId, { type: LedgerAccountType.WALLET }),
      ).rejects.toThrow(/requires a ref/);
    });

    it('throws when totalOwed is asked for the debit-normal float', async () => {
      await expect(LedgerService.totalOwed(eventId, LedgerAccountType.FLOAT)).rejects.toThrow(
        /credit-normal/,
      );
    });
  });
});
