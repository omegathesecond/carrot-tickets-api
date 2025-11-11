import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Vendor } from '../models/vendor.model';
import { Event } from '../models/event.model';

dotenv.config();

const MONGODB_URI = process.env['MONGODB_URI'] || 'mongodb://localhost:27017/keshless-tickets-dev';

async function seedTestData() {
  console.log('🌱 Seeding test data for Keshless Tickets API...\n');

  try {
    // Connect to MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Clear existing test data
    console.log('🗑️  Clearing existing test data...');
    await Vendor.deleteMany({});
    await Event.deleteMany({});
    console.log('✅ Database cleared\n');

    // Create test vendor
    console.log('👤 Creating test vendor...');
    const vendor = await Vendor.create({
      email: 'test@vendor.com',
      phoneNumber: '+26878000001',
      password: 'password123',
      businessName: 'Test Event Organizer',
      apps: {
        keshless: { enabled: false },
        tickets: { enabled: true, activatedAt: new Date() }
      },
      isActive: true,
      verificationStatus: 'verified'
    });
    console.log('✅ Test vendor created:');
    console.log(`   - Email: test@vendor.com`);
    console.log(`   - Password: password123`);
    console.log(`   - ID: ${vendor._id}`);
    console.log(`   - Slug: ${vendor.slug}\n`);

    // Create test event
    console.log('🎫 Creating test event...');
    const eventDate = new Date();
    eventDate.setDate(eventDate.getDate() + 30); // 30 days from now

    const startTime = new Date(eventDate);
    startTime.setHours(18, 0, 0, 0);

    const endTime = new Date(eventDate);
    endTime.setHours(23, 0, 0, 0);

    const event = await Event.create({
      vendorId: vendor._id,
      name: 'Test Music Festival 2025',
      description: 'A test event for API testing purposes',
      venue: 'Test Arena, Maseru',
      eventDate: eventDate,
      startTime: startTime,
      endTime: endTime,
      capacity: 500,
      ticketTypes: [
        {
          name: 'VIP',
          description: 'VIP access with premium seating',
          price: 300,
          quantity: 50,
          sold: 0,
          available: 50
        },
        {
          name: 'Regular',
          description: 'General admission',
          price: 150,
          quantity: 400,
          sold: 0,
          available: 400
        },
        {
          name: 'Early Bird',
          description: 'Discounted early bird tickets',
          price: 100,
          quantity: 50,
          sold: 0,
          available: 50
        }
      ],
      status: 'published'
    });
    console.log('✅ Test event created:');
    console.log(`   - Name: ${event.name}`);
    console.log(`   - Event ID: ${event.eventId}`);
    console.log(`   - Date: ${event.eventDate.toDateString()}`);
    console.log(`   - Capacity: ${event.capacity}`);
    console.log(`   - Ticket types: ${event.ticketTypes.length}\n`);

    console.log('✅✅✅ TEST DATA SEEDED SUCCESSFULLY! ✅✅✅\n');
    console.log('📝 Test credentials:');
    console.log('   Email: test@vendor.com');
    console.log('   Password: password123\n');
    console.log('🚀 Ready to test endpoints!\n');

  } catch (error: any) {
    console.error('❌ Error seeding test data:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
  }
}

seedTestData();
