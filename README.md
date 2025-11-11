# Keshless Tickets API

A comprehensive REST API for event management, ticket sales, and entry validation. Standalone ticketing platform with Keshless wallet payment integration.

## Features

- **Multi-User Authentication**: Support for Vendors, Managers, Sales Staff, and Scanners
- **Event Management**: Create, publish, and manage events with multiple ticket types
- **Ticket Sales**: Sell tickets via cash or Keshless wallet payments
- **Entry Validation**: QR code scanning for ticket verification at event entry
- **Analytics & Reporting**: Revenue tracking, sales stats, and attendance analytics
- **Multi-tenant**: Complete vendor isolation and data security
- **Payment Integration**: Seamless Keshless wallet integration for digital payments

## Tech Stack

- **Runtime**: Node.js 18+
- **Language**: TypeScript 5.2+
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Authentication**: JWT (JSON Web Tokens)
- **Validation**: Joi
- **Security**: bcrypt, helmet, CORS
- **Monitoring**: Sentry (optional)
- **Documentation**: Swagger/OpenAPI

## Project Structure

```
src/
├── config/
│   ├── database.config.ts    # Database connection & validation
│   ├── sentry.config.ts       # Error tracking configuration
│   └── swagger.config.ts      # API documentation configuration
├── controllers/               # Request handlers (business logic entry)
├── services/                  # Core business logic
│   └── keshlessPayment.service.ts  # Payment integration
├── models/                    # MongoDB schemas
│   ├── vendor.model.ts
│   ├── vendorSubUser.model.ts
│   ├── event.model.ts
│   ├── ticket.model.ts
│   ├── ticketSale.model.ts
│   └── ticketScan.model.ts
├── routes/                    # API route definitions
├── middleware/                # Authentication & validation
│   └── errorHandler.middleware.ts
├── validators/                # Request validation (Joi)
├── interfaces/                # TypeScript type definitions
│   ├── vendor.interface.ts
│   ├── subUser.interface.ts
│   ├── event.interface.ts
│   └── ticket.interface.ts
├── utils/                     # Helper functions
├── scripts/                   # Seed scripts
└── app.ts                     # Express app initialization
```

## Installation

### Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0
- MongoDB (local or MongoDB Atlas)
- Keshless API credentials (for payment integration)

### Setup

1. **Clone and navigate to the project**
   ```bash
   cd /path/to/keshless-tickets/dev/backend/keshless-tickets-api
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set the following:
   ```env
   # Server
   PORT=5000
   NODE_ENV=development

   # Database
   MONGODB_URI=mongodb://localhost:27017/keshless-tickets-dev
   # Or use MongoDB Atlas:
   # MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/keshless-tickets-dev

   # JWT
   JWT_SECRET=your_secure_random_secret_here
   JWT_EXPIRY=7d

   # Keshless Integration
   KESHLESS_API_URL=http://localhost:3000/api
   # Production: https://api.keshless.app/api
   KESHLESS_VENDOR_ID=your_keshless_vendor_id
   KESHLESS_API_KEY=kl_live_your_api_key_here

   # CORS
   CORS_ORIGINS=http://localhost:5173,http://localhost:5174

   # Sentry (optional)
   SENTRY_DSN=
   SENTRY_ENVIRONMENT=development
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

5. **Run development server**
   ```bash
   npm run dev
   ```

   The API will start on http://localhost:5000

## API Documentation

Once the server is running, access the Swagger documentation at:

- **Swagger UI**: http://localhost:5000/api-docs
- **Swagger JSON**: http://localhost:5000/api-docs.json
- **Health Check**: http://localhost:5000/health

## Database Models

### Vendor
Event organizers/businesses who create and manage events.
- Authentication (email/phone + password)
- Business information
- Keshless vendor linkage for payments
- Multi-app support (Keshless + Tickets)

### VendorSubUser
Staff members with different roles:
- **Manager**: Full access to all features
- **Sales**: Can sell tickets and view sales
- **Scanner**: Can only scan/validate tickets

### Event
Events with multiple ticket types:
- Event details (name, description, venue, date/time)
- Capacity management
- Multiple ticket types (VIP, Regular, Early Bird, etc.)
- Status tracking (draft, published, ongoing, completed, cancelled)

### Ticket
Individual tickets with QR codes:
- Unique ticket ID (QR scannable: `TKT-{timestamp}-{random}`)
- Ticket type and price
- Customer information
- Status (available, sold, checked_in, cancelled)

### TicketSale
Transaction records:
- Multiple tickets per sale
- Payment method (cash or Keshless wallet)
- Customer details
- Staff attribution

### TicketScan
Entry validation logs:
- Scan timestamp and result
- Validation status
- Scanner attribution
- Audit trail

## Payment Integration

