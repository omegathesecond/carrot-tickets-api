import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const API_URL = process.env['API_URL'] || 'http://localhost:5000';
const BASE_URL = `${API_URL}/api/tickets`;

let accessToken = '';
let refreshToken = '';
let eventId = '';
let ticketId = '';
let saleId = '';

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL';
  message?: string;
}

const results: TestResult[] = [];

function logTest(name: string, passed: boolean, message?: string) {
  results.push({
    name,
    status: passed ? 'PASS' : 'FAIL',
    message
  });
  const emoji = passed ? '✅' : '❌';
  console.log(`${emoji} ${name}${message ? ': ' + message : ''}`);
}

async function makeRequest(
  endpoint: string,
  method: string = 'GET',
  body?: any,
  token?: string
): Promise<any> {
  const headers: any = {
    'Content-Type': 'application/json'
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const options: any = {
    method,
    headers
  };

  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, options);
  const data = await response.json();

  return { status: response.status, data };
}

async function testAuthentication() {
  console.log('\n🔐 Testing Authentication Endpoints...\n');

  try {
    // Test Login
    const loginResponse = await makeRequest('/auth/login', 'POST', {
      identifier: process.env['TEST_VENDOR_EMAIL'] || 'test@vendor.com',
      password: process.env['TEST_VENDOR_PASSWORD'] || 'password123'
    });

    if (loginResponse.status === 200 && loginResponse.data.data.accessToken) {
      accessToken = loginResponse.data.data.accessToken;
      refreshToken = loginResponse.data.data.refreshToken;
      logTest('POST /auth/login', true, 'Login successful');
    } else {
      logTest('POST /auth/login', false, JSON.stringify(loginResponse.data));
      return false;
    }

    // Test Get Me
    const meResponse = await makeRequest('/auth/me', 'GET', undefined, accessToken);
    logTest(
      'GET /auth/me',
      meResponse.status === 200 && meResponse.data.data,
      meResponse.data.data?.businessName || meResponse.data.data?.username
    );

    // Test Refresh Token
    const refreshResponse = await makeRequest('/auth/refresh', 'POST', {
      refreshToken
    });
    logTest(
      'POST /auth/refresh',
      refreshResponse.status === 200 && refreshResponse.data.data.accessToken,
      'Token refreshed'
    );

    // Update access token with new one
    if (refreshResponse.data.data.accessToken) {
      accessToken = refreshResponse.data.data.accessToken;
      refreshToken = refreshResponse.data.data.refreshToken;
    }

    return true;
  } catch (error: any) {
    console.error('Authentication test error:', error);
    logTest('Authentication', false, error.message);
    return false;
  }
}

async function testEventManagement() {
  console.log('\n📅 Testing Event Management Endpoints...\n');

  try {
    // Create Event
    const createEventResponse = await makeRequest(
      '/events',
      'POST',
      {
        name: 'Test Concert 2024',
        description: 'Amazing live music event',
        venue: 'City Stadium',
        eventDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days from now
        startTime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        endTime: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000).toISOString(),
        capacity: 1000,
        ticketTypes: [
          {
            name: 'VIP',
            description: 'VIP seating with exclusive access',
            price: 100,
            quantity: 50
          },
          {
            name: 'General',
            description: 'General admission',
            price: 50,
            quantity: 200
          }
        ]
      },
      accessToken
    );

    if (createEventResponse.status === 201 && createEventResponse.data.data._id) {
      eventId = createEventResponse.data.data._id;
      logTest('POST /events', true, `Event created: ${createEventResponse.data.data.eventId}`);
    } else {
      logTest('POST /events', false, JSON.stringify(createEventResponse.data));
    }

    // Get Events
    const getEventsResponse = await makeRequest('/events?page=1&limit=10', 'GET', undefined, accessToken);
    logTest(
      'GET /events',
      getEventsResponse.status === 200 && Array.isArray(getEventsResponse.data.data.events),
      `Found ${getEventsResponse.data.data?.events?.length || 0} events`
    );

    // Get Single Event
    if (eventId) {
      const getEventResponse = await makeRequest(`/events/${eventId}`, 'GET', undefined, accessToken);
      logTest(
        'GET /events/:eventId',
        getEventResponse.status === 200 && getEventResponse.data.data._id === eventId,
        getEventResponse.data.data?.name
      );

      // Update Event
      const updateEventResponse = await makeRequest(
        `/events/${eventId}`,
        'PUT',
        {
          description: 'Updated description for the event'
        },
        accessToken
      );
      logTest('PUT /events/:eventId', updateEventResponse.status === 200, 'Event updated');

      // Publish Event
      const publishResponse = await makeRequest(`/events/${eventId}/publish`, 'PUT', {}, accessToken);
      logTest('PUT /events/:eventId/publish', publishResponse.status === 200, 'Event published');
    }
  } catch (error: any) {
    console.error('Event management test error:', error);
    logTest('Event Management', false, error.message);
  }
}

