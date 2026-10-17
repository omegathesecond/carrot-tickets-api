import { TicketsAuthService } from '../ticketsAuth.service';
import { Vendor } from '@models/vendor.model';
import { RefreshToken } from '@models/refreshToken.model';
afterEach(() => jest.restoreAllMocks());
it('revokes organizer access, refresh and SSO sessions through the shared auth version', async () => {
  jest.spyOn(RefreshToken, 'findOne').mockResolvedValue({ userType: 'vendor', vendorId: 'owner', authVersion: 4 } as any);
  const update = jest.spyOn(Vendor, 'updateOne').mockResolvedValue({ modifiedCount: 1 } as any);
  await TicketsAuthService.logout('expired-access', 'refresh');
  expect(update).toHaveBeenCalledWith({ _id: 'owner', authVersion: 4 }, { $inc: { authVersion: 1 } });
});
it('surfaces database failures instead of reporting successful logout', async () => {
  jest.spyOn(RefreshToken, 'findOne').mockRejectedValue(new Error('Database unavailable'));
  await expect(TicketsAuthService.logout('access', 'refresh')).rejects.toThrow('Database unavailable');
});
it('preserves refresh-only logout for sub-users', async () => {
  jest.spyOn(RefreshToken, 'findOne').mockResolvedValue({ userType: 'sub-user' } as any);
  const revoke = jest.spyOn(TicketsAuthService, 'revokeRefreshToken').mockResolvedValue();
  const update = jest.spyOn(Vendor, 'updateOne');
  await TicketsAuthService.logout('access', 'staff-refresh');
  expect(revoke).toHaveBeenCalledWith('staff-refresh');
  expect(update).not.toHaveBeenCalled();
});
it('requires credentials when there is no request body', async () => {
  await expect(TicketsAuthService.logout()).rejects.toThrow('valid session');
});

it('rejects structured refresh tokens before querying MongoDB', async () => {
  const lookup = jest.spyOn(RefreshToken, 'findOne');
  await expect(TicketsAuthService.logout(undefined, { $ne: null } as any)).rejects.toThrow('non-empty string');
  expect(lookup).not.toHaveBeenCalled();
});
