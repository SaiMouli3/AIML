import { redirect } from "next/navigation";
import { NewWorkspaceForm } from "@/components/auth-forms";
import { currentSession } from "@/server/http/page";

export const dynamic = "force-dynamic";

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const sp = await searchParams;
  if (session.workspace && !sp.new) redirect("/overview");
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-[400px]">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
          {session.workspace ? "New workspace" : "Create a workspace"}
        </h1>
        <p className="text-fg-muted mt-1 mb-6 text-[13.5px]">
          Each workspace keeps its own Company Brain, integrations, approvals and audit log.
        </p>
        <NewWorkspaceForm />
      </div>
    </div>
  );
}
