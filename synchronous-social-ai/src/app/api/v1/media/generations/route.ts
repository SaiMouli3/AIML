import { route } from "@/server/http/handler";
import { createGeneration, generationSchema, listGenerations } from "@/server/services/media";

export const GET = route({ permission: "content.read" }, ({ ctx }) => listGenerations(ctx));
export const POST = route(
  { permission: "media.generate", body: generationSchema, rateLimit: 30 },
  ({ ctx, body }) => createGeneration(ctx, body),
);
