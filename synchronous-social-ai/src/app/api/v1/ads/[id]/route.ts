import { z } from "zod";
import { route } from "@/server/http/handler";
import { adDetail, adUpdateSchema, updateAdDraft } from "@/server/services/ads";

export const GET = route({ permission: "campaigns.read" }, ({ ctx, params }) => adDetail(ctx, z.uuid().parse(params.id)));
export const PATCH = route({ permission: "campaigns.write", body: adUpdateSchema }, ({ ctx, params, body }) => updateAdDraft(ctx, z.uuid().parse(params.id), body));
