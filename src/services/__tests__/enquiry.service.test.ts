import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';
import { Enquiry } from '@models/enquiry.model';
import { Notification } from '@models/notification.model';
import { EnquiryService } from '@services/enquiry.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function mkServicesBiz(over: any = {}) {
  return Vendor.create({
    businessName: over.businessName ?? 'Luxe Decor',
    phoneNumber: over.phoneNumber ?? '+2687650' + Math.floor(Math.random() * 100000),
    password: 'secret1',
    operatorType: OperatorType.SERVICES,
    serviceCategory: over.serviceCategory ?? 'furniture_decor',
    verificationStatus: over.verificationStatus ?? VerificationStatus.VERIFIED,
  });
}

async function mkBuyer(over: any = {}) {
  return Buyer.create({
    phone: over.phone ?? '+26878' + Math.floor(Math.random() * 1000000),
    password: 'secret1',
    name: over.name ?? 'Test Buyer',
  }) as Promise<IBuyer>;
}

describe('EnquiryService.create', () => {
  it('creates an Enquiry with status new and notifies the vendor', async () => {
    const biz = await mkServicesBiz();
    const buyer = await mkBuyer();

    const enquiry = await EnquiryService.create(String(biz._id), buyer, { message: 'Do you do weddings?' });

    expect(enquiry.status).toBe('new');
    expect(String(enquiry.businessId)).toBe(String(biz._id));
    expect(String(enquiry.customerId)).toBe(String(buyer._id));

    const stored = await Enquiry.findById(enquiry._id);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('new');

    const notification = await Notification.findOne({ recipientType: 'vendor', recipientId: biz._id, type: 'enquiry_received' });
    expect(notification).not.toBeNull();
    expect(String(notification!.recipientId)).toBe(String(biz._id));
    expect((notification!.data as any).buyerId).toBe(String(buyer._id));
    expect((notification!.data as any).enquiryId).toBe(String(enquiry._id));
  });

  it('rejects an events vendor (not a services business) with 404', async () => {
    const eventsVendor = await Vendor.create({
      businessName: 'Event Org',
      phoneNumber: '+26876999001',
      password: 'secret1',
      operatorType: OperatorType.EVENTS,
      verificationStatus: VerificationStatus.VERIFIED,
    });
    const buyer = await mkBuyer();
    await expect(EnquiryService.create(String(eventsVendor._id), buyer, { message: 'Hi' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects an unverified services vendor with 404', async () => {
    const biz = await mkServicesBiz({ verificationStatus: VerificationStatus.PENDING });
    const buyer = await mkBuyer();
    await expect(EnquiryService.create(String(biz._id), buyer, { message: 'Hi' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('EnquiryService.hasEnquired', () => {
  it('is true only for the buyer/business pair that enquired', async () => {
    const biz = await mkServicesBiz();
    const buyer = await mkBuyer();
    const otherBuyer = await mkBuyer();

    await EnquiryService.create(String(biz._id), buyer, { message: 'Interested!' });

    expect(await EnquiryService.hasEnquired(String(buyer._id), String(biz._id))).toBe(true);
    expect(await EnquiryService.hasEnquired(String(otherBuyer._id), String(biz._id))).toBe(false);
  });
});
