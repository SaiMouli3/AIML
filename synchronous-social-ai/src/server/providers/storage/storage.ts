import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env } from "../../env";
import { hmacSha256, safeEqual } from "../../lib/crypto";

/** Object storage with tenant-scoped keys: `<workspaceId>/<category>/<uuid>.<ext>`. */
export interface ObjectStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Short-lived URL. Signed URLs are bearer credentials: never log them. */
  signedUrl(key: string, ttlSeconds?: number): Promise<string>;
}

export function tenantKey(workspaceId: string, category: string, fileName: string) {
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) throw new Error("Invalid workspace id for storage key");
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return `${workspaceId}/${category}/${safe}`;
}

export function keyBelongsTo(key: string, workspaceId: string) {
  return key.startsWith(`${workspaceId}/`) && !key.includes("..");
}

export function signLocal(key: string, exp: number) {
  return hmacSha256(env().sessionSecret, `file:${key}:${exp}`);
}

export function verifyLocalSignature(key: string, exp: number, sig: string) {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(signLocal(key, exp), sig);
}

class LocalStorage implements ObjectStorage {
  private root = resolve(env().STORAGE_LOCAL_DIR);
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + "/")) throw new Error("Path traversal rejected");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  get(key: string) {
    return readFile(this.path(key));
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  async deletePrefix(prefix: string) {
    await rm(this.path(prefix), { recursive: true, force: true });
  }
  async signedUrl(key: string, ttlSeconds = 900) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `${env().APP_URL}/api/v1/files/${key}?exp=${exp}&sig=${signLocal(key, exp)}`;
  }
}

/**
 * Extra PutObject parameters. SSE-S3 (AES256) is requested from AWS only: S3-compatible stores such as
 * Cloudflare R2 reject the x-amz-server-side-encryption header and already encrypt every object at rest.
 */
export function putObjectExtras(contentType: string, endpoint = env().S3_ENDPOINT) {
  return endpoint
    ? { ContentType: contentType }
    : { ContentType: contentType, ServerSideEncryption: "AES256" as const };
}

class S3Storage implements ObjectStorage {
  private async client() {
    const { S3Client } = await import("@aws-sdk/client-s3");
    const e = env();
    return new S3Client({
      region: e.S3_REGION ?? "us-east-1",
      endpoint: e.S3_ENDPOINT || undefined,
      forcePathStyle: Boolean(e.S3_ENDPOINT),
      credentials:
        e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  private bucket() {
    const b = env().S3_BUCKET;
    if (!b) throw new Error("S3_BUCKET is not configured");
    return b;
  }
  async put(key: string, data: Buffer, contentType: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (
      await this.client()
    ).send(
      new PutObjectCommand({ Bucket: this.bucket(), Key: key, Body: data, ...putObjectExtras(contentType) }),
    );
  }
  async get(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await (await this.client()).send(new GetObjectCommand({ Bucket: this.bucket(), Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: key }));
  }
  async deletePrefix(prefix: string) {
    const { ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
    const c = await this.client();
    let token: string | undefined;
    do {
      const page = await c.send(
        new ListObjectsV2Command({ Bucket: this.bucket(), Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length)
        await c.send(new DeleteObjectsCommand({ Bucket: this.bucket(), Delete: { Objects: keys } }));
      token = page.NextContinuationToken;
    } while (token);
  }
  async signedUrl(key: string, ttlSeconds = 900) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    return getSignedUrl(await this.client(), new GetObjectCommand({ Bucket: this.bucket(), Key: key }), {
      expiresIn: ttlSeconds,
    });
  }
}

let instance: ObjectStorage | undefined;
export function storage(): ObjectStorage {
  if (!instance) instance = env().STORAGE_DRIVER === "s3" ? new S3Storage() : new LocalStorage();
  return instance;
}
