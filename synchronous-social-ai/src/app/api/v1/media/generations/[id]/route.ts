import { z } from "zod";
import { route } from "@/server/http/handler";
import { getGeneration } from "@/server/services/media";

export const GET = route({ permission: "content.read" }, ({ ctx, params }) =>
  getGeneration(ctx, z.uuid().parse(params.id)),
);