### Keshless Wallet Payments

The API integrates with Keshless for digital wallet payments:

1. **Setup**: Configure `KESHLESS_API_KEY` and `KESHLESS_VENDOR_ID` in `.env`

2. **Payment Flow**:
   ```typescript
   import { KeshlessPaymentService } from '@services/keshlessPayment.service';

   const result = await KeshlessPaymentService.acceptPayment({
     cardNumber: 'ABC12345',  // NFC card number
     amount: 150,              // Ticket price
     pin: '1234',             // Required if amount >= 50
     description: 'VIP Ticket - Summer Festival 2025'
   });

   if (result.status === 'completed') {
     // Payment successful
     // result.transactionId - save this
     // result.vendorReceived - amount credited to vendor
   }
   ```

3. **Error Handling**: User-friendly error messages for:
   - Invalid card
   - Incorrect PIN
   - Insufficient balance
   - Blocked/restricted accounts

## Scripts

```bash
# Development
npm run dev              # Start development server with hot reload

# Building
npm run build            # Build TypeScript to JavaScript
npm start                # Start production server (after build)

# Code Quality
npm run lint             # Run ESLint
npm run lint:fix         # Fix ESLint errors automatically

# Testing
npm test                 # Run tests (when implemented)

# Database Seeds (when implemented)
npm run seed:admin       # Create admin user
npm run seed:test        # Seed test data
```

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `PORT` | Server port | No | 5000 |
| `NODE_ENV` | Environment (development/production) | No | development |
| `MONGODB_URI` | MongoDB connection string | Yes | mongodb://localhost:27017/keshless-tickets-dev |
| `JWT_SECRET` | Secret for JWT signing | Yes | - |
| `JWT_EXPIRY` | JWT token expiry | No | 7d |
| `KESHLESS_API_URL` | Keshless API base URL | Yes | http://localhost:3000/api |
| `KESHLESS_VENDOR_ID` | Keshless vendor ID | Yes | - |
| `KESHLESS_API_KEY` | Keshless integration API key | Yes | - |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated) | No | * |
| `SENTRY_DSN` | Sentry error tracking DSN | No | - |

## Keshless Integration Setup

1. **Get API Credentials**:
   - Contact Keshless admin to create vendor account
   - Generate Integration API key via Keshless dashboard
   - Note your Vendor ID

2. **Configure Environment**:
   ```env
   # Development
   KESHLESS_API_URL=http://localhost:3000/api
   KESHLESS_VENDOR_ID=68ed3b8abf3cef8c0e536c1c
   KESHLESS_API_KEY=kl_dev_abc123xyz...

   # Production
   KESHLESS_API_URL=https://api.keshless.app/api
   KESHLESS_VENDOR_ID=your_prod_vendor_id
   KESHLESS_API_KEY=kl_live_abc123xyz...
   ```

3. **Test Integration**:
   - Use Keshless sandbox/test environment for development
   - Test with test NFC cards
   - Verify payments appear in Keshless dashboard

## Security

- Passwords hashed with bcrypt (12 salt rounds)
- JWT authentication for all protected routes
- API key authentication for Keshless integration
- Helmet.js for security headers
- CORS configuration
- Input validation with Joi
- MongoDB injection prevention
- Rate limiting (implement in production)

## Error Handling

All errors follow a consistent format:

```json
{
  "success": false,
  "message": "Error description",
  "code": "ERROR_CODE",
  "requestId": "unique-request-id"
}
```

Error types:
- `ValidationError` (400)
- `AuthenticationError` (401)
- `AuthorizationError` (403)
- `NotFoundError` (404)
- `ConflictError` (409)
- `DatabaseError` (500)
- `ExternalServiceError` (502)

## Deployment

### Development
```bash
npm run dev
```

### Production
```bash
npm run build
npm start
```

### Docker (TODO)
Docker configuration to be added.

### Cloud Deployment

Recommended platforms:
- **Google Cloud Run** (containerized deployment)
- **AWS ECS/Fargate**
- **Azure App Service**
- **Heroku** (simple deployment)

## Monitoring & Logging

### Sentry Integration

Configure Sentry for error tracking:

1. Create Sentry project at https://sentry.io
2. Copy DSN to `.env`:
   ```env
   SENTRY_DSN=https://abc123@o123456.ingest.sentry.io/7654321
   SENTRY_ENVIRONMENT=production
   ```
3. Sentry automatically captures:
   - Unhandled exceptions
   - Promise rejections
   - HTTP errors (500+)
   - MongoDB errors
   - Express middleware errors

### Logs

- Console logging for development
- Structured JSON logs for production
- Error logs with stack traces
- Request tracking with unique IDs

## License

Proprietary - All rights reserved

## Support

For support, contact: support@keshless.app
