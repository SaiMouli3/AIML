import { and, eq, inArray } from "drizzle-orm";
import { PageHeader } from "@/components/ui/primitives";
import { Forbidden } from "@/components/forbidden";
import * as s from "@/server/db/schema";
import { loadPage, serialize } from "@/server/http/page";
import { can } from "@/server/rbac/roles";
import { storage } from "@/server/providers/storage/storage";
import { getApproval, listApprovals } from "@/server/services/approvals";
import { ApprovalsClient } from "./client";

export const metadata = { title: "Approvals" };
export const dynamic = "force-dynamic";

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ id?: string; status?: string }> }) {
  const sp = await searchParams;
  const status = sp.status ?? "pending";
  const { data, session, allowed } = await loadPage(
    async (ctx) => {
      const list = await listApprovals(ctx, { status });
      const selectedId = sp.id ?? list[0]?.id;
      const detail = selectedId ? await getApproval(ctx, selectedId).catch(() => null) : null;
      const ids = (detail?.approval.summary.preview?.mediaAssetIds ?? []) as string[];
      const assets = ids.length ? await ctx.tx.select().from(s.mediaAssets).where(and(inArray(s.mediaAssets.id, ids), eq(s.mediaAssets.workspaceId, ctx.workspaceId))) : [];
      const media = await Promise.all(ids.map(async (id) => {
        const a = assets.find((x) => x.id === id);
        return a ? { id: a.id, kind: a.kind, origin: a.origin, url: await storage().signedUrl(a.storageKey, 900), sha256: a.sha256 } : null;
      }));
      return { list, detail, media: media.filter(Boolean) };
    },
    { permission: "approvals.read" },
  );
  if (!allowed) return <Forbidden what="the Approval Center" />;
  return (
    <>
      <PageHeader title="Approval Center" description="Approve exactly what will happen. Each decision is bound to a fingerprint of the exact payload; any material edit invalidates it." />
      <ApprovalsClient
        data={serialize(data!) as never}
        status={status}
        userId={session.user.id}
        canTier3={can(session.role!, "approvals.decide.tier3")}
        canTier4={can(session.role!, "approvals.decide.tier4")}
      />
    </>
  );
}
