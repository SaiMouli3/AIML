import { Badge } from "./ui/primitives";
import { sentence } from "@/lib/format";

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const CONTENT: Record<string, [Tone, string]> = {
  concept: ["neutral", "Concept"],
  draft: ["neutral", "Draft"],
  in_review: ["info", "In review"],
  approved: ["brand", "Approved"],
  scheduled: ["brand", "Scheduled"],
  publishing: ["warning", "Publishing…"],
  published: ["success", "Published"],
  failed: ["danger", "Failed"],
  archived: ["neutral", "Archived"],
};
const GENERIC: Record<string, Tone> = {
  pending: "warning",
  pending_approval: "warning",
  awaiting_approval: "warning",
  approved: "brand",
  executed: "success",
  succeeded: "success",
  sent: "success",
  completed: "success",
  connected: "success",
  available: "success",
  active: "success",
  ready: "success",
  handled: "success",
  launched_paused: "info",
  rejected: "danger",
  failed: "danger",
  dead: "danger",
  blocked: "danger",
  nsfw: "danger",
  token_expired: "danger",
  revoked: "danger",
  error: "danger",
  needs_human: "danger",
  unavailable: "neutral",
  invalidated: "neutral",
  expired: "neutral",
  cancelled: "neutral",
  canceled: "neutral",
  discarded: "neutral",
  disconnected: "neutral",
  ignored: "neutral",
  changes_requested: "warning",
  needs_input: "warning",
  NEEDS_INPUT: "warning",
  unknown: "warning",
  queued: "info",
  submitted: "info",
  in_progress: "info",
  running: "info",
  sending: "info",
  REQUESTED: "info",
  PLANNING: "info",
  DRAFTING: "info",
  VALIDATING: "info",
  SUCCEEDED: "success",
  FAILED: "danger",
  CANCELLED: "neutral",
  timed_out: "danger",
  open: "info",
};

export function ContentStatus({ status }: { status: string }) {
  const [tone, label] = CONTENT[status] ?? ["neutral", sentence(status)];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <Badge tone={GENERIC[status] ?? "neutral"} dot>
      {label ?? sentence(status.toLowerCase())}
    </Badge>
  );
}

/** Every provider-backed object shows whether it is LIVE or a development MOCK. */
export function ModeBadge({ mode }: { mode: string | null | undefined }) {
  if (!mode) return null;
  return mode === "mock" ? (
    <Badge tone="warning" className="tracking-wide uppercase">
      Mock
    </Badge>
  ) : (
    <Badge tone="success" className="tracking-wide uppercase">
      Live
    </Badge>
  );
}

export function TierBadge({ tier }: { tier: number }) {
  return <Badge tone={tier >= 4 ? "danger" : tier === 3 ? "warning" : "neutral"}>{`Tier ${tier}`}</Badge>;
}
