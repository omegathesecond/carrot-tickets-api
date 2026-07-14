import jwt, { SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { Vendor } from '@models/vendor.model';
import { VendorSubUser } from '@models/vendorSubUser.model';
import { TicketsUserAccess } from '@models/ticketsUserAccess.model';
import { RefreshToken } from '@models/refreshToken.model';
import { HandoffToken } from '@models/handoffToken.model';
import { TicketsRole, TICKETS_ROLE_PERMISSIONS } from '@interfaces/ticketsPermission.interface';
import { JWT_SECRET } from '@config/jwt.config';

const JWT_EXPIRY: string = process.env['JWT_EXPIRY'] || '15m';
const JWT_REFRESH_SECRET: string = process.env['JWT_REFRESH_SECRET'] || 'your-refresh-secret-key';
const JWT_REFRESH_EXPIRY: string = process.env['JWT_REFRESH_EXPIRY'] || '7d';

// Log JWT configuration at startup for debugging
console.log('[TicketsAuth] JWT Configuration:', {
  accessTokenExpiry: JWT_EXPIRY,
  refreshTokenExpiry: JWT_REFRESH_EXPIRY,
  jwtSecretConfigured: !!process.env['JWT_SECRET'],
  jwtSecretLength: JWT_SECRET?.length || 0,
  refreshSecretConfigured: !!process.env['JWT_REFRESH_SECRET'],
  envJwtExpiry: process.env['JWT_EXPIRY'],
  envRefreshExpiry: process.env['JWT_REFRESH_EXPIRY'],
});

export class TicketsAuthService {
  /**
   * Self-service organizer signup.
   *
   * Creates a Vendor in the PENDING verification state with Tickets access
   * enabled (the model defaults). A pending organizer can log in and build
   * DRAFT events immediately, but EventService.publishEvent refuses to go
   * live until an admin verifies the account. Returns the same token + user
   * shape as login() so the dashboard can sign the new owner straight in.
   */
  static async register(params: {
    businessName: string;
    email?: string;
    phoneNumber?: string;
    password: string;
    businessType?: string;
    primaryContact?: string;
  }) {
    const { businessName, email, phoneNumber, password, businessType, primaryContact } = params;

    if (!email && !phoneNumber) {
      throw new Error('An email address or phone number is required');
    }

    // Reject duplicates up-front so the caller gets a clean message instead
    // of a Mongo duplicate-key error leaking out of save().
    if (email && await Vendor.findOne({ email })) {
      throw new Error('An account with this email already exists');
    }
    if (phoneNumber && await Vendor.findOne({ phoneNumber })) {
      throw new Error('An account with this phone number already exists');
    }

    const vendor = new Vendor({
      businessName,
      email,
      phoneNumber,
      password,
      businessType,
      primaryContact,
      // verificationStatus, isActive, isVerified and apps.tickets.enabled all
      // fall back to the model defaults (PENDING / true / false / true).
    });
    await vendor.save();

    const payload = {
      vendorId: vendor._id.toString(),
      userType: 'vendor',
      app: 'tickets',
      role: TicketsRole.OWNER,
      permissions: TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER],
      isSuperAdmin: false
    };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);
    const refreshToken = this.generateRefreshToken();
    await this.storeRefreshToken(refreshToken, undefined, vendor._id.toString(), 'vendor');

    return {
      accessToken,
      refreshToken,
      user: {
        _id: vendor._id,
        email: vendor.email,
        phoneNumber: vendor.phoneNumber,
        businessName: vendor.businessName,
        slug: vendor.slug,
        userType: 'vendor',
        role: TicketsRole.OWNER,
        permissions: TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER],
        isSuperAdmin: false,
        verificationStatus: vendor.verificationStatus,
        isVerified: vendor.isVerified
      }
    };
  }

  /**
   * Unified login for Keshless Tickets app
   * Automatically detects user type (Vendor or SubUser) and authenticates accordingly
   */
  static async login(identifier: string, password: string) {
    // Try Vendor (email or phone)
    const vendor = await Vendor.findOne({
      $or: [
        { email: identifier },
        { phoneNumber: identifier }
      ]
    }).select('+password');

    if (vendor && await vendor.comparePassword(password)) {
      if (!vendor.isActive) {
        throw new Error('Vendor account is inactive');
      }

      if (!vendor.apps?.tickets?.enabled) {
        throw new Error('Keshless Tickets access is not enabled for this vendor. Please contact support.');
      }

      // Generate tokens for vendor
      const payload = {
        vendorId: vendor._id.toString(),
        userType: 'vendor',
        app: 'tickets',
        role: TicketsRole.OWNER,
        permissions: TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER],
        isSuperAdmin: vendor.isSuperAdmin || false
      };
      const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);
      const refreshToken = this.generateRefreshToken();

      // Store refresh token
      await this.storeRefreshToken(refreshToken, undefined, vendor._id.toString(), 'vendor');

      return {
        accessToken,
        refreshToken,
        user: {
          _id: vendor._id,
          email: vendor.email,
          phoneNumber: vendor.phoneNumber,
          businessName: vendor.businessName,
          slug: vendor.slug,
          userType: 'vendor',
          role: TicketsRole.OWNER,
          permissions: TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER],
          isSuperAdmin: vendor.isSuperAdmin || false,
          verificationStatus: vendor.verificationStatus,
          isVerified: vendor.isVerified
        }
      };
    }

    // Try SubUser (username-based)
    const subUser = await VendorSubUser.findOne({ username: identifier }).select('+password');
    if (subUser && await subUser.comparePassword(password)) {
      if (!subUser.isActive) {
        throw new Error('User account is inactive');
      }

      // Check Tickets access
      const ticketsAccess = await TicketsUserAccess.findOne({
        userId: subUser._id,
        isActive: true
      });

      if (!ticketsAccess) {
        throw new Error('You do not have access to Keshless Tickets. Please contact your administrator.');
      }

      // Verify vendor has Tickets enabled
      const vendorForSubUser = await Vendor.findById(subUser.vendorId);
      if (!vendorForSubUser) {
        throw new Error('Vendor not found');
      }

      if (!vendorForSubUser.apps?.tickets?.enabled) {
        throw new Error('Keshless Tickets is not enabled for your vendor');
      }

      if (!vendorForSubUser.isActive) {
        throw new Error('Vendor account is inactive');
      }

      // Update last login
      subUser.lastLoginAt = new Date();
      await subUser.save();

      // Generate tokens for sub-user
      const payload = {
        userId: subUser._id.toString(),
        vendorId: subUser.vendorId.toString(),
        userType: 'sub-user',
        app: 'tickets',
        role: ticketsAccess.role,
        permissions: ticketsAccess.permissions
      };
      const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);
      const refreshToken = this.generateRefreshToken();

      // Store refresh token
      await this.storeRefreshToken(refreshToken, subUser._id.toString(), subUser.vendorId.toString(), 'sub-user');

      return {
        accessToken,
        refreshToken,
        user: {
          _id: subUser._id,
          vendorId: subUser.vendorId,
          fullName: subUser.fullName,
          email: subUser.email,
          phoneNumber: subUser.phoneNumber,
          userType: 'sub-user',
          role: ticketsAccess.role,
          permissions: ticketsAccess.permissions
        }
      };
    }

    // No user found
    throw new Error('Invalid credentials');
  }

  /**
   * Verify Tickets token
   */
  static verifyToken(token: string): any {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);

      // Verify it's a Tickets token
      if ((decoded as any).app !== 'tickets') {
        console.error('[TicketsAuth] Token verification failed: Missing or invalid app claim');
        throw new Error('Invalid token for Keshless Tickets');
      }

      return decoded;
    } catch (error: any) {
      // Log the actual error for debugging
      console.error('[TicketsAuth] Token verification failed:', {
        error: error.message,
        name: error.name,
        expiredAt: error.expiredAt,
      });

      // Return specific error messages based on JWT error type
      if (error.name === 'TokenExpiredError') {
        throw new Error('Token has expired');
      } else if (error.name === 'JsonWebTokenError') {
        throw new Error('Invalid token signature');
      } else if (error.name === 'NotBeforeError') {
        throw new Error('Token not yet valid');
      } else if (error.message === 'Invalid token for Keshless Tickets') {
        throw error; // Re-throw our custom error
      }

      throw new Error('Invalid or expired token');
    }
  }

  /** The identity claims a vendor/sub-user token carries — copied verbatim so
   *  an exchanged social token is equivalent to a fresh login token. */
  private static identityClaims(src: any) {
    return {
      app: 'tickets' as const,
      userId: src.userId,
      vendorId: src.vendorId,
      userType: src.userType ?? 'vendor',
      businessName: src.businessName,
      role: src.role,
      isSuperAdmin: src.isSuperAdmin ?? false,
      permissions: src.permissions ?? [],
    };
  }

  /**
   * Mint a SHORT-LIVED, one-time handoff token from an already-authenticated
   * dashboard session, for seamless sign-in on the consumer social site
   * (different origin). It carries the vendor identity but is only valid for
   * 90s and single-use (see exchangeSocialHandoff).
   */
  static mintSocialHandoff(ticketsUser: any): string {
    if (!ticketsUser?.vendorId) throw new Error('Vendor sign-in required');
    const jti = crypto.randomBytes(16).toString('hex');
    return jwt.sign(
      { ...TicketsAuthService.identityClaims(ticketsUser), purpose: 'social-handoff', jti },
      JWT_SECRET,
      { expiresIn: '90s' } as SignOptions
    );
  }

  /**
   * Exchange a valid, unused handoff for a normal vendor access token. Rejects
   * expired/forged/replayed handoffs. Never issues anything the organizer
   * didn't already have (same identity claims).
   */
  static async exchangeSocialHandoff(handoff: string): Promise<string> {
    let decoded: any;
    try {
      decoded = jwt.verify(handoff, JWT_SECRET);
    } catch {
      throw new Error('This sign-in link has expired — please try again from your dashboard');
    }
    if (decoded.app !== 'tickets' || decoded.purpose !== 'social-handoff' || !decoded.jti || !decoded.vendorId) {
      throw new Error('Invalid sign-in link');
    }
    // Single-use: the read (MongoDB read-your-writes) catches the common
    // replay; the unique index is the concurrency backstop.
    if (await HandoffToken.findOne({ jti: decoded.jti })) {
      throw new Error('This sign-in link was already used — please try again from your dashboard');
    }
    try {
      await HandoffToken.create({ jti: decoded.jti });
    } catch (err: any) {
      if (err?.code === 11000) throw new Error('This sign-in link was already used — please try again from your dashboard');
      throw err;
    }
    return jwt.sign(TicketsAuthService.identityClaims(decoded), JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);
  }

  /**
   * Get current user from token
   */
  static async getMe(userId: string | undefined, vendorId: string | undefined, userType: string) {
    if (userType === 'vendor') {
      const vendor = await Vendor.findById(vendorId);
      if (!vendor) {
        throw new Error('Vendor not found');
      }

      return {
        _id: vendor._id,
        email: vendor.email,
        phoneNumber: vendor.phoneNumber,
        businessName: vendor.businessName,
        slug: vendor.slug,
        userType: 'vendor',
        role: TicketsRole.OWNER,
        permissions: TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER],
        isSuperAdmin: vendor.isSuperAdmin || false,
        verificationStatus: vendor.verificationStatus,
        isVerified: vendor.isVerified
      };
    } else {
      const subUser = await VendorSubUser.findById(userId);
      if (!subUser) {
        throw new Error('User not found');
      }

      const ticketsAccess = await TicketsUserAccess.findOne({
        userId: subUser._id,
        isActive: true
      });

      if (!ticketsAccess) {
        throw new Error('Keshless Tickets access not found');
      }

      return {
        _id: subUser._id,
        vendorId: subUser.vendorId,
        fullName: subUser.fullName,
        email: subUser.email,
        phoneNumber: subUser.phoneNumber,
        userType: 'sub-user',
        role: ticketsAccess.role,
        permissions: ticketsAccess.permissions
      };
    }
  }

  /**
   * Update user profile
   */
  static async updateProfile(
    userId: string | undefined,
    vendorId: string | undefined,
    userType: string,
    updates: {
      firstName?: string;
      lastName?: string;
      email?: string;
      phoneNumber?: string;
      businessName?: string;
    }
  ) {
    if (userType === 'vendor') {
      if (!vendorId) throw new Error('Vendor ID is required');

      const vendor = await Vendor.findById(vendorId);
      if (!vendor) throw new Error('Vendor not found');

      // Update allowed fields
      if (updates.email) {
        // Check if email is already in use by another vendor
        const existingVendor = await Vendor.findOne({ email: updates.email, _id: { $ne: vendorId } });
        if (existingVendor) throw new Error('Email is already in use');
        vendor.email = updates.email;
      }
      if (updates.phoneNumber) {
        // Check if phone is already in use by another vendor
        const existingVendor = await Vendor.findOne({ phoneNumber: updates.phoneNumber, _id: { $ne: vendorId } });
        if (existingVendor) throw new Error('Phone number is already in use');
        vendor.phoneNumber = updates.phoneNumber;
      }
      if (updates.businessName) vendor.businessName = updates.businessName;

      await vendor.save();

      return {
        _id: vendor._id,
        email: vendor.email,
        phoneNumber: vendor.phoneNumber,
        businessName: vendor.businessName,
        slug: vendor.slug,
        userType: 'vendor'
      };
    } else {
      if (!userId) throw new Error('User ID is required');

      const subUser = await VendorSubUser.findById(userId);
      if (!subUser) throw new Error('User not found');

      // Update allowed fields (subUser has fullName, not firstName/lastName)
      if (updates.email) subUser.email = updates.email;
      if (updates.phoneNumber) subUser.phoneNumber = updates.phoneNumber;

      await subUser.save();

      const ticketsAccess = await TicketsUserAccess.findOne({
        userId: subUser._id,
        isActive: true
      });

      return {
        _id: subUser._id,
        vendorId: subUser.vendorId,
        fullName: subUser.fullName,
        email: subUser.email,
        phoneNumber: subUser.phoneNumber,
        userType: 'sub-user',
        role: ticketsAccess?.role
      };
    }
  }

  /**
   * Change user password
   */
  static async changePassword(
    userId: string | undefined,
    vendorId: string | undefined,
    userType: string,
    currentPassword: string,
    newPassword: string
  ) {
    if (!currentPassword || !newPassword) {
      throw new Error('Current password and new password are required');
    }

    if (newPassword.length < 6) {
      throw new Error('New password must be at least 6 characters long');
    }

    if (userType === 'vendor') {
      if (!vendorId) throw new Error('Vendor ID is required');

      const vendor = await Vendor.findById(vendorId).select('+password');
      if (!vendor) throw new Error('Vendor not found');

      // Verify current password
      const isValidPassword = await vendor.comparePassword(currentPassword);
      if (!isValidPassword) throw new Error('Current password is incorrect');

      // Update password
      vendor.password = newPassword;
      await vendor.save();

      return { message: 'Password changed successfully' };
    } else {
      if (!userId) throw new Error('User ID is required');

      const subUser = await VendorSubUser.findById(userId).select('+password');
      if (!subUser) throw new Error('User not found');

      // Verify current password
      const isValidPassword = await subUser.comparePassword(currentPassword);
      if (!isValidPassword) throw new Error('Current password is incorrect');

      // Update password
      subUser.password = newPassword;
      await subUser.save();

      return { message: 'Password changed successfully' };
    }
  }

  /**
   * Generate refresh token
   */
  private static generateRefreshToken(): string {
    return crypto.randomBytes(64).toString('hex');
  }

  /**
   * Calculate expiry date from string (e.g., '7d', '24h', '15m')
   */
  private static calculateExpiryDate(expiryString: string): Date {
    const now = new Date();
    const match = expiryString.match(/^(\d+)([smhd])$/);

    if (!match) {
      throw new Error('Invalid expiry format');
    }

    const value = parseInt(match[1]!);
    const unit = match[2]!;

    switch (unit) {
      case 's': return new Date(now.getTime() + value * 1000);
      case 'm': return new Date(now.getTime() + value * 60 * 1000);
      case 'h': return new Date(now.getTime() + value * 60 * 60 * 1000);
      case 'd': return new Date(now.getTime() + value * 24 * 60 * 60 * 1000);
      default: throw new Error('Invalid time unit');
    }
  }

  /**
   * Store refresh token in database
   */
  private static async storeRefreshToken(
    refreshToken: string,
    userId: string | undefined,
    vendorId: string | undefined,
    userType: 'vendor' | 'sub-user',
    deviceInfo?: string
  ): Promise<void> {
    const expiresAt = this.calculateExpiryDate(JWT_REFRESH_EXPIRY);

    await RefreshToken.create({
      token: refreshToken,
      userId,
      vendorId,
      userType,
      expiresAt,
      deviceInfo,
      isRevoked: false
    });
  }

  /**
   * Refresh access token using refresh token
   */
  static async refreshAccessToken(refreshTokenString: string): Promise<{ accessToken: string; refreshToken: string }> {
    // Find refresh token in database
    const refreshTokenDoc = await RefreshToken.findOne({
      token: refreshTokenString,
      isRevoked: false,
      expiresAt: { $gt: new Date() }
    });

    if (!refreshTokenDoc) {
      throw new Error('Invalid or expired refresh token');
    }

    // Get user data based on user type
    let payload: any;

    if (refreshTokenDoc.userType === 'vendor') {
      const vendor = await Vendor.findById(refreshTokenDoc.vendorId);
      if (!vendor || !vendor.isActive) {
        throw new Error('Vendor account not found or inactive');
      }

      payload = {
        vendorId: vendor._id.toString(),
        userType: 'vendor',
        app: 'tickets',
        role: TicketsRole.OWNER,
        permissions: TICKETS_ROLE_PERMISSIONS[TicketsRole.OWNER],
        isSuperAdmin: vendor.isSuperAdmin || false
      };
    } else {
      const subUser = await VendorSubUser.findById(refreshTokenDoc.userId);
      if (!subUser || !subUser.isActive) {
        throw new Error('User account not found or inactive');
      }

      const ticketsAccess = await TicketsUserAccess.findOne({
        userId: subUser._id,
        isActive: true
      });

      if (!ticketsAccess) {
        throw new Error('Keshless Tickets access not found');
      }

      payload = {
        userId: subUser._id.toString(),
        vendorId: subUser.vendorId.toString(),
        userType: 'sub-user',
        app: 'tickets',
        role: ticketsAccess.role,
        permissions: ticketsAccess.permissions
      };
    }

    // Generate new access token
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as SignOptions);

    // Generate new refresh token (rotation)
    const newRefreshToken = this.generateRefreshToken();

    // Revoke old refresh token
    refreshTokenDoc.isRevoked = true;
    await refreshTokenDoc.save();

    // Store new refresh token
    await this.storeRefreshToken(
      newRefreshToken,
      refreshTokenDoc.userId,
      refreshTokenDoc.vendorId,
      refreshTokenDoc.userType
    );

    return {
      accessToken,
      refreshToken: newRefreshToken
    };
  }

  /**
   * Revoke refresh token (for logout)
   */
  static async revokeRefreshToken(refreshTokenString: string): Promise<void> {
    await RefreshToken.updateOne(
      { token: refreshTokenString },
      { isRevoked: true }
    );
  }

  /**
   * Revoke all refresh tokens for a user (for security purposes)
   */
  static async revokeAllUserTokens(userId: string | undefined, vendorId: string | undefined): Promise<void> {
    const query: any = { isRevoked: false };

    if (userId) {
      query.userId = userId;
    }
    if (vendorId) {
      query.vendorId = vendorId;
    }

    await RefreshToken.updateMany(query, { isRevoked: true });
  }
}
