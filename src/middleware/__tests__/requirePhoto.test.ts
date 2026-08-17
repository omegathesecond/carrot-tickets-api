import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

const mockRes = () => {
  const res: any = { req: { originalUrl: '/test' } };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

/** The machine-readable code the client keys on to pop the PhotoGate. */
const photoRequiredBody = (res: any) => res.json.mock.calls[0]?.[0];

describe('requireProfilePhoto', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('passes an anonymous request through (no actor resolved here)', async () => {
    const req: any = {};
    const next = jest.fn();
    const res = mockRes();
    await requireProfilePhoto(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  describe('buyer actor', () => {
    it('lets a buyer WITH a photo continue', async () => {
      const buyer = await Buyer.create({
        email: 'has@example.com',
        password: 'secret6',
        emailVerifiedAt: new Date(),
        avatarUrl: 'https://cdn.carrottickets.com/a.jpg',
      });
      const req: any = { ticketsUser: { userType: 'buyer', buyerId: String(buyer._id) } };
      const next = jest.fn();
      const res = mockRes();
      await requireProfilePhoto(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('blocks a buyer WITHOUT a photo with 403 PHOTO_REQUIRED', async () => {
      const buyer = await Buyer.create({
        email: 'none@example.com',
        password: 'secret6',
        emailVerifiedAt: new Date(),
      });
      const req: any = { ticketsUser: { userType: 'buyer', buyerId: String(buyer._id) } };
      const next = jest.fn();
      const res = mockRes();
      await requireProfilePhoto(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(photoRequiredBody(res).error).toBe('PHOTO_REQUIRED');
    });

    it('passes through when the buyer row cannot be resolved (controller handles it)', async () => {
      const req: any = { ticketsUser: { userType: 'buyer', buyerId: '5f9f1b9b9b9b9b9b9b9b9b9b' } };
      const next = jest.fn();
      const res = mockRes();
      await requireProfilePhoto(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('brand (vendor) actor', () => {
    it('lets a brand owner WITH a logo continue', async () => {
      const vendor = await Vendor.create({
        businessName: 'Has Logo Co',
        password: 'secret6',
        logoUrl: 'https://cdn.carrottickets.com/logo.png',
      });
      const req: any = {
        ticketsUser: { userType: 'vendor', vendorId: String(vendor._id), permissions: [TicketsPermission.EDIT_BRAND] },
      };
      const next = jest.fn();
      const res = mockRes();
      await requireProfilePhoto(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('blocks a brand owner WITHOUT a logo with 403 PHOTO_REQUIRED', async () => {
      const vendor = await Vendor.create({ businessName: 'No Logo Co', password: 'secret6' });
      const req: any = {
        ticketsUser: { userType: 'vendor', vendorId: String(vendor._id), permissions: [TicketsPermission.EDIT_BRAND] },
      };
      const next = jest.fn();
      const res = mockRes();
      await requireProfilePhoto(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(photoRequiredBody(res).error).toBe('PHOTO_REQUIRED');
    });

    it('EXEMPTS a brand sub-user without EDIT_BRAND, even with no logo (they cannot upload one)', async () => {
      const vendor = await Vendor.create({ businessName: 'Staffer Co', password: 'secret6' });
      const req: any = {
        ticketsUser: { userType: 'sub-user', vendorId: String(vendor._id), permissions: [TicketsPermission.SCAN_TICKETS] },
      };
      const next = jest.fn();
      const res = mockRes();
      await requireProfilePhoto(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
