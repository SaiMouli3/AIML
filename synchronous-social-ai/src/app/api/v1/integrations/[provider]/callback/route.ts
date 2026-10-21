import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import "@/server/register";
import { resolveSession, sessionCookieName } from "@/server/auth/session";
import { withSystem } from "@/server/db/tenant";
import { env } from "@/server/env";
import { logger } from "@/server/lib/logger";
import { isProviderError } from "@/server/providers/errors";
import { completeInstagramOAuth, completeMetaAdsOAuth, consumeOAuthState } from "@/server/services/integrations";
import { isAppError } from "@/server/lib/errors";

/** OAuth redirect target. Validates single-use state bound to the signed-in user, then exchanges the code server-side. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const provider = z.enum(["instagram", "meta_ads"]).safeParse((await params).provider);
  const back = (q: string) => NextResponse.redirect(new URL(`/integrations?${q}`, env().APP_URL));
  if (!provider.success) return back("error=unknown_provider");
  const sp = req.nextUrl.searchParams;
  if (sp.get("error")) return back(`error=${encodeURIComponent(sp.get("error_reason") ?? sp.get("error") ?? "denied")}`);
  const code = sp.get("code");
  const state = sp.get("state");
  if (!code || !state) return back("error=missing_code");
  try {
    const session = await resolveSession(req.cookies.get(sessionCookieName())?.value);
    const st = await consumeOAuthState(state, provider.data, session?.user.id ?? null);
    await withSystem(async (tx) => {
      if (provider.data === "instagram") await completeInstagramOAuth(tx, st, code);
      else await completeMetaAdsOAuth(tx, st, code);
    });
    return NextResponse.redirect(new URL(`${st.redirectPath}?connected=${provider.data}`, env().APP_URL));
  } catch (e) {
    logger.warn("oauth_callback_failed", { provider: provider.data, error: e });
    const reason = isAppError(e) ? e.code : isProviderError(e) ? e.kind : "failed";
    return back(`error=${encodeURIComponent(reason)}`);
  }
}
