import Joi from 'joi';
import {
  encryptOperatorPin,
  decryptOperatorPin,
} from './operatorPinEncryption.util';
import { HttpError } from './httpError.util';

export interface PayoutBankDetails {
  country: string;
  bank: string;
  accountType: string;
  branchCode: string;
  accountHolder: string;
  accountNumber: string;
}
const text = Joi.string().trim().min(1).max(120).required();
const schema = Joi.object({
  country: text,
  bank: text,
  accountType: text,
  branchCode: Joi.string()
    .trim()
    .pattern(/^[a-zA-Z0-9 -]{2,20}$/)
    .required(),
  accountHolder: text,
  accountNumber: Joi.string()
    .trim()
    .pattern(/^[0-9]{4,34}$/)
    .required(),
}).unknown(false);
export function validatePayoutBank(input: unknown): PayoutBankDetails {
  const result = schema.validate(input);
  // Do not echo account numbers through Joi's validation message.
  if (result.error)
    throw new HttpError(
      400,
      'Enter valid country, bank, account type, branch code, holder and a 4–34 digit account number',
    );
  return result.value;
}
export function maskPayoutBank(bank: PayoutBankDetails): PayoutBankDetails {
  return {
    ...bank,
    accountNumber: `••••${bank.accountNumber.slice(-Math.min(4, Math.floor(bank.accountNumber.length / 2)))}`,
  };
}
// Reuse the existing authenticated encryption/key lifecycle. A domain-separated
// AAD binds bank ciphertext to its vendor and prevents PIN/bank ciphertext swaps.
export function encryptPayoutBank(
  bank: PayoutBankDetails,
  vendorId: string,
): string {
  return encryptOperatorPin(JSON.stringify(bank), `payout-bank:${vendorId}`);
}
export function decryptPayoutBank(
  value: string,
  vendorId: string,
): PayoutBankDetails {
  return validatePayoutBank(
    JSON.parse(decryptOperatorPin(value, `payout-bank:${vendorId}`)),
  );
}
