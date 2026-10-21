/**
 * Server-side policy engine. Independent of any LLM: agents can only *propose* actions; this module
 * decides whether an action may execute. Pure functions here are unit-tested exhaustively.
 */

export const ACTION_TIERS = {
  // Tier 0 — read
  read_company_facts: 0,
  read_analytics: 0,
  read_provider_metadata: 0,
  // Tier 1 — create internal drafts/plans/media jobs
  create_draft: 1,
  create_plan: 1,
  create_media_job: 1,
  // Tier 2 — reversible internal edits
  edit_draft: 2,
  edit_calendar: 2,
  internal_note: 2,
  // Tier 3 — external public actions
  publish_post: 3,
  public_comment_reply: 3,
  private_comment_reply: 3,
  dm_reply: 3,
  customer_message: 3,
  ad_pause: 3,
  // Tier 4 — financially consequential
  ad_launch: 4,
  ad_resume: 4,
  ad_budget_change: 4,
  commerce_discount: 4,
} as const;

export type ActionType = keyof typeof ACTION_TIERS;
export type Tier = 0 | 1 | 2 | 3 | 4;

export const EXTERNAL_ACTIONS = (Object.keys(ACTION_TIERS) as ActionType[]).filter(
  (a) => ACTION_TIERS[a] >= 3,
);

export const ACTION_LABELS: Record<ActionType, string> = {
  read_company_facts: "Read company facts",
  read_analytics: "Read analytics",
  read_provider_metadata: "Read provider metadata",
  create_draft: "Create draft",
  create_plan: "Create plan",
  create_media_job: "Create media generation job",
  edit_draft: "Edit draft",
  edit_calendar: "Edit calendar",
  internal_note: "Internal note",
  publish_post: "Publish Instagram content",
  public_comment_reply: "Public comment reply",
  private_comment_reply: "Private reply to comment",
  dm_reply: "Direct message reply",
  customer_message: "Customer message",
  ad_pause: "Pause ad campaign",
  ad_launch: "Launch ad campaign",
  ad_resume: "Resume ad campaign",
  ad_budget_change: "Change ad budget",
  commerce_discount: "Activate commerce discount",
};

export const tierOf = (a: ActionType): Tier => ACTION_TIERS[a] as Tier;
export const isActionType = (s: string): s is ActionType => s in ACTION_TIERS;

export interface ApprovalState {
  id: string;
  actionType: string;
  status: string;
  payloadHash: string;
  expiresAt: Date | null;
  executedAt: Date | null;
}

export interface BoundedPolicy {
  id: string;
  enabled: boolean;
  approvalMode: string;
  enabledBy: string | null;
  allowedActionTypes: string[];
  accountId: string | null;
  activeFrom: Date | null;
  activeUntil: Date | null;
  withinRateLimit: boolean;
}

export interface PolicyInput {
  actionType: ActionType;
  actorType: "user" | "agent" | "system" | "worker" | "webhook";
  workspace: { killSwitch: boolean; automationPaused: boolean };
  accountId?: string | null;
  account?: { automationPaused: boolean; status: string; mode: string } | null;
  currentPayloadHash?: string;
  approval?: ApprovalState | null;
  policy?: BoundedPolicy | null;
  mocksAllowed?: boolean;
  now?: Date;
}

export interface PolicyDecision {
  allowed: boolean;
  tier: Tier;
  via: "tier_auto" | "approval" | "bounded_policy" | null;
  reasons: string[];
}

