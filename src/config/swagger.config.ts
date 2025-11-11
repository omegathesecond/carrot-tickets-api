import swaggerJsdoc from 'swagger-jsdoc';
import { version } from '../../package.json';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Keshless Tickets API Documentation',
      version: version,
      description: `
# Keshless Tickets Event Management & Ticketing API

A comprehensive REST API for event management, ticket sales, and entry validation.

## Features

- **Multi-User Authentication**: Support for Vendors, Managers, and Staff
- **Event Management**: Create, publish, and manage events
- **Ticket Management**: Generate tickets, track sales, and validate entries
- **Payment Integration**: Support for cash and Keshless wallet payments
- **Sales Analytics**: Revenue tracking, attendance stats, and reporting
- **Entry Validation**: QR code scanning for ticket verification
- **Multi-tenant**: Complete vendor isolation and data security

## Authentication

Most endpoints require authentication using JWT tokens. Include the token in the Authorization header:

\`\`\`
Authorization: Bearer <your_jwt_token>
\`\`\`

### User Types

- **Vendor**: Event organizers/businesses
- **Manager**: Event managers with full access
- **Sales**: Staff who can sell tickets
- **Scanner**: Staff who can only scan/validate tickets

## Payment Methods

- **Cash**: Manual cash payment recorded in the system
- **Keshless Wallet**: Tap NFC card or scan QR code to pay via Keshless

## Error Handling

All errors follow a consistent format:

\`\`\`json
{
  "success": false,
  "message": "Error description",
  "code": "ERROR_CODE",
  "requestId": "unique-request-id"
}
\`\`\`
      `,
      contact: {
        name: 'Keshless Tickets API Support',
        email: 'support@keshless.app',
      },
      license: {
        name: 'Proprietary',
      },
    },
    servers: [
      {
        url: 'http://localhost:5000/api',
        description: 'Development server',
      },
      {
        url: 'https://dev-api-tickets.keshless.app/api',
        description: 'Development environment',
      },
      {
        url: 'https://api-tickets.keshless.app/api',
        description: 'Production environment',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT token',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              example: false,
            },
            message: {
              type: 'string',
              example: 'Error description',
            },
            code: {
              type: 'string',
              example: 'ERROR_CODE',
            },
            requestId: {
              type: 'string',
              example: '1234567890-abc123',
            },
          },
        },
        Event: {
          type: 'object',
          properties: {
            _id: {
              type: 'string',
              example: '507f1f77bcf86cd799439011',
            },
            eventId: {
              type: 'string',
              example: 'EVT-1234567890abc',
            },
            vendorId: {
              type: 'string',
              example: '507f1f77bcf86cd799439011',
            },
            name: {
              type: 'string',
              example: 'Summer Music Festival 2025',
            },
            description: {
              type: 'string',
              example: 'Annual outdoor music festival featuring local artists',
            },
            venue: {
              type: 'string',
              example: 'Central Park Amphitheater',
            },
            eventDate: {
              type: 'string',
              format: 'date',
              example: '2025-06-15',
            },
            startTime: {
              type: 'string',
              format: 'date-time',
              example: '2025-06-15T18:00:00Z',
            },
            endTime: {
              type: 'string',
              format: 'date-time',
              example: '2025-06-15T23:00:00Z',
            },
            capacity: {
              type: 'number',
              example: 500,
            },
            status: {
              type: 'string',
              enum: ['draft', 'published', 'ongoing', 'completed', 'cancelled'],
              example: 'published',
            },
          },
        },
        Ticket: {
          type: 'object',
          properties: {
            _id: {
              type: 'string',
              example: '507f1f77bcf86cd799439011',
            },
            ticketId: {
              type: 'string',
              example: 'TKT-1699000000-A7B9C2',
            },
            eventId: {
              type: 'string',
              example: '507f1f77bcf86cd799439011',
            },
            ticketType: {
              type: 'string',
              example: 'VIP',
            },
            price: {
              type: 'number',
              example: 150,
            },
            status: {
              type: 'string',
              enum: ['available', 'sold', 'checked_in', 'cancelled'],
              example: 'sold',
            },
          },
        },
        TicketSale: {
          type: 'object',
          properties: {
            _id: {
              type: 'string',
              example: '507f1f77bcf86cd799439011',
            },
            saleId: {
              type: 'string',
              example: 'SALE-1699000000-XYZ123',
            },
            eventId: {
              type: 'string',
              example: '507f1f77bcf86cd799439011',
            },
            ticketIds: {
              type: 'array',
              items: {
                type: 'string',
              },
              example: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
            },
            quantity: {
              type: 'number',
              example: 2,
            },
            totalAmount: {
              type: 'number',
              example: 300,
            },
            paymentMethod: {
              type: 'string',
              enum: ['cash', 'keshless_wallet'],
              example: 'keshless_wallet',
            },
            paymentStatus: {
              type: 'string',
              enum: ['pending', 'completed', 'failed', 'refunded'],
              example: 'completed',
            },
          },
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
    tags: [
      {
        name: 'Authentication',
        description: 'User authentication endpoints',
      },
      {
        name: 'Events',
        description: 'Event management',
      },
      {
        name: 'Tickets',
        description: 'Ticket operations',
      },
      {
        name: 'Sales',
        description: 'Ticket sales and checkout',
      },
      {
        name: 'Entry',
        description: 'Ticket scanning and validation',
      },
      {
        name: 'Analytics',
        description: 'Sales analytics and reporting',
      },
      {
        name: 'Account',
        description: 'Vendor account settings',
      },
    ],
  },
  apis: [
    './src/routes/*.ts',
    './src/controllers/*.ts',
    './src/models/*.ts',
  ],
};

export const swaggerSpec = swaggerJsdoc(options);
