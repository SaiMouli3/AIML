"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";

export function RunAnalyst() {
  const { run, isBusy } = useAction();
  const router = useRouter();
  return (
    <Button
      loading={isBusy("a")}
      onClick={() =>
        run(
          "a",
          () =>
            api<{ id: string }>("/agents/runs", {
              body: { role: "analytics_analyst", input: { windowDays: 28 } },
            }),
          { success: "Analyst run queued" },
        ).then((r) => r && router.push(`/ai-team?run=${r.id}`))
      }
    >
      <Sparkles className="h-4 w-4" /> Ask the analyst
    </Button>
  );
}
