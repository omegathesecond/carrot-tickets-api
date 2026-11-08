import express from 'express';
import request from 'supertest';
import { enforceOnboarding } from '@middleware/onboarding.middleware';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { Update } from '@models/update.model';
import { OnboardingService } from '@services/onboarding.service';

jest.mock('@utils/socialActor.util', () => ({ ...jest.requireActual('@utils/socialActor.util'), resolveActorFromRequest: jest.fn() }));
jest.mock('@services/onboarding.service', () => ({ OnboardingService: { status: jest.fn() } }));
jest.mock('@models/update.model', () => ({ Update: { findById: jest.fn() } }));
const app = express();
app.use(enforceOnboarding);
app.use((_req, res) => { res.json({ reached: true }); });
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: err.message }); });
const status = jest.mocked(OnboardingService.status);

describe.each(['buyer', 'vendor'] as const)('%s server onboarding', (type) => {
  beforeEach(() => {
    jest.spyOn(TicketsAuthService, 'verifyAndResolveSession').mockResolvedValue({ userType: type } as never);
    jest.mocked(resolveActorFromRequest).mockResolvedValue({ type, id: 'own-id' });
    status.mockResolvedValue({ actorId: 'own-id', actorType: type, username: type === 'buyer' ? 'own-name' : null, followingCount: 0, mediaCount: 0, canBrowse: false, canViewProfiles: false, hasProfilePhoto: true });
  });
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });
  const social = type === 'buyer' ? '/api/social' : '/api/tickets/social';
  it.each(['/api/public/feed', '/API/PUBLIC/FEED', '/api/public/%66eed', '/api/public/events', '/api/public/activity-feed', '/api/public/updates/post-id', '/api/public/services', '/api/marketplace/opportunities', `${social}/recommendations`, `${social}/stories`])('blocks direct browse read %s', async (path) => {
    const res = await request(app).get(path).set('Authorization', 'Bearer valid');
    expect(res.status).toBe(403); expect(res.body.error).toBe('FOLLOWING_REQUIRED');
  });
  it.each([`${social}/users/other`, '/api/public/organizers/other', '/api/public/services/other', '/api/public/services/other/reviews', '/api/public/updates/by/buyer/other'])('blocks profile/media read %s', async (path) => {
    const res = await request(app).get(path).set('Authorization', 'Bearer valid');
    expect(res.status).toBe(403); expect(res.body.error).toBe('MEDIA_REQUIRED');
  });
  it('unlocks browse independently of media and checks again after counts change', async () => {
    const initial = await OnboardingService.status({ type, id: 'own-id' });
    status.mockResolvedValue({ ...initial, followingCount: 10, canBrowse: true });
    expect((await request(app).get('/api/public/feed').set('Authorization', 'Bearer valid')).status).toBe(200);
    expect((await request(app).get(`${social}/users/other`).set('Authorization', 'Bearer valid')).status).toBe(403);
    status.mockResolvedValue(initial);
    expect((await request(app).get('/api/public/feed').set('Authorization', 'Bearer valid')).status).toBe(403);
  });
  it('unlocks profiles independently of follows', async () => {
    status.mockResolvedValue({ ...await OnboardingService.status({ type, id: 'own-id' }), mediaCount: 3, canViewProfiles: true });
    expect((await request(app).get(`${social}/users/other`).set('Authorization', 'Bearer valid')).status).toBe(200);
    expect((await request(app).get('/api/public/feed').set('Authorization', 'Bearer valid')).status).toBe(403);
  });
  it.each([`${social}/me/onboarding`, `${social}/me`, `${social}/suggestions/people`, '/api/public/my-tickets', '/api/public/profile', '/api/media/upload-url', '/api/public/events/event-id/preparation', `/api/public/updates/by/${type}/own-id`])('keeps recovery available %s', async (path) => {
    expect((await request(app).get(path).set('Authorization', 'Bearer valid')).status).toBe(200);
  });
  it('allows three owner video polls without follows and unlocks profiles independently', async () => {
    const lean = jest.fn().mockResolvedValue({ authorType: type, authorId: 'own-id' });
    const select = jest.fn().mockReturnValue({ lean });
    jest.mocked(Update.findById).mockReturnValue({ select } as never);
    for (const id of ['111111111111111111111111', '222222222222222222222222', '333333333333333333333333']) {
      expect((await request(app).get(`/api/public/updates/${id}`).set('Authorization', 'Bearer valid')).status).toBe(200);
    }
    status.mockResolvedValue({ ...await OnboardingService.status({ type, id: 'own-id' }), mediaCount: 3, canViewProfiles: true });
    expect((await request(app).get(`${social}/users/other`).set('Authorization', 'Bearer valid')).status).toBe(200);
    expect((await request(app).get('/api/public/feed').set('Authorization', 'Bearer valid')).status).toBe(403);
  });
  it.each([
    { authorType: type, authorId: 'other-id' },
    { authorType: type === 'buyer' ? 'vendor' : 'buyer', authorId: 'own-id' },
    null,
  ])('keeps non-owner or missing update reads gated: %j', async (update) => {
    jest.mocked(Update.findById).mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(update) }) } as never);
    const res = await request(app).get('/api/public/updates/111111111111111111111111').set('Authorization', 'Bearer valid');
    expect(res.status).toBe(403); expect(res.body.error).toBe('FOLLOWING_REQUIRED');
  });
  it('keeps comments gated even on an owned update', async () => {
    const res = await request(app).get('/api/public/updates/111111111111111111111111/comments').set('Authorization', 'Bearer valid');
    expect(res.status).toBe(403); expect(res.body.error).toBe('FOLLOWING_REQUIRED');
    expect(Update.findById).not.toHaveBeenCalled();
  });
  it('surfaces owner lookup failures', async () => {
    jest.mocked(Update.findById).mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('database unavailable')) }) } as never);
    expect((await request(app).get('/api/public/updates/111111111111111111111111').set('Authorization', 'Bearer valid')).status).toBe(500);
  });
  it('keeps follow and upload writes available', async () => {
    for (const path of [`${social}/follow`, '/api/public/updates', '/api/tickets/updates', '/api/media/upload']) {
      expect((await request(app).post(path).set('Authorization', 'Bearer valid')).status).toBe(200);
    }
    expect(status).not.toHaveBeenCalled();
  });
  it('keeps own profile available', async () => {
    const path = type === 'buyer' ? `${social}/users/OWN-NAME` : '/api/public/organizers/own-id';
    expect((await request(app).get(path).set('Authorization', 'Bearer valid')).status).toBe(200);
  });
  it('does not disguise dependency failures as success', async () => {
    status.mockRejectedValue(new Error('database unavailable'));
    expect((await request(app).get('/api/public/feed').set('Authorization', 'Bearer valid')).status).toBe(500);
  });
  it('preserves anonymous public browsing', async () => {
    expect((await request(app).get('/api/public/feed')).status).toBe(200);
    expect(status).not.toHaveBeenCalled();
  });
});
