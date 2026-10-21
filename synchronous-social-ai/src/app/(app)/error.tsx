"use client";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import { AlertTriangle } from "lucide-react";

export default function Error({ reset, error }: { reset: () => void; error: Error & { digest?: string } }) {
  return (
    <EmptyState
      icon={<AlertTriangle className="h-5 w-5" />}
      title="This page could not be loaded"
      description={`Something went wrong on our side.${error.digest ? ` Reference: ${error.digest}` : ""}`}
      action={<Button onClick={reset}>Try again</Button>}
    />
  );
}
