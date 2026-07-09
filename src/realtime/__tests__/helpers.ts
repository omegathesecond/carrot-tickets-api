import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { createAdapter } from '@socket.io/mongo-adapter';
import mongoose from 'mongoose';
import { ensureAdapterCollection } from '../adapterCollection';
import { socketAuthMiddleware } from '../socketAuth';
import { registerChannelHandlers } from '../channelHandlers';

export interface TestRealtime {
  io: Server;
  httpServer: HttpServer;
  port: number;
  close: () => Promise<void>;
}

/**
 * Spin a realtime server on an ephemeral port. withAdapter wires the mongo
 * adapter (for cross-instance tests); without it the server is in-memory.
 * ALWAYS await close() in test teardown — the adapter's tailable cursor
 * keeps jest alive otherwise.
 */
export async function startTestRealtime(withAdapter = false): Promise<TestRealtime> {
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });
  if (withAdapter) {
    const collection = await ensureAdapterCollection(mongoose.connection.db! as any);
    io.adapter(createAdapter(collection as any));
  }
  io.use(socketAuthMiddleware);
  io.on('connection', (socket) => registerChannelHandlers(io, socket));
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    io,
    httpServer,
    port,
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  };
}

export function connectClient(port: number, token?: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioc(`http://127.0.0.1:${port}`, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => {
      socket.close();
      reject(err);
    });
  });
}

export function waitForEvent<T = any>(
  socket: ClientSocket,
  event: string,
  ms = 3000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}
