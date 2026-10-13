import { createServer, Server as HttpServer } from 'http';
import express from 'express';
import { Server } from 'socket.io';
import type { CorsOrigin } from '@utils/corsOrigins.util';
import { socketAuthMiddleware } from './socketAuth';
import { registerChannelHandlers } from './channelHandlers';
import { registerDmHandlers } from './dmHandlers';
import { trackConnection } from './presence';
import { TicketsAuthService } from '@services/ticketsAuth.service';

export interface RealtimeServer {
  httpServer: HttpServer;
  io: Server;
}

/**
 * Assemble the realtime gateway: a bare express app (health only — ALL REST
 * lives on carrot-tickets-api) with Socket.io attached. The mongo adapter is
 * wired by the caller so this stays connection-agnostic and testable.
 */
export function createRealtimeServer(corsOrigins: CorsOrigin): RealtimeServer {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: corsOrigins, credentials: false },
  });

  io.use(socketAuthMiddleware);
  io.on('connection', (socket) => {
    const validateSession = async () => {
      await TicketsAuthService.verifyAndResolveSession(socket.handshake.auth['token']);
    };
    // A socket must not turn a revoked/expired bearer into a permanent session.
    socket.use((_packet, next) => {
      validateSession().then(() => next()).catch((error) => {
        next(error);
        socket.disconnect(true);
      });
    });
    const sessionCheck = setInterval(() => {
      validateSession().catch(() => socket.disconnect(true));
    }, 30_000);
    sessionCheck.unref();
    socket.on('disconnect', () => clearInterval(sessionCheck));
    trackConnection(socket);
    registerChannelHandlers(io, socket);
    registerDmHandlers(io, socket);
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'OK',
      mode: 'realtime',
      connections: io.engine.clientsCount,
    });
  });

  return { httpServer, io };
}
