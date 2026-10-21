import { z } from "zod";
import { route } from "@/server/http/handler";
import { archiveProduct, productSchema, upsertProduct } from "@/server/services/company-brain";

export const PATCH = route({ permission: "brain.write", body: productSchema }, ({ ctx, body, params }) =>
  upsertProduct(ctx, body, z.uuid().parse(params.id)),
);
export const DELETE = route({ permission: "brain.write" }, async ({ ctx, params }) => {
  await archiveProduct(ctx, z.uuid().parse(params.id));
  return { ok: true };
});
