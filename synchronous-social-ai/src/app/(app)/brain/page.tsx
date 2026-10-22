import { PageHeader } from "@/components/ui/primitives";
import { loadPage, serialize } from "@/server/http/page";
import {
  getProfile,
  listAllowedDomains,
  listBrandRules,
  listFacts,
  listProducts,
  listSources,
} from "@/server/services/company-brain";
import { Forbidden } from "@/components/forbidden";
import { can } from "@/server/rbac/roles";
import { BrainClient } from "./client";

export const metadata = { title: "Company Brain" };
export const dynamic = "force-dynamic";

export default async function BrainPage({
  searchParams,
}: {
  searchParams: Promise<{ onboarding?: string; tab?: string }>;
}) {
  const sp = await searchParams;
  const { data, session, allowed } = await loadPage(
    async (ctx) => ({
      profile: await getProfile(ctx),
      facts: await listFacts(ctx),
      products: await listProducts(ctx),
      rules: await listBrandRules(ctx),
      domains: await listAllowedDomains(ctx),
      sources: await listSources(ctx),
    }),
    { permission: "brain.read" },
  );
  if (!allowed) return <Forbidden what="the Company Brain" />;
  return (
    <>
      <PageHeader
        title="Company Brain"
        description="Structured, source-linked company truth. Agents may only use approved facts, approved claims, catalog prices and allowlisted links."
      />
      <BrainClient
        data={serialize(data)}
        canWrite={can(session.role!, "brain.write")}
        onboarding={sp.onboarding === "1"}
        initialTab={sp.tab}
      />
    </>
  );
}
