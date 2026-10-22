"use client";

import { Bot, Play, RotateCcw, ShieldOff, Square, Wrench } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Dialog, Drawer, Switch } from "@/components/ui/overlay";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Notice,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";
import { fmtDateTime, fmtRelative, sentence } from "@/lib/format";

interface Agent {
  role: string;
  title: string;
  purpose: string;
  nonGoals: string[];
  allowedTools: string[];
  disallowedActions: string[];
  model: string;
  maxSteps: number;
  budgetUsdPerRun: number;
  timeoutMs: number;
  escalation: string[];
  sourceRequirements: string;
}
interface Run {
  id: string;
  agentRole: string;
  state: string;
  provider: string | null;
  model: string | null;
  costUsd: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number | null;
  steps: number;
  error: string | null;
  createdAt: string;
  output: { result?: unknown; escalationReasons?: string[] } | null;
  input: Record<string, unknown>;
}
interface Data {
  runs: Run[];
  settings: Array<{ role: string; paused: boolean }>;
  detail: {
    run: Run;
    messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
    tools: Array<{
      id: string;
      tool: string;
      tier: number;
      allowed: boolean;
      reason: string | null;
      createdAt: string;
    }>;
  } | null;
}

/** Roles a user can run directly from this page, with the input fields they need. */
const RUNNABLE: Record<
  string,
  Array<{ key: string; label: string; type?: "number" | "textarea"; default?: string }>
> = {
  marketing_strategist: [
    { key: "goal", label: "Goal", type: "textarea", default: "Grow online orders for our new product line" },
    { key: "horizonDays", label: "Horizon (days)", type: "number", default: "30" },
  ],
  audience_research: [{ key: "objective", label: "Objective", type: "textarea" }],
  content_copywriter: [
    { key: "brief", label: "Brief", type: "textarea" },
    { key: "format", label: "Format (post/carousel/story/reel)", default: "post" },
  ],
  creative_director: [
    { key: "brief", label: "Brief", type: "textarea" },
    { key: "format", label: "Format", default: "reel" },
  ],
  ads_strategist: [
    { key: "goal", label: "Goal", type: "textarea" },
    { key: "dailyBudgetMinor", label: "Daily budget (minor units, e.g. 2000 = $20)", type: "number" },
    { key: "durationDays", label: "Duration (days)", type: "number" },
  ],
  analytics_analyst: [{ key: "windowDays", label: "Window (days)", type: "number", default: "28" }],
  compliance_reviewer: [
    { key: "text", label: "Copy to review", type: "textarea" },
    { key: "channel", label: "Channel", default: "instagram" },
  ],
};

