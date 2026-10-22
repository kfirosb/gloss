import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dataDir } from './data-dir.js';
import type { ImageAttachment } from '../core/contracts.js';
import {
  MAX_UPLOAD_BASE64_CHARS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  MAX_ATTACHMENT_NAME_CHARS,
} from '../core/content-policy.js';
export const attachmentRoot = join(dataDir(), 'attachments');
export async function saveImage(
  input: { name: string; data: string },
  root = attachmentRoot,
): Promise<ImageAttachment> {
  if (
    typeof input.data !== 'string' ||
    input.data.length > MAX_UPLOAD_BASE64_CHARS ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)
  )
    throw new Error(`Invalid image or image exceeds ${MAX_UPLOAD_LABEL}`);
  const bytes = Buffer.from(input.data, 'base64');
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES)
    throw new Error(`Images must be between 1 byte and ${MAX_UPLOAD_LABEL}`);
  const mime = imageMime(bytes);
  if (!mime) throw new Error('Use a PNG, JPEG, WebP, or GIF image');
  const id = randomUUID();
  const extension = mime.split('/')[1];
  const result: ImageAttachment = {
    id,
    name:
      typeof input.name === 'string'
        ? input.name.slice(0, MAX_ATTACHMENT_NAME_CHARS)
        : 'Screenshot',
    mime,
    size: bytes.length,
    path: join(root, `${id}.${extension}`),
  };
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(result.path, bytes, { mode: 0o600, flag: 'wx' });
  await writeFile(join(root, `${id}.json`), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
  return result;
}
export async function loadImage(id: string, root = attachmentRoot): Promise<ImageAttachment> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))
    throw new Error('Invalid attachment ID');
  try {
    const image = JSON.parse(await readFile(join(root, `${id}.json`), 'utf8')) as ImageAttachment;
    await readFile(image.path);
    return image;
  } catch {
    throw new Error('Attached image is unavailable; attach it again');
  }
}

export function imageMime(bytes: Buffer): string | null {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'image/jpeg'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
        ? 'image/webp'
        : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
          ? 'image/gif'
          : null;
}
