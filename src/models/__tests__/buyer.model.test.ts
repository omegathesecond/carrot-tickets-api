import { Buyer } from '@models/buyer.model';

describe('Buyer identity invariant', () => {
  it('rejects a buyer with neither phone nor email', () => {
    const b = new Buyer({ password: 'secret6' });
    const err = b.validateSync();
    expect(err?.message).toMatch(/phone or email/i);
  });

  it('accepts an email-only buyer', () => {
    const b = new Buyer({ email: 'buyer@example.com', password: 'secret6', emailVerifiedAt: new Date() });
    expect(b.validateSync()).toBeUndefined();
  });

  it('lowercases + trims email', () => {
    const b = new Buyer({ email: '  BUYER@Example.COM ', password: 'secret6', emailVerifiedAt: new Date() });
    expect(b.email).toBe('buyer@example.com');
  });

  it('still accepts a phone-only buyer', () => {
    const b = new Buyer({ phone: '+26878422613', password: 'secret6', phoneVerifiedAt: new Date() });
    expect(b.validateSync()).toBeUndefined();
  });
});
