import { describe, expect, it } from "vitest";
import {
  agentMayUseTool,
  checkSpendCap,
  evaluateAction,
  requiredApprovalsFor,
  tierOf,
  type BoundedPolicy,
} from "@/server/policy/policy";

const ws = { killSwitch: false, automationPaused: false };
const acct = { automationPaused: false, status: "connected", mode: "live" };
const approved = {
  id: "a1",
  actionType: "publish_post",
  status: "approved",
  payloadHash: "h1",
  expiresAt: new Date(Date.now() + 3600_000),
  executedAt: null,
};
const policy: BoundedPolicy = {
  id: "r1",
  enabled: true,
  approvalMode: "bounded_auto",
  enabledBy: "u1",
  allowedActionTypes: ["private_comment_reply"],
  accountId: "acc1",
  activeFrom: null,
  activeUntil: null,
  withinRateLimit: true,
};

describe("permission tiers", () => {
  it("maps actions to tiers", () => {
    expect(tierOf("read_analytics")).toBe(0);
    expect(tierOf("create_draft")).toBe(1);
    expect(tierOf("edit_draft")).toBe(2);
    expect(tierOf("publish_post")).toBe(3);
    expect(tierOf("private_comment_reply")).toBe(3);
    expect(tierOf("ad_launch")).toBe(4);
    expect(tierOf("commerce_discount")).toBe(4);
  });
  it("allows tier 0-2 without approval", () => {
    expect(evaluateAction({ actionType: "edit_draft", actorType: "agent", workspace: ws }).allowed).toBe(
      true,
    );
  });
  it("requires approval for tier 3 and 4 by default", () => {
    const d = evaluateAction({
      actionType: "publish_post",
      actorType: "worker",
      workspace: ws,
      account: acct,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/explicit approval/);
    expect(
      evaluateAction({ actionType: "ad_launch", actorType: "worker", workspace: ws, account: acct }).allowed,
    ).toBe(false);
  });
});

describe("approval binding", () => {
  it("allows an approved, unexpired, matching payload", () => {
    const d = evaluateAction({
      actionType: "publish_post",
      actorType: "worker",
      workspace: ws,
      account: acct,
      approval: approved,
      currentPayloadHash: "h1",
    });
    expect(d).toMatchObject({ allowed: true, via: "approval" });
  });
  it("rejects when payload changed after approval", () => {
    const d = evaluateAction({
      actionType: "publish_post",
      actorType: "worker",
      workspace: ws,
      account: acct,
      approval: approved,
      currentPayloadHash: "h2",
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/changed after approval/);
  });
  it("rejects expired, used, pending or mismatched-type approvals", () => {
    for (const a of [
      { ...approved, expiresAt: new Date(Date.now() - 1) },
      { ...approved, executedAt: new Date() },
      { ...approved, status: "pending" },
      { ...approved, actionType: "dm_reply" },
    ]) {
      expect(
        evaluateAction({
          actionType: "publish_post",
          actorType: "worker",
          workspace: ws,
          account: acct,
          approval: a,
          currentPayloadHash: "h1",
        }).allowed,
      ).toBe(false);
    }
  });
  it("kill switch blocks even approved actions", () => {
    const d = evaluateAction({
      actionType: "publish_post",
      actorType: "worker",
      workspace: { ...ws, killSwitch: true },
      account: acct,
      approval: approved,
      currentPayloadHash: "h1",
    });
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/kill switch/);
  });
  it("blocks disconnected accounts and mock accounts outside dev", () => {
    expect(
      evaluateAction({
        actionType: "publish_post",
        actorType: "worker",
        workspace: ws,
        account: { ...acct, status: "token_expired" },
        approval: approved,
        currentPayloadHash: "h1",
      }).allowed,
    ).toBe(false);
    expect(
      evaluateAction({
        actionType: "publish_post",
        actorType: "worker",
        workspace: ws,
        account: { ...acct, mode: "mock" },
        approval: approved,
        currentPayloadHash: "h1",
        mocksAllowed: false,
      }).allowed,
    ).toBe(false);
  });
});

describe("bounded automation policies", () => {
  const base = {
    actionType: "private_comment_reply" as const,
    actorType: "worker" as const,
    workspace: ws,
    account: acct,
    accountId: "acc1",
  };
  it("allows a matching, enabled, human-enabled rule", () => {
    expect(evaluateAction({ ...base, policy }).via).toBe("bounded_policy");
  });
  it.each([
    [{ enabled: false }, /disabled/],
    [{ approvalMode: "approve_every" }, /every response/],
    [{ enabledBy: null }, /authorized human/],
    [{ allowedActionTypes: ["public_comment_reply"] }, /does not authorize/],
    [{ accountId: "other" }, /different account/],
    [{ accountId: null }, /single account/],
    [{ activeUntil: new Date(Date.now() - 1000) }, /expired/],
    [{ withinRateLimit: false }, /rate limit/],
  ])("denies %o", (patch, re) => {
    const d = evaluateAction({ ...base, policy: { ...policy, ...patch } as BoundedPolicy });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(" ")).toMatch(re);
  });
  it("respects workspace and account pause", () => {
    expect(evaluateAction({ ...base, workspace: { ...ws, automationPaused: true }, policy }).allowed).toBe(
      false,
    );
    expect(evaluateAction({ ...base, account: { ...acct, automationPaused: true }, policy }).allowed).toBe(
      false,
    );
  });
  it("never allows tier 4 via automation", () => {
    const d = evaluateAction({
      actionType: "ad_launch",
      actorType: "worker",
      workspace: ws,
      account: acct,
      accountId: "acc1",
      policy: { ...policy, allowedActionTypes: ["ad_launch"] },
    });
    expect(d.allowed).toBe(false);
  });
});