/** Decide whether an action may execute right now. Every denial includes human-readable reasons. */
export function evaluateAction(input: PolicyInput): PolicyDecision {
  const tier = tierOf(input.actionType);
  const now = input.now ?? new Date();
  const reasons: string[] = [];

  if (tier <= 2) return { allowed: true, tier, via: "tier_auto", reasons };

  if (input.workspace.killSwitch)
    reasons.push("Workspace emergency kill switch is active; all external mutations are blocked.");
  if (input.account) {
    if (input.account.status !== "connected") reasons.push(`Destination account is ${input.account.status}.`);
    if (input.account.mode === "mock" && !input.mocksAllowed)
      reasons.push("Mock accounts cannot execute in this environment.");
  }
  if (reasons.length) return { allowed: false, tier, via: null, reasons };

  // Path 1: exact-version human approval.
  if (input.approval) {
    const a = input.approval;
    const approvalReasons: string[] = [];
    if (a.actionType !== input.actionType)
      approvalReasons.push("Approval was granted for a different action type.");
    if (a.status !== "approved") approvalReasons.push(`Approval status is ${a.status}.`);
    if (a.executedAt) approvalReasons.push("Approval has already been used.");
    if (a.expiresAt && a.expiresAt.getTime() <= now.getTime()) approvalReasons.push("Approval has expired.");
    if (!input.currentPayloadHash || input.currentPayloadHash !== a.payloadHash) {
      approvalReasons.push(
        "Content or action details changed after approval; the approval no longer applies.",
      );
    }
    if (approvalReasons.length === 0) return { allowed: true, tier, via: "approval", reasons: [] };
    reasons.push(...approvalReasons);
  }

  // Path 2: bounded automation policy (only for automated actors, never self-granted by agents).
  if (input.policy) {
    const p = input.policy;
    const policyReasons: string[] = [];
    if (!p.enabled) policyReasons.push("Automation rule is disabled.");
    if (p.approvalMode !== "bounded_auto")
      policyReasons.push("Automation rule requires approval for every response.");
    if (!p.enabledBy) policyReasons.push("Automation rule was not enabled by an authorized human.");
    if (!p.allowedActionTypes.includes(input.actionType))
      policyReasons.push("Rule does not authorize this action type.");
    if (p.accountId && input.accountId && p.accountId !== input.accountId)
      policyReasons.push("Rule is scoped to a different account.");
    if (!p.accountId) policyReasons.push("Bounded rules must be scoped to a single account.");
    if (p.activeFrom && now < p.activeFrom) policyReasons.push("Rule is not active yet.");
    if (p.activeUntil && now > p.activeUntil) policyReasons.push("Rule has expired.");
    if (!p.withinRateLimit) policyReasons.push("Rule rate limit reached.");
    if (input.workspace.automationPaused)
      policyReasons.push("Automated replies are paused for this workspace.");
    if (input.account?.automationPaused) policyReasons.push("Automated replies are paused for this account.");
    if (tier >= 4) policyReasons.push("Tier 4 financial actions cannot run under automation rules.");
    if (policyReasons.length === 0) return { allowed: true, tier, via: "bounded_policy", reasons: [] };
    reasons.push(...policyReasons);
  }

  if (!input.approval && !input.policy) reasons.push(`Tier ${tier} actions require explicit approval.`);
  return { allowed: false, tier, via: null, reasons: [...new Set(reasons)] };
}

// ───────────────────────────── Spend controls ─────────────────────────────

export interface SpendCheckInput {
  workspaceMonthlyCapMinor: number;
  committedThisMonthMinor: number;
  dailyBudgetMinor: number;
  durationDays: number | null;
  testMode: boolean;
}

/**
 * Hard spend ceiling enforced before every ads mutation. Open-ended campaigns (no end date) are
 * evaluated as a full 31-day month. A zero cap means "no paid spend allowed".
 */
export function checkSpendCap(i: SpendCheckInput): {
  allowed: boolean;
  projectedMinor: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const days = i.durationDays && i.durationDays > 0 ? Math.min(i.durationDays, 31) : 31;
  const projectedMinor = i.dailyBudgetMinor * days;
  if (!Number.isFinite(i.dailyBudgetMinor) || i.dailyBudgetMinor <= 0)
    reasons.push("Daily budget must be positive.");
  if (i.workspaceMonthlyCapMinor <= 0 && !i.testMode)
    reasons.push("Workspace monthly ad spend cap is 0. Set a cap in Settings before launching.");
  else if (!i.testMode && i.committedThisMonthMinor + projectedMinor > i.workspaceMonthlyCapMinor) {
    reasons.push(
      `Projected spend ${projectedMinor} plus committed ${i.committedThisMonthMinor} exceeds the workspace cap of ${i.workspaceMonthlyCapMinor} (minor units).`,
    );
  }
  return { allowed: reasons.length === 0, projectedMinor, reasons };
}

export function requiredApprovalsFor(
  actionType: ActionType,
  opts: { budgetMinor?: number | null; twoPersonThresholdMinor?: number | null },
): number {
  if (tierOf(actionType) < 4) return 1;
  const threshold = opts.twoPersonThresholdMinor;
  if (threshold && threshold > 0 && (opts.budgetMinor ?? 0) >= threshold) return 2;
  return 1;
}

// ───────────────────────────── Agent tool allowlists ─────────────────────────────

/** Agents can only use tools up to Tier 2. Tier 3/4 always go through approval/policy services. */
export const MAX_AGENT_TOOL_TIER: Tier = 2;

export function agentMayUseTool(allowedTools: readonly string[], tool: string, toolTier: Tier) {
  if (!allowedTools.includes(tool))
    return { allowed: false, reason: `Tool ${tool} is not in this agent's allowlist.` };
  if (toolTier > MAX_AGENT_TOOL_TIER)
    return { allowed: false, reason: `Agents cannot invoke Tier ${toolTier} tools directly.` };
  return { allowed: true, reason: null };
}
