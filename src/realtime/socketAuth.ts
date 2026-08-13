import { Socket } from 'socket.io';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { Buyer } from '@models/buyer.model';
import { normalizePhone } from '@utils/phone.util';
import { ensureUsername } from '@utils/username.util';
import type { SocialActor } from '@utils/socialActor.util';

/**
 * Socket.io handshake auth — the WS twin of the REST DM auth. The client passes
 * its JWT as `auth: { token }`; anything unverifiable rejects the connection
 * (surfaces client-side as connect_error). BOTH buyer and vendor (brand) tokens
 * are accepted — verified by the same TicketsAuthService.verifyToken; only the
 * claim shape differs. A normalized `socket.data.actor` is the identity every
 * downstream handler uses. A vendor gets live DM delivery (brand↔buyer +
 * brand↔brand) but no presence/username (those stay buyer-only, see presence).
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

    // Vendor / sub-user session — the brand is the actor (mirrors
    // resolveActorFromRequest + authenticateCommunityViewer on the REST side).
    if ((decoded?.userType === 'vendor' || decoded?.userType === 'sub-user') && decoded?.vendorId) {
      socket.data.actor = { type: 'vendor', id: String(decoded.vendorId) } as SocialActor;
      return next();
    }

    if (decoded?.userType !== 'buyer' || !(decoded?.buyerId || decoded?.userPhone)) {
      return next(new Error('Invalid token'));
    }

    const buyer = decoded.buyerId
      ? await Buyer.findById(decoded.buyerId)
      : await Buyer.findOne({ phone: normalizePhone(decoded.userPhone) });
    if (!buyer) return next(new Error('Account not found'));
    await ensureUsername(buyer);

    socket.data.buyerId = String(buyer._id);
    socket.data.phone = buyer.phone;
    socket.data.username = buyer.username ?? null;
    socket.data.actor = { type: 'buyer', id: String(buyer._id) } as SocialActor;
    next();
  } catch (err) {
    console.error('[realtime] socket handshake rejected:', err);
    next(new Error('Invalid or expired token'));
  }
}
