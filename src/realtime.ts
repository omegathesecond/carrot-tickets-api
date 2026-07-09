import mongoose from 'mongoose';
import { createAdapter } from '@socket.io/mongo-adapter';
import { JWT_SECRET } from '@config/jwt.config';
import { createRealtimeServer } from './realtime/server';
import { ensureAdapterCollection } from './realtime/adapterCollection';

/**
 * Entrypoint for the carrot-tickets-realtime Cloud Run service. Same image
 * as carrot-tickets-api, launched as `node dist/realtime.js` (container
 * command override). Fail-closed: missing MONGODB_URI or JWT_SECRET must
 * prevent boot, exactly like the API.
 */
const MONGODB_URI = process.env['MONGODB_URI'];
if (!MONGODB_URI) {
  throw new Error('FATAL: MONGODB_URI is not set. Refusing to start the realtime gateway.');
}
void JWT_SECRET; // imported for its fail-closed boot check

const corsOriginsEnv = process.env['CORS_ORIGINS'] || '*';
const corsOrigins = corsOriginsEnv === '*' ? '*' : corsOriginsEnv.split(',');

async function main(): Promise<void> {
  await mongoose.connect(MONGODB_URI as string);
  console.log('✅ Connected to MongoDB');

  const db = mongoose.connection.db;
  if (!db) throw new Error('FATAL: MongoDB connection has no db handle');

  const collection = await ensureAdapterCollection(db as any);
  const { httpServer, io } = createRealtimeServer(corsOrigins);
  io.adapter(createAdapter(collection as any));

  const PORT = Number(process.env['PORT'] || 8080);
  httpServer.listen(PORT, () => {
    console.log(`⚡ Carrot Tickets realtime gateway on :${PORT}`);
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received. Closing realtime gateway...');
    io.close(() => {
      mongoose.connection.close().then(() => process.exit(0));
    });
  });
}

main().catch((err) => {
  console.error('❌ Realtime gateway failed to start:', err);
  process.exit(1);
});
