import { Lock } from "lucide-react";
import { EmptyState } from "./ui/primitives";

export function Forbidden({ what }: { what: string }) {
  return (
    <EmptyState
      icon={<Lock className="h-5 w-5" />}
      title="You don't have access"
      description={`Your role does not include ${what}. Ask a workspace admin if you need it.`}
    />
  );
}
