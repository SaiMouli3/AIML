import { randomUUID } from "node:crypto";
export const newId = () => randomUUID();
export const newCorrelationId = () => `corr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
export const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
