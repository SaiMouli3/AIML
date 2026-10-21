import { z } from "zod";
import { route } from "@/server/http/handler";
import { testInputSchema, testRule } from "@/server/services/automations";

export const POST = route(
  { permission: "automations.manage", body: testInputSchema },
  ({ ctx, params, body }) => testRule(ctx, z.uuid().parse(params.id), body),
);
