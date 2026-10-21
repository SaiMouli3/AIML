import { route } from "@/server/http/handler";
import { listProducts, productSchema, upsertProduct } from "@/server/services/company-brain";

export const GET = route({ permission: "brain.read" }, ({ ctx }) => listProducts(ctx));
export const POST = route({ permission: "brain.write", body: productSchema }, ({ ctx, body }) => upsertProduct(ctx, body));