async function testTicketSales() {
  console.log('\n🎫 Testing Ticket Sales Endpoints...\n');

  try {
    // Sell Tickets (Cash)
    const sellCashResponse = await makeRequest(
      '/sales/sell',
      'POST',
      {
        eventId,
        ticketType: 'General',
        quantity: 2,
        customerName: 'John Doe',
        customerPhone: '+26878422613',
        paymentMethod: 'cash'
      },
      accessToken
    );

    if (sellCashResponse.status === 201 && sellCashResponse.data.data.sale) {
      saleId = sellCashResponse.data.data.sale._id;
      ticketId = sellCashResponse.data.data.tickets[0]?.ticketId;
      logTest('POST /sales/sell (cash)', true, `Sale ID: ${sellCashResponse.data.data.sale.saleId}`);
    } else {
      logTest('POST /sales/sell (cash)', false, JSON.stringify(sellCashResponse.data));
    }

    // Get Sales
    const getSalesResponse = await makeRequest('/sales?page=1&limit=10', 'GET', undefined, accessToken);
    logTest(
      'GET /sales',
      getSalesResponse.status === 200 && Array.isArray(getSalesResponse.data.data.sales),
      `Found ${getSalesResponse.data.data?.sales?.length || 0} sales`
    );

    // Get Single Sale
    if (saleId) {
      const getSaleResponse = await makeRequest(`/sales/${saleId}`, 'GET', undefined, accessToken);
      logTest(
        'GET /sales/:saleId',
        getSaleResponse.status === 200 && getSaleResponse.data.data._id === saleId,
        getSaleResponse.data.data?.saleId
      );
    }
  } catch (error: any) {
    console.error('Ticket sales test error:', error);
    logTest('Ticket Sales', false, error.message);
  }
}

async function testScanning() {
  console.log('\n🔍 Testing Scanning Endpoints...\n');

  try {
    if (!ticketId) {
      logTest('Scanning tests', false, 'No ticket ID available for testing');
      return;
    }

    // Validate Ticket
    const validateResponse = await makeRequest(
      '/scans/validate',
      'POST',
      {
        ticketId
      },
      accessToken
    );
    logTest(
      'POST /scans/validate',
      validateResponse.status === 200 && validateResponse.data.data.valid,
      'Ticket is valid'
    );

    // Check-in Ticket
    const checkInResponse = await makeRequest(
      '/scans/check-in',
      'POST',
      {
        ticketId,
        notes: 'Test check-in'
      },
      accessToken
    );
    logTest(
      'POST /scans/check-in',
      checkInResponse.status === 200 && checkInResponse.data.data.valid,
      'Ticket checked in'
    );

    // Try to check-in again (should fail)
    const checkInAgainResponse = await makeRequest(
      '/scans/check-in',
      'POST',
      {
        ticketId
      },
      accessToken
    );
    logTest(
      'POST /scans/check-in (already checked in)',
      checkInAgainResponse.status === 400,
      'Correctly rejected duplicate check-in'
    );

    // Get Scans
    const getScansResponse = await makeRequest('/scans?page=1&limit=10', 'GET', undefined, accessToken);
    logTest(
      'GET /scans',
      getScansResponse.status === 200 && Array.isArray(getScansResponse.data.data.scans),
      `Found ${getScansResponse.data.data?.scans?.length || 0} scans`
    );
  } catch (error: any) {
    console.error('Scanning test error:', error);
    logTest('Scanning', false, error.message);
  }
}

