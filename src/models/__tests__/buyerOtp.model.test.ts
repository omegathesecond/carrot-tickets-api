import { BuyerOtp } from '@models/buyerOtp.model';

describe('BuyerOtp channel', () => {
  it('requires audience, channel and destination', () => {
    const otp = new BuyerOtp({ codeHash: 'x', expiresAt: new Date() });
    const err = otp.validateSync();
    expect(err).toBeDefined();
    expect(err?.errors['audience']).toBeDefined();
    expect(err?.errors['channel']).toBeDefined();
    expect(err?.errors['destination']).toBeDefined();
  });

  it('rejects an unknown audience', () => {
    const otp = new BuyerOtp({ audience: 'admin', channel: 'email', destination: 'a@b.com', codeHash: 'x', expiresAt: new Date() });
    expect(otp.validateSync()?.errors['audience']).toBeDefined();
  });

  it('accepts a buyer email OTP row', () => {
    const otp = new BuyerOtp({ audience: 'buyer', channel: 'email', destination: 'a@b.com', codeHash: 'x', expiresAt: new Date() });
    expect(otp.validateSync()).toBeUndefined();
  });

  it('accepts a vendor sms OTP row', () => {
    const otp = new BuyerOtp({ audience: 'vendor', channel: 'sms', destination: '+26876000000', codeHash: 'x', expiresAt: new Date() });
    expect(otp.validateSync()).toBeUndefined();
  });
});
