import { BuyerOtp } from '@models/buyerOtp.model';

describe('BuyerOtp channel', () => {
  it('requires channel and destination', () => {
    const otp = new BuyerOtp({ codeHash: 'x', expiresAt: new Date() });
    const err = otp.validateSync();
    expect(err).toBeDefined();
    expect(err?.errors['channel']).toBeDefined();
    expect(err?.errors['destination']).toBeDefined();
  });

  it('accepts an email OTP row', () => {
    const otp = new BuyerOtp({ channel: 'email', destination: 'a@b.com', codeHash: 'x', expiresAt: new Date() });
    expect(otp.validateSync()).toBeUndefined();
  });
});
