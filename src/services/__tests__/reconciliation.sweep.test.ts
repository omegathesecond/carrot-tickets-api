/**
 * ReconciliationService.sweepRecentCashlessEvents — the background alarm for
 * the cashless ledger.
 *
 * checkWalletBalances / checkJournalIntegrity / checkInvariant existed but
 * nothing in production ever ran them, so a wallet whose stored balance
 * drifted from its journal, or an unbalanced ledger transaction, could sit
 * unnoticed forever. This sweep runs all three over every cashless event that
 * ended in the last 7 days and makes any failure LOUD (console.error with the
 * event id and the drifted wallet ids). It never repairs anything and never
 * swallows a failure.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ReconciliationService } from '@services/reconciliation.service';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { EventStatus } from '@interfaces/event.interface';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';

const DAY = 864e5;

beforeAll(connectTestDb);
afterEach(async () => {
  await clearTestDb();
  jest.restoreAllMocks();
});
afterAll(disconnectTestDb);

async function eventEnding(endTime: Date, opts: { cashless?: boolean; name?: string } = {}): Promise<string> {
  const start = new Date(endTime.getTime() - 3 * 3600e3);
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(), name: opts.name ?? 'Festival', venue: 'V',
    eventDate: start, startTime: start, endTime, status: EventStatus.COMPLETED,
    cashless: opts.cashless ?? true,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
  return (event._id as any).toString() as string;
}

async function walletWithBalance(eventId: string, balance: number): Promise<string> {
  const w = await Wallet.create({
    eventId: new mongoose.Types.ObjectId(eventId),
    ticketId: new mongoose.Types.ObjectId(),
    balance,
  });
  return String(w._id);
}

/** A balanced top-up posting written straight to the journal (no transaction needed). */
async function journalTopup(eventId: string, walletId: string, amount: number) {
  const oid = new mongoose.Types.ObjectId(eventId);
  const txnId = `topup-${walletId}`;
  await LedgerEntry.create([
    { eventId: oid, txnId, accountType: LedgerAccountType.FLOAT, accountRef: null, delta: amount, tag: FloatTag.KESHLESS, refType: 'topup', refId: txnId },
    { eventId: oid, txnId, accountType: LedgerAccountType.WALLET, accountRef: walletId, delta: -amount, refType: 'topup', refId: txnId },
  ]);
}

/** Stored balance 5000 against a journal that only ever saw 4000 → drift 1000. */
async function seedDriftedWallet(eventId: string): Promise<string> {
  const walletId = await walletWithBalance(eventId, 5000);
  await journalTopup(eventId, walletId, 4000);
  return walletId;
}

describe('ReconciliationService.sweepRecentCashlessEvents', () => {
  it('logs at error level with the event id and the drifted wallet ids when a stored balance drifts from its journal', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const eventId = await eventEnding(new Date(Date.now() - 2 * DAY));
    const walletId = await seedDriftedWallet(eventId);

    const result = await ReconciliationService.sweepRecentCashlessEvents();

    expect(result).toEqual({ checked: 1, notOk: [eventId], errored: [] });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[cashless-reconcile]'),
      expect.objectContaining({ eventId, driftedWalletIds: [walletId] }),
    );
  });

  it('names the unbalanced txnIds when the journal itself is corrupt', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const eventId = await eventEnding(new Date(Date.now() - DAY));
    await LedgerEntry.create({
      eventId: new mongoose.Types.ObjectId(eventId), txnId: 'rogue-1',
      accountType: LedgerAccountType.FLOAT, accountRef: null, delta: 9999,
      tag: FloatTag.KESHLESS, refType: 'rogue', refId: 'r1',
    });

    const result = await ReconciliationService.sweepRecentCashlessEvents();

    expect(result.notOk).toEqual([eventId]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[cashless-reconcile]'),
      expect.objectContaining({ eventId, unbalancedTxnIds: ['rogue-1'], driftedWalletIds: [] }),
    );
  });

  it('names journal wallet refs that have no Wallet row', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const eventId = await eventEnding(new Date(Date.now() - DAY));
    const ghost = new mongoose.Types.ObjectId().toString();
    await journalTopup(eventId, ghost, 700);

    const result = await ReconciliationService.sweepRecentCashlessEvents();

    expect(result.notOk).toEqual([eventId]);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[cashless-reconcile]'),
      expect.objectContaining({ eventId, unknownWalletRefs: [ghost], driftedWalletIds: [] }),
    );
  });

  it('stays silent when every recent cashless event reconciles', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const eventId = await eventEnding(new Date(Date.now() - 3 * DAY));
    const walletId = await walletWithBalance(eventId, 5000);
    await journalTopup(eventId, walletId, 5000);

    const result = await ReconciliationService.sweepRecentCashlessEvents();

    expect(result).toEqual({ checked: 1, notOk: [], errored: [] });
    expect(error).not.toHaveBeenCalled();
  });

  it('only sweeps cashless events whose end time is within the last 7 days', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Every one of these carries a drift that WOULD be reported if swept.
    await seedDriftedWallet(await eventEnding(new Date(Date.now() - 8 * DAY), { name: 'too old' }));
    await seedDriftedWallet(await eventEnding(new Date(Date.now() + DAY), { name: 'still running' }));
    await seedDriftedWallet(await eventEnding(new Date(Date.now() - DAY), { name: 'not cashless', cashless: false }));
    const inWindow = await eventEnding(new Date(Date.now() - 6 * DAY), { name: 'in window' });
    const walletId = await seedDriftedWallet(inWindow);

    const result = await ReconciliationService.sweepRecentCashlessEvents();

    expect(result).toEqual({ checked: 1, notOk: [inWindow], errored: [] });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[cashless-reconcile]'),
      expect.objectContaining({ eventId: inWindow, driftedWalletIds: [walletId] }),
    );
  });

  it("keeps checking the remaining events when one event's check throws, and reports the failure", async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const bad = await eventEnding(new Date(Date.now() - DAY), { name: 'bad' });
    const good = await eventEnding(new Date(Date.now() - 2 * DAY), { name: 'good' });
    const walletId = await seedDriftedWallet(good);
    const real = ReconciliationService.checkEvent.bind(ReconciliationService);
    jest.spyOn(ReconciliationService, 'checkEvent').mockImplementation(async (eventId: string) => {
      if (eventId === bad) throw new Error('boom');
      return real(eventId);
    });

    const result = await ReconciliationService.sweepRecentCashlessEvents();

    expect(result).toEqual({ checked: 2, notOk: [good], errored: [bad] });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[cashless-reconcile]'),
      expect.objectContaining({ eventId: bad, error: expect.any(Error) }),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[cashless-reconcile]'),
      expect.objectContaining({ eventId: good, driftedWalletIds: [walletId] }),
    );
  });
});
