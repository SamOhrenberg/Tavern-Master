import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { badRequest, HttpError } from '../errors.js';
import { ensureDataDirs, newStorageName, uploadPath, uploadsDir } from '../storage.js';

export interface ReceivedFile {
  /** Random name under the uploads directory. Nothing the client sent is part of the path. */
  storageName: string;
  path: string;
  /** The client's file name, cleaned up, kept only as a label. */
  originalName: string;
  size: number;
  sha256: string;
  /** Text fields sent alongside the file. */
  fields: Record<string, string>;
}

/**
 * Stream the single file of a multipart request to disk, outside the web
 * root, counting and hashing it on the way. The caller decides whether to
 * keep it and must remove it otherwise (see `discard`).
 */
export async function receiveFile(req: FastifyRequest, maxBytes?: number): Promise<ReceivedFile> {
  if (!req.isMultipart()) throw badRequest('Send the file as multipart/form-data.');
  const part = await req.file();
  if (!part) throw badRequest('No file was uploaded.');

  const fields: Record<string, string> = {};
  for (const [name, field] of Object.entries(part.fields)) {
    if (field && !Array.isArray(field) && 'value' in field) fields[name] = String(field.value);
  }
  const originalName = part.filename.replace(/[^\w .()-]/g, '_').slice(-120) || 'document';
  const storageName = newStorageName();
  const path = uploadPath(storageName);
  await ensureDataDirs(uploadsDir());

  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(part.file, meter, createWriteStream(path, { mode: 0o600 }));
    if (part.file.truncated) {
      throw new HttpError(413, 'too_large', `File is larger than the ${config().MAX_UPLOAD_MB} MB limit.`);
    }
    if (maxBytes && size > maxBytes) {
      throw new HttpError(
        413,
        'too_large',
        `File is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`,
      );
    }
    if (size === 0) throw badRequest('The file is empty.');
  } catch (err) {
    await rm(path, { force: true });
    throw err;
  }
  return { storageName, path, originalName, size, sha256: hash.digest('hex'), fields };
}

export const discard = (file: ReceivedFile) => rm(file.path, { force: true });

/** The first few kilobytes of a stored file: enough to tell what it really is. */
export async function readHead(path: string): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
