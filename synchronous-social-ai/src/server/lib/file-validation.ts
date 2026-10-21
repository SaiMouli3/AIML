/**
 * Upload validation: size limits and content sniffing (magic bytes). The declared MIME type must match
 * the detected type; text formats must decode as UTF-8 without NUL bytes.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // Instagram JPEG limit is 8 MB
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type DetectedType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif"
  | "video/mp4"
  | "video/quicktime"
  | "application/pdf"
  | "text/plain"
  | "text/markdown"
  | "text/csv"
  | "application/json"
  | "text/html";

export function sniff(buf: Buffer): DetectedType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("ascii");
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

function isText(buf: Buffer) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

const TEXT_TYPES: Record<string, DetectedType> = {
  "text/plain": "text/plain",
  "text/markdown": "text/markdown",
  "text/x-markdown": "text/markdown",
  "text/csv": "text/csv",
  "application/json": "application/json",
  "text/html": "text/html",
};

export interface ValidatedFile {
  ok: boolean;
  type?: DetectedType;
  kind?: "image" | "video" | "document";
  reason?: string;
}

export function validateUpload(
  buf: Buffer,
  declaredType: string,
  purpose: "media" | "knowledge",
): ValidatedFile {
  if (buf.length === 0) return { ok: false, reason: "File is empty" };
  const detected = sniff(buf);
  const declared = declaredType.split(";")[0]!.trim().toLowerCase();
  if (purpose === "media") {
    if (!detected || !(detected.startsWith("image/") || detected.startsWith("video/"))) {
      return { ok: false, reason: "Unsupported media type. Upload JPEG, PNG, WebP, GIF, MP4 or MOV." };
    }
    if (declared && declared !== detected && !(declared === "image/jpg" && detected === "image/jpeg")) {
      return { ok: false, reason: `Declared type ${declared} does not match file contents (${detected})` };
    }
    const kind = detected.startsWith("image/") ? "image" : "video";
    const max = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (buf.length > max) return { ok: false, reason: `File exceeds ${Math.round(max / 1048576)} MB limit` };
    return { ok: true, type: detected, kind };
  }
  if (buf.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: "Document exceeds 10 MB limit" };
  if (detected === "application/pdf") return { ok: true, type: detected, kind: "document" };
  if (detected) return { ok: false, reason: "Images and video belong in the Media Library" };
  const textType = TEXT_TYPES[declared] ?? "text/plain";
  if (!isText(buf))
    return { ok: false, reason: "Unsupported document type. Upload PDF, TXT, Markdown, CSV, JSON or HTML." };
  return { ok: true, type: textType, kind: "document" };
}

/** Read image dimensions for JPEG/PNG without external dependencies. */
export function imageDimensions(buf: Buffer, type: string): { width: number; height: number } | null {
  if (type === "image/png" && buf.length >= 24)
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** Malware scanning integration point. Default reports "not_scanned"; wire ClamAV or a vendor here. */
export interface MalwareScanner {
  scan(buf: Buffer): Promise<{ status: "clean" | "infected" | "not_scanned"; detail?: string }>;
}
export const malwareScanner: MalwareScanner = {
  async scan(buf) {
    // EICAR test signature: lets tests verify the quarantine path without a real scanner.
    if (buf.includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")))
      return { status: "infected", detail: "EICAR test signature" };
    return { status: "not_scanned" };
  },
};
