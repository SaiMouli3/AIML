import { route } from "@/server/http/handler";
import { inboxQuery, listConversations } from "@/server/services/inbox";

export const GET = route({ permission: "inbox.read", query: inboxQuery }, ({ ctx, query }) =>
  listConversations(ctx, query),
);
