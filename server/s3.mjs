import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

/**
 * Object storage contract (separate from SQL storage):
 * put(key, Buffer, { mime, sha256 }): Promise<void>, create only;
 * get(key): Promise<Readable>, raw bytes, caller consumes/destroys the stream;
 * head(key): Promise<{ size: number, sha256: string | null }>;
 * delete(key): Promise<void>, idempotent for a missing key.
 * HEAD metadata alone is not proof of the stored bytes: upload also hashes GET.
 * @typedef {Object} ObjectStorage
 * @property {Function} put
 * @property {Function} get
 * @property {Function} head
 * @property {Function} delete
 */

export class ObjectStorageError extends Error {
  constructor(code = 'STORAGE_UNAVAILABLE', status = 503) {
    super('Attachment storage operation failed.');
    this.code = code;
    this.status = status;
  }
}

const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
export const encodeS3Component = value => encodeURIComponent(value).replace(/[!'()*]/g,
  character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

// URL.pathname is already encoded exactly once. No path normalization or redirects.
export function signS3Request({ method, url, headers = {}, body = Buffer.alloc(0),
  accessKey, secretKey, region = 'us-east-1', now = new Date() }) {
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = timestamp.slice(0, 8);
  const signed = Object.fromEntries(Object.entries(headers).map(([key, value]) =>
    [key.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')]));
  signed.host = url.host;
  signed['x-amz-date'] = timestamp;
  signed['x-amz-content-sha256'] = hash(body);
  const names = Object.keys(signed).sort();
  const query = [...url.searchParams].map(([key, value]) => [encodeS3Component(key), encodeS3Component(value)])
    .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(pair => pair.join('=')).join('&');
  const canonical = [method, url.pathname, query,
    names.map(name => `${name}:${signed[name]}\n`).join(''), names.join(';'), hash(body)].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`;
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), 's3'), 'aws4_request');
  signed.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope},SignedHeaders=${names.join(';')},Signature=${hmac(key, stringToSign).toString('hex')}`;
  return signed;
}

/** @implements {ObjectStorage} */
export class S3Storage {
  #env;
  #fetch;
  #now;
  constructor({ env = process.env, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
    this.#env = env;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async #request(method, key, { headers = {}, body } = {}) {
    const { S3_ENDPOINT: endpoint, S3_BUCKET: bucket, S3_ACCESS_KEY: accessKey,
      S3_SECRET_KEY: secretKey, S3_REGION: region = 'us-east-1' } = this.#env;
    let url;
    try {
      if (!endpoint || !bucket || !accessKey || !secretKey || !/^[a-z0-9-]+$/.test(region)) throw new Error();
      url = new URL(endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
          !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error();
      if (typeof key !== 'string' || !key || key.split('/').some(part => part === '.' || part === '..')) throw new Error();
      url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeS3Component(bucket)}/${key.split('/').map(encodeS3Component).join('/')}`;
    } catch {
      throw new ObjectStorageError('STORAGE_NOT_CONFIGURED');
    }
    let response;
    try {
      response = await this.#fetch(url, { method, body, redirect: 'error',
        signal: AbortSignal.timeout(60000),
        headers: signS3Request({ method, url, headers, body, accessKey, secretKey, region, now: this.#now() }),
      });
    } catch {
      throw new ObjectStorageError();
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (method === 'DELETE' && response.status === 404) return response;
      throw new ObjectStorageError(response.status === 412 ? 'STORAGE_CONFLICT' : 'STORAGE_UNAVAILABLE');
    }
    return response;
  }

  async put(key, data, { mime, sha256 }) {
    const response = await this.#request('PUT', key, { body: data, headers: {
      'content-type': mime, 'content-length': String(data.length),
      'x-amz-meta-sha256': sha256, 'if-none-match': '*',
    } });
    await response.body?.cancel();
  }

  async get(key) {
    const response = await this.#request('GET', key);
    if (!response.body) throw new ObjectStorageError();
    return Readable.fromWeb(response.body);
  }

  async head(key) {
    const response = await this.#request('HEAD', key);
    const length = response.headers.get('content-length');
    return { size: length !== null && /^\d+$/.test(length) ? Number(length) : NaN,
      sha256: response.headers.get('x-amz-meta-sha256') };
  }

  async delete(key) {
    const response = await this.#request('DELETE', key);
    await response.body?.cancel();
  }
}
