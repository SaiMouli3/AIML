import { route } from "@/server/http/handler";
import { env } from "@/server/env";
import { inviteMember, inviteSchema, listMembers } from "@/server/services/workspace";

export const GET = route({}, ({ ctx }) => listMembers(ctx));
/** Returns a one-time invite link. Email delivery is an adapter boundary (see docs/integrations.md). */
export const POST = route(
  { permission: "members.manage", body: inviteSchema, rateLimit: 30 },
  async ({ ctx, body }) => {
    const r = await inviteMember(ctx, body);
    return { invitation: r.invitation, inviteUrl: `${env().APP_URL}/invite/${r.token}` };
  },
);
