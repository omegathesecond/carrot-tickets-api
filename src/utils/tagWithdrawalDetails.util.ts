import Joi from 'joi';
import { validatePayoutBank, PayoutBankDetails } from './payoutBank.util';
import { normalizePhone } from './phone.util';
import { HttpError } from './httpError.util';

export interface TagWithdrawalDetails {
  fullName: string;
  contactPhone: string;
  email?: string;
  bank?: PayoutBankDetails;
  mobileNumber?: string;
  provider?: 'MTN MoMo' | 'Eswatini Mobile';
}

export function validateTagWithdrawalInput(input: unknown) {
  const result = Joi.object({
    bandUid: Joi.string().trim().max(64).required(),
    eventId: Joi.string().hex().length(24).required(),
    expectedAmount: Joi.number().integer().min(1).max(10_000_000).required(),
    country: Joi.string().valid('SZ', 'ZA').required(),
    method: Joi.string().valid('mobile_money', 'bank_transfer').required(),
    fullName: Joi.string().trim().min(2).max(120).required(),
    contactPhone: Joi.string().trim().max(25).required(),
    email: Joi.string().trim().email().max(254).allow(''),
    bank: Joi.object(),
    mobileNumber: Joi.string().trim().max(25),
    provider: Joi.string().valid('MTN MoMo', 'Eswatini Mobile'),
    clientTxnId: Joi.string().guid({ version: 'uuidv4' }).required(),
    trackingToken: Joi.string().pattern(/^[A-Za-z0-9_-]{32,100}$/).required(),
  }).unknown(false).validate(input);
  if (result.error) throw new HttpError(400, 'Enter the tag, event, amount, contact and valid payout details');
  const value = result.value;
  const phone = normalizePhone(value.contactPhone);
  if (!value.contactPhone.startsWith('+') || !/^\+\d{10,15}$/.test(phone)) throw new HttpError(400, 'Enter a valid contact phone number with country code');
  const details: TagWithdrawalDetails = { fullName: value.fullName, contactPhone: phone, ...(value.email ? { email: value.email } : {}) };
  if (value.method === 'mobile_money') {
    if (value.country !== 'SZ' || !value.mobileNumber || !value.provider || value.bank)
      throw new HttpError(400, 'Mobile money payouts require Eswatini, a provider and a mobile number');
    const number = normalizePhone(value.mobileNumber);
    if (!/^\+268[67]\d{7}$/.test(number)) throw new HttpError(400, 'Enter a valid Eswatini mobile money number');
    details.mobileNumber = number;
    details.provider = value.provider;
  } else {
    if (value.mobileNumber || value.provider) throw new HttpError(400, 'Choose either bank or mobile money details');
    const bank = validatePayoutBank(value.bank);
    const country = value.country === 'SZ' ? 'Eswatini' : 'South Africa';
    if (bank.country !== country) throw new HttpError(400, 'Bank country must match the selected payout country');
    details.bank = bank;
  }
  return { ...value, details } as typeof value & { details: TagWithdrawalDetails };
}
