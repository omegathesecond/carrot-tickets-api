import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { startTestRealtime, connectClient, TestRealtime } from './helpers';

const PHONE = '+26878422613';

describe('socketAuthMiddleware', () => {
  let rt: TestRealtime;

  beforeAll(connectTestDb);
  beforeEach(async () => {
    rt = await startTestRealtime();
  });
  afterEach(async () => {
    await rt.close();
    await clearTestDb();
  });
  afterAll(disconnectTestDb);

  it('rejects a connection with no token', async () => {
    await expect(connectClient(rt.port)).rejects.toThrow(/sign in/i);
  });

  it('accepts a vendor token and attaches a vendor actor (no presence identity)', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const client = await connectClient(rt.port, signVendorToken(vendorId));

    const serverSocket = rt.io.sockets.sockets.get(client.id!)!;
    expect(serverSocket.data.actor).toEqual({ type: 'vendor', id: vendorId });
    expect(serverSocket.data.buyerId).toBeUndefined(); // presence stays buyer-only

    client.close();
  });

  it('rejects a buyer token whose account does not exist', async () => {
    await expect(connectClient(rt.port, signBuyerToken('+26878000099'))).rejects.toThrow(/account not found/i);
  });

  it('accepts a valid buyer and attaches identity + lazily assigns username', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Sock Buyer' });
    const client = await connectClient(rt.port, signBuyerToken(PHONE));

    const serverSocket = rt.io.sockets.sockets.get(client.id!)!;
    expect(serverSocket.data.phone).toBe(PHONE);
    expect(typeof serverSocket.data.buyerId).toBe('string');
    expect(serverSocket.data.username).toMatch(/^[a-z0-9_]{3,20}$/);
    expect(serverSocket.data.actor).toEqual({ type: 'buyer', id: serverSocket.data.buyerId });

    client.close();
  });
});
