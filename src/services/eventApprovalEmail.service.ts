import { Vendor } from '@models/vendor.model';
import { IEvent } from '@interfaces/event.interface';
import { YeboLinkClient } from './yebolink.client';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]!));

export class EventApprovalEmailService {
  static async send(event: IEvent, approved: boolean): Promise<void> {
    const organizer = await Vendor.findById(event.vendorId);
    if (!organizer) throw new Error('Organizer not found');
    const recipients = approved
      ? [organizer.email].filter((email): email is string => !!email)
      : (await Vendor.find({ isSuperAdmin: true, isActive: true })).map(admin => admin.email)
        .filter((email): email is string => !!email);
    if (!recipients.length) throw new Error('No notification email recipients configured');
    const base = process.env['EVENT_APPROVAL_DASHBOARD_URL'] || 'https://manage.carrottickets.com';
    const link = new URL(`/events/${encodeURIComponent(String(event._id))}`, base).href;
    const subject = approved ? `Event approved: ${event.name}` : `Event awaiting approval: ${event.name}`;
    const html = `<p>${escape(event.name)} ${approved ? 'has been approved and is now live.' : 'has been submitted for approval.'}</p>` +
      (approved ? '' : `<p>Organiser: ${escape(organizer.businessName)}<br>Contact: ${escape(organizer.primaryContact || '')}<br>Email: ${escape(organizer.email || '')}<br>Phone: ${escape(organizer.phoneNumber || '')}</p>`) +
      `<p><a href="${escape(link)}">${approved ? 'Open event dashboard' : 'Review event'}</a></p>`;
    // Settle all recipients before reporting failure; never automatically resend
    // successful recipients when another recipient fails.
    const results = await Promise.allSettled([...new Set(recipients)].map(async to => {
      const result = await YeboLinkClient.sendEmail(to, subject, html);
      if (['failed', 'rejected', 'undelivered'].includes(result.status)) {
        throw new Error(`Email delivery ${result.status}`);
      }
    }));
    if (results.some(result => result.status === 'rejected')) throw new Error('Notification email delivery failed');
  }
}
