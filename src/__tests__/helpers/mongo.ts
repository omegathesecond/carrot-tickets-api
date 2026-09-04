import mongoose from 'mongoose';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';

let mongod: MongoMemoryServer | MongoMemoryReplSet;

/**
 * Mongoose builds declared indexes in the BACKGROUND after connect, so a test
 * can start before they exist. That matters because some code paths depend on a
 * unique index for correctness rather than a lookup — the duplicate-username 409
 * in socialProfile.controller.ts comes solely from catching MongoDB's E11000.
 * Racing the build yields a silent WRONG ANSWER (200 instead of 409), not an
 * error, and only under full-suite CPU load — which reads as flakiness.
 *
 * Model.init() resolves once a model's indexes are built. Awaiting it also makes
 * index-build failures LOUD instead of silent.
 */
async function awaitIndexBuilds(): Promise<void> {
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
}

/**
 * The default harness: a standalone mongod. Fast, and what all but the ledger
 * suites need. Does NOT support multi-document transactions.
 */
export async function connectTestDb(): Promise<void> {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await awaitIndexBuilds();
}

/**
 * A 1-node REPLICA SET, for the few suites that need multi-document
 * transactions — MongoDB only permits them on a replica set (or mongos). The
 * cashless ledger commits a wallet balance mutation and its double-entry
 * postings in one transaction (cashless spec §3), so its suites use this.
 *
 * Deliberately NOT the default. The harness starts one mongod PER TEST FILE;
 * making all ~163 of them replica sets exhausts the machine and causes a
 * different suite to die on every run. Opt in only where transactions are
 * genuinely required.
 */
export async function connectLedgerTestDb(): Promise<void> {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri());
  await awaitIndexBuilds();
}

export async function clearTestDb(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]?.deleteMany({});
  }
}

export async function disconnectTestDb(): Promise<void> {
  await mongoose.disconnect();
  await mongod.stop();
}
