import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { EventStatus, IEvent, ITicketType } from '@interfaces/event.interface';
import { VerificationStatus } from '@interfaces/vendor.interface';
import mongoose from 'mongoose';

export interface CreateEventParams {
  vendorId: string;
  name: string;
  description?: string;
  venue: string;
  eventDate: Date;
  startTime: Date;
  endTime: Date;
  isMultiDay?: boolean;
  capacity?: number; // optional — derived from ticket-type quantities server-side
  ticketTypes?: Array<{
    name: string;
    description?: string;
    price: number;
    quantity: number;
  }>;
}

export interface UpdateEventParams {
  name?: string;
  description?: string;
  venue?: string;
  eventDate?: Date;
  startTime?: Date;
  endTime?: Date;
  isMultiDay?: boolean;
  capacity?: number;
  ticketTypes?: Array<{
    name: string;
    description?: string;
    price: number;
    quantity: number;
  }>;
}

export interface GetEventsQuery {
  vendorId: string;
  status?: EventStatus;
  startDate?: Date;
  endDate?: Date;
  search?: string;
  page?: number;
  limit?: number;
  isSuperAdmin?: boolean;
}

export class EventService {
  /**
   * Create a new event
   */
  static async createEvent(params: CreateEventParams): Promise<IEvent> {
    try {
      // Create event
      const event = new Event({
        vendorId: params.vendorId,
        name: params.name,
        description: params.description,
        venue: params.venue,
        eventDate: params.eventDate,
        startTime: params.startTime,
        endTime: params.endTime,
        isMultiDay: params.isMultiDay,
        capacity: params.capacity,
        ticketTypes: params.ticketTypes ? params.ticketTypes.map(tt => ({
          name: tt.name,
          description: tt.description,
          price: tt.price,
          quantity: tt.quantity,
          sold: 0,
          available: tt.quantity,
          isSoldOut: false
        })) : [],
        status: EventStatus.DRAFT,
        totalTicketsSold: 0,
        totalRevenue: 0
      });

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Event creation error:', error);
      throw new Error(error.message || 'Failed to create event');
    }
  }

