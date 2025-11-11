/**
 * Keshless Payment Integration Service
 *
 * Handles payment processing via Keshless Integration API
 * Uses API key authentication for secure server-to-server communication
 *
 * Integration Pattern:
 * - All Keshless Tickets vendors share a single Keshless vendor account
 * - Authentication via API key (not JWT or password)
 * - Synchronous payment processing (no webhooks needed)
 * - Direct integration with Keshless vendor payment acceptance API
 */

export interface AcceptPaymentParams {
  cardNumber: string;  // NFC card number (8 chars, alphanumeric)
  amount: number;      // Payment amount
  pin?: string;        // User's 4-digit PIN (required if amount >= 50)
  description?: string; // Transaction description (optional)
}

export interface PaymentResponse {
  transactionId: string;
  status: 'completed' | 'failed';
  amount: number;
  feeAmount: number;
  totalAmount: number;
  vendorReceived: number;
  message?: string;
  error?: string;
}

export class KeshlessPaymentService {
  private static KESHLESS_API_URL = process.env['KESHLESS_API_URL'] || 'http://localhost:3000/api';
  private static API_KEY = process.env['KESHLESS_API_KEY'] || '';
  private static VENDOR_ID = process.env['KESHLESS_VENDOR_ID'] || '';

  /**
   * Accept payment from user via NFC card
   * This is the primary integration method - synchronous payment processing
   *
   * @param params - Payment parameters (cardNumber, amount, pin, description)
   * @returns Payment result with transaction ID and status
   * @throws Error if payment fails or API call fails
   */
  static async acceptPayment(params: AcceptPaymentParams): Promise<PaymentResponse> {
    try {
      // Validate required environment variables
      if (!this.API_KEY || this.API_KEY === 'kl_live_your_api_key_here_from_keshless_admin') {
        throw new Error('KESHLESS_API_KEY not configured. Please set valid API key in environment.');
      }

      console.log('🎫 [Keshless Tickets] Initiating payment acceptance:');
      console.log('  - API URL:', this.KESHLESS_API_URL);
      console.log('  - Vendor ID:', this.VENDOR_ID);
      console.log('  - Card Number:', params.cardNumber);
      console.log('  - Amount:', params.amount);
      console.log('  - PIN:', params.pin ? '****' : 'not provided');

      // Call Keshless Integration API
      const response = await fetch(`${this.KESHLESS_API_URL}/integration/payment`, {
        method: 'POST',
        headers: {
          'x-api-key': this.API_KEY,  // API key authentication
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cardNumber: params.cardNumber,
          amount: params.amount,
          pin: params.pin,
          description: params.description || `Keshless Tickets - Event ticket purchase`
        })
      });

      // Handle HTTP errors
      if (!response.ok) {
        const errorData: any = await response.json().catch(() => ({
          message: `HTTP ${response.status}: ${response.statusText}`
        }));

        console.error('❌ [Keshless Tickets] Payment failed:', errorData);

        // Return structured error response
        return {
          transactionId: '',
          status: 'failed',
          amount: params.amount,
          feeAmount: 0,
          totalAmount: params.amount,
          vendorReceived: 0,
          error: errorData.message || errorData.error || 'Payment failed',
          message: this.getUserFriendlyErrorMessage(errorData, response.status)
        };
      }

      // Parse successful response
      const data: any = await response.json();

      console.log('✅ [Keshless Tickets] Payment accepted successfully');
      console.log('  - Transaction ID:', data.data?._id || data.transactionId);
      console.log('  - Fee Amount:', data.data?.feeAmount);
      console.log('  - Vendor Received:', data.data?.vendorReceived);

      // Extract payment details from response
      const paymentData = data.data || data;

      return {
        transactionId: paymentData._id || paymentData.transactionId,
        status: 'completed',
        amount: paymentData.amount || params.amount,
        feeAmount: paymentData.feeAmount || 0,
        totalAmount: paymentData.totalAmount || params.amount,
        vendorReceived: paymentData.vendorReceived || params.amount,
        message: 'Payment accepted successfully'
      };

    } catch (error) {
      const err = error as Error;
      console.error('❌ [Keshless Tickets] Payment error:', err);

      return {
        transactionId: '',
        status: 'failed',
        amount: params.amount,
        feeAmount: 0,
        totalAmount: params.amount,
        vendorReceived: 0,
        error: err.message,
        message: 'Payment processing failed. Please try again.'
      };
    }
  }

  /**
   * Convert API errors to user-friendly messages
   */
  private static getUserFriendlyErrorMessage(errorData: any, statusCode: number): string {
    const errorMessage = errorData.message || errorData.error || '';

    // Handle specific error cases
    if (statusCode === 401) {
      return 'Payment service authentication error. Please contact support.';
    }

    if (errorMessage.toLowerCase().includes('invalid card') || errorMessage.toLowerCase().includes('card not found')) {
      return 'Invalid NFC card. Please check the card and try again.';
    }

    if (errorMessage.toLowerCase().includes('incorrect pin') || errorMessage.toLowerCase().includes('wrong pin')) {
      return 'Incorrect PIN. Please try again.';
    }

    if (errorMessage.toLowerCase().includes('insufficient balance') || errorMessage.toLowerCase().includes('insufficient funds')) {
      return 'Insufficient balance. Please top up your wallet and try again.';
    }

    if (errorMessage.toLowerCase().includes('pin required') || errorMessage.toLowerCase().includes('pin must be provided')) {
      return 'PIN required for this transaction amount. Please provide your 4-digit PIN.';
    }

    if (errorMessage.toLowerCase().includes('blocked') || errorMessage.toLowerCase().includes('restricted')) {
      return 'Account is blocked or restricted. Please contact support.';
    }

    if (errorMessage.toLowerCase().includes('not linked') || errorMessage.toLowerCase().includes('no user')) {
      return 'NFC card is not linked to a Keshless account. Please register first.';
    }

    // Default message
    return errorMessage || 'Payment failed. Please try again or contact support.';
  }

  /**
   * Get vendor balance (optional - for reporting/reconciliation)
   */
  static async getVendorBalance(): Promise<{ balance: number }> {
    try {
      const response = await fetch(`${this.KESHLESS_API_URL}/integration/balance`, {
        method: 'GET',
        headers: {
          'x-api-key': this.API_KEY,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch vendor balance');
      }

      const data: any = await response.json();
      return {
        balance: data.data?.balance || data.balance || 0
      };
    } catch (error) {
      const err = error as Error;
      console.error('Keshless balance fetch error:', err);
      throw new Error(`Failed to fetch balance: ${err.message}`);
    }
  }

  /**
   * Get vendor transactions (optional - for reporting/reconciliation)
   */
  static async getVendorTransactions(params?: {
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<any[]> {
    try {
      const queryParams = new URLSearchParams();
      if (params?.startDate) queryParams.append('startDate', params.startDate.toISOString());
      if (params?.endDate) queryParams.append('endDate', params.endDate.toISOString());
      if (params?.limit) queryParams.append('limit', params.limit.toString());
      if (params?.offset) queryParams.append('offset', params.offset.toString());

      const response = await fetch(
        `${this.KESHLESS_API_URL}/integration/transactions?${queryParams.toString()}`,
        {
          method: 'GET',
          headers: {
            'x-api-key': this.API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch vendor transactions');
      }

      const data: any = await response.json();
      return data.data?.transactions || data.transactions || [];
    } catch (error) {
      const err = error as Error;
      console.error('Keshless transactions fetch error:', err);
      throw new Error(`Failed to fetch transactions: ${err.message}`);
    }
  }
}
