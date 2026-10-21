"use client";

import { AlertOctagon, Download, RotateCcw, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ConfirmButton, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlay";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";
import { fmtDateTime, fmtMoney, fmtRelative, sentence } from "@/lib/format";

interface Data {
  workspace: {
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    killSwitch: boolean;
    killSwitchReason: string | null;
    killSwitchAt: string | null;
    automationPaused: boolean;
    monthlyAdSpendCapMinor: number;
    settings: {
      twoPersonApprovalAdBudgetMinor?: number;
      llmMonthlyBudgetUsd?: number;
      mediaMonthlyBudgetUsd?: number;
      approvalExpiryHours?: number;
      retentionDays?: number;
    };
  };
  usage: {
    since: string;
    rows: Array<{
      kind: string;
      provider: string;
      model: string | null;
      qty: number;
      cost: number;
      n: number;
      estimated: boolean;
    }>;
    budgets: {
      llmMonthlyBudgetUsd: number | null;
      mediaMonthlyBudgetUsd: number | null;
      adSpendCapMinor: number;
    };
    note: string;
  } | null;
  jobs: {
    items: Array<{
      id: string;
      type: string;
      status: string;
      attempts: number;
      maxAttempts: number;
      lastError: string | null;
      runAt: string;
      updatedAt: string;
    }>;
    counts: Record<string, number>;
  } | null;
  unknown: Array<{
    id: string;
    actionType: string;
    provider: string;
    subjectType: string;
    error: string | null;
    createdAt: string;
    mode: string;
  }>;
  audit: {
    items: Array<{
      id: string;
      actorType: string;
      actorId: string | null;
      action: string;
      targetType: string | null;
      targetId: string | null;
      result: string;
      provider: string | null;
      correlationId: string | null;
      metadata: Record<string, unknown>;
      createdAt: string;
    }>;
  } | null;
}

export function SettingsClient({
  data,
  isOwner,
  canManage,
  canKill,
  appEnv,
  testMode,
}: {
  data: Data;
  isOwner: boolean;
  canManage: boolean;
  canKill: boolean;
  appEnv: string;
  testMode: boolean;
}) {
  const { run, isBusy } = useAction();
  const w = data.workspace;
  const [auditFilter, setAuditFilter] = useState("");
  const audit = (data.audit?.items ?? []).filter((a) => !auditFilter || a.action.startsWith(auditFilter));
  return (
    <Tabs defaultValue="workspace">
      <TabsList className="mb-5 flex-wrap">
        <TabsTrigger value="workspace">Workspace & safety</TabsTrigger>
        {data.usage ? <TabsTrigger value="usage">Usage & budgets</TabsTrigger> : null}
        {data.jobs ? (
          <TabsTrigger value="ops" count={(data.jobs.counts.dead ?? 0) + data.unknown.length || undefined}>
            Operations
          </TabsTrigger>
        ) : null}
        {data.audit ? <TabsTrigger value="audit">Audit log</TabsTrigger> : null}
      </TabsList>
      <TabsContent value="workspace" className="space-y-6">
        <Card className={w.killSwitch ? "border-danger-600/40" : ""}>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <AlertOctagon className="text-danger-600 h-4 w-4" /> Emergency kill switch
              </span>
            }
            description="Blocks all publishing, messaging and ad mutations immediately and holds external jobs in the queue. Internal drafting continues."
            actions={w.killSwitch ? <Badge tone="danger">ACTIVE</Badge> : <Badge tone="success">Off</Badge>}
          />
          <CardBody className="flex flex-wrap items-center gap-3">
            {w.killSwitch ? (
              <p className="text-fg-muted flex-1 text-[13px]">
                Activated {fmtRelative(w.killSwitchAt)}
                {w.killSwitchReason ? ` — ${w.killSwitchReason}` : ""}. Note: ads already live at Meta keep
                delivering until paused there or via an approved pause.
              </p>
            ) : (
              <p className="text-fg-muted flex-1 text-[13px]">
                Use during incidents, account compromise or suspected misuse.
              </p>
            )}
            {canKill ? (
              w.killSwitch ? (
                <ConfirmButton
                  variant="primary"
                  label="Deactivate"
                  title="Deactivate kill switch?"
                  effect="Held jobs resume. Approvals that expired meanwhile stay expired."
                  confirmLabel="Deactivate"
                  onConfirm={() =>
                    run("ks", () => api("/workspace/kill-switch", { body: { active: false } }), {
                      success: "Kill switch deactivated",
                    }).then(() => undefined)
                  }
                />
              ) : (
                <ConfirmButton
                  variant="danger"
                  label="Activate kill switch"
                  title="Activate kill switch?"
                  effect="Every external action in this workspace is blocked until an admin turns it off."
                  confirmLabel="Activate"
                  reason={{ label: "Reason", required: true }}
                  onConfirm={(r) =>
                    run("ks", () => api("/workspace/kill-switch", { body: { active: true, reason: r } }), {
                      success: "Kill switch ACTIVE",
                    }).then(() => undefined)
                  }
                />
              )
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Workspace"
            description={`Environment: ${appEnv}${testMode ? " · ads test mode ON" : ""}`}
          />
          <CardBody>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const n = (k: string) =>
                  String(f.get(k) ?? "").trim() === "" ? undefined : Number(f.get(k));
                void run(
                  "save",
                  () =>
                    api("/workspace", {
                      method: "PATCH",
                      body: {
                        name: String(f.get("name")),
                        timezone: String(f.get("timezone")),
                        currency: String(f.get("currency")).toUpperCase(),
                        monthlyAdSpendCapMinor: Math.round((n("cap") ?? 0) * 100),
                        settings: {
                          twoPersonApprovalAdBudgetMinor:
                            n("twoPerson") !== undefined ? Math.round(n("twoPerson")! * 100) : undefined,
                          llmMonthlyBudgetUsd: n("llm"),
                          mediaMonthlyBudgetUsd: n("media"),
                          approvalExpiryHours: n("expiry"),
                          retentionDays: n("retention"),
                        },
                      },
                    }),
                  { success: "Settings saved (audited)" },
                );
              }}
              className="grid gap-4 md:grid-cols-3"
            >
              <Field label="Name" htmlFor="w-name">
                <Input id="w-name" name="name" defaultValue={w.name} disabled={!canManage} />
              </Field>
              <Field label="Timezone (IANA)" htmlFor="w-tz">
                <Input id="w-tz" name="timezone" defaultValue={w.timezone} disabled={!canManage} />
              </Field>
              <Field label="Currency" htmlFor="w-cur">
                <Input
                  id="w-cur"
                  name="currency"
                  defaultValue={w.currency}
                  maxLength={3}
                  disabled={!canManage}
                />
              </Field>
              <Field
                label="Monthly ad spend cap"
                htmlFor="w-cap"
                hint="Hard ceiling checked before every ads mutation. 0 blocks live spend."
              >
                <Input
                  id="w-cap"
                  name="cap"
                  inputMode="decimal"
                  defaultValue={(w.monthlyAdSpendCapMinor / 100).toFixed(2)}
                  disabled={!canManage}
                />
              </Field>
              <Field
                label="Two-person approval above"
                htmlFor="w-2p"
                hint="Total campaign budget requiring two approvers."
              >
                <Input
                  id="w-2p"
                  name="twoPerson"
                  inputMode="decimal"
                  defaultValue={
                    w.settings.twoPersonApprovalAdBudgetMinor
                      ? (w.settings.twoPersonApprovalAdBudgetMinor / 100).toFixed(2)
                      : ""
                  }
                  disabled={!canManage}
                />
              </Field>
              <Field label="Approval expiry (hours)" htmlFor="w-exp">
                <Input
                  id="w-exp"
                  name="expiry"
                  type="number"
                  min={1}
                  defaultValue={w.settings.approvalExpiryHours ?? 72}
                  disabled={!canManage}
                />
              </Field>
              <Field label="LLM monthly budget (USD)" htmlFor="w-llm" hint="Agent runs stop when exceeded.">
                <Input
                  id="w-llm"
                  name="llm"
                  inputMode="decimal"
                  defaultValue={w.settings.llmMonthlyBudgetUsd ?? ""}
                  disabled={!canManage}
                />
              </Field>
              <Field label="Media monthly budget (USD)" htmlFor="w-media">
                <Input
                  id="w-media"
                  name="media"
                  inputMode="decimal"
                  defaultValue={w.settings.mediaMonthlyBudgetUsd ?? ""}
                  disabled={!canManage}
                />
              </Field>
              <Field label="Data retention (days)" htmlFor="w-ret">
                <Input
                  id="w-ret"
                  name="retention"
                  type="number"
                  min={30}
                  defaultValue={w.settings.retentionDays ?? ""}
                  disabled={!canManage}
                />
              </Field>
              {canManage ? (
                <div className="flex justify-end md:col-span-3">
                  <Button type="submit" variant="primary" loading={isBusy("save")}>
                    Save settings
                  </Button>
                </div>
              ) : null}
            </form>
          </CardBody>
        </Card>
        {canManage ? (
          <Card>
            <CardHeader title="Data export & offboarding" />
            <CardBody className="flex flex-wrap items-center gap-3">
              <a href="/api/v1/workspace/export" download>
                <Button>
                  <Download className="h-4 w-4" /> Export workspace data (JSON)
                </Button>
              </a>
              <span className="text-fg-muted flex-1 text-[12.5px]">
                Includes profile, facts, catalog, content and versions, approvals, inbox, campaigns, rules and
                audit log. Tokens are never exported.
              </span>
              {isOwner ? (
                <ConfirmButton
                  variant="danger"
                  label={
                    <>
                      <Trash2 className="h-4 w-4" /> Delete workspace
                    </>
                  }
                  title="Permanently delete this workspace?"
                  effect="All tenant data and stored files are deleted. Connected provider tokens are destroyed. This cannot be undone."
                  requireText={w.slug}
                  confirmLabel="Delete forever"
                  onConfirm={async () => {
                    await run(
                      "del",
                      () => api("/workspace", { method: "DELETE", body: { confirmSlug: w.slug } }),
                      { success: "Workspace deleted", refresh: false },
                    );
                    window.location.assign("/onboarding");
                  }}
                />
              ) : null}
            </CardBody>
          </Card>
        ) : null}
      </TabsContent>
      {data.usage ? (
        <TabsContent value="usage">
          <Card>
            <CardHeader title="This month" description={data.usage.note} />
            {data.usage.rows.length === 0 ? (
              <EmptyState title="No usage recorded this month" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Type</Th>
                    <Th>Provider</Th>
                    <Th>Model</Th>
                    <Th>Events</Th>
                    <Th>Quantity</Th>
                    <Th>Cost (USD)</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.usage.rows.map((r, i) => (
                    <tr key={i}>
                      <Td>{sentence(r.kind)}</Td>
                      <Td>{r.provider === "mock" ? <Badge tone="warning">mock</Badge> : r.provider}</Td>
                      <Td className="text-[12.5px]">{r.model ?? "—"}</Td>
                      <Td>{r.n}</Td>
                      <Td className="tabular-nums">{r.qty.toLocaleString()}</Td>
                      <Td className="tabular-nums">
                        ${r.cost.toFixed(4)} {r.estimated ? <Badge>est.</Badge> : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <CardBody className="text-fg-muted text-[12.5px]">
              Budgets: LLM{" "}
              {data.usage.budgets.llmMonthlyBudgetUsd !== null
                ? `$${data.usage.budgets.llmMonthlyBudgetUsd}`
                : "unlimited"}{" "}
              · Media{" "}
              {data.usage.budgets.mediaMonthlyBudgetUsd !== null
                ? `$${data.usage.budgets.mediaMonthlyBudgetUsd}`
                : "unlimited"}{" "}
              · Ad spend cap {fmtMoney(data.usage.budgets.adSpendCapMinor, w.currency)}
            </CardBody>
          </Card>
        </TabsContent>
      ) : null}
      {data.jobs ? (
        <TabsContent value="ops" className="space-y-6">
          {data.unknown.length ? (
            <Card className="border-warning-600/40">
              <CardHeader
                title="External actions with an unknown outcome"
                description="The provider response was ambiguous. Check the provider directly, then record what happened. These are never retried automatically."
              />
              <ul className="divide-border divide-y">
                {data.unknown.map((u) => (
                  <UnknownRow key={u.id} u={u} />
                ))}
              </ul>
            </Card>
          ) : null}
          <Card>
            <CardHeader
              title="Background jobs"
              description={
                Object.entries(data.jobs.counts)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ") || "No jobs yet"
              }
            />
            {data.jobs.items.length === 0 ? (
              <EmptyState title="No jobs yet" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Type</Th>
                    <Th>Status</Th>
                    <Th>Attempts</Th>
                    <Th>Last error</Th>
                    <Th>Updated</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {data.jobs.items.map((j) => (
                    <tr key={j.id}>
                      <Td className="font-mono text-[12px]">{j.type}</Td>
                      <Td>
                        <StatusBadge status={j.status} />
                      </Td>
                      <Td className="tabular-nums">
                        {j.attempts}/{j.maxAttempts}
                      </Td>
                      <Td
                        className="text-danger-600 max-w-[320px] truncate text-[12px]"
                        title={j.lastError ?? undefined}
                      >
                        {j.lastError ?? ""}
                      </Td>
                      <Td className="text-fg-muted text-[12.5px]">{fmtRelative(j.updatedAt)}</Td>
                      <Td className="text-right">
                        {["dead", "failed"].includes(j.status) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              run(`r${j.id}`, () => api(`/operations/jobs/${j.id}/retry`, { body: {} }), {
                                success: "Requeued",
                              })
                            }
                          >
                            <RotateCcw className="h-3.5 w-3.5" /> Retry
                          </Button>
                        ) : null}
                        {j.status === "queued" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              run(`c${j.id}`, () => api(`/operations/jobs/${j.id}/cancel`, { body: {} }), {
                                success: "Cancelled",
                              })
                            }
                          >
                            <XCircle className="h-3.5 w-3.5" /> Cancel
                          </Button>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </TabsContent>
      ) : null}
      {data.audit ? (
        <TabsContent value="audit">
          <Card>
            <CardHeader
              title="Audit log"
              description="Append-only. Secrets, tokens, emails and signed URLs are redacted."
              actions={
                <Select
                  aria-label="Filter audit events"
                  className="h-8 w-[200px] text-[12.5px]"
                  value={auditFilter}
                  onChange={(e) => setAuditFilter(e.target.value)}
                >
                  <option value="">All events</option>
                  {[
                    "approval.",
                    "external.",
                    "inbox.",
                    "content.",
                    "ads.",
                    "budget.",
                    "integration.",
                    "members.",
                    "automation.",
                    "operations.",
                    "agent.",
                    "brain.",
                  ].map((p) => (
                    <option key={p} value={p}>
                      {p.replace(".", "")}
                    </option>
                  ))}
                </Select>
              }
            />
            <Table>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Target</Th>
                  <Th>Result</Th>
                  <Th>Correlation</Th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <Td className="text-fg-muted text-[12px] whitespace-nowrap">
                      {fmtDateTime(a.createdAt)}
                    </Td>
                    <Td className="text-[12px]">{a.actorType}</Td>
                    <Td>
                      <div className="font-mono text-[12px]">{a.action}</div>
                      {Object.keys(a.metadata).length ? (
                        <div className="text-fg-subtle line-clamp-1 max-w-[380px] text-[11.5px]">
                          {JSON.stringify(a.metadata)}
                        </div>
                      ) : null}
                    </Td>
                    <Td className="text-fg-muted text-[12px]">
                      {a.targetType ?? ""}
                      {a.provider ? ` · ${a.provider}` : ""}
                    </Td>
                    <Td>
                      <StatusBadge
                        status={
                          a.result === "success" ? "succeeded" : a.result === "failure" ? "failed" : a.result
                        }
                        label={a.result}
                      />
                    </Td>
                    <Td className="text-fg-subtle font-mono text-[11px]">{a.correlationId?.slice(0, 14)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

function UnknownRow({ u }: { u: Data["unknown"][number] }) {
  const { run } = useAction();
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">
          {sentence(u.actionType)} · {u.provider}{" "}
          {u.mode === "mock" ? <Badge tone="warning">Mock</Badge> : null}
        </div>
        <div className="text-fg-muted text-[12px]">
          {fmtDateTime(u.createdAt)} · {u.error}
        </div>
      </div>
      <ConfirmButton
        size="sm"
        label="It was sent"
        title="Record as sent"
        effect="Marks the action as succeeded without re-sending."
        confirmLabel="Record"
        reason={{ label: "How did you verify?", required: true }}
        onConfirm={(r) =>
          run(
            "s",
            () => api(`/operations/actions/${u.id}/resolve`, { body: { resolution: "sent", note: r } }),
            { success: "Recorded" },
          ).then(() => undefined)
        }
      />
      <ConfirmButton
        size="sm"
        label="It was not sent"
        title="Record as not sent"
        effect="Marks it failed. A new approved attempt can then be made."
        confirmLabel="Record"
        reason={{ label: "How did you verify?", required: true }}
        onConfirm={(r) =>
          run(
            "n",
            () => api(`/operations/actions/${u.id}/resolve`, { body: { resolution: "not_sent", note: r } }),
            { success: "Recorded" },
          ).then(() => undefined)
        }
      />
    </li>
  );
}
