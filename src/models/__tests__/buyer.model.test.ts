import { Buyer } from '@models/buyer.model';

describe('Buyer identity invariant', () => {
  it('rejects a buyer with neither phone nor email', async () => {
    const b = new Buyer({ password: 'secret6' });
    await expect(b.validate()).rejects.toThrow(/phone or email/i);
  });

  it('accepts an email-only buyer', async () => {
    const b = new Buyer({ email: 'buyer@example.com', password: 'secret6', emailVerifiedAt: new Date() });
    await expect(b.validate()).resolves.toBeUndefined();
  });

  it('lowercases + trims email', () => {
    const b = new Buyer({ email: '  BUYER@Example.COM ', password: 'secret6', emailVerifiedAt: new Date() });
    expect(b.email).toBe('buyer@example.com');
  });

  it('still accepts a phone-only buyer', async () => {
    const b = new Buyer({ phone: '+26878422613', password: 'secret6', phoneVerifiedAt: new Date() });
    await expect(b.validate()).resolves.toBeUndefined();
  });
});
