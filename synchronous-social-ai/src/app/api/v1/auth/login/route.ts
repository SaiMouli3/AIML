import { NextResponse } from "next/server";
import { createSession, sessionCookieName, sessionCookieOptions } from "@/server/auth/session";
import { writeAudit } from "@/server/audit/audit";
import { withSystem } from "@/server/db/tenant";
import { clientIp, route } from "@/server/http/handler";
import { login, loginSchema } from "@/server/services/workspace";

export const POST = route({ auth: "none", body: loginSchema, rateLimit: 20 }, async ({ body, req, correlationId }) => {
  const ip = clientIp(req);
  const user = await login(body, { ip });
  const { token, expiresAt } = await createSession(user.id, { ip, userAgent: req.headers.get("user-agent") });
  await withSystem((tx) => writeAudit(tx, { workspaceId: null, actorType: "user", actorId: user.id, action: "auth.login", targetType: "user", targetId: user.id, ip, correlationId }));
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookieName(), token, sessionCookieOptions(expiresAt));
  return res;
});
