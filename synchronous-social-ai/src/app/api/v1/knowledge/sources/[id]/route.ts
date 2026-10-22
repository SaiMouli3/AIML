import { z } from "zod";
import { route } from "@/server/http/handler";
import { deleteSource } from "@/server/services/knowledge";

export const DELETE = route({ permission: "brain.write" }, async ({ ctx, params }) => {
  await deleteSource(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
