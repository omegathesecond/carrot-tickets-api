# Seed Data Scripts

This document describes the available seed scripts for populating your database with test data.

## Available Seed Scripts

### 1. Seed Sales Data
**Command:** `npm run seed:sales`

**What it does:**
- Creates 5 past events with different dates (30-90 days ago)
- Generates realistic ticket sales for each event
- Creates individual tickets for each sale
- Marks ~60% of tickets as checked in for past events
- Uses a mix of payment methods (cash and wallet)
- Spreads sales across time to create realistic revenue trends

**Generated Events:**
1. Summer Music Festival (VIP, General, Early Bird tickets)
2. Tech Conference (Premium, Standard, Student tickets)
3. Food & Wine Expo (Tasting Pass, Regular Entry)
4. Comedy Night Special (Front Row, Standard, Balcony)
5. Charity Gala Dinner (Table of 10, Individual)

**Usage:**
```bash
cd backend/keshless-tickets-api
npm run seed:sales
```

**Notes:**
- Requires at least one vendor to exist in the database
- Creates NEW events each time (doesn't delete existing data)
- Sales dates are randomly distributed over 30 days before event
- Each event sells 70-95% of total capacity

### 2. Seed Admin Data
**Command:** `npm run seed:admin`

Creates admin user account (if exists).

### 3. Seed Test Data
**Command:** `npm run seed:test`

Creates general test data (if exists).

## Viewing the Data

After running the seed script:

1. **Dashboard** - View analytics charts with real data
   - Revenue Overview
   - Ticket Sales Trends
   - Payment Method Breakdown
   - Top Selling Events

2. **Event Details** - Each event now has:
   - Sales history
   - Ticket type performance
   - Check-in rates
   - Analytics tab with detailed charts

3. **Analytics Page** - Global analytics across all events

## Customizing the Seed Data

Edit `/src/scripts/seedSalesData.ts` to customize:

- Event names and descriptions
- Ticket types and prices
- Number of events to create
- Date ranges for events and sales
- Customer names
- Payment method distribution
- Check-in rates

## Clearing Seed Data

To remove seeded data, use MongoDB directly:

```javascript
// Connect to your MongoDB database
use keshless-tickets-dev

// Remove all events created by seed
db.events.deleteMany({})

// Remove all ticket sales
db.ticketsales.deleteMany({})

// Remove all tickets
db.tickets.deleteMany({})
```

Or use a MongoDB GUI tool like MongoDB Compass.

## Environment Variables

The seed script uses the `MONGODB_URI` environment variable:
- Default: `mongodb://localhost:27017/keshless-tickets-dev`
- Override with your `.env` file

## Troubleshooting

**Error: "No vendor found"**
- Solution: Create a vendor account first using the admin panel or seed:admin script

**TypeScript compilation errors**
- Solution: Run `npm install` to ensure all dependencies are installed

**Connection errors**
- Solution: Ensure MongoDB is running on `localhost:27017` or update your `MONGODB_URI`
