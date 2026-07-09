import { Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { createAdapter } from '@socket.io/mongo-adapter';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ensureAdapterCollection } from '../adapterCollection';
import { createRealtimeServer } from '../server';

export interface TestRealtime {
  io: Server;
  httpServer: HttpServer;
  port: number;
  close: () => Promise<void>;
}

/**
 * Spin a realtime server on an ephemeral port. withAdapter wires the mongo
 * adapter (for cross-instance tests); without it the server is in-memory.
 * ALWAYS await close() in test teardown — the adapter's change stream
 * keeps jest alive otherwise.
 */
export async function startTestRealtime(withAdapter = false): Promise<TestRealtime> {
  const { httpServer, io } = createRealtimeServer('*');
  if (withAdapter) {
    const collection = await ensureAdapterCollection(mongoose.connection.db! as any);
    io.adapter(createAdapter(collection as any));
  }
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

let adapterMongod: MongoMemoryReplSet | undefined;

/**
 * @socket.io/mongo-adapter@0.3.2 fans events out via MongoDB change streams
 * (NOT tailable cursors — the capped collection in adapterCollection.ts only
 * bounds storage growth), which require a replica set. The shared
 * connectTestDb()/disconnectTestDb() in __tests__/helpers/mongo.ts boot a
 * standalone mongod (correct for every other suite in this repo — no other
 * suite needs change streams), so cross-instance fan-out tests need their
 * own single-node replica set instead. Scoped here rather than in the shared
 * helper to avoid slowing down or changing behavior for the other ~60
 * consumers of connectTestDb().
 */
export async function connectAdapterTestDb(): Promise<void> {
  adapterMongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(adapterMongod.getUri());
}

export async function disconnectAdapterTestDb(): Promise<void> {
  await mongoose.disconnect();
  await adapterMongod?.stop();
  adapterMongod = undefined;
}
