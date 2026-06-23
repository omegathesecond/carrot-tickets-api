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
  password: string;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  firstLogin: boolean;
  lastLoginAt?: Date;
  comparePassword(p: string): Promise<boolean>;
}
