export interface IReseller {
  businessName: string;
  slug?: string;
  email?: string;
  phoneNumber?: string;
  // Optional owner password — lets a reseller partner (e.g. DeltaPay) sign in to
  // the allocation portal with email + password, instead of the till-operator
  // loginCode + PIN. Hashed at rest; never serialized.
  password?: string;
  commissionPercent: number | null;
  status: 'active' | 'suspended';
  isActive: boolean;
  comparePassword(candidate: string): Promise<boolean>;
}

export interface IResellerHub {
  resellerId: any;
  name: string;
  location?: {
    city?: string;
    region?: string;
  };
  isActive: boolean;
}

export interface IResellerOperator {
  hubId: any;
  resellerId: any;
  fullName: string;
  email?: string;
  phoneNumber?: string;
  loginCode: string;
  pin: string;
  role: string;
  isActive: boolean;
  failedPinAttempts: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date;
  comparePin(p: string): Promise<boolean>;
}
