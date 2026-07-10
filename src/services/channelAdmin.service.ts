import { Community } from '@models/community.model';
import { Channel, ChannelPostPolicy, IChannel } from '@models/channel.model';
import { HttpError } from '@utils/httpError.util';

export interface ChannelAdminView {
  id: string;
  name: string;
  slug: string;
  gated: boolean;
  postPolicy: ChannelPostPolicy;
  archived: boolean;
  isDefault: boolean;
  createdAt: Date;
}

export interface ChannelAdminListView {
  communityId: string;
  channels: ChannelAdminView[];
}

export interface CreateChannelInput {
  name: string;
  gated?: boolean;
  postPolicy?: ChannelPostPolicy;
}

export interface UpdateChannelInput {
  name?: string;
  gated?: boolean;
  postPolicy?: ChannelPostPolicy;
  archived?: boolean;
}

/** Kebab-case slug, mirroring Vendor.generateSlug (no shared export exists for
 *  this — see task-1-report.md for the reuse note). Falls back to 'channel'
 *  so a symbols-only name never produces an empty slug. */
function slugifyChannelName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug || 'channel';
}

export class ChannelAdminService {
  /** GET /api/tickets/events/:eventId/channels — ALL channels incl. archived. */
  static async list(eventId: string): Promise<ChannelAdminListView> {
    const community = await Community.findOne({ eventId });
    if (!community) throw new HttpError(404, 'Community not found for this event');

    const channels = await Channel.find({ communityId: community._id }).sort({ createdAt: 1 });
    return {
      communityId: String(community._id),
      channels: channels.map(ChannelAdminService.toView),
    };
  }

  /** POST /api/tickets/events/:eventId/channels — 409 on duplicate slug. */
  static async create(eventId: string, input: CreateChannelInput): Promise<ChannelAdminView> {
    const community = await Community.findOne({ eventId });
    if (!community) throw new HttpError(404, 'Community not found for this event');

    try {
      const channel = await Channel.create({
        communityId: community._id,
        name: input.name,
        slug: slugifyChannelName(input.name),
        gated: input.gated ?? false,
        postPolicy: input.postPolicy ?? 'all',
        archived: false,
        isDefault: false,
      });
      return ChannelAdminService.toView(channel);
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, 'A channel with that name already exists');
      throw err;
    }
  }

  /**
   * PATCH /api/tickets/channels/:channelId — default channels (announcements/
   * general/attendees) can have gated/postPolicy toggled but never renamed or
   * archived, since buyers and the realtime gateway assume they always exist.
   */
  static async update(channelId: string, input: UpdateChannelInput): Promise<ChannelAdminView> {
    const channel = await Channel.findById(channelId);
    if (!channel) throw new HttpError(404, 'Channel not found');

    if (channel.isDefault && (input.name !== undefined || input.archived !== undefined)) {
      throw new HttpError(400, 'Default channels cannot be renamed or archived');
    }

    if (input.name !== undefined && input.name !== channel.name) {
      channel.name = input.name;
      channel.slug = slugifyChannelName(input.name);
    }
    if (input.gated !== undefined) channel.gated = input.gated;
    if (input.postPolicy !== undefined) channel.postPolicy = input.postPolicy;
    if (input.archived !== undefined) channel.archived = input.archived;

    try {
      await channel.save();
    } catch (err: any) {
      if (err?.code === 11000) throw new HttpError(409, 'A channel with that name already exists');
      throw err;
    }
    return ChannelAdminService.toView(channel);
  }

  private static toView(c: IChannel): ChannelAdminView {
    return {
      id: String(c._id),
      name: c.name,
      slug: c.slug,
      gated: c.gated,
      postPolicy: c.postPolicy,
      archived: c.archived,
      isDefault: c.isDefault,
      createdAt: c.createdAt,
    };
  }
}
