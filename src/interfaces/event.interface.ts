import { Document, Types } from 'mongoose';

export enum EventStatus {
  DRAFT = 'draft',
  // An organizer has submitted the event to go live, but a Keshless admin must
  // approve it first. Approval is per-EVENT, not per-organizer-account — a
  // pending event sells nothing until a superadmin publishes (approves) it.
  PENDING_APPROVAL = 'pending_approval',
  PUBLISHED = 'published',
  ONGOING = 'ongoing',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled'
}

export interface ITicketType {
  _id?: string; // Ticket type ID (MongoDB ObjectId as string)
  name: string; // e.g., "VIP", "Regular", "Early Bird"
  description?: string;
  price: number;
  quantity: number; // Total tickets of this type
  sold: number; // Number sold
  available: number; // quantity - sold
  isSoldOut?: boolean; // Manual sold-out flag
}

export interface IEvent extends Document {
  _id: Types.ObjectId;

  // Event Identification
  eventId: string; // EVT-{timestamp}-{random}
  vendorId: Types.ObjectId;

  // Event Details
  name: string;
  description?: string;
  venue: string;
  eventDate: Date; // For single-day: event date. For multi-day: start date
  startTime: Date; // For single-day: start time on eventDate. For multi-day: start datetime
  endTime: Date; // For single-day: end time on eventDate. For multi-day: end datetime
  isMultiDay?: boolean; // Whether this is a multi-day event (default: false)

  // Capacity & Tickets
  capacity: number; // Total event capacity
  ticketTypes: ITicketType[]; // Different ticket types

  // Status
  status: EventStatus;

  // Sales Info
  totalTicketsSold: number;
  totalRevenue: number;

  // Media & Images
  posterUrl?: string;
  thumbnailUrl?: string;
  galleryImages?: string[];
  qrCodeUrl?: string;

  // Publishing
  publishedAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Methods
  getTotalAvailable(): number;
  isSoldOut(): boolean;
}
