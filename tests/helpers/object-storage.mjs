import { Readable } from 'node:stream';
import { ObjectStorageError } from '../../server/s3.mjs';
import { createAttachment } from '../../server/repository.mjs';

export const taskEvidenceInput = id => ({
  entity_type: 'task', entity_id: id, filename: 'synthetic-evidence.pdf',
  content_type: 'application/pdf', data_base64: Buffer.from('%PDF synthetic evidence').toString('base64'),
});

export const attachTaskEvidence = (db, id, user) =>
  createAttachment(db, taskEvidenceInput(id), user, new MemoryObjectStorage());

/** @implements {import('../../server/s3.mjs').ObjectStorage} */
export class MemoryObjectStorage {
  objects = new Map();
  calls = [];
  async put(key, data, { mime, sha256 }) {
    this.calls.push(['put', key]);
    if (this.objects.has(key)) throw new ObjectStorageError('STORAGE_CONFLICT');
    this.objects.set(key, { data: Buffer.from(data), mime, sha256 });
  }
  async head(key) {
    this.calls.push(['head', key]);
    const object = this.objects.get(key);
    if (!object) throw new ObjectStorageError();
    return { size: object.data.length, sha256: object.sha256 };
  }
  async get(key) {
    this.calls.push(['get', key]);
    const object = this.objects.get(key);
    if (!object) throw new ObjectStorageError();
    return Readable.from([Buffer.from(object.data)]);
  }
  async delete(key) {
    this.calls.push(['delete', key]);
    this.objects.delete(key);
  }
}
