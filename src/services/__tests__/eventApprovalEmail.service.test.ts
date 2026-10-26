import { EventApprovalEmailService } from '../eventApprovalEmail.service';
import { Vendor } from '@models/vendor.model';
import { YeboLinkClient } from '../yebolink.client';
jest.mock('@models/vendor.model', () => ({ Vendor: { findById: jest.fn(), find: jest.fn() } }));
jest.mock('../yebolink.client', () => ({ YeboLinkClient: { sendEmail: jest.fn() } }));
const event = { _id: '123', vendorId: 'owner', name: '<Launch>' } as any;
beforeEach(() => {
  jest.resetAllMocks();
  (Vendor.findById as jest.Mock).mockResolvedValue({ businessName: 'A & B', primaryContact: 'Owner', email: 'owner@example.com', phoneNumber: '+268123' });
  (Vendor.find as jest.Mock).mockResolvedValue([{ email: 'admin@example.com' }, { email: 'admin@example.com' }]);
  (YeboLinkClient.sendEmail as jest.Mock).mockResolvedValue({ status: 'queued' });
});
it('emails each admin once with escaped event, organizer contacts and review link', async () => {
  await EventApprovalEmailService.send(event, false);
  expect(YeboLinkClient.sendEmail).toHaveBeenCalledTimes(1);
  expect(YeboLinkClient.sendEmail).toHaveBeenCalledWith('admin@example.com', expect.any(String), expect.stringContaining('A &amp; B'));
  const html = (YeboLinkClient.sendEmail as jest.Mock).mock.calls[0][2];
  expect(html).toContain('&lt;Launch&gt;');
  expect(html).toContain('https://manage.carrottickets.com/events/123');
  expect(html).toContain('+268123');
});
it('sends approval to the organizer only', async () => {
  await EventApprovalEmailService.send(event, true);
  expect(Vendor.find).not.toHaveBeenCalled();
  expect(YeboLinkClient.sendEmail).toHaveBeenCalledWith('owner@example.com', expect.any(String), expect.stringContaining('approved and is now live'));
});
it('surfaces missing recipients', async () => {
  (Vendor.find as jest.Mock).mockResolvedValue([]);
  await expect(EventApprovalEmailService.send(event, false)).rejects.toThrow('recipients');
});
it.each(['failed', 'rejected', 'undelivered'])('surfaces provider status %s', async status => {
  (YeboLinkClient.sendEmail as jest.Mock).mockResolvedValue({ status });
  await expect(EventApprovalEmailService.send(event, true)).rejects.toThrow('delivery failed');
});
it('surfaces transport errors', async () => {
  (YeboLinkClient.sendEmail as jest.Mock).mockRejectedValue(new Error('offline'));
  await expect(EventApprovalEmailService.send(event, true)).rejects.toThrow('delivery failed');
});
