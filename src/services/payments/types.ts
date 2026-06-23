import { PaymentMethod } from '@interfaces/ticket.interface';

export interface ChargeInput {
  method: PaymentMethod;
  amount: number;
  description: string;
  keshlessCardNumber?: string;
  keshlessPin?: string;
}

export interface ChargeResult {
  status: 'completed' | 'pending' | 'failed';
  providerRef?: string;   // walletTransactionId for keshless
  message: string;
  error?: string;
}

export interface PaymentProcessor {
  method: PaymentMethod;
  isConfigured(): boolean;
  charge(input: ChargeInput): Promise<ChargeResult>;
}
