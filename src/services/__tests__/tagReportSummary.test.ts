import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';
import { TagReportService } from '@services/tagReport.service';

const EVENT = new mongoose.Types.ObjectId();
const OTHER_EVENT = new mongoose.Types.ObjectId();

const wallet = (over: Record<string, unknown> = {}) =>
  Wallet.create({
    eventId: EVENT,
    ticketId: new mongoose.Types.ObjectId(),
    bandUid: 'UID' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    balance: 0,
    cashFundedBalance: 0,
    status: 'active',
    ...over,
  });

describe('TagReportService.summary', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('counts tags in use and totals what is still owed to attendees', async () => {
    await wallet({ balance: 15000, cashFundedBalance: 5000 });
    await wallet({ balance: 5000, cashFundedBalance: 0 });

    const s = await TagReportService.summary(String(EVENT));

    expect(s.tagsInUse).toBe(2);
    expect(s.activeTags).toBe(2);
    expect(s.balanceOutstanding).toBe(20000);
    expect(s.cashFundedOutstanding).toBe(5000);
    expect(s.averageBalance).toBe(10000);
  });

  it('counts a wallet whose tag was deactivated as unbound, not as gone', async () => {
    await wallet({ balance: 7000, bandUid: null });

    const s = await TagReportService.summary(String(EVENT));

    expect(s.tagsInUse).toBe(1);
    expect(s.activeTags).toBe(0);
    expect(s.unboundTags).toBe(1);
    // The money is still owed even though no plastic is holding it.
    expect(s.balanceOutstanding).toBe(7000);
  });

  it('ignores other events', async () => {
    await wallet({ balance: 100 });
    await wallet({ eventId: OTHER_EVENT, balance: 999999 });

    const s = await TagReportService.summary(String(EVENT));

    expect(s.tagsInUse).toBe(1);
    expect(s.balanceOutstanding).toBe(100);
  });

  it('reports zeroes rather than NaN for an event with no tags', async () => {
    const s = await TagReportService.summary(String(EVENT));

    expect(s).toMatchObject({
      tagsInUse: 0, activeTags: 0, unboundTags: 0,
      balanceOutstanding: 0, cashFundedOutstanding: 0, averageBalance: 0,
    });
  });
});