async function testAnalytics() {
  console.log('\n📊 Testing Analytics Endpoints...\n');

  try {
    // Dashboard Stats
    const dashboardResponse = await makeRequest('/stats/dashboard', 'GET', undefined, accessToken);
    logTest(
      'GET /stats/dashboard',
      dashboardResponse.status === 200 && dashboardResponse.data.data.events,
      'Dashboard stats retrieved'
    );

    // Sales Stats
    const salesStatsResponse = await makeRequest('/stats/sales', 'GET', undefined, accessToken);
    logTest(
      'GET /stats/sales',
      salesStatsResponse.status === 200 && salesStatsResponse.data.data.totalSales !== undefined,
      `Total sales: ${salesStatsResponse.data.data?.totalSales || 0}`
    );

    // Revenue Stats
    const revenueStatsResponse = await makeRequest('/stats/revenue', 'GET', undefined, accessToken);
    logTest(
      'GET /stats/revenue',
      revenueStatsResponse.status === 200 && revenueStatsResponse.data.data.totalRevenue !== undefined,
      `Total revenue: ${revenueStatsResponse.data.data?.totalRevenue || 0}`
    );

    // Event Analytics
    if (eventId) {
      const eventAnalyticsResponse = await makeRequest(
        `/stats/events/${eventId}`,
        'GET',
        undefined,
        accessToken
      );
      logTest(
        'GET /stats/events/:eventId',
        eventAnalyticsResponse.status === 200 && eventAnalyticsResponse.data.data.event,
        'Event analytics retrieved'
      );
    }
  } catch (error: any) {
    console.error('Analytics test error:', error);
    logTest('Analytics', false, error.message);
  }
}

async function testExports() {
  console.log('\n📄 Testing Export Endpoints...\n');

  try {
    // Export Sales
    const exportSalesResponse = await makeRequest('/export/sales', 'GET', undefined, accessToken);
    logTest(
      'GET /export/sales',
      exportSalesResponse.status === 200,
      'Sales CSV exported'
    );

    // Export Revenue
    const exportRevenueResponse = await makeRequest('/export/revenue', 'GET', undefined, accessToken);
    logTest(
      'GET /export/revenue',
      exportRevenueResponse.status === 200,
      'Revenue CSV exported'
    );

    // Export Event Summary
    if (eventId) {
      const exportSummaryResponse = await makeRequest(
        `/export/events/${eventId}/summary`,
        'GET',
        undefined,
        accessToken
      );
      logTest(
        'GET /export/events/:eventId/summary',
        exportSummaryResponse.status === 200,
        'Event summary CSV exported'
      );
    }
  } catch (error: any) {
    console.error('Export test error:', error);
    logTest('Exports', false, error.message);
  }
}

async function testLogout() {
  console.log('\n🚪 Testing Logout...\n');

  try {
    const logoutResponse = await makeRequest(
      '/auth/logout',
      'POST',
      { refreshToken },
      accessToken
    );
    logTest('POST /auth/logout', logoutResponse.status === 200, 'Logged out successfully');
  } catch (error: any) {
    console.error('Logout test error:', error);
    logTest('Logout', false, error.message);
  }
}

async function runAllTests() {
  console.log('\n🎫 ====================================== 🎫');
  console.log('   Keshless Tickets API Endpoint Tests');
  console.log('🎫 ====================================== 🎫');
  console.log(`\n📍 Testing API at: ${BASE_URL}\n`);

  try {
    const authSuccess = await testAuthentication();

    if (!authSuccess) {
      console.log('\n❌ Authentication failed. Cannot proceed with other tests.');
      console.log('Please ensure:');
      console.log('1. The API server is running');
      console.log('2. Test vendor credentials are set in .env');
      console.log('3. MongoDB is connected');
      return;
    }

    await testEventManagement();
    await testTicketSales();
    await testScanning();
    await testAnalytics();
    await testExports();
    await testLogout();

    // Summary
    console.log('\n📊 Test Summary');
    console.log('================\n');

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const total = results.length;

    console.log(`Total Tests: ${total}`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`\nSuccess Rate: ${((passed / total) * 100).toFixed(2)}%\n`);

    if (failed > 0) {
      console.log('Failed Tests:');
      results
        .filter(r => r.status === 'FAIL')
        .forEach(r => {
          console.log(`  ❌ ${r.name}${r.message ? ': ' + r.message : ''}`);
        });
      console.log('');
    }
  } catch (error: any) {
    console.error('Test execution error:', error);
  }
}

// Run tests
runAllTests()
  .then(() => {
    console.log('✅ Test execution completed\n');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Test execution failed:', error);
    process.exit(1);
  });
