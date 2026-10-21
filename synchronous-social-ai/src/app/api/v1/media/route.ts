import { route } from "@/server/http/handler";
import { AppError } from "@/server/lib/errors";
import { listMedia, rightsSchema, uploadMedia } from "@/server/services/media";

export const GET = route({ permission: "content.read" }, ({ ctx }) => listMedia(ctx));

/** multipart/form-data: file, altText?, rightsOwner?, rightsLicense?, consent? */
export const POST = route({ permission: "content.write", rateLimit: 60 }, async ({ ctx, req }) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("VALIDATION_FAILED", "Attach a file");
  if (file.size > 300 * 1024 * 1024) throw new AppError("VALIDATION_FAILED", "File too large");
  const rights = rightsSchema.parse({
    owner: form.get("rightsOwner") || undefined,
    license: form.get("rightsLicense") || undefined,
    consent: form.get("consent") === "on" ? true : undefined,
  });
  return uploadMedia(ctx, { name: file.name, type: file.type, data: Buffer.from(await file.arrayBuffer()) }, { altText: String(form.get("altText") ?? "") || undefined, rights });
});
