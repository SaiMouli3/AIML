import { and, eq, inArray } from "drizzle-orm";
import { AlertOctagon, FlaskConical, PauseCircle } from "lucide-react";
import Link from "next/link";
import { SideNav } from "@/components/shell/nav";
import { Topbar } from "@/components/shell/topbar";
import * as s from "@/server/db/schema";
import { env } from "@/server/env";
import { loadPage, serialize } from "@/server/http/page";
import { pendingApprovalCount } from "@/server/services/approvals";
import { listNotifications } from "@/server/services/notifications";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { data, session } = await loadPage(async (ctx) => {
    const ws = (
      await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
    )[0]!;
    const mockAccounts = await ctx.tx
      .select({ id: s.connectedAccounts.id })
      .from(s.connectedAccounts)
      .where(and(eq(s.connectedAccounts.workspaceId, ctx.workspaceId), eq(s.connectedAccounts.mode, "mock")));
    const needsHuman = await ctx.tx
      .select({ id: s.inboxConversations.id })
      .from(s.inboxConversations)
      .where(
        and(
          eq(s.inboxConversations.workspaceId, ctx.workspaceId),
          inArray(s.inboxConversations.status, ["needs_human", "awaiting_approval"]),
        ),
      );
    return {
      ws,
      mock: mockAccounts.length > 0,
      approvals: await pendingApprovalCount(ctx),
      inbox: needsHuman.length,
      notifications: await listNotifications(ctx, 20),
    };
  });
  const d = data!;
  const demo = env().APP_ENV === "demo" || d.ws.isDemo;
  return (
    <div className="flex min-h-screen">
      <aside className="border-border bg-bg sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r md:flex">
        <div className="flex h-14 items-center gap-2 px-4">
          <div className="bg-fg text-bg flex h-7 w-7 items-center justify-center rounded-lg">
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
              <path
                fill="currentColor"
                d="M5 7.5C5 5.6 6.6 4 8.5 4H19v3H8.5a.5.5 0 0 0 0 1H15.5C17.4 8 19 9.6 19 11.5S17.4 15 15.5 15H8.5a.5.5 0 0 0 0 1H19v3H8.5C6.6 19 5 17.4 5 15.5S6.6 12 8.5 12h7a.5.5 0 0 0 0-1h-7C6.6 11 5 9.4 5 7.5Z"
              />
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-[13.5px] font-semibold tracking-[-0.01em]">Synchronous</div>
            <div className="text-fg-subtle text-[11px]">Social AI</div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          <SideNav counts={{ approvals: d.approvals, inbox: d.inbox }} />
        </div>
        <div className="border-border text-fg-subtle border-t px-4 py-3 text-[11.5px]">
          Every external action is approval-gated and audited.
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={session.user}
          workspace={{ id: d.ws.id, name: d.ws.name }}
          memberships={session.memberships}
          role={session.role!}
          notifications={serialize(d.notifications)}
          counts={{ approvals: d.approvals, inbox: d.inbox }}
        />
        {d.ws.killSwitch ? (
          <div
            className="border-danger-600/25 bg-danger-50 text-danger-600 flex items-center gap-2 border-b px-6 py-2 text-[13px]"
            role="alert"
          >
            <AlertOctagon className="h-4 w-4" /> <strong>Emergency kill switch is ON.</strong> All publishing,
            messaging and ad changes are blocked.{" "}
            {d.ws.killSwitchReason ? `Reason: ${d.ws.killSwitchReason}.` : ""}
            <Link href="/settings" className="ml-auto font-medium underline">
              Manage
            </Link>
          </div>
        ) : null}
        {d.ws.automationPaused && !d.ws.killSwitch ? (
          <div className="border-warning-600/25 bg-warning-50 text-warning-600 flex items-center gap-2 border-b px-6 py-2 text-[13px]">
            <PauseCircle className="h-4 w-4" /> Automated replies are paused for this workspace.
            <Link href="/automations" className="ml-auto font-medium underline">
              Automations
            </Link>
          </div>
        ) : null}
        {demo || d.mock ? (
          <div className="border-warning-600/20 bg-warning-50/60 text-warning-600 flex items-center gap-2 border-b px-6 py-1.5 text-[12.5px]">
            <FlaskConical className="h-3.5 w-3.5" />
            {demo ? <strong>Demo environment — sample data is fictional.</strong> : null}
            {d.mock ? (
              <span>
                Development mock integrations are connected. Items marked MOCK never reach Instagram or Meta.
              </span>
            ) : null}
          </div>
        ) : null}
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
