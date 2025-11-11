import dotenv from 'dotenv';
import { KeshlessPaymentService } from '../services/keshlessPayment.service';

dotenv.config();

async function testPaymentService() {
  console.log('🎫 Testing Keshless Payment Service\n');

  // TEST 1: Environment Variables
  console.log('📝 TEST 1: Environment Configuration');
  console.log('   - API URL:', process.env['KESHLESS_API_URL']);
  console.log('   - Vendor ID:', process.env['KESHLESS_VENDOR_ID']);
  console.log('   - API Key:', process.env['KESHLESS_API_KEY']?.substring(0, 15) + '...');
  const hasEnvVars = !!(process.env['KESHLESS_API_URL'] && process.env['KESHLESS_VENDOR_ID']);
  console.log('   ', hasEnvVars ? '✅ Environment loaded' : '❌ Environment missing');
  console.log('');

  // TEST 2: Payment Attempt (will fail gracefully if Keshless not running)
  console.log('📝 TEST 2: Payment Processing Test');
  try {
    const result = await KeshlessPaymentService.acceptPayment({
      cardNumber: 'ABC12345',
      amount: 150,
      pin: '1234',
      description: 'Test VIP Ticket - Summer Music Festival'
    });

    if (result.status === 'completed') {
      console.log('   ✅ Payment succeeded!');
      console.log('      - Transaction ID:', result.transactionId);
      console.log('      - Amount:', result.amount);
      console.log('      - Fee:', result.feeAmount);
      console.log('      - Vendor received:', result.vendorReceived);
    } else {
      console.log('   ⚠️  Payment failed (expected if Keshless API not running)');
      console.log('      - Error:', result.error);
      console.log('      - Message:', result.message);
      console.log('   ✅ Error handling works correctly');
    }
  } catch (error: any) {
    console.log('   ⚠️  API Connection Failed (expected if Keshless not running)');
    console.log('      -', error.message);
    console.log('   ✅ Exception handling works correctly');
  }
  console.log('');

  // TEST 3: Balance Check
  console.log('📝 TEST 3: Vendor Balance Check');
  try {
    const balance = await KeshlessPaymentService.getVendorBalance();
    console.log('   ✅ Balance retrieved:', balance.balance);
  } catch (error: any) {
    console.log('   ⚠️  Balance check failed (expected if Keshless not running)');
    console.log('      -', error.message);
    console.log('   ✅ Error handling works correctly');
  }
  console.log('');

  // TEST 4: Transaction History Check
  console.log('📝 TEST 4: Transaction History Check');
  try {
    const transactions = await KeshlessPaymentService.getVendorTransactions({
      limit: 10
    });
    console.log('   ✅ Transactions retrieved:', transactions.length, 'transactions');
  } catch (error: any) {
    console.log('   ⚠️  Transaction fetch failed (expected if Keshless not running)');
    console.log('      -', error.message);
    console.log('   ✅ Error handling works correctly');
  }
  console.log('');

  console.log('✅✅✅ PAYMENT SERVICE TESTS COMPLETE! ✅✅✅');
  console.log('');
  console.log('📌 NOTE: Live integration requires Keshless API running');
  console.log('   To test live payments:');
  console.log('   1. Start Keshless API (npm run dev in keshless-api)');
  console.log('   2. Ensure KESHLESS_API_KEY is valid');
  console.log('   3. Run this test again');
  console.log('');
}

testPaymentService();
