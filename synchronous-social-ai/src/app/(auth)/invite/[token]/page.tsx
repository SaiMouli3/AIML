import { AcceptInviteForm } from "@/components/auth-forms";
import { currentSession } from "@/server/http/page";

export const metadata = { title: "Accept invitation" };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await currentSession();
  return (
    <>
      <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Join workspace</h1>
      <p className="mt-1 mb-8 text-[13.5px] text-fg-muted">{session ? `Signed in as ${session.user.email}.` : "Create your account to join your team."}</p>
      <AcceptInviteForm token={token} signedIn={Boolean(session)} />
    </>
  );
}
