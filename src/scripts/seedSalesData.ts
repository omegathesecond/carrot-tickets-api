import mongoose from 'mongoose';
import { Event } from '../models/event.model';
import { TicketSale } from '../models/ticketSale.model';
import { Ticket } from '../models/ticket.model';
import { Vendor } from '../models/vendor.model';
import { EventStatus } from '../interfaces/event.interface';
import { PaymentMethod, PaymentStatus, TicketStatus } from '../interfaces/ticket.interface';
import { getDatabaseURI } from '../config/database.config';

// Helper to generate random date within a range
const randomDate = (start: Date, end: Date): Date => {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
};

// Helper to get random element from array
const randomElement = <T>(arr: T[]): T => {
  return arr[Math.floor(Math.random() * arr.length)] as T;
};

// Helper to get random integer between min and max
const randomInt = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;

const seedSalesData = async () => {
  try {
    console.log('🌱 Starting seed script...');

    // Connect to MongoDB
    const dbUri = getDatabaseURI();
    await mongoose.connect(dbUri);
    console.log(`✅ Connected to MongoDB: ${dbUri}`);

    // Get the first vendor (or you can specify a specific vendorId)
    const vendor = await Vendor.findOne();
    if (!vendor) {
      console.error('❌ No vendor found. Please create a vendor first.');
      process.exit(1);
    }
    console.log(`📍 Using vendor: ${vendor.businessName} (${vendor._id})`);

    // Define past events to create
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const eventsData = [
      {
        name: 'Summer Music Festival 2025',
        description: 'The biggest music festival of the year featuring top artists',
        venue: 'Central Park Arena',
        eventDate: new Date(ninetyDaysAgo.getTime() + 5 * 24 * 60 * 60 * 1000),
        capacity: 500,
        ticketTypes: [
          { name: 'VIP', description: 'VIP access with backstage passes', price: 15000, quantity: 50 },
          { name: 'General Admission', description: 'Standard entry', price: 5000, quantity: 300 },
          { name: 'Early Bird', description: 'Discounted early tickets', price: 3500, quantity: 150 },
        ],
      },
      {
        name: 'Tech Conference 2025',
        description: 'Annual technology and innovation conference',
        venue: 'International Convention Center',
        eventDate: new Date(sixtyDaysAgo.getTime() + 10 * 24 * 60 * 60 * 1000),
        capacity: 300,
        ticketTypes: [
          { name: 'Premium', description: 'All-access premium pass', price: 25000, quantity: 30 },
          { name: 'Standard', description: 'Standard conference pass', price: 12000, quantity: 200 },
          { name: 'Student', description: 'Discounted student tickets', price: 5000, quantity: 70 },
        ],
      },
      {
        name: 'Food & Wine Expo',
        description: 'Culinary experience with local chefs and wineries',
        venue: 'Riverside Gardens',
        eventDate: new Date(thirtyDaysAgo.getTime() + 15 * 24 * 60 * 60 * 1000),
        capacity: 200,
        ticketTypes: [
          { name: 'Tasting Pass', description: 'Full tasting experience', price: 8000, quantity: 150 },
          { name: 'Regular Entry', description: 'Standard entry ticket', price: 3000, quantity: 50 },
        ],
      },
      {
        name: 'Comedy Night Special',
        description: 'Stand-up comedy featuring renowned comedians',
        venue: 'Downtown Theater',
        eventDate: new Date(thirtyDaysAgo.getTime() + 3 * 24 * 60 * 60 * 1000),
        capacity: 250,
        ticketTypes: [
          { name: 'Front Row', description: 'Premium front row seats', price: 10000, quantity: 20 },
          { name: 'Standard', description: 'Standard seating', price: 4000, quantity: 180 },
          { name: 'Balcony', description: 'Balcony seating', price: 2500, quantity: 50 },
        ],
      },
      {
        name: 'Charity Gala Dinner',
        description: 'Fundraising gala with dinner and entertainment',
        venue: 'Grand Hotel Ballroom',
        eventDate: new Date(sixtyDaysAgo.getTime() + 20 * 24 * 60 * 60 * 1000),
        capacity: 150,
        ticketTypes: [
          { name: 'Table of 10', description: 'Reserved table for 10 guests', price: 50000, quantity: 10 },
          { name: 'Individual', description: 'Single seat ticket', price: 6000, quantity: 50 },
        ],
      },
    ];

    console.log('\n📅 Creating events...');
    const createdEvents = [];

    for (const eventData of eventsData) {
      const startTime = new Date(eventData.eventDate);
      startTime.setHours(18, 0, 0); // 6 PM start

      const endTime = new Date(eventData.eventDate);
      endTime.setHours(23, 0, 0); // 11 PM end

      const event = new Event({
        vendorId: vendor._id,
        name: eventData.name,
        description: eventData.description,
        venue: eventData.venue,
        eventDate: eventData.eventDate,
        startTime: startTime,
        endTime: endTime,
        capacity: eventData.capacity,
        ticketTypes: eventData.ticketTypes.map(tt => ({
          ...tt,
          sold: 0,
          available: tt.quantity,
        })),
        status: EventStatus.PUBLISHED,
        publishedAt: new Date(eventData.eventDate.getTime() - 45 * 24 * 60 * 60 * 1000), // Published 45 days before
      });

      await event.save();
      createdEvents.push(event);
      console.log(`  ✅ Created: ${event.name}`);
    }

    console.log('\n💰 Generating ticket sales...');

    const customerNames = [
      'John Doe', 'Jane Smith', 'Mike Johnson', 'Sarah Williams', 'David Brown',
      'Emily Davis', 'Chris Wilson', 'Lisa Anderson', 'Tom Martinez', 'Amy Taylor',
      'Kevin Lee', 'Maria Garcia', 'Daniel Rodriguez', 'Jessica Martinez', 'Robert Thompson'
    ];

    let totalSalesCreated = 0;
    let totalTicketsCreated = 0;
    let totalCheckedIn = 0;

    for (const event of createdEvents) {
      // Determine sales period (from 30 days before event to event date)
      const salesStartDate = new Date(event.eventDate.getTime() - 30 * 24 * 60 * 60 * 1000);
      const salesEndDate = event.eventDate;

      // Calculate how many tickets to sell (70-95% of capacity)
      const soldPercentage = 0.7 + Math.random() * 0.25;

      for (const ticketType of event.ticketTypes) {
        const ticketsToSell = Math.floor(ticketType.quantity * soldPercentage);

        // Create sales spread over time
        const numberOfSales = Math.ceil(ticketsToSell / randomInt(1, 5)); // Random sale sizes

        let ticketsSoldForType = 0;

        for (let i = 0; i < numberOfSales && ticketsSoldForType < ticketsToSell; i++) {
          const quantity = Math.min(randomInt(1, 5), ticketsToSell - ticketsSoldForType);
          const saleDate = randomDate(salesStartDate, salesEndDate);
          const paymentMethod = Math.random() > 0.4 ? PaymentMethod.CASH : PaymentMethod.KESHLESS_WALLET;
          const customerName = randomElement(customerNames);
          const customerPhone = `+26878${randomInt(100000, 999999)}`;

          // Create the sale
          const sale = new TicketSale({
            eventId: event._id,
            vendorId: vendor._id,
            quantity: quantity,
            customerName: customerName,
            customerPhone: customerPhone,
            totalAmount: ticketType.price * quantity,
            paymentMethod: paymentMethod,
            paymentStatus: PaymentStatus.COMPLETED,
            soldBy: vendor._id,
            soldByType: 'Vendor',
            soldAt: saleDate,
          });

          // Create tickets for this sale
          const ticketIds = [];
          for (let j = 0; j < quantity; j++) {
            const ticket = new Ticket({
              eventId: event._id,
              vendorId: vendor._id,
              ticketType: ticketType.name,
              price: ticketType.price,
              customerName: customerName,
              customerPhone: customerPhone,
              saleId: sale._id,
              status: TicketStatus.SOLD,
              createdAt: saleDate,
            });

            // 60% chance of being checked in if event is in the past
            if (event.eventDate < now && Math.random() > 0.4) {
              const checkInTime = randomDate(event.startTime, event.endTime);
              ticket.status = TicketStatus.CHECKED_IN;
              ticket.checkedInAt = checkInTime;
              ticket.checkedInBy = vendor._id;
              ticket.checkedInByModel = 'Vendor';
              totalCheckedIn++;
            }

            await ticket.save();
            ticketIds.push(ticket._id);
            totalTicketsCreated++;
          }

          sale.ticketIds = ticketIds;
          await sale.save();

          // Update event ticket type sold count
          ticketType.sold += quantity;
          ticketsSoldForType += quantity;
          totalSalesCreated++;
        }
      }

      // Update event totals
      event.totalTicketsSold = event.ticketTypes.reduce((sum, tt) => sum + tt.sold, 0);
      event.totalRevenue = event.ticketTypes.reduce((sum, tt) => sum + (tt.sold * tt.price), 0);
      await event.save();

      console.log(`  💵 ${event.name}: ${event.totalTicketsSold} tickets sold, E ${event.totalRevenue.toLocaleString()} revenue`);
    }

    console.log('\n📊 Seed Summary:');
    console.log(`  Events created: ${createdEvents.length}`);
    console.log(`  Sales created: ${totalSalesCreated}`);
    console.log(`  Tickets created: ${totalTicketsCreated}`);
    console.log(`  Tickets checked in: ${totalCheckedIn}`);
    console.log(`  Total revenue: E ${createdEvents.reduce((sum, e) => sum + e.totalRevenue, 0).toLocaleString()}`);

    console.log('\n✅ Seed completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding data:', error);
    process.exit(1);
  }
};

// Run the seed function
seedSalesData();
