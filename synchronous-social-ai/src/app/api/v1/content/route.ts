import { route } from "@/server/http/handler";
import { createContent, createContentSchema, listContent, listContentQuery } from "@/server/services/content";

export const GET = route({ permission: "content.read", query: listContentQuery }, ({ ctx, query }) =>
  listContent(ctx, query),
);
export const POST = route({ permission: "content.write", body: createContentSchema }, ({ ctx, body }) =>
  createContent(ctx, body),
);
