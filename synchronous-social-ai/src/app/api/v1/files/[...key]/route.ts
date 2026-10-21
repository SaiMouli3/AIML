import { NextResponse, type NextRequest } from "next/server";
import { storage, verifyLocalSignature } from "@/server/providers/storage/storage";
import { env } from "@/server/env";

const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime" };

/**
 * Serves locally stored objects via short-lived HMAC-signed URLs (the local-driver equivalent of S3
 * presigned URLs). Meta fetches media for publishing from these URLs, so they carry no session.
 * Knowledge documents are never served.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  if (env().STORAGE_DRIVER !== "local") return new NextResponse("Not found", { status: 404 });
  const key = (await params).key.join("/");
  const exp = Number(req.nextUrl.searchParams.get("exp"));
  const sig = req.nextUrl.searchParams.get("sig") ?? "";
  if (!verifyLocalSignature(key, exp, sig) || key.includes("/knowledge/") || key.includes("..")) return new NextResponse("Forbidden", { status: 403 });
  try {
    const data = await storage().get(key);
    const ext = key.split(".").pop()?.toLowerCase() ?? "";
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=600",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
