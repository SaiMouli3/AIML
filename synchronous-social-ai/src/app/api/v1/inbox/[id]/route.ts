import { z } from "zod";
import { route } from "@/server/http/handler";
import { conversationDetail } from "@/server/services/inbox";

export const GET = route({ permission: "inbox.read" }, ({ ctx, params }) => conversationDetail(ctx, z.uuid().parse(params.id)));
