"use client";

import { FlaskConical, PauseCircle, Plus, Power, Workflow } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ConfirmButton, Drawer, Switch } from "@/components/ui/overlay";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Notice,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";
import { fmtRelative, sentence } from "@/lib/format";

interface Rule {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  approvalMode: string;
  accountId: string | null;
  config: Record<string, unknown>;
  version: number;
  lastTestedAt: string | null;
  lastTestResult: {
    results?: Array<{
      text: string;
      intent: string;
      confidence: number;
      product: string | null;
      decision: string;
      privateReply: string | null;
      publicReply: string | null;
      reasons: string[];
    }>;
    wouldCreate?: string;
  } | null;
  enabledAt: string | null;
  updatedAt: string;
  timezone: string | null;
  activeFrom: string | null;
  activeUntil: string | null;
}
interface Data {
  rules: Rule[];
  products: Array<{ id: string; name: string }>;
  accounts: Array<{
    id: string;
    provider: string;
    username: string | null;
    displayName: string;
    mode: string;
    automationPaused: boolean;
  }>;
  automationPaused: boolean;
  timezone: string;
}

const MODE_LABEL: Record<string, string> = {
  approve_every: "Approve every response",
  bounded_auto: "Auto-send within limits",
  human_only: "Draft only (human sends)",
};

