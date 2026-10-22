import { NextResponse } from "next/server";

/** Liveness: the process is up. No dependencies checked. */
export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "synchronous-social-ai",
    time: new Date().toISOString(),
  });
}
