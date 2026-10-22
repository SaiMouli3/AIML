import { z } from "zod";
import { route } from "@/server/http/handler";
import { addAllowedDomain, listAllowedDomains, removeAllowedDomain } from "@/server/services/company-brain";

export const GET = route({ permission: "brain.read" }, ({ ctx }) => listAllowedDomains(ctx));
export const POST = route(
  { permission: "brain.write", body: z.object({ domain: z.string().min(3).max(253) }) },
  async ({ ctx, body }) => ({ domain: await addAllowedDomain(ctx, body.domain) }),
);
export const DELETE = route(
  { permission: "brain.write", query: z.object({ domain: z.string().min(3).max(253) }) },
  async ({ ctx, query }) => {
    await removeAllowedDomain(ctx, query.domain);
    return { ok: true };
  },
);
