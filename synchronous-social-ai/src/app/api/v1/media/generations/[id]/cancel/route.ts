import { z } from "zod";
import { route } from "@/server/http/handler";
import { cancelGeneration } from "@/server/services/media";

export const POST = route({ permission: "media.generate" }, ({ ctx, params }) =>
  cancelGeneration(ctx, z.uuid().parse(params.id)),
);
