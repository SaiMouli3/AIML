import { z } from "zod";
import { route } from "@/server/http/handler";
import { companyProfileSchema, getProfile, updateProfile } from "@/server/services/company-brain";

export const GET = route({ permission: "brain.read" }, ({ ctx }) => getProfile(ctx));
export const PATCH = route({ permission: "brain.write", body: z.object({ data: companyProfileSchema, expectedVersion: z.number().int().optional() }) }, ({ ctx, body }) =>
  updateProfile(ctx, body.data, body.expectedVersion),
);
