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
});
