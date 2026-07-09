import { Socket } from 'socket.io';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { Buyer } from '@models/buyer.model';
import { normalizePhone } from '@utils/phone.util';
import { ensureUsername } from '@utils/username.util';

/**
 * Socket.io handshake auth — the WS twin of authenticateBuyer +
 * resolveBuyerFromRequest. The client passes its buyer JWT as
 * `auth: { token }`; anything else rejects the connection, which surfaces
 * client-side as connect_error. Chat identity is the username, so it is
 * lazily assigned here exactly like the REST social endpoints do.
 */
export async function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    const token = socket.handshake.auth?.['token'];
    if (!token || typeof token !== 'string') {
      return next(new Error('Please sign in first'));
    }

    const decoded: any = TicketsAuthService.verifyToken(token);
    if (decoded?.userType !== 'buyer' || !decoded?.userPhone) {
      return next(new Error('Invalid buyer token'));
    }

    const phone = normalizePhone(decoded.userPhone);
    const buyer = await Buyer.findOne({ phone });
    if (!buyer) return next(new Error('Account not found'));
    await ensureUsername(buyer);

    socket.data.buyerId = String(buyer._id);
    socket.data.phone = buyer.phone;
    socket.data.username = buyer.username ?? null;
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
}
