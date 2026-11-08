import type { Request, Response } from 'express';
import { OnboardingController } from '@controllers/onboarding.controller';
import { OnboardingService } from '@services/onboarding.service';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

jest.mock('@utils/socialActor.util', () => ({ resolveActorFromRequest: jest.fn() }));
const status = { hasProfilePhoto: false, actorId: 'id', actorType: 'vendor' as const, username: null, followingCount: 0, mediaCount: 0, canBrowse: false, canViewProfiles: false };
function response() {
  const res = { req: { originalUrl: '/me/onboarding' }, status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}
describe('onboarding controller', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([
    ['buyer', [], true],
    ['vendor', [TicketsPermission.EDIT_BRAND], true],
    ['vendor', [], false],
  ] as const)('sequences the photo gate for %s with %j', async (type, permissions, required) => {
    jest.mocked(resolveActorFromRequest).mockResolvedValue({ type, id: 'id' });
    jest.spyOn(OnboardingService, 'status').mockResolvedValue(status);
    const res = response();
    await OnboardingController.status({ ticketsUser: { permissions } } as unknown as Request, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: { ...status, photoRequired: required } }));
  });
  it('rejects an unresolved session', async () => {
    jest.mocked(resolveActorFromRequest).mockResolvedValue(null);
    const res = response();
    await OnboardingController.status({} as Request, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(401);
  });
  it('returns a visible error when progress cannot be read', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.mocked(resolveActorFromRequest).mockResolvedValue({ type: 'buyer', id: 'id' });
    jest.spyOn(OnboardingService, 'status').mockRejectedValue(new Error('Database unavailable'));
    const res = response();
    await OnboardingController.status({} as Request, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, message: 'Database unavailable' }));
  });
});
