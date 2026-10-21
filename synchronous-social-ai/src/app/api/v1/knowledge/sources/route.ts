import { z } from "zod";
import { route } from "@/server/http/handler";
import { AppError } from "@/server/lib/errors";
import { listSources } from "@/server/services/company-brain";
import { addTextSource, uploadKnowledgeSource } from "@/server/services/knowledge";

export const GET = route({ permission: "brain.read" }, ({ ctx }) => listSources(ctx));

/** multipart/form-data with `file`, or JSON { title, text } for pasted content. */
export const POST = route({ permission: "brain.write", rateLimit: 30 }, async ({ ctx, req }) => {
  const type = req.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("VALIDATION_FAILED", "Attach a file");
    if (file.size > 10 * 1024 * 1024) throw new AppError("VALIDATION_FAILED", "Document exceeds 10 MB limit");
    return uploadKnowledgeSource(ctx, { name: file.name, type: file.type, data: Buffer.from(await file.arrayBuffer()) });
  }
  const body = z.object({ title: z.string().trim().min(1).max(200), text: z.string().min(1).max(200_000) }).parse(await req.json());
  return addTextSource(ctx, body.title, body.text);
});
