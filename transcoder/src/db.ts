import mongoose from 'mongoose';

const updateSchema = new mongoose.Schema({}, { strict: false, collection: 'updates' });
export const Update = mongoose.model('Update', updateSchema);

// Story.media is a single embedded doc (not an array like Update.media) —
// see @models/story.model on the api side. The transcoder writes to whichever
// of these two the api's Transcodable.collection field named; see
// mediaTarget.ts for the field-path branch this drives.
const storySchema = new mongoose.Schema({}, { strict: false, collection: 'stories' });
export const StoryTarget = mongoose.model('StoryTarget', storySchema);

export async function connect(): Promise<void> {
  if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI!);
}
