import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Vendor } from '../models/vendor.model';

dotenv.config();

const MONGODB_URI = process.env['MONGODB_URI'] || 'mongodb://localhost:27017/keshless-tickets-dev';

async function seedAdmin() {
  console.log('🔐 Seeding admin user for Keshless Tickets API...\n');

  try {
    // Connect to MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Check if admin already exists
    const existingAdmin = await Vendor.findOne({ email: 'admin@keshless.com' });

    if (existingAdmin) {
      console.log('⚠️  Admin user already exists!');
      console.log(`   - Email: ${existingAdmin.email}`);
      console.log(`   - Business: ${existingAdmin.businessName}`);
      console.log(`   - ID: ${existingAdmin._id}\n`);
      console.log('✅ Use existing admin credentials to login\n');
      return;
    }

    // Create admin vendor with GOD powers
    console.log('👑 Creating admin user with GOD permissions...');
    const admin = await Vendor.create({
      email: 'admin@keshless.com',
      phoneNumber: '+26878999999',
      password: 'Admin@123',
      businessName: 'Keshless Tickets Administrator',
      apps: {
        keshless: { enabled: false },
        tickets: { enabled: true, activatedAt: new Date() }
      },
      isActive: true,
      verificationStatus: 'verified',
      isVerified: true,
      isSuperAdmin: true
    });

    console.log('✅ Admin user created:');
    console.log(`   - Email: admin@keshless.com`);
    console.log(`   - Password: Admin@123`);
    console.log(`   - ID: ${admin._id}`);
    console.log(`   - Slug: ${admin.slug}`);
    console.log(`   - Role: tickets_owner (GOD permissions)`);
    console.log(`   - Permissions: ALL`);
    console.log(`   - Super Admin: YES (System-wide access)\n`);

    console.log('👑👑👑 SYSTEM-WIDE ADMIN CREATED SUCCESSFULLY! 👑👑👑\n');
    console.log('📝 Admin credentials:');
    console.log('   Email: admin@keshless.com');
    console.log('   Password: Admin@123\n');
    console.log('✨ Admin capabilities:');
    console.log('   - View ALL events from ALL vendors');
    console.log('   - Publish/Unpublish any event');
    console.log('   - System-wide analytics and reporting\n');
    console.log('⚠️  IMPORTANT: Change the admin password after first login!\n');

  } catch (error: any) {
    console.error('❌ Error seeding admin user:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
  }
}

seedAdmin();