export function AiTeamClient({
  data,
  agents,
  canRun,
  canManage,
  llmConfigured,
}: {
  data: Data;
  agents: Agent[];
  canRun: boolean;
  canManage: boolean;
  llmConfigured: boolean;
}) {
  const { run } = useAction();
  const router = useRouter();
  const path = usePathname();
  const [start, setStart] = useState<Agent | null>(null);
  return (
    <>
      {!llmConfigured ? (
        <Notice tone="warning" title="No LLM provider configured" className="mb-5">
          Agents use a deterministic mock. Outputs are labelled “Mock LLM” and are placeholders, not real
          drafts.
        </Notice>
      ) : null}
      <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((a) => {
          const paused = data.settings.find((s) => s.role === a.role)?.paused ?? false;
          const runs = data.runs.filter((r) => r.agentRole === a.role);
          const last = runs[0];
          const cost = runs.reduce((s, r) => s + Number(r.costUsd), 0);
          return (
            <Card key={a.role} className="flex flex-col">
              <CardBody className="flex-1">
                <div className="flex items-start gap-3">
                  <div className="bg-brand-50 text-brand-600 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                    <Bot className="h-4.5 w-4.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[14px] font-semibold">{a.title}</h3>
                      {paused ? (
                        <Badge tone="warning">Paused</Badge>
                      ) : (
                        <Badge tone="success">Available</Badge>
                      )}
                    </div>
                    <p className="text-fg-muted mt-1 text-[12.5px]">{a.purpose}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {a.allowedTools.map((t) => (
                    <Badge key={t}>
                      <Wrench className="h-3 w-3" /> {t}
                    </Badge>
                  ))}
                </div>
                <div className="text-fg-subtle mt-3 text-[12px]">
                  {a.model === "none"
                    ? "Deterministic (no LLM)"
                    : `${a.model === "fast" ? "Fast" : "Default"} model · ≤${a.maxSteps} steps · ≤$${a.budgetUsdPerRun}/run · ${a.timeoutMs / 1000}s timeout`}
                </div>
                <div className="text-fg-muted mt-2 text-[12px]">
                  Last run:{" "}
                  {last ? (
                    <>
                      {fmtRelative(last.createdAt)} · <StatusBadge status={last.state} />
                    </>
                  ) : (
                    "never"
                  )}{" "}
                  · {runs.length} runs · ${cost.toFixed(4)}
                </div>
              </CardBody>
              <div className="border-border flex items-center gap-2 border-t px-5 py-2.5">
                <label className="text-fg-muted flex items-center gap-2 text-[12.5px]">
                  <Switch
                    checked={!paused}
                    disabled={!canManage}
                    label={`${a.title} enabled`}
                    onCheckedChange={(v) =>
                      run(`p${a.role}`, () => api(`/agents/${a.role}/pause`, { body: { paused: !v } }), {
                        success: v ? "Agent resumed" : "Agent paused",
                      })
                    }
                  />{" "}
                  Enabled
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setStart(a)}
                  disabled={!canRun || paused || !RUNNABLE[a.role]}
                  title={
                    !RUNNABLE[a.role]
                      ? "This role runs inside workflows (inbox, media jobs, ads execution)"
                      : undefined
                  }
                >
                  <Play className="h-3.5 w-3.5" /> {RUNNABLE[a.role] ? "Run" : "Workflow-only"}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
      <Card>
        <div className="border-border border-b px-5 py-3 text-[14px] font-semibold">Run history</div>
        {data.runs.length === 0 ? (
          <EmptyState
            icon={<Bot className="h-5 w-5" />}
            title="No runs yet"
            description="Run the marketing strategist to get a first 30-day plan."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Agent</Th>
                <Th>State</Th>
                <Th>Provider</Th>
                <Th>Tokens</Th>
                <Th>Cost</Th>
                <Th>Started</Th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr
                  key={r.id}
                  className="hover:bg-surface-2 cursor-pointer"
                  onClick={() => router.push(`${path}?run=${r.id}`)}
                >
                  <Td>
                    <button className="font-medium hover:underline">
                      {agents.find((a) => a.role === r.agentRole)?.title ?? r.agentRole}
                    </button>
                  </Td>
                  <Td>
                    <StatusBadge status={r.state} />
                  </Td>
                  <Td className="text-[12.5px]">
                    {r.provider === "mock" ? <Badge tone="warning">Mock LLM</Badge> : (r.model ?? "—")}
                  </Td>
                  <Td className="text-[12.5px] tabular-nums">{r.tokensIn + r.tokensOut}</Td>
                  <Td className="text-[12.5px] tabular-nums">${Number(r.costUsd).toFixed(4)}</Td>
                  <Td className="text-fg-muted text-[12.5px]">{fmtRelative(r.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {start ? (
        <StartDialog
          agent={start}
          onClose={() => setStart(null)}
          onStarted={(id) => router.push(`${path}?run=${id}`)}
        />
      ) : null}
      {data.detail ? <RunDrawer d={data.detail} agents={agents} onClose={() => router.push(path)} /> : null}
    </>
  );
}

function StartDialog({
  agent,
  onClose,
  onStarted,
}: {
  agent: Agent;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const { run, isBusy } = useAction();
  const fields = RUNNABLE[agent.role] ?? [];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Run ${agent.title}`}
      description={agent.sourceRequirements}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const input: Record<string, unknown> = {};
          for (const fl of fields) {
            const v = String(f.get(fl.key) ?? "").trim();
            if (v) input[fl.key] = fl.type === "number" ? Number(v) : v;
          }
          void run(
            "start",
            () => api<{ id: string }>("/agents/runs", { body: { role: agent.role, input } }),
            { success: "Run queued" },
          ).then((r) => {
            if (r) {
              onClose();
              onStarted(r.id);
            }
          });
        }}
        className="space-y-4"
      >
        {fields.map((fl) => (
          <Field key={fl.key} label={fl.label} htmlFor={`f-${fl.key}`}>
            {fl.type === "textarea" ? (
              <Textarea id={`f-${fl.key}`} name={fl.key} defaultValue={fl.default} />
            ) : (
              <Input id={`f-${fl.key}`} name={fl.key} type={fl.type ?? "text"} defaultValue={fl.default} />
            )}
          </Field>
        ))}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={isBusy("start")}>
            <Play className="h-4 w-4" /> Start run
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RunDrawer({
  d,
  agents,
  onClose,
}: {
  d: NonNullable<Data["detail"]>;
  agents: Agent[];
  onClose: () => void;
}) {
  const { run, isBusy } = useAction();
  const r = d.run;
  const agent = agents.find((a) => a.role === r.agentRole);
  const active = ["REQUESTED", "PLANNING", "DRAFTING", "VALIDATING"].includes(r.state);
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="max-w-[860px]"
      title={
        <span className="flex items-center gap-2">
          {agent?.title} <StatusBadge status={r.state} />
        </span>
      }
      description={`Run ${r.id.slice(0, 8)} · ${fmtDateTime(r.createdAt)}`}
      footer={
        <>
          {active ? (
            <Button
              onClick={() =>
                run("cancel", () => api(`/agents/runs/${r.id}/cancel`, { body: {} }), {
                  success: "Cancelled",
                })
              }
              loading={isBusy("cancel")}
            >
              <Square className="h-4 w-4" /> Cancel
            </Button>
          ) : null}
          {["FAILED", "NEEDS_INPUT"].includes(r.state) ? (
            <Button
              onClick={() =>
                run("retry", () => api(`/agents/runs/${r.id}/retry`, { body: {} }), {
                  success: "Retry queued",
                })
              }
              loading={isBusy("retry")}
            >
              <RotateCcw className="h-4 w-4" /> Retry
            </Button>
          ) : null}
        </>
      }
    >
      {r.error ? (
        <Notice tone="danger" title="Failed" className="mb-4">
          {r.error}
        </Notice>
      ) : null}
      {r.output?.escalationReasons?.length ? (
        <Notice tone="warning" title="Needs input" className="mb-4">
          <ul className="list-disc pl-4">
            {r.output.escalationReasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <KeyValue
        items={[
          ["Provider", r.provider === "mock" ? "Mock (deterministic)" : (r.provider ?? "—")],
          ["Model", r.model ?? "—"],
          ["Steps", String(r.steps)],
          ["Tokens", `${r.tokensIn} in / ${r.tokensOut} out`],
          ["Cost", `$${Number(r.costUsd).toFixed(6)}`],
          ["Latency", r.latencyMs ? `${r.latencyMs} ms` : "—"],
        ]}
      />
      <h4 className="mt-5 mb-2 text-[13px] font-semibold">Input</h4>
      <pre className="bg-surface-2 overflow-x-auto rounded-lg p-3 text-[12px]">
        {JSON.stringify(r.input, null, 2)}
      </pre>
      <h4 className="mt-5 mb-2 text-[13px] font-semibold">Tool invocations</h4>
      <ul className="space-y-1">
        {d.tools.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-[12.5px]">
            {t.allowed ? (
              <Badge tone="success">allowed</Badge>
            ) : (
              <Badge tone="danger">
                <ShieldOff className="h-3 w-3" /> denied
              </Badge>
            )}
            <code>{t.tool}</code>
            <Badge>Tier {t.tier}</Badge>
            {t.reason ? <span className="text-fg-muted">{t.reason}</span> : null}
          </li>
        ))}
      </ul>
      <h4 className="mt-5 mb-2 text-[13px] font-semibold">Validated output</h4>
      {r.output?.result ? (
        <pre className="bg-surface-2 max-h-[420px] overflow-auto rounded-lg p-3 text-[12px] whitespace-pre-wrap">
          {JSON.stringify(r.output.result, null, 2)}
        </pre>
      ) : (
        <p className="text-fg-subtle text-[12.5px]">
          {active ? "Running in the background worker…" : "No output."}
        </p>
      )}
      {agent ? (
        <>
          <h4 className="mt-5 mb-2 text-[13px] font-semibold">Contract</h4>
          <KeyValue
            items={[
              ["Non-goals", agent.nonGoals.join("; ")],
              ["Never allowed", agent.disallowedActions.map(sentence).join("; ")],
              ["Escalates when", agent.escalation.join("; ")],
            ]}
          />
        </>
      ) : null}
    </Drawer>
  );
}
