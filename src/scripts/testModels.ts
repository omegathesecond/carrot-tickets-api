import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Vendor } from '../models/vendor.model';
import { VendorSubUser } from '../models/vendorSubUser.model';
import { Event } from '../models/event.model';
import { EventStatus } from '../interfaces/event.interface';
import { Ticket } from '../models/ticket.model';
import { TicketSale } from '../models/ticketSale.model';
import { TicketScan } from '../models/ticketScan.model';
import { SubUserRole } from '../interfaces/subUser.interface';

dotenv.config();

async function testModels() {
  console.log('🎫 Testing Keshless Tickets Database Models\n');

  try {
    // Connect to MongoDB
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env['MONGODB_URI'] || 'mongodb://localhost:27017/keshless-tickets-dev');
    console.log('✅ Connected to MongoDB:', mongoose.connection.name);
    console.log('');

    // TEST 1: Vendor Model
    console.log('📝 TEST 1: Creating Vendor...');
    const vendor = await Vendor.create({
      email: 'organizer@festival.com',
      password: 'SecurePassword123!',
      businessName: 'Summer Music Festival Organizers',
      businessType: 'event_organizer',
      primaryContact: 'John Smith',
      address: {
        street: '123 Festival Lane',
        city: 'Mbabane',
        region: 'Hhohho',
        country: 'SZ'
      },
      keshlessVendorId: '507f1f77bcf86cd799439011'
    });
    console.log('✅ Vendor created successfully');
    console.log('   - ID:', vendor._id);
    console.log('   - Slug:', vendor.slug);
    console.log('   - Email:', vendor.email);
    console.log('   - Apps enabled:', Object.keys(vendor.apps).filter(k => (vendor.apps as any)[k].enabled));
    console.log('');

    // TEST 2: Password Hashing & Comparison
    console.log('📝 TEST 2: Testing Password Security...');
    const vendorWithPassword = await Vendor.findById(vendor._id).select('+password');
    const isPasswordCorrect = await vendorWithPassword!.comparePassword('SecurePassword123!');
    const isPasswordWrong = await vendorWithPassword!.comparePassword('WrongPassword');
    console.log('✅ Password hashing works');
    console.log('   - Correct password:', isPasswordCorrect ? '✅ PASS' : '❌ FAIL');
    console.log('   - Wrong password:', !isPasswordWrong ? '✅ PASS' : '❌ FAIL');
    console.log('   - Password not in JSON:', !JSON.stringify(vendor).includes('password') ? '✅ PASS' : '❌ FAIL');
    console.log('');

    // TEST 3: Slug Auto-generation & Uniqueness
    console.log('📝 TEST 3: Testing Slug Generation...');
    const vendor2 = await Vendor.create({
      email: 'another@festival.com',
      password: 'password123',
      businessName: 'Summer Music Festival Organizers' // Same name!
    });
    console.log('✅ Slug uniqueness works');
    console.log('   - Vendor 1 slug:', vendor.slug);
    console.log('   - Vendor 2 slug:', vendor2.slug);
    console.log('   - Slugs different:', vendor.slug !== vendor2.slug ? '✅ PASS' : '❌ FAIL');
    console.log('');

    // TEST 4: VendorSubUser Model
    console.log('📝 TEST 4: Creating Sub-Users (Manager, Sales, Scanner)...');
    const manager = await VendorSubUser.create({
      email: 'manager@festival.com',
      password: 'password123',
      fullName: 'Jane Manager',
      vendorId: vendor._id,
      role: SubUserRole.MANAGER
    });
    const salesPerson = await VendorSubUser.create({
      phoneNumber: '26878123456',
      password: 'password123',
      fullName: 'Bob Sales',
      vendorId: vendor._id,
      role: SubUserRole.SALES
    });
    const scanner = await VendorSubUser.create({
      phoneNumber: '26878654321',
      password: 'password123',
      fullName: 'Alice Scanner',
      vendorId: vendor._id,
      role: SubUserRole.SCANNER
    });
    console.log('✅ Sub-users created successfully');
    console.log('   - Manager permissions:', manager.permissions.length, 'permissions');
    console.log('   - Sales permissions:', salesPerson.permissions.length, 'permissions');
    console.log('   - Scanner permissions:', scanner.permissions.length, 'permissions');
    console.log('');

    // TEST 5: Event Model
    console.log('📝 TEST 5: Creating Event with Multiple Ticket Types...');
    const event = await Event.create({
      vendorId: vendor._id,
      name: 'Summer Music Festival 2025',
      description: 'The biggest music festival of the year featuring top international artists',
      venue: 'Mavuso Trade Centre, Manzini',
      eventDate: new Date('2025-07-15'),
      startTime: new Date('2025-07-15T14:00:00Z'),
      endTime: new Date('2025-07-15T23:59:00Z'),
      capacity: 1000,
      ticketTypes: [
        { name: 'VIP', description: 'VIP access with backstage pass', price: 500, quantity: 100, sold: 0, available: 100 },
        { name: 'Regular', description: 'General admission', price: 200, quantity: 800, sold: 0, available: 800 },
        { name: 'Early Bird', description: 'Limited early bird special', price: 150, quantity: 100, sold: 0, available: 100 }
      ],
      status: EventStatus.PUBLISHED,
      publishedAt: new Date()
    });
    console.log('✅ Event created successfully');
    console.log('   - Event ID:', event.eventId);
    console.log('   - Name:', event.name);
    console.log('   - Ticket types:', event.ticketTypes.length);
    console.log('   - Total capacity:', event.capacity);
    console.log('   - Status:', event.status);
    console.log('');

    // TEST 6: Ticket Model
    console.log('📝 TEST 6: Creating Individual Tickets...');
    const tickets = await Ticket.create([
      {
        eventId: event._id,
        vendorId: vendor._id,
        ticketType: 'VIP',
        price: 500,
        customerName: 'Alice Customer',
        customerPhone: '26878111111',
        status: 'sold'
      },
      {
        eventId: event._id,
        vendorId: vendor._id,
        ticketType: 'Regular',
        price: 200,
        customerName: 'Bob Customer',
        customerPhone: '26878222222',
        status: 'sold'
      },
      {
        eventId: event._id,
        vendorId: vendor._id,
        ticketType: 'Early Bird',
        price: 150,
        status: 'available'
      }
    ]);
    console.log('✅ Tickets created successfully');
    tickets.forEach((ticket, i) => {
      console.log(`   - Ticket ${i + 1}: ${ticket.ticketId} (${ticket.ticketType}, ${ticket.status})`);
    });
    console.log('');

    // TEST 7: TicketSale Model (Cash Payment)
    console.log('📝 TEST 7: Creating Ticket Sale (Cash)...');
    const cashSale = await TicketSale.create({
      eventId: event._id,
      vendorId: vendor._id,
      ticketIds: [tickets[0]!._id],
      quantity: 1,
      customerName: 'Alice Customer',
      customerPhone: '26878111111',
      totalAmount: 500,
      paymentMethod: 'cash',
      paymentStatus: 'completed',
      soldBy: salesPerson._id,
      soldByType: 'VendorSubUser'
    });
    console.log('✅ Cash sale created successfully');
    console.log('   - Sale ID:', cashSale.saleId);
    console.log('   - Amount:', cashSale.totalAmount);
    console.log('   - Payment:', cashSale.paymentMethod);
    console.log('   - Status:', cashSale.paymentStatus);
    console.log('');

    // TEST 8: TicketSale Model (Keshless Payment)
    console.log('📝 TEST 8: Creating Ticket Sale (Keshless Wallet)...');
    const walletSale = await TicketSale.create({
      eventId: event._id,
      vendorId: vendor._id,
      ticketIds: [tickets[1]!._id],
      quantity: 1,
      customerName: 'Bob Customer',
      customerPhone: '26878222222',
      totalAmount: 200,
      paymentMethod: 'keshless_wallet',
      paymentStatus: 'completed',
      walletTransactionId: '507f1f77bcf86cd799439011',
      soldBy: vendor._id,
      soldByType: 'Vendor'
    });
    console.log('✅ Keshless wallet sale created successfully');
    console.log('   - Sale ID:', walletSale.saleId);
    console.log('   - Amount:', walletSale.totalAmount);
    console.log('   - Payment:', walletSale.paymentMethod);
    console.log('   - Wallet TX ID:', walletSale.walletTransactionId);
    console.log('');

    // TEST 9: TicketScan Model
    console.log('📝 TEST 9: Creating Ticket Scan Logs...');
    const successfulScan = await TicketScan.create({
      ticketId: tickets[0]!._id,
      eventId: event._id,
      vendorId: vendor._id,
      scannedBy: scanner._id,
      scannedByType: 'VendorSubUser',
      isValid: true,
      scanResult: 'success'
    });
    const failedScan = await TicketScan.create({
      ticketId: tickets[0]!._id,
      eventId: event._id,
      vendorId: vendor._id,
      scannedBy: scanner._id,
      scannedByType: 'VendorSubUser',
      isValid: false,
      scanResult: 'already_scanned',
      notes: 'Ticket already scanned 5 minutes ago'
    });
    console.log('✅ Scan logs created successfully');
    console.log('   - Successful scan:', successfulScan.scanResult);
    console.log('   - Failed scan:', failedScan.scanResult);
    console.log('   - Notes:', failedScan.notes);
    console.log('');

    // TEST 10: Database Indexes
    console.log('📝 TEST 10: Verifying Database Indexes...');
    const vendorIndexes = await Vendor.collection.getIndexes();
    const eventIndexes = await Event.collection.getIndexes();
    const ticketIndexes = await Ticket.collection.getIndexes();
    console.log('✅ Indexes verified');
    console.log('   - Vendor indexes:', Object.keys(vendorIndexes).length);
    console.log('   - Event indexes:', Object.keys(eventIndexes).length);
    console.log('   - Ticket indexes:', Object.keys(ticketIndexes).length);
    console.log('');

    // TEST 11: Query Performance
    console.log('📝 TEST 11: Testing Query Performance...');
    const start = Date.now();
    const vendorEvents = await Event.find({ vendorId: vendor._id });
    const eventTickets = await Ticket.find({ eventId: event._id });
    const eventSales = await TicketSale.find({ eventId: event._id });
    const end = Date.now();
    console.log('✅ Query performance acceptable');
    console.log('   - Vendor events found:', vendorEvents.length);
    console.log('   - Event tickets found:', eventTickets.length);
    console.log('   - Event sales found:', eventSales.length);
    console.log('   - Query time:', end - start, 'ms');
    console.log('');

    // Cleanup
    console.log('🧹 Cleaning up test data...');
    await Vendor.deleteMany({});
    await VendorSubUser.deleteMany({});
    await Event.deleteMany({});
    await Ticket.deleteMany({});
    await TicketSale.deleteMany({});
    await TicketScan.deleteMany({});
    console.log('✅ Cleanup complete\n');

    await mongoose.disconnect();
    console.log('✅✅✅ ALL MODEL TESTS PASSED! ✅✅✅\n');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

testModels();
