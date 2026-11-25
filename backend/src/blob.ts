import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface Blob {
  presignUpload(key: string, contentType: string): Promise<{ url: string; headers: Record<string, string> }>;
  presignDownload(key: string, fileName: string): Promise<string>;
  read(key: string): Promise<Buffer | undefined>;
  remove(key: string): Promise<void>;
  write(key: string, data: Buffer, contentType: string): Promise<void>; // used by seeding
}

export class S3Blob implements Blob {
  constructor(private bucket: string, private s3 = new S3Client({})) {}
  async presignUpload(key: string, contentType: string) {
    const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn: 300 });
    return { url, headers: { 'Content-Type': contentType } };
  }
  presignDownload(key: string, fileName: string) {
    const safe = fileName.replace(/[^\w.\- ]/g, '_');
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: `attachment; filename="${safe}"` }),
      { expiresIn: 120 },
    );
  }
  async read(key: string) {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'NoSuchKey') return undefined;
      throw e;
    }
  }
  async write(key: string, data: Buffer, contentType: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }
  async remove(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** In-memory blob store. The local server exposes it at /blob/*. */
export class MemoryBlob implements Blob {
  files = new Map<string, { data: Buffer; contentType: string }>();
  constructor(private baseUrl: string) {}
  async presignUpload(key: string, contentType: string) {
    return { url: `${this.baseUrl}/blob/${encodeURIComponent(key)}`, headers: { 'Content-Type': contentType } };
  }
  async presignDownload(key: string) {
    return `${this.baseUrl}/blob/${encodeURIComponent(key)}`;
  }
  async read(key: string) {
    return this.files.get(key)?.data;
  }
  async write(key: string, data: Buffer, contentType: string) {
    this.files.set(key, { data, contentType });
  }
  async remove(key: string) {
    this.files.delete(key);
  }
}

