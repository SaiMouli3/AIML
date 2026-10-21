import { NextResponse } from "next/server";
import { destroySession, sessionCookieName } from "@/server/auth/session";
import { route } from "@/server/http/handler";

export const POST = route({ auth: "user" }, async ({ req }) => {
  const token = req.cookies.get(sessionCookieName())?.value;
  if (token) await destroySession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(sessionCookieName());
  return res;
});
