import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { ReportService } from '@services/report.service';
import { CommunityService } from '@services/community.service';
import { Channel } from '@models/channel.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Membership } from '@models/membership.model';
import { Message } from '@models/message.model';
import { Report } from '@models/report.model';
import { resetBuckets } from '@utils/rateLimit.util';

describe('ReportService', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Report.init(); // partial unique dedupe indexes must exist before the duplicate-report tests race them
  });
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedCommunityWithChannel() {
    const seeded = await seedPublishedEvent(); // real Event doc — toAdminView's eventName enrichment needs one
    const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
    const general = (await Channel.findOne({ communityId: community._id, slug: 'general' }))!;
    return { eventId: seeded.eventId, vendorId: seeded.vendorId, community, general };
  }

  async function seedBuyer(phone: string, name = 'Buyer'): Promise<IBuyer> {
    return Buyer.create({ phone, password: 'secret1', name });
  }

  async function seedChannelMessage(general: any, community: any, sender: IBuyer, body = 'spam') {
    const message = await Message.create({
      channelId: general._id,
      communityId: community._id,
      senderId: sender._id,
      body,
    });
    return message;
  }

  describe('fileReport', () => {
    it('files a message report and returns created:true', async () => {
      const { general, community } = await seedCommunityWithChannel();
      const sender = await seedBuyer('+26878200001', 'Sender');
      const reporter = await seedBuyer('+26878200002', 'Reporter');
      const message = await seedChannelMessage(general, community, sender);

      const { report, created } = await ReportService.fileReport(reporter, {
        targetType: 'message',
        messageId: String(message._id),
        reason: 'spam link',
      });
      expect(created).toBe(true);
      expect(report.status).toBe('open');
      expect(String(report.messageId)).toBe(String(message._id));
    });

    it('files a buyer report and returns created:true', async () => {
      const reporter = await seedBuyer('+26878200003', 'Reporter');
      const target = await seedBuyer('+26878200004', 'Target');

      const { report, created } = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'harassment',
      });
      expect(created).toBe(true);
      expect(String(report.targetBuyerId)).toBe(String(target._id));
    });

    it('a second open report on the same message from the same reporter dedupes to the existing row (created:false)', async () => {
      const { general, community } = await seedCommunityWithChannel();
      const sender = await seedBuyer('+26878200005', 'Sender');
      const reporter = await seedBuyer('+26878200006', 'Reporter');
      const message = await seedChannelMessage(general, community, sender);

      const first = await ReportService.fileReport(reporter, {
        targetType: 'message',
        messageId: String(message._id),
        reason: 'spam',
      });
      const second = await ReportService.fileReport(reporter, {
        targetType: 'message',
        messageId: String(message._id),
        reason: 'still spam',
      });
      expect(second.created).toBe(false);
      expect(String(second.report._id)).toBe(String(first.report._id));

      const count = await Report.countDocuments({ reporterId: reporter._id, messageId: message._id });
      expect(count).toBe(1);
    });

    it('a second open report on the same buyer from the same reporter dedupes (created:false)', async () => {
      const reporter = await seedBuyer('+26878200007', 'Reporter');
      const target = await seedBuyer('+26878200008', 'Target');

      const first = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'first',
      });
      const second = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'second',
      });
      expect(second.created).toBe(false);
      expect(String(second.report._id)).toBe(String(first.report._id));
    });

    it('a report on a buyer-target and a message-target from the same reporter never collide (both created:true)', async () => {
      const { general, community } = await seedCommunityWithChannel();
      const sender = await seedBuyer('+26878200009', 'Sender');
      const reporter = await seedBuyer('+26878200010', 'Reporter');
      const message = await seedChannelMessage(general, community, sender);
      const otherTarget = await seedBuyer('+26878200011', 'OtherTarget');

      const messageReport = await ReportService.fileReport(reporter, {
        targetType: 'message',
        messageId: String(message._id),
        reason: 'spam',
      });
      const buyerReport = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(otherTarget._id),
        reason: 'harassment',
      });
      expect(messageReport.created).toBe(true);
      expect(buyerReport.created).toBe(true);
    });

    it('after the first report resolves, the reporter may file again on the same target', async () => {
      const reporter = await seedBuyer('+26878200012', 'Reporter');
      const target = await seedBuyer('+26878200013', 'Target');

      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'first',
      });
      await ReportService.resolve(String(report._id), { vendorId: 'admin-1' }, { action: 'dismiss' });

      const refiled = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'second incident',
      });
      expect(refiled.created).toBe(true);
      expect(String(refiled.report._id)).not.toBe(String(report._id));
    });

    it('rejects reporting yourself (400)', async () => {
      const reporter = await seedBuyer('+26878200014', 'Reporter');
      await expect(
        ReportService.fileReport(reporter, {
          targetType: 'buyer',
          targetBuyerId: String(reporter._id),
          reason: 'x',
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('404s an unknown message and an unknown target buyer', async () => {
      const reporter = await seedBuyer('+26878200015', 'Reporter');
      const fakeId = new mongoose.Types.ObjectId().toString();
      await expect(
        ReportService.fileReport(reporter, { targetType: 'message', messageId: fakeId, reason: 'x' })
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        ReportService.fileReport(reporter, { targetType: 'buyer', targetBuyerId: fakeId, reason: 'x' })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('404s a DM message (organizers/admins never touch DMs — mirrors moderation)', async () => {
      const reporter = await seedBuyer('+26878200016', 'Reporter');
      const sender = await seedBuyer('+26878200017', 'Sender');
      const thread = await mongoose.model('DmThread').create({
        participants: [sender._id, reporter._id],
        isGroup: false,
        createdBy: sender._id,
        pairKey: `${String(sender._id)}:${String(reporter._id)}`,
      });
      const dm = await Message.create({ dmThreadId: thread._id, senderId: sender._id, body: 'private' });

      await expect(
        ReportService.fileReport(reporter, { targetType: 'message', messageId: String(dm._id), reason: 'x' })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('rate-limits at a burst of 3/min', async () => {
      const { general, community } = await seedCommunityWithChannel();
      const sender = await seedBuyer('+26878200018', 'Sender');
      const reporter = await seedBuyer('+26878200019', 'Reporter');
      const messages = await Promise.all(
        Array.from({ length: 4 }, (_, i) => seedChannelMessage(general, community, sender, `msg ${i}`))
      );

      for (const m of messages.slice(0, 3)) {
        await ReportService.fileReport(reporter, {
          targetType: 'message',
          messageId: String(m._id),
          reason: 'spam',
        });
      }
      await expect(
        ReportService.fileReport(reporter, {
          targetType: 'message',
          messageId: String(messages[3]!._id),
          reason: 'spam',
        })
      ).rejects.toMatchObject({ statusCode: 429 });
    });
  });

  describe('listQueue', () => {
    it('defaults to status open and cursor-paginates newest first', async () => {
      const reporter = await seedBuyer('+26878200020', 'Reporter');
      const targets = await Promise.all(
        Array.from({ length: 3 }, (_, i) => seedBuyer(`+2687820002${i + 1}`, `Target${i}`))
      );
      for (const t of targets) {
        await ReportService.fileReport(reporter, { targetType: 'buyer', targetBuyerId: String(t._id), reason: 'x' });
      }

      const page1 = await ReportService.listQueue({ limit: 2 });
      expect(page1).toHaveLength(2);
      expect(page1.every((r) => r.status === 'open')).toBe(true);

      const page2 = await ReportService.listQueue({ limit: 2, before: page1[1]!.id });
      expect(page2).toHaveLength(1);
    });

    it('filters by status', async () => {
      const reporter = await seedBuyer('+26878200030', 'Reporter');
      const target = await seedBuyer('+26878200031', 'Target');
      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'x',
      });
      await ReportService.resolve(String(report._id), { vendorId: 'admin-1' }, { action: 'dismiss' });

      expect(await ReportService.listQueue({ status: 'open' })).toHaveLength(0);
      const dismissed = await ReportService.listQueue({ status: 'dismissed' });
      expect(dismissed).toHaveLength(1);
      expect(dismissed[0]!.status).toBe('dismissed');
    });
  });

  describe('resolve', () => {
    it('404s an unknown report', async () => {
      await expect(
        ReportService.resolve(new mongoose.Types.ObjectId().toString(), { vendorId: 'admin-1' }, { action: 'dismiss' })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('409s an already-resolved report', async () => {
      const reporter = await seedBuyer('+26878200040', 'Reporter');
      const target = await seedBuyer('+26878200041', 'Target');
      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'x',
      });
      await ReportService.resolve(String(report._id), { vendorId: 'admin-1' }, { action: 'dismiss' });
      await expect(
        ReportService.resolve(String(report._id), { vendorId: 'admin-1' }, { action: 'dismiss' })
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('dismiss sets status dismissed + resolvedBy/resolvedAt/resolutionNote', async () => {
      const reporter = await seedBuyer('+26878200050', 'Reporter');
      const target = await seedBuyer('+26878200051', 'Target');
      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'x',
      });

      const view = await ReportService.resolve(
        String(report._id),
        { userId: 'sub-user-9', vendorId: 'admin-vendor-id' },
        { action: 'dismiss', note: 'not credible' }
      );
      expect(view.status).toBe('dismissed');
      expect(view.resolvedBy).toBe('sub-user-9'); // prefers userId over vendorId when present
      expect(view.resolvedAt).toBeInstanceOf(Date);
      expect(view.resolutionNote).toBe('not credible');
    });

    it('falls back to vendorId for resolvedBy when the actor carries no userId (super-admin token shape)', async () => {
      const reporter = await seedBuyer('+26878200052', 'Reporter');
      const target = await seedBuyer('+26878200053', 'Target');
      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'x',
      });
      const view = await ReportService.resolve(String(report._id), { vendorId: 'admin-vendor-id' }, { action: 'dismiss' });
      expect(view.resolvedBy).toBe('admin-vendor-id');
    });

    it('delete_message soft-deletes the message via the shared moderation path, cross-vendor (no ownership walk)', async () => {
      const { general, community } = await seedCommunityWithChannel();
      const sender = await seedBuyer('+26878200060', 'Sender');
      const reporter = await seedBuyer('+26878200061', 'Reporter');
      const message = await seedChannelMessage(general, community, sender);
      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'message',
        messageId: String(message._id),
        reason: 'spam',
      });

      const view = await ReportService.resolve(
        String(report._id),
        { vendorId: 'some-unrelated-admin-vendor-id' }, // NOT the message's community's vendor — proves no ownership walk applies
        { action: 'delete_message' }
      );
      expect(view.status).toBe('resolved');
      expect(view.message!.deleted).toBe(true);

      const reloaded = await Message.findById(message._id);
      expect(reloaded!.deletedAt).toBeInstanceOf(Date);
    });

    it('delete_message is a no-op (not an error) when the message is already deleted', async () => {
      const { general, community } = await seedCommunityWithChannel();
      const sender = await seedBuyer('+26878200062', 'Sender');
      const reporter = await seedBuyer('+26878200063', 'Reporter');
      const message = await seedChannelMessage(general, community, sender);
      message.deletedAt = new Date();
      await message.save();
      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'message',
        messageId: String(message._id),
        reason: 'spam',
      });

      const view = await ReportService.resolve(String(report._id), { vendorId: 'admin-1' }, { action: 'delete_message' });
      expect(view.status).toBe('resolved');
    });

    it('delete_message on a buyer-target report is rejected (400)', async () => {
      const reporter = await seedBuyer('+26878200064', 'Reporter');
      const target = await seedBuyer('+26878200065', 'Target');
      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'x',
      });
      await expect(
        ReportService.resolve(String(report._id), { vendorId: 'admin-1' }, { action: 'delete_message' })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('suspend_buyer on a buyer-target report suspends the target', async () => {
      const reporter = await seedBuyer('+26878200070', 'Reporter');
      const target = await seedBuyer('+26878200071', 'Target');
      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'x',
      });

      await ReportService.resolve(String(report._id), { vendorId: 'admin-1' }, { action: 'suspend_buyer' });
      const reloaded = await Buyer.findById(target._id);
      expect(reloaded!.socialSuspendedAt).toBeInstanceOf(Date);
    });

    it('suspend_buyer on a message-target report suspends the message sender', async () => {
      const { general, community } = await seedCommunityWithChannel();
      const sender = await seedBuyer('+26878200072', 'Sender');
      const reporter = await seedBuyer('+26878200073', 'Reporter');
      const message = await seedChannelMessage(general, community, sender);
      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'message',
        messageId: String(message._id),
        reason: 'spam',
      });

      await ReportService.resolve(String(report._id), { vendorId: 'admin-1' }, { action: 'suspend_buyer' });
      const reloaded = await Buyer.findById(sender._id);
      expect(reloaded!.socialSuspendedAt).toBeInstanceOf(Date);
    });

    it('suspend_buyer on an organizer-authored message report 400s (no buyer to suspend)', async () => {
      const { general, community, vendorId } = await seedCommunityWithChannel();
      const reporter = await seedBuyer('+26878200074', 'Reporter');
      const orgMessage = await Message.create({
        channelId: general._id,
        communityId: community._id,
        senderVendorId: vendorId,
        body: 'announcement',
      });
      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'message',
        messageId: String(orgMessage._id),
        reason: 'x',
      });
      await expect(
        ReportService.resolve(String(report._id), { vendorId: 'admin-1' }, { action: 'suspend_buyer' })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('unsuspend_buyer clears socialSuspendedAt', async () => {
      const reporter = await seedBuyer('+26878200075', 'Reporter');
      const target = await Buyer.create({
        phone: '+26878200076',
        password: 'secret1',
        name: 'Target',
        socialSuspendedAt: new Date(),
      });
      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'appeal accepted',
      });

      await ReportService.resolve(String(report._id), { vendorId: 'admin-1' }, { action: 'unsuspend_buyer' });
      const reloaded = await Buyer.findById(target._id);
      expect(reloaded!.socialSuspendedAt).toBeNull();
    });
  });

  describe('admin view enrichment (toAdminView, via listQueue/resolve)', () => {
    it('message target: reporter summary + UNMASKED body/sender even when the message is deleted + channel/community/event names', async () => {
      const { general, community, eventId } = await seedCommunityWithChannel();
      const sender = await seedBuyer('+26878200080', 'Sender');
      const reporter = await seedBuyer('+26878200081', 'Reporter');
      const message = await seedChannelMessage(general, community, sender, 'the actual spam text');
      message.deletedAt = new Date(); // pre-deleted before the report is even filed/reviewed
      await message.save();

      const { report } = await ReportService.fileReport(reporter, {
        targetType: 'message',
        messageId: String(message._id),
        reason: 'spam',
      });
      const [view] = await ReportService.listQueue({});
      expect(String(view!.id)).toBe(String(report._id));
      expect(view!.reporter.id).toBe(String(reporter._id));
      expect(view!.reporter.name).toBe(reporter.name);
      expect(view!.targetBuyer).toBeNull();
      expect(view!.message).not.toBeNull();
      expect(view!.message!.body).toBe('the actual spam text'); // unmasked despite deletedAt
      expect(view!.message!.deleted).toBe(true);
      expect(view!.message!.senderId).toBe(String(sender._id));
      expect(view!.message!.channelName).toBe('general');
      expect(view!.message!.communityId).toBe(String(community._id));
      expect(view!.message!.eventId).toBe(String(eventId));
      expect(view!.message!.eventName).toBeTruthy();
    });

    it('buyer target: reporter summary + target BuyerSummary, no message context', async () => {
      const reporter = await seedBuyer('+26878200082', 'Reporter');
      const target = await seedBuyer('+26878200083', 'Target');
      await ReportService.fileReport(reporter, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'harassment',
      });

      const [view] = await ReportService.listQueue({});
      expect(view!.message).toBeNull();
      expect(view!.targetBuyer).not.toBeNull();
      expect(view!.targetBuyer!.id).toBe(String(target._id));
    });
  });
});