  /**
   * Get events with filters and pagination
   */
  static async getEvents(query: GetEventsQuery) {
    try {
      const {
        vendorId,
        status,
        startDate,
        endDate,
        search,
        page = 1,
        limit = 20,
        isSuperAdmin = false
      } = query;

      // Build query - skip vendorId filter for superadmin
      const filter: any = {};
      if (!isSuperAdmin) {
        filter.vendorId = vendorId;
      }

      if (status) {
        filter.status = status;
      }

      if (startDate || endDate) {
        filter.eventDate = {};
        if (startDate) filter.eventDate.$gte = startDate;
        if (endDate) filter.eventDate.$lte = endDate;
      }

      if (search) {
        filter.$or = [
          { name: { $regex: search, $options: 'i' } },
          { venue: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ];
      }

      // Execute query with pagination
      const skip = (page - 1) * limit;
      const [events, total] = await Promise.all([
        Event.find(filter)
          .sort({ eventDate: -1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Event.countDocuments(filter)
      ]);

      return {
        data: events,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1
        }
      };
    } catch (error: any) {
      console.error('Get events error:', error);
      throw new Error(error.message || 'Failed to fetch events');
    }
  }

  /**
   * Get single event by ID
   */
  static async getEventById(eventId: string, vendorId: string, isSuperAdmin: boolean = false): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }

      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      return event;
    } catch (error: any) {
      console.error('Get event by ID error:', error);
      throw new Error(error.message || 'Failed to fetch event');
    }
  }

  /**
   * Get the creator (vendor) of an event plus a summary of all their events.
   *
   * Powers the admin "Creator" panel: who made this event, their contact and
   * verification status, and a roll-up of every event they own with ticket /
   * revenue totals. `requesterVendorId` / `isSuperAdmin` enforce access — a
   * normal organiser may only view their own creator card, superadmins any.
   */
  static async getEventCreatorSummary(
    eventId: string,
    requesterVendorId: string,
    isSuperAdmin: boolean = false
  ) {
    const event = await Event.findById(eventId).select('vendorId').lean();
    if (!event) {
      throw new Error('Event not found');
    }

    const creatorId = event.vendorId.toString();
    if (!isSuperAdmin && creatorId !== requesterVendorId) {
      throw new Error('You do not have access to this creator');
    }

    const vendor = await Vendor.findById(creatorId)
      .select('businessName email phoneNumber primaryContact businessType verificationStatus verifiedAt isActive createdAt')
      .lean();
    if (!vendor) {
      throw new Error('Creator not found');
    }

    const events = await Event.find({ vendorId: creatorId })
      .select('name status eventDate venue totalTicketsSold totalRevenue capacity posterUrl thumbnailUrl createdAt')
      .sort({ eventDate: -1, createdAt: -1 })
      .lean();

    const stats = events.reduce(
      (acc, e) => {
        acc.totalEvents += 1;
        acc.totalTicketsSold += e.totalTicketsSold || 0;
        acc.totalRevenue += e.totalRevenue || 0;
        return acc;
      },
      { totalEvents: 0, totalTicketsSold: 0, totalRevenue: 0 }
    );

    return { creator: vendor, stats, events };
  }

  /**
   * Update event
   */
  static async updateEvent(
    eventId: string,
    vendorId: string,
    updates: UpdateEventParams,
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      // Don't allow updates if event is cancelled
      if (event.status === EventStatus.CANCELLED) {
        throw new Error('Cannot update cancelled event');
      }

      // Don't allow updates if event is completed
      if (event.status === EventStatus.COMPLETED) {
        throw new Error('Cannot update completed event');
      }

      // Update fields
      if (updates.name) event.name = updates.name;
      if (updates.description !== undefined) event.description = updates.description;
      if (updates.venue) event.venue = updates.venue;
      if (updates.eventDate) event.eventDate = updates.eventDate;
      if (updates.startTime) event.startTime = updates.startTime;
      if (updates.endTime) event.endTime = updates.endTime;
      if (updates.capacity) event.capacity = updates.capacity;

      // Update ticket types if provided
      if (updates.ticketTypes) {
        // Preserve sold counts when updating ticket types
        const oldTicketTypes = event.ticketTypes;
        event.ticketTypes = updates.ticketTypes.map(tt => {
          const existing = oldTicketTypes.find(old => old.name === tt.name);
          const sold = existing ? existing.sold : 0;
          const isSoldOut = existing ? existing.isSoldOut : false;
          return {
            name: tt.name,
            description: tt.description,
            price: tt.price,
            quantity: tt.quantity,
            sold,
            available: tt.quantity - sold,
            isSoldOut
          };
        });
      }

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Update event error:', error);
      throw new Error(error.message || 'Failed to update event');
    }
  }

  /**
   * Delete event (soft delete - only allowed if no tickets sold)
   */
  static async deleteEvent(eventId: string, vendorId: string, isSuperAdmin: boolean = false): Promise<void> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      // Check if any tickets have been sold
      if (event.totalTicketsSold > 0) {
        throw new Error('Cannot delete event with sold tickets. Cancel the event instead.');
      }

      // Delete event
      await Event.deleteOne({ _id: eventId });
    } catch (error: any) {
      console.error('Delete event error:', error);
      throw new Error(error.message || 'Failed to delete event');
    }
  }

  /**
   * Publish event (make it active)
   */
  static async publishEvent(eventId: string, vendorId: string, isSuperAdmin: boolean = false): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      if (event.status !== EventStatus.DRAFT) {
        throw new Error(`Event is already ${event.status.toLowerCase()}`);
      }

      // Publishing gate: a self-registered organizer can build draft events
      // freely, but the event only goes live (and sellable) once an admin has
      // verified the account. Super admins bypass this. (Drafts are unaffected
      // — this only blocks the DRAFT → PUBLISHED transition.)
      if (!isSuperAdmin) {
        const vendor = await Vendor.findById(event.vendorId).select('verificationStatus isActive');
        if (!vendor) {
          throw new Error('Organizer account not found');
        }
        if (!vendor.isActive) {
          throw new Error('Your organizer account is inactive. Please contact support.');
        }
        if (vendor.verificationStatus !== VerificationStatus.VERIFIED) {
          throw new Error('Your organizer account is pending approval. You can publish events once it is verified.');
        }
      }

      event.status = EventStatus.PUBLISHED;
      event.publishedAt = new Date();

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Publish event error:', error);
      throw new Error(error.message || 'Failed to publish event');
    }
  }

  /**
   * Unpublish event (revert to draft)
   */
  static async unpublishEvent(eventId: string, vendorId: string, isSuperAdmin: boolean = false): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      if (event.status !== EventStatus.PUBLISHED) {
        throw new Error('Event is not published');
      }

      // Check if any tickets have been sold
      if (event.totalTicketsSold > 0) {
        throw new Error('Cannot unpublish event with sold tickets');
      }

      event.status = EventStatus.DRAFT;
      event.publishedAt = undefined;

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Unpublish event error:', error);
      throw new Error(error.message || 'Failed to unpublish event');
    }
  }

  /**
   * Cancel event
   */
  static async cancelEvent(
    eventId: string,
    vendorId: string,
    reason?: string
  ): Promise<IEvent> {
    try {
      const event = await Event.findOne({ _id: eventId, vendorId });

      if (!event) {
        throw new Error('Event not found');
      }

      if (event.status === EventStatus.CANCELLED) {
        throw new Error('Event is already cancelled');
      }

      if (event.status === EventStatus.COMPLETED) {
        throw new Error('Cannot cancel completed event');
      }

      event.status = EventStatus.CANCELLED;
      event.cancelledAt = new Date();
      if (reason) event.cancellationReason = reason;

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Cancel event error:', error);
      throw new Error(error.message || 'Failed to cancel event');
    }
  }

  /**
   * Mark event as completed (after event date has passed)
   */
  static async completeEvent(eventId: string, vendorId: string): Promise<IEvent> {
    try {
      const event = await Event.findOne({ _id: eventId, vendorId });

      if (!event) {
        throw new Error('Event not found');
      }

      if (event.status === EventStatus.COMPLETED) {
        throw new Error('Event is already completed');
      }

      if (event.status === EventStatus.CANCELLED) {
        throw new Error('Cannot complete cancelled event');
      }

      event.status = EventStatus.COMPLETED;

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Complete event error:', error);
      throw new Error(error.message || 'Failed to complete event');
    }
  }

  /**
   * Update ticket sold count for event
   */
  static async updateTicketsSold(
    eventId: string,
    ticketTypeId: string,
    quantity: number,
    revenue: number
  ): Promise<void> {
    try {
      const event = await Event.findById(eventId);

      if (!event) {
        throw new Error('Event not found');
      }

      // Update ticket type sold count
      const ticketTypeObj = event.ticketTypes.find(tt => tt._id?.toString() === ticketTypeId);
      if (ticketTypeObj) {
        ticketTypeObj.sold += quantity;
        ticketTypeObj.available = ticketTypeObj.quantity - ticketTypeObj.sold;
      }

      // Update event totals
      event.totalTicketsSold += quantity;
      event.totalRevenue += revenue;

      await event.save();
    } catch (error: any) {
      console.error('Update tickets sold error:', error);
      throw new Error(error.message || 'Failed to update tickets sold');
    }
  }

  /**
   * Check if tickets are available for purchase
   */
  static async checkTicketAvailability(
    eventId: string,
    ticketTypeId: string,
    quantity: number
  ): Promise<{ available: boolean; message?: string; ticketTypeData?: ITicketType }> {
    try {
      const event = await Event.findById(eventId);

      if (!event) {
        return { available: false, message: 'Event not found' };
      }

      if (event.status !== EventStatus.PUBLISHED) {
        return { available: false, message: `Event is ${event.status.toLowerCase()}` };
      }

      const ticketTypeObj = event.ticketTypes.find(tt => tt._id?.toString() === ticketTypeId);
      if (!ticketTypeObj) {
        return { available: false, message: 'Ticket type not found' };
      }

      if (ticketTypeObj.available < quantity) {
        return {
          available: false,
          message: `Only ${ticketTypeObj.available} tickets available`,
          ticketTypeData: ticketTypeObj
        };
      }

      return {
        available: true,
        ticketTypeData: ticketTypeObj
      };
    } catch (error: any) {
      console.error('Check ticket availability error:', error);
      return { available: false, message: error.message || 'Error checking availability' };
    }
  }

  /**
   * Add a new ticket type to an event
   */
  static async addTicketType(
    eventId: string,
    vendorId: string,
    ticketType: {
      name: string;
      description?: string;
      price: number;
      quantity: number;
    },
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      // Check if ticket type with same name already exists
      const existing = event.ticketTypes.find(tt => tt.name.toLowerCase() === ticketType.name.toLowerCase());
      if (existing) {
        throw new Error(`Ticket type "${ticketType.name}" already exists`);
      }

      // Add new ticket type
      event.ticketTypes.push({
        name: ticketType.name,
        description: ticketType.description,
        price: ticketType.price,
        quantity: ticketType.quantity,
        sold: 0,
        available: ticketType.quantity,
        isSoldOut: false
      });

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Add ticket type error:', error);
      throw new Error(error.message || 'Failed to add ticket type');
    }
  }

  /**
   * Update an existing ticket type
   */
  static async updateTicketType(
    eventId: string,
    vendorId: string,
    ticketTypeName: string,
    updates: {
      name?: string;
      description?: string;
      price?: number;
      quantity?: number;
    },
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      const ticketType = event.ticketTypes.find(tt => tt.name === ticketTypeName);
      if (!ticketType) {
        throw new Error('Ticket type not found');
      }

      // Check if any tickets have been sold
      if (ticketType.sold > 0) {
        // Only allow updating description and increasing quantity
        if (updates.name || updates.price !== undefined) {
          throw new Error('Cannot change name or price of ticket type with sold tickets');
        }
        if (updates.quantity !== undefined && updates.quantity < ticketType.sold) {
          throw new Error(`Cannot reduce quantity below sold count (${ticketType.sold})`);
        }
      }

      // Update fields
      if (updates.name) ticketType.name = updates.name;
      if (updates.description !== undefined) ticketType.description = updates.description;
      if (updates.price !== undefined) ticketType.price = updates.price;
      if (updates.quantity !== undefined) {
        ticketType.quantity = updates.quantity;
        ticketType.available = updates.quantity - ticketType.sold;
      }

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Update ticket type error:', error);
      throw new Error(error.message || 'Failed to update ticket type');
    }
  }

  /**
   * Delete a ticket type (only if no tickets sold)
   */
  static async deleteTicketType(
    eventId: string,
    vendorId: string,
    ticketTypeName: string,
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      const ticketType = event.ticketTypes.find(tt => tt.name === ticketTypeName);
      if (!ticketType) {
        throw new Error('Ticket type not found');
      }

      // Check if any tickets have been sold
      if (ticketType.sold > 0) {
        throw new Error('Cannot delete ticket type with sold tickets');
      }

      // Remove ticket type
      event.ticketTypes = event.ticketTypes.filter(tt => tt.name !== ticketTypeName);

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Delete ticket type error:', error);
      throw new Error(error.message || 'Failed to delete ticket type');
    }
  }

  /**
   * Adjust ticket quantity (increase or decrease)
   */
  static async adjustTicketQuantity(
    eventId: string,
    vendorId: string,
    ticketTypeName: string,
    adjustment: number,
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      const ticketType = event.ticketTypes.find(tt => tt.name === ticketTypeName);
      if (!ticketType) {
        throw new Error('Ticket type not found');
      }

      const newQuantity = ticketType.quantity + adjustment;

      // Validate new quantity
      if (newQuantity < ticketType.sold) {
        throw new Error(`Cannot reduce quantity below sold count (${ticketType.sold})`);
      }

      if (newQuantity < 0) {
        throw new Error('Quantity cannot be negative');
      }

      // Update quantity
      ticketType.quantity = newQuantity;
      ticketType.available = newQuantity - ticketType.sold;

      // Recalculate event capacity from all ticket types
      event.capacity = event.ticketTypes.reduce((sum, tt) => sum + tt.quantity, 0);

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Adjust ticket quantity error:', error);
      throw new Error(error.message || 'Failed to adjust ticket quantity');
    }
  }

  /**
   * Mark ticket type as sold out (manual override)
   */
  static async markTicketSoldOut(
    eventId: string,
    vendorId: string,
    ticketTypeName: string,
    isSoldOut: boolean,
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      const ticketType = event.ticketTypes.find(tt => tt.name === ticketTypeName);
      if (!ticketType) {
        throw new Error('Ticket type not found');
      }

      ticketType.isSoldOut = isSoldOut;

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Mark ticket sold out error:', error);
      throw new Error(error.message || 'Failed to update sold out status');
    }
  }
}
