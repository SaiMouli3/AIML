import { PageHeader } from "@/components/ui/primitives";
import { loadPage, serialize } from "@/server/http/page";
import { assignableRoles, can, permissionsFor, PERMISSIONS, ROLE_LABELS, ROLES } from "@/server/rbac/roles";
import { listMembers } from "@/server/services/workspace";
import { TeamClient } from "./client";

export const metadata = { title: "Team & Permissions" };
export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const { data, session } = await loadPage((ctx) => listMembers(ctx));
  const matrix = ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r], permissions: permissionsFor(r) }));
  return (
    <>
      <PageHeader
        title="Team & Permissions"
        description="Roles are enforced on the server for every request. Nobody can grant a role above their own; agents can never change permissions."
      />
      <TeamClient
        data={serialize(data!) as never}
        me={session.user.id}
        canManage={can(session.role!, "members.manage")}
        assignable={assignableRoles(session.role!)}
        labels={ROLE_LABELS}
        matrix={matrix}
        permissions={[...PERMISSIONS]}
      />
    </>
  );
}
