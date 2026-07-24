import { Document, Types } from 'mongoose';
import type { EventCategory } from '@/constants/eventCategories';

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

export type EventTicketing = 'carrot' | 'external';

export interface ITicketType {
  _id?: string; // Ticket type ID (MongoDB ObjectId as string)
  name: string; // e.g., "VIP", "Regular", "Early Bird"
  description?: string;
  price: number;
  quantity: number; // Total tickets of this type
  sold: number; // Number sold
  reserved: number;  // tickets held by in-flight (PENDING) async payments
  available: number; // quantity - sold - reserved
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

  // Organizer-set category — powers Home/Discover category chips + poster
  // badge. Never inferred; defaults to 'Other' when unset.
  category: EventCategory;

  // Ticketing mode — 'carrot' sells tickets on-platform (default); 'external'
  // links out to the organizer's own ticket seller (see externalTicketUrl).
  ticketing: EventTicketing;
  externalTicketUrl?: string;

  // Sales Info
  totalTicketsSold: number;
  totalRevenue: number;

  // Discover-feed engagement counters
  likeCount: number;
  shareCount: number;

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
