import mongoose from 'mongoose';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';

const reqWith = (ticketsUser: any) => ({ ticketsUser } as any);

describe('resolveActorFromRequest', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns a vendor actor from a vendor token (vendorId)', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const actor = await resolveActorFromRequest(reqWith({ app: 'tickets', userType: 'vendor', vendorId }));
    expect(actor).toEqual({ type: 'vendor', id: vendorId });
  });

  it('returns a vendor actor for a sub-user token (also carries vendorId)', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const actor = await resolveActorFromRequest(reqWith({ app: 'tickets', userType: 'sub-user', vendorId }));
    expect(actor).toEqual({ type: 'vendor', id: vendorId });
  });

  it('returns a buyer actor resolved from the token phone', async () => {
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'testpass123', name: 'Test' });
    const actor = await resolveActorFromRequest(reqWith({ app: 'tickets', userType: 'buyer', userPhone: '+26878422613' }));
    expect(actor).toEqual({ type: 'buyer', id: String(buyer._id) });
  });

  it('returns null for a buyer token with no matching Buyer document', async () => {
    const actor = await resolveActorFromRequest(reqWith({ app: 'tickets', userType: 'buyer', userPhone: '+26800000000' }));
    expect(actor).toBeNull();
  });

  it('returns null when there is no token', async () => {
    expect(await resolveActorFromRequest(reqWith(undefined))).toBeNull();
  });
});
