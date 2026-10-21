import { z } from "zod";
import { route } from "@/server/http/handler";
import { contentDetail, scheduleSchema, updateSchedule } from "@/server/services/content";

export const GET = route({ permission: "content.read" }, ({ ctx, params }) => contentDetail(ctx, z.uuid().parse(params.id)));
/** Destination/schedule/metadata edits. Material changes invalidate open approvals. */
export const PATCH = route({ permission: "content.write", body: scheduleSchema }, ({ ctx, params, body }) => updateSchedule(ctx, z.uuid().parse(params.id), body));
