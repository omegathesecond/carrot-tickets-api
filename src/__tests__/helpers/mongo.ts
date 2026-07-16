import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod: MongoMemoryServer;

export async function connectTestDb(): Promise<void> {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Mongoose builds declared indexes in the BACKGROUND after connect, so a
  // test can start before they exist. That matters because some code paths
  // depend on a unique index for correctness rather than a lookup — the
  // duplicate-username 409 in socialProfile.controller.ts comes solely from
  // catching MongoDB's E11000. Racing the build yields a silent WRONG ANSWER
  // (200 instead of 409), not an error, and only under full-suite CPU load —
  // which reads as flakiness. Model.init() resolves once a model's indexes
  // are built, so wait for every registered model before handing back.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
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
