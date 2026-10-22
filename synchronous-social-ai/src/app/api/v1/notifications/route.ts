import { route } from "@/server/http/handler";
import { listNotifications } from "@/server/services/notifications";

export const GET = route({}, ({ ctx }) => listNotifications(ctx));
