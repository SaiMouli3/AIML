import { z } from "zod";
import { route } from "@/server/http/handler";
import { addVersion, versionInputSchema } from "@/server/services/content";

export const POST = route({ permission: "content.write", body: versionInputSchema }, ({ ctx, params, body }) => addVersion(ctx, z.uuid().parse(params.id), body));
