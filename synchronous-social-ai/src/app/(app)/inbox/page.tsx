import { and, eq, isNotNull } from "drizzle-orm";
import { PageHeader } from "@/components/ui/primitives";
import { Forbidden } from "@/components/forbidden";
import * as s from "@/server/db/schema";
import { env } from "@/server/env";
import { loadPage, serialize } from "@/server/http/page";
import { can } from "@/server/rbac/roles";
import { conversationDetail, inboxMetrics, listConversations } from "@/server/services/inbox";
import { InboxClient } from "./client";

export const metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

const TABS = ["all", "comments", "dms", "leads", "needs_human", "automation_paused"] as const;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; c?: string }>;
}) {
  const sp = await searchParams;
  const tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as (typeof TABS)[number]) : "all";
  const { data, session, allowed } = await loadPage(
    async (ctx) => {
      const conversations = await listConversations(ctx, { tab });
      const selected = sp.c ?? conversations[0]?.id;
      const detail = selected ? await conversationDetail(ctx, selected).catch(() => null) : null;
      const ws = (
        await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
      )[0]!;
      const accounts = (
        await ctx.tx
          .select()
          .from(s.connectedAccounts)
          .where(eq(s.connectedAccounts.workspaceId, ctx.workspaceId))
      ).filter((a) => a.provider === "instagram");
      const posts = await ctx.tx
        .select({
          id: s.contentItems.id,
          title: s.contentItems.title,
          mediaId: s.contentItems.publishedMediaId,
          accountId: s.contentItems.connectedAccountId,
        })
        .from(s.contentItems)
        .where(
          and(eq(s.contentItems.workspaceId, ctx.workspaceId), isNotNull(s.contentItems.publishedMediaId)),
        );
      return {
        conversations,
        detail,
        metrics: await inboxMetrics(ctx, 30),
        automationPaused: ws.automationPaused,
        accounts,
        posts,
      };
    },
    { permission: "inbox.read" },
  );
  if (!allowed) return <Forbidden what="the Inbox" />;
  return (
    <>
      <PageHeader
        title="Inbox"
        description="Eligible Instagram comments and DMs from official webhooks. Every reply is grounded in approved data and passes eligibility, policy and approval checks before sending."
      />
      <InboxClient
        data={serialize(data!) as never}
        tab={tab}
        canReply={can(session.role!, "inbox.reply")}
        canAutomate={can(session.role!, "automations.manage")}
        mocksAllowed={env().mocksAllowed}
      />
    </>
  );
}
