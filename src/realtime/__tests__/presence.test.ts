import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { startTestRealtime, connectClient, TestRealtime } from './helpers';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { BuyerPresence } from '@models/buyerPresence.model';
import { isBuyerOnline } from '@utils/buyerOnline.util';
import { Socket as ClientSocket } from 'socket.io-client';

const PHONE = '+26878422613';

async function waitFor(cond: () => Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

describe('gateway presence', () => {
  let rt: TestRealtime;
  const clients: ClientSocket[] = [];

  beforeAll(connectTestDb);
  beforeEach(async () => {
    rt = await startTestRealtime();
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await rt.close();
    await clearTestDb();
  });
  afterAll(disconnectTestDb);

  it('connect creates a presence row; disconnect removes it; isBuyerOnline tracks staleness', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1' });
    expect(await isBuyerOnline(String(buyer._id))).toBe(false);

    const client = await connectClient(rt.port, signBuyerToken(PHONE));
    clients.push(client);
    await waitFor(async () => (await BuyerPresence.countDocuments({ buyerId: buyer._id })) === 1);
    expect(await isBuyerOnline(String(buyer._id))).toBe(true);

    // stale rows do not count as online
    await BuyerPresence.updateMany({ buyerId: buyer._id }, { lastSeenAt: new Date(Date.now() - 10 * 60_000) });
    expect(await isBuyerOnline(String(buyer._id))).toBe(false);

    client.close();
    await waitFor(async () => (await BuyerPresence.countDocuments({ buyerId: buyer._id })) === 0);
  });

  it('a disconnect racing the create leaves no phantom row', async () => {
    const buyer = await Buyer.create({ phone: '+26878000042', password: 'secret1' });
    const listeners: Record<string, () => void> = {};
    const fakeSocket: any = {
      id: 'race-socket-1',
      data: { buyerId: String(buyer._id) },
      disconnected: false,
      on: (event: string, cb: () => void) => { listeners[event] = cb; },
    };

    const { trackConnection } = await import('../presence');
    trackConnection(fakeSocket);
    // Disconnect fires while the create is still in flight.
    fakeSocket.disconnected = true;
    listeners['disconnect']!();

    await new Promise((r) => setTimeout(r, 300)); // let create + recheck settle
    expect(await BuyerPresence.countDocuments({ socketId: 'race-socket-1' })).toBe(0);
  });
});
