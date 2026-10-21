import { NextResponse } from "next/server";
import "@/server/register";
import { createSession, sessionCookieName, sessionCookieOptions } from "@/server/auth/session";
import { clientIp, route } from "@/server/http/handler";
import { signup, signupSchema } from "@/server/services/workspace";

export const POST = route({ auth: "none", body: signupSchema, rateLimit: 10 }, async ({ body, req }) => {
  const ip = clientIp(req);
  const { user, workspace } = await signup(body, { ip });
  const { token, expiresAt } = await createSession(user.id, { ip, userAgent: req.headers.get("user-agent") });
  const res = NextResponse.json({ user: { id: user.id, email: user.email, name: user.name }, workspace: { id: workspace.id, name: workspace.name } }, { status: 201 });
  res.cookies.set(sessionCookieName(), token, sessionCookieOptions(expiresAt));
  return res;
});
