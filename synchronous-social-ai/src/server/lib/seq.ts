/**
 * Run async thunks one after another. A transaction holds one connection, so queries on `ctx.tx` must
 * not run concurrently (node-postgres would queue them and warn). Use this instead of Promise.all.
 */
export async function seq<const T extends readonly (() => unknown)[]>(
  fns: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const f of fns) out.push(await f());
  return out as never;
}
