"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";

/** Wraps a mutation: busy state, error toast with server-provided reasons, refresh on success. */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, opts: { success?: string; refresh?: boolean } = {}): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (opts.success) toast.success(opts.success);
        if (opts.refresh !== false) router.refresh();
        return r;
      } catch (e) {
        if (e instanceof ApiError) {
          toast.error(e.message, { description: e.lines.length ? e.lines.slice(0, 6).join(" · ") : e.correlationId ? `Ref ${e.correlationId}` : undefined });
        } else toast.error("Something went wrong");
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [router],
  );
  return { run, busy, isBusy: (k: string) => busy === k };
}
