import { NextResponse } from "next/server";
import { createSession, resolveSession, sessionCookieName, sessionCookieOptions, setActiveWorkspace } from "@/server/auth/session";
import { clientIp, route } from "@/server/http/handler";
import { acceptInvite, acceptInviteSchema } from "@/server/services/workspace";

export const POST = route({ auth: "none", body: acceptInviteSchema, rateLimit: 20 }, async ({ body, req }) => {
  const existing = await resolveSession(req.cookies.get(sessionCookieName())?.value);
  const r = await acceptInvite(body, existing?.user.id ?? null);
  const res = NextResponse.json({ ok: true, workspaceId: r.workspaceId });
  if (existing) {
    await setActiveWorkspace(existing.sessionId, existing.user.id, r.workspaceId);
  } else {
    const { token, expiresAt } = await createSession(r.userId, { ip: clientIp(req), userAgent: req.headers.get("user-agent") });
    res.cookies.set(sessionCookieName(), token, sessionCookieOptions(expiresAt));
  }
  return res;
});
