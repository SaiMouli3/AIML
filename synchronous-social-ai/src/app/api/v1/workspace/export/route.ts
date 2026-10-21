import { NextResponse } from "next/server";
import { route } from "@/server/http/handler";
import { exportWorkspace } from "@/server/services/workspace";

export const GET = route({ permission: "workspace.manage", rateLimit: 5 }, async ({ ctx }) => {
  const data = await exportWorkspace(ctx);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="workspace-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
});