export function AutomationsClient({
  data,
  canManage,
  intents,
  placeholders,
}: {
  data: Data;
  canManage: boolean;
  intents: string[];
  placeholders: string[];
}) {
  const { run } = useAction();
  const [edit, setEdit] = useState<Rule | "new-dm" | "new-draft" | null>(null);
  return (
    <>
      <Card className="mb-6">
        <CardBody className="flex flex-wrap items-center gap-4">
          <PauseCircle
            className={data.automationPaused ? "text-warning-600 h-5 w-5" : "text-fg-subtle h-5 w-5"}
          />
          <div className="flex-1">
            <div className="text-[14px] font-semibold">Pause all automated replies</div>
            <div className="text-fg-muted text-[12.5px]">
              Workspace-wide emergency stop for rule-based sends. Per-account pauses live in Integrations. The
              kill switch in Settings blocks every external action.
            </div>
          </div>
          <Switch
            checked={data.automationPaused}
            disabled={!canManage}
            label="Pause all automated replies"
            onCheckedChange={(v) =>
              run("pause", () => api("/workspace/automation-pause", { body: { paused: v } }), {
                success: v ? "Automated replies paused" : "Resumed",
              })
            }
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Rules"
          actions={
            canManage ? (
              <>
                <Button size="sm" onClick={() => setEdit("new-draft")}>
                  <Plus className="h-3.5 w-3.5" /> Scheduled draft
                </Button>
                <Button size="sm" variant="primary" onClick={() => setEdit("new-dm")}>
                  <Plus className="h-3.5 w-3.5" /> Comment-to-DM rule
                </Button>
              </>
            ) : null
          }
        />
        {data.rules.length === 0 ? (
          <EmptyState
            icon={<Workflow className="h-5 w-5" />}
            title="No rules yet"
            description="Example: send the approved product link by private reply when someone comments “LINK” on a specific Reel."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Rule</Th>
                <Th>Type</Th>
                <Th>Mode</Th>
                <Th>Account</Th>
                <Th>Status</Th>
                <Th>Tested</Th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={r.id} className="hover:bg-surface-2 cursor-pointer" onClick={() => setEdit(r)}>
                  <Td>
                    <button className="font-medium hover:underline">{r.name}</button>
                    <div className="text-fg-muted text-[12px]">
                      v{r.version} · updated {fmtRelative(r.updatedAt)}
                    </div>
                  </Td>
                  <Td>
                    <Badge>{r.kind === "comment_to_dm" ? "Comment-to-DM" : "Scheduled draft"}</Badge>
                  </Td>
                  <Td className="text-[12.5px]">{MODE_LABEL[r.approvalMode]}</Td>
                  <Td className="text-[12.5px]">
                    {data.accounts.find((a) => a.id === r.accountId)?.username ?? "Any"}
                  </Td>
                  <Td>
                    {r.enabled ? (
                      <Badge tone="success" dot>
                        Enabled
                      </Badge>
                    ) : (
                      <Badge dot>Disabled</Badge>
                    )}
                  </Td>
                  <Td className="text-fg-muted text-[12.5px]">
                    {r.lastTestedAt ? fmtRelative(r.lastTestedAt) : "Not tested"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {edit ? (
        <RuleDrawer
          key={
            typeof edit === "string"
              ? edit
              : `${edit.id}:${edit.version}:${edit.enabled}:${edit.lastTestedAt}`
          }
          rule={typeof edit === "string" ? null : edit}
          kind={
            typeof edit === "string" ? (edit === "new-dm" ? "comment_to_dm" : "scheduled_draft") : edit.kind
          }
          data={data}
          canManage={canManage}
          intents={intents}
          placeholders={placeholders}
          onClose={() => setEdit(null)}
          onSaved={(r) => setEdit(r)}
        />
      ) : null}
    </>
  );
}

function RuleDrawer({
  rule,
  kind,
  data,
  canManage,
  intents,
  placeholders,
  onClose,
  onSaved,
}: {
  rule: Rule | null;
  kind: string;
  data: Data;
  canManage: boolean;
  intents: string[];
  placeholders: string[];
  onClose: () => void;
  onSaved: (r: Rule) => void;
}) {
  const { run, isBusy } = useAction();
  const c = (rule?.config ?? {}) as Record<string, unknown>;
  const limits = (c.limits ?? {}) as Record<string, number>;
  const schedule = (c.schedule ?? {}) as { days?: number[]; startHour?: number; endHour?: number };
  const [samples, setSamples] = useState("LINK\nPrice?\nMy order never arrived");
  const [test, setTest] = useState(rule?.lastTestResult ?? null);
  const save = (f: FormData) => {
    const g = (k: string) => String(f.get(k) ?? "").trim();
    const config =
      kind === "comment_to_dm"
        ? {
            triggers: g("triggers")
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
            allowedIntents: f.getAll("intents").map(String),
            productIds: f.getAll("products").map(String),
            sendPublicReply: f.get("sendPublic") === "on",
            sendPrivateReply: f.get("sendPrivate") === "on",
            publicReplyTemplate: g("publicTemplate"),
            privateReplyTemplate: g("privateTemplate"),
            minConfidence: Number(g("minConfidence") || 0.8),
            limits: {
              maxPerHour: Number(g("maxPerHour") || 30),
              maxPerDay: Number(g("maxPerDay") || 200),
              perUserCooldownHours: Number(g("cooldown") || 24),
            },
            schedule: {
              days: f.getAll("days").map(Number),
              startHour: Number(g("startHour") || 0),
              endHour: Number(g("endHour") || 24),
            },
          }
        : { brief: g("brief"), format: g("format"), weekday: Number(g("weekday")), hour: Number(g("hour")) };
    const body = {
      kind,
      name: g("name"),
      approvalMode: g("mode") || "approve_every",
      accountId: g("account") || null,
      config,
      timezone: g("timezone") || data.timezone,
    };
    return run(
      "save",
      () =>
        api<Rule>(rule ? `/automations/${rule.id}` : "/automations", { method: rule ? "PUT" : "POST", body }),
      { success: rule ? "Saved as a new version — re-test and re-enable it" : "Rule created (disabled)" },
    ).then((r) => r && onSaved(r));
  };
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="max-w-[900px]"
      title={
        rule ? (
          <span className="flex items-center gap-2">
            {rule.name} {rule.enabled ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}{" "}
            <Badge>v{rule.version}</Badge>
          </span>
        ) : kind === "comment_to_dm" ? (
          "New comment-to-DM rule"
        ) : (
          "New scheduled draft rule"
        )
      }
      description={
        rule?.enabledAt
          ? `Enabled ${fmtRelative(rule.enabledAt)} by an authorized user`
          : "Rules start disabled. Run a dry-run test, then enable."
      }
      footer={
        rule && canManage ? (
          rule.enabled ? (
            <ConfirmButton
              variant="danger"
              label={
                <>
                  <Power className="h-4 w-4" /> Disable
                </>
              }
              title="Disable rule?"
              effect="Matching events will go back to approval-required drafts."
              confirmLabel="Disable"
              onConfirm={() =>
                run("dis", () => api(`/automations/${rule.id}/disable`, { body: {} }), {
                  success: "Disabled",
                }).then(() => onClose())
              }
            />
          ) : (
            <ConfirmButton
              variant="primary"
              disabled={!rule.lastTestedAt}
              label={
                <>
                  <Power className="h-4 w-4" /> Enable
                </>
              }
              title="Enable rule?"
              effect={
                rule.approvalMode === "bounded_auto"
                  ? "Matching low-risk replies will be SENT without per-message approval, within the limits, schedule and account shown. You can pause at any time."
                  : "Matching events will create drafts according to this rule."
              }
              confirmLabel="Enable"
              onConfirm={() =>
                run("en", () => api(`/automations/${rule.id}/enable`, { body: {} }), {
                  success: "Enabled",
                }).then(() => onClose())
              }
            />
          )
        ) : null
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(new FormData(e.currentTarget));
        }}
        className="grid gap-4 md:grid-cols-2"
      >
        <Field label="Name" htmlFor="r-name" className="md:col-span-2">
          <Input
            id="r-name"
            name="name"
            required
            defaultValue={
              rule?.name ??
              (kind === "comment_to_dm"
                ? "LINK → private reply with product URL"
                : "Weekly product spotlight draft")
            }
            disabled={!canManage}
          />
        </Field>
        <Field
          label="Approval mode"
          htmlFor="r-mode"
          hint={
            kind === "scheduled_draft"
              ? "Drafts always need approval to publish."
              : "Auto-send needs one account and is limited to low-risk intents."
          }
        >
          <Select
            id="r-mode"
            name="mode"
            defaultValue={rule?.approvalMode ?? "approve_every"}
            disabled={!canManage}
          >
            <option value="approve_every">{MODE_LABEL.approve_every}</option>
            {kind === "comment_to_dm" ? (
              <option value="bounded_auto">{MODE_LABEL.bounded_auto}</option>
            ) : null}
            <option value="human_only">{MODE_LABEL.human_only}</option>
          </Select>
        </Field>
        <Field label="Instagram account" htmlFor="r-acct">
          <Select
            id="r-acct"
            name="account"
            defaultValue={rule?.accountId ?? data.accounts[0]?.id ?? ""}
            disabled={!canManage}
          >
            <option value="">Any account (approval modes only)</option>
            {data.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.provider === "facebook"
                  ? `Facebook · ${a.displayName}`
                  : `Instagram · @${a.username ?? a.displayName}`}
                {a.mode === "mock" ? " (MOCK)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        {kind === "comment_to_dm" ? (
          <>
            <Field
              label="Trigger keywords (comma separated)"
              htmlFor="r-trig"
              hint="Whole-word match. Leave empty to match on intent only."
            >
              <Input
                id="r-trig"
                name="triggers"
                defaultValue={((c.triggers as string[]) ?? ["LINK"]).join(", ")}
                disabled={!canManage}
              />
            </Field>
            <Field label="Minimum confidence" htmlFor="r-conf">
              <Input
                id="r-conf"
                name="minConfidence"
                type="number"
                step="0.05"
                min={0.5}
                max={1}
                defaultValue={String(c.minConfidence ?? 0.8)}
                disabled={!canManage}
              />
            </Field>
            <fieldset className="md:col-span-2">
              <legend className="mb-1.5 text-[12.5px] font-medium">Allowed intents</legend>
              <div className="flex flex-wrap gap-2">
                {intents.map((i) => (
                  <label
                    key={i}
                    className="border-border flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12.5px]"
                  >
                    <input
                      type="checkbox"
                      name="intents"
                      value={i}
                      defaultChecked={((c.allowedIntents as string[]) ?? ["product_link"]).includes(i)}
                      disabled={!canManage}
                    />{" "}
                    {sentence(i)}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="md:col-span-2">
              <legend className="mb-1.5 text-[12.5px] font-medium">
                Products (empty = any approved product)
              </legend>
              <div className="flex flex-wrap gap-2">
                {data.products.map((p) => (
                  <label
                    key={p.id}
                    className="border-border flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12.5px]"
                  >
                    <input
                      type="checkbox"
                      name="products"
                      value={p.id}
                      defaultChecked={((c.productIds as string[]) ?? []).includes(p.id)}
                      disabled={!canManage}
                    />{" "}
                    {p.name}
                  </label>
                ))}
                {data.products.length === 0 ? (
                  <span className="text-fg-subtle text-[12.5px]">
                    Add products in the Company Brain first.
                  </span>
                ) : null}
              </div>
            </fieldset>
            <div className="flex flex-col gap-2 md:col-span-2">
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  name="sendPublic"
                  defaultChecked={(c.sendPublicReply as boolean) ?? true}
                  disabled={!canManage}
                />{" "}
                Post a public reply
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  name="sendPrivate"
                  defaultChecked={(c.sendPrivateReply as boolean) ?? true}
                  disabled={!canManage}
                />{" "}
                Send a private reply (one per comment, within 7 days)
              </label>
            </div>
            <Field
              label="Public reply template"
              htmlFor="r-pub"
              className="md:col-span-2"
              hint="No links or prices in public replies."
            >
              <Input
                id="r-pub"
                name="publicTemplate"
                defaultValue={
                  (c.publicReplyTemplate as string) ??
                  "Thanks @{username}! We've sent you the details in a private message."
                }
                disabled={!canManage}
              />
            </Field>
            <Field
              label="Private reply template"
              htmlFor="r-priv"
              className="md:col-span-2"
              hint={`Placeholders: ${placeholders.map((p) => `{${p}}`).join(" ")} — filled only from verified catalog data; missing values escalate.`}
            >
              <Textarea
                id="r-priv"
                name="privateTemplate"
                defaultValue={
                  (c.privateReplyTemplate as string) ?? "Hi @{username}! Here's {product_name}: {product_url}"
                }
                disabled={!canManage}
              />
            </Field>
            <div className="grid grid-cols-3 gap-3 md:col-span-2">
              <Field label="Max per hour" htmlFor="r-h">
                <Input
                  id="r-h"
                  name="maxPerHour"
                  type="number"
                  min={1}
                  defaultValue={String(limits.maxPerHour ?? 30)}
                  disabled={!canManage}
                />
              </Field>
              <Field label="Max per day" htmlFor="r-d">
                <Input
                  id="r-d"
                  name="maxPerDay"
                  type="number"
                  min={1}
                  defaultValue={String(limits.maxPerDay ?? 200)}
                  disabled={!canManage}
                />
              </Field>
              <Field label="Per-person cooldown (h)" htmlFor="r-cd">
                <Input
                  id="r-cd"
                  name="cooldown"
                  type="number"
                  min={1}
                  defaultValue={String(limits.perUserCooldownHours ?? 24)}
                  disabled={!canManage}
                />
              </Field>
            </div>
            <fieldset className="md:col-span-2">
              <legend className="mb-1.5 text-[12.5px] font-medium">
                Active days & hours ({rule?.timezone ?? data.timezone})
              </legend>
              <div className="flex flex-wrap items-center gap-2">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
                  <label
                    key={d}
                    className="border-border flex items-center gap-1 rounded-md border px-2 py-1 text-[12.5px]"
                  >
                    <input
                      type="checkbox"
                      name="days"
                      value={i}
                      defaultChecked={(schedule.days ?? [0, 1, 2, 3, 4, 5, 6]).includes(i)}
                      disabled={!canManage}
                    />{" "}
                    {d}
                  </label>
                ))}
                <Input
                  aria-label="Start hour"
                  name="startHour"
                  type="number"
                  min={0}
                  max={23}
                  className="w-20"
                  defaultValue={String(schedule.startHour ?? 0)}
                  disabled={!canManage}
                />{" "}
                to{" "}
                <Input
                  aria-label="End hour"
                  name="endHour"
                  type="number"
                  min={1}
                  max={24}
                  className="w-20"
                  defaultValue={String(schedule.endHour ?? 24)}
                  disabled={!canManage}
                />
              </div>
            </fieldset>
            <Notice tone="neutral" className="md:col-span-2" title="Always escalated to a human">
              Complaints, refunds, legal or safety issues, ambiguous products, missing price/stock, unapproved
              links, low confidence, expired windows and opted-out recipients.
            </Notice>
          </>
        ) : (
          <>
            <Field label="Brief" htmlFor="r-brief" className="md:col-span-2">
              <Textarea
                id="r-brief"
                name="brief"
                required
                defaultValue={
                  (c.brief as string) ?? "Spotlight one product with an approved benefit and link"
                }
                disabled={!canManage}
              />
            </Field>
            <Field label="Format" htmlFor="r-fmt">
              <Select
                id="r-fmt"
                name="format"
                defaultValue={(c.format as string) ?? "post"}
                disabled={!canManage}
              >
                {["post", "carousel", "story", "reel"].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Weekday" htmlFor="r-wd">
                <Select id="r-wd" name="weekday" defaultValue={String(c.weekday ?? 1)} disabled={!canManage}>
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Hour" htmlFor="r-hr">
                <Input
                  id="r-hr"
                  name="hour"
                  type="number"
                  min={0}
                  max={23}
                  defaultValue={String(c.hour ?? 9)}
                  disabled={!canManage}
                />
              </Field>
            </div>
          </>
        )}
        <Field label="Timezone" htmlFor="r-tz">
          <Input
            id="r-tz"
            name="timezone"
            defaultValue={rule?.timezone ?? data.timezone}
            disabled={!canManage}
          />
        </Field>
        {canManage ? (
          <div className="flex items-end justify-end">
            <Button type="submit" variant="primary" loading={isBusy("save")}>
              {rule ? "Save new version" : "Create rule"}
            </Button>
          </div>
        ) : null}
      </form>
      {rule ? (
        <Card className="mt-6">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <FlaskConical className="h-4 w-4" /> Dry-run test
              </span>
            }
            description="Shows exactly what would happen. Sends nothing."
            actions={
              <Button
                size="sm"
                loading={isBusy("test")}
                disabled={!canManage}
                onClick={() =>
                  run(
                    "test",
                    () =>
                      api<NonNullable<Rule["lastTestResult"]>>(`/automations/${rule.id}/test`, {
                        body: {
                          samples: samples
                            .split("\n")
                            .map((x) => x.trim())
                            .filter(Boolean),
                        },
                      }),
                    { success: "Dry run complete", refresh: true },
                  ).then((r) => r && setTest(r))
                }
              >
                Run test
              </Button>
            }
          />
          <CardBody className="space-y-3">
            {kind === "comment_to_dm" ? (
              <Field label="Sample comments (one per line)" htmlFor="r-samples">
                <Textarea id="r-samples" value={samples} onChange={(e) => setSamples(e.target.value)} />
              </Field>
            ) : null}
            {test?.wouldCreate ? <p className="text-[13px]">{test.wouldCreate}</p> : null}
            {test?.results ? (
              <ul className="space-y-2">
                {test.results.map((t, i) => (
                  <li key={i} className="border-border rounded-lg border p-3 text-[12.5px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">“{t.text}”</span>
                      <Badge>
                        {sentence(t.intent)} · {t.confidence.toFixed(2)}
                      </Badge>
                      {t.product ? <Badge tone="brand">{t.product}</Badge> : null}
                      <span className="ml-auto">
                        <StatusBadge
                          status={
                            t.decision === "auto_send"
                              ? "succeeded"
                              : t.decision === "escalate"
                                ? "needs_human"
                                : t.decision === "no_match"
                                  ? "ignored"
                                  : "pending"
                          }
                          label={sentence(t.decision)}
                        />
                      </span>
                    </div>
                    {t.privateReply ? (
                      <div className="text-fg-muted mt-1.5">Private: {t.privateReply}</div>
                    ) : null}
                    {t.publicReply ? <div className="text-fg-muted">Public: {t.publicReply}</div> : null}
                    {t.reasons.length ? (
                      <div className="text-danger-600 mt-1">{t.reasons.join("; ")}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-fg-subtle text-[12.5px]">
                {rule.lastTestedAt
                  ? ""
                  : "This version has not been tested. Rules cannot be enabled until tested."}
              </p>
            )}
          </CardBody>
        </Card>
      ) : null}
    </Drawer>
  );
}
