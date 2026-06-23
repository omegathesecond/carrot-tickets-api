export interface IReseller {
  businessName: string;
  slug?: string;
  email?: string;
  phoneNumber?: string;
  commissionPercent: number | null;
  status: 'active' | 'suspended';
  isActive: boolean;
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