describe("spend caps", () => {
  it("blocks launches that exceed the monthly cap", () => {
    const r = checkSpendCap({
      workspaceMonthlyCapMinor: 100_00,
      committedThisMonthMinor: 50_00,
      dailyBudgetMinor: 20_00,
      durationDays: 3,
      testMode: false,
    });
    expect(r.allowed).toBe(false);
    expect(r.projectedMinor).toBe(60_00);
  });
  it("treats open-ended campaigns as a full month", () => {
    expect(
      checkSpendCap({
        workspaceMonthlyCapMinor: 1000_00,
        committedThisMonthMinor: 0,
        dailyBudgetMinor: 40_00,
        durationDays: null,
        testMode: false,
      }).allowed,
    ).toBe(false);
  });
  it("zero cap blocks all live spend", () => {
    expect(
      checkSpendCap({
        workspaceMonthlyCapMinor: 0,
        committedThisMonthMinor: 0,
        dailyBudgetMinor: 1_00,
        durationDays: 1,
        testMode: false,
      }).allowed,
    ).toBe(false);
  });
  it("allows within cap", () => {
    expect(
      checkSpendCap({
        workspaceMonthlyCapMinor: 1000_00,
        committedThisMonthMinor: 0,
        dailyBudgetMinor: 10_00,
        durationDays: 3,
        testMode: false,
      }).allowed,
    ).toBe(true);
  });
  it("two-person approval above threshold for tier 4 only", () => {
    expect(
      requiredApprovalsFor("ad_launch", { budgetMinor: 2000_00, twoPersonThresholdMinor: 1000_00 }),
    ).toBe(2);
    expect(requiredApprovalsFor("ad_launch", { budgetMinor: 500_00, twoPersonThresholdMinor: 1000_00 })).toBe(
      1,
    );
    expect(requiredApprovalsFor("publish_post", { budgetMinor: 5000_00, twoPersonThresholdMinor: 1 })).toBe(
      1,
    );
  });
});

describe("agent tool allowlists", () => {
  it("denies tools outside the allowlist and any tier 3+ tool", () => {
    expect(agentMayUseTool(["read_company_facts"], "read_company_facts", 0).allowed).toBe(true);
    expect(agentMayUseTool(["read_company_facts"], "search_knowledge", 0).allowed).toBe(false);
    expect(agentMayUseTool(["execute_approved_ad_action"], "execute_approved_ad_action", 4).allowed).toBe(
      false,
    );
  });
});
