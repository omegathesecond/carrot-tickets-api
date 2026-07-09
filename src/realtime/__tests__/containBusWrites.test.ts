import { ObjectId } from 'mongodb';
import { containBusWrites } from '../containBusWrites';

describe('containBusWrites', () => {
  it('rejected insertOne resolves to acknowledged:false with a usable insertedId', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const fake = { insertOne: jest.fn().mockRejectedValue(new Error('stepdown')) };
    const wrapped = containBusWrites(fake as any);
    const result: any = await (wrapped.insertOne as any)({ some: 'doc' });
    expect(result.acknowledged).toBe(false);
    expect(result.insertedId).toBeInstanceOf(ObjectId);
    expect(result.insertedId.toString('hex')).toHaveLength(24); // adapter chains .toString("hex")
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[realtime-bus] write failed'), expect.any(Error));
    spy.mockRestore();
  });

  it('passes successful insertOne through untouched', async () => {
    const ok = { acknowledged: true, insertedId: new ObjectId() };
    const fake = { insertOne: jest.fn().mockResolvedValue(ok) };
    const wrapped = containBusWrites(fake as any);
    await expect((wrapped.insertOne as any)({})).resolves.toBe(ok);
  });
});
