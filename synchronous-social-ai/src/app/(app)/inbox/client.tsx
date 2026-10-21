"use client";

import {
  AlertTriangle,
  Ban,
  Bot,
  Check,
  Clock,
  FlaskConical,
  Hand,
  Inbox as InboxIcon,
  Link2,
  MessageCircle,
  MessagesSquare,
  Package,
  PauseCircle,
  Send,
  ShieldAlert,
  Trash2,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ModeBadge, StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ConfirmButton, Dialog, Switch } from "@/components/ui/overlay";
import { SegmentedNav } from "@/components/ui/segmented";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Notice,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { fmtDateTime, fmtMoney, fmtRelative, sentence, titleCase } from "@/lib/format";

interface Elig {
  eligible: boolean;
  reasons: string[];
  windowEndsAt?: string | null;
}
interface Conv {
  id: string;
  channel: string;
  status: string;
  intent: string | null;
  intentConfidence: string | null;
  isLead: boolean;
  humanTakeover: boolean;
  lastMessageAt: string | null;
  escalationReasons: string[];
  contact: {
    id: string;
    username: string | null;
    externalId: string;
    optedOut: boolean;
    suppressed: boolean;
  } | null;
  account: { id: string; username: string | null; displayName: string; mode: string } | null;
  lastMessage: { text: string; direction: string } | null;
  eligibility: { private?: Elig; public?: Elig; checkedAt?: string } | null;
}
interface Draft {
  id: string;
  actionType: string;
  text: string;
  url: string | null;
  status: string;
  blockedReasons: string[];
  approvalRequestId: string | null;
  automationRuleId: string | null;
  agentRunId: string | null;
  createdAt: string;
  version: number;
}
interface Detail {
  conversation: Conv & {
    mediaExternalId: string | null;
    mediaProductType: string | null;
    contentItemId: string | null;
    matchedProductId: string | null;
    sourceFactIds: string[];
  };
  messages: Array<{
    id: string;
    direction: string;
    kind: string;
    text: string;
    authorUsername: string | null;
    providerCreatedAt: string | null;
    createdAt: string;
    mode: string | null;
  }>;
  drafts: Draft[];
  approvals: Array<{ id: string; status: string }>;
  history: Array<{
    id: string;
    action: string;
    result: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    actorType: string;
  }>;
  contact: Conv["contact"];
  account: {
    id: string;
    username: string | null;
    displayName: string;
    mode: string;
    automationPaused: boolean;
  };
  product: {
    id: string;
    name: string;
    url: string | null;
    priceMinor: number | null;
    currency: string | null;
    stockStatus: string;
  } | null;
  content: { id: string; title: string; format: string; permalink: string | null } | null;
}
interface Metrics {
  windowDays: number;
  drafted: number;
  awaitingApproval: number;
  approved: number;
  sent: number;
  sentPrivate: number;
  blocked: number;
  failed: number;
  repliedTo: number;
  escalated: number;
  ignored: number;
  leads: number;
  notTracked: string[];
}
interface Data {
  conversations: Conv[];
  detail: Detail | null;
  metrics: Metrics;
  automationPaused: boolean;
  accounts: Array<{
    id: string;
    username: string | null;
    displayName: string;
    mode: string;
    automationPaused: boolean;
  }>;
  posts: Array<{ id: string; title: string; mediaId: string | null; accountId: string | null }>;
}

const ACTION_LABEL: Record<string, string> = {
  public_comment_reply: "Public reply",
  private_comment_reply: "Private reply (DM)",
  dm_reply: "DM reply",
};

export function InboxClient({
  data,
  tab,
  canReply,
  canAutomate,
  mocksAllowed,
}: {
  data: Data;
  tab: string;
  canReply: boolean;
  canAutomate: boolean;
  mocksAllowed: boolean;
}) {
  const path = usePathname();
  const { run } = useAction();
  const [sim, setSim] = useState(false);
  const m = data.metrics;
  const mockAccounts = data.accounts.filter((a) => a.mode === "mock");
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {(
          [
            ["Drafted", m.drafted],
            ["Awaiting approval", m.awaitingApproval],
            ["Approved", m.approved],
            ["Sent", m.sent],
            ["Replied to", m.repliedTo],
            ["Escalated", m.escalated],
            ["Blocked", m.blocked],
            ["Failed", m.failed],
          ] as Array<[string, number]>
        ).map(([k, v]) => (
          <Card key={k} className="px-3.5 py-3">
            <div className="text-fg-muted text-[11.5px]">{k}</div>
            <div className="text-[18px] font-semibold tabular-nums">{v}</div>
          </Card>
        ))}
      </div>
      <p className="text-fg-subtle -mt-3 mb-5 text-[12px]">
        Last {m.windowDays} days, from stored records. Not tracked: {m.notTracked.join(", ")} (no attribution
        integration).
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SegmentedNav
          label="Inbox filters"
          active={tab}
          items={(
            [
              ["all", "All"],
              ["comments", "Comments"],
              ["dms", "DMs"],
              ["leads", "Leads"],
              ["needs_human", "Needs human"],
              ["automation_paused", "Automation paused"],
            ] as const
          ).map(([value, label]) => ({ value, label, href: `${path}?tab=${value}` }))}
        />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="border-border bg-surface flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px]">
            <PauseCircle
              className={cn("h-4 w-4", data.automationPaused ? "text-warning-600" : "text-fg-subtle")}
            />
            Pause all automated replies
            <Switch
              checked={data.automationPaused}
              disabled={!canAutomate}
              label="Pause all automated replies"
              onCheckedChange={(v) =>
                run("pause", () => api("/workspace/automation-pause", { body: { paused: v } }), {
                  success: v ? "Automated replies paused" : "Automated replies resumed",
                })
              }
            />
          </label>
          <Link href="/automations">
            <Button size="sm">Comment-to-DM rules</Button>
          </Link>
          {mocksAllowed && mockAccounts.length && canReply ? (
            <Button size="sm" variant="ghost" onClick={() => setSim(true)}>
              <FlaskConical className="h-3.5 w-3.5" /> Simulate event
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card className="overflow-hidden">
          {data.conversations.length === 0 ? (
            <EmptyState
              icon={<InboxIcon className="h-5 w-5" />}
              title="No conversations"
              description={
                data.accounts.length
                  ? "Comments and DMs from connected accounts appear here once Meta delivers webhook events."
                  : "Connect an Instagram professional account and configure the webhook in Integrations."
              }
            />
          ) : (
            <ul className="divide-border max-h-[72vh] divide-y overflow-y-auto">
              {data.conversations.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`${path}?tab=${tab}&c=${c.id}`}
                    className={cn(
                      "hover:bg-surface-2 block px-4 py-3",
                      data.detail?.conversation.id === c.id && "bg-brand-50/60",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {c.channel === "instagram_comment" ? (
                        <MessageCircle className="text-fg-subtle h-3.5 w-3.5" />
                      ) : (
                        <MessagesSquare className="text-fg-subtle h-3.5 w-3.5" />
                      )}
                      <span className="truncate text-[13px] font-medium">
                        @{c.contact?.username ?? c.contact?.externalId ?? "unknown"}
                      </span>
                      {c.isLead ? <Badge tone="brand">Lead</Badge> : null}
                      <span className="text-fg-subtle ml-auto text-[11.5px]">
                        {fmtRelative(c.lastMessageAt)}
                      </span>
                    </div>
                    <p className="text-fg-muted mt-1 line-clamp-1 text-[12.5px]">
                      {c.lastMessage?.direction === "outbound" ? "You: " : ""}
                      {c.lastMessage?.text}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={c.status} />
                      {c.intent ? <Badge>{sentence(c.intent)}</Badge> : null}
                      {c.humanTakeover ? <Badge tone="warning">Human</Badge> : null}
                      <ModeBadge mode={c.account?.mode} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {data.detail ? (
          <ConversationPanel
            key={data.detail.conversation.id + data.detail.drafts.map((d) => d.status + d.version).join()}
            d={data.detail}
            canReply={canReply}
          />
        ) : (
          <Card>
            <EmptyState title="Select a conversation" />
          </Card>
        )}
      </div>
      {sim ? (
        <SimulateDialog onClose={() => setSim(false)} accounts={mockAccounts} posts={data.posts} />
      ) : null}
    </>
  );
}

function ConversationPanel({ d, canReply }: { d: Detail; canReply: boolean }) {
  const { run } = useAction();
  const c = d.conversation;
  const [compose, setCompose] = useState(false);
  const isComment = c.channel === "instagram_comment";
  const origin = d.messages.find((m) => m.direction === "inbound");
  const elig = c.eligibility;
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <Card className="flex flex-col">
        <CardHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              @{d.contact?.username ?? d.contact?.externalId} <StatusBadge status={c.status} />{" "}
              <ModeBadge mode={d.account.mode} />
            </span>
          }
          description={`${isComment ? "Comment" : "Direct message"} via @${d.account.username ?? d.account.displayName}`}
          actions={
            canReply ? (
              <>
                <Button
                  size="sm"
                  variant={c.humanTakeover ? "primary" : "secondary"}
                  onClick={() =>
                    run(
                      "takeover",
                      () => api(`/inbox/${c.id}/takeover`, { body: { takeover: !c.humanTakeover } }),
                      {
                        success: c.humanTakeover
                          ? "Released to automation"
                          : "You took over — automation disabled for this conversation",
                      },
                    )
                  }
                >
                  <Hand className="h-3.5 w-3.5" /> {c.humanTakeover ? "Release" : "Take over"}
                </Button>
                <Button size="sm" onClick={() => setCompose(true)}>
                  <Send className="h-3.5 w-3.5" /> Write reply
                </Button>
              </>
            ) : null
          }
        />
        <CardBody className="space-y-4">
          {c.escalationReasons.length ? (
            <Notice tone="danger" icon={<ShieldAlert className="h-4 w-4" />} title="Needs a human">
              <ul className="list-disc pl-4">
                {c.escalationReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {d.content ? (
            <div className="border-border bg-surface-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px]">
              <Link2 className="text-fg-subtle h-3.5 w-3.5" /> On{" "}
              {titleCase(c.mediaProductType ?? d.content.format)}:{" "}
              <Link href={`/content?id=${d.content.id}`} className="font-medium hover:underline">
                {d.content.title}
              </Link>
            </div>
          ) : c.mediaExternalId ? (
            <div className="text-fg-subtle text-[12px]">
              On media {c.mediaExternalId} (not created in this workspace)
            </div>
          ) : null}
          <ol className="space-y-3">
            {d.messages.map((m) => (
              <li key={m.id} className={cn("flex", m.direction === "outbound" && "justify-end")}>
                <div
                  className={cn(
                    "max-w-[80%] rounded-2xl px-3.5 py-2 text-[13.5px]",
                    m.direction === "outbound"
                      ? "bg-brand-600 text-white"
                      : "border-border bg-surface-2 border",
                  )}
                >
                  <div
                    className={cn(
                      "mb-0.5 text-[11px]",
                      m.direction === "outbound" ? "text-white/75" : "text-fg-subtle",
                    )}
                  >
                    {m.direction === "inbound"
                      ? `@${m.authorUsername ?? "customer"} · ${sentence(m.kind)}`
                      : `${ACTION_LABEL[m.kind === "public_reply" ? "public_comment_reply" : m.kind === "private_reply" ? "private_comment_reply" : "dm_reply"]}${m.mode === "mock" ? " · MOCK (not sent)" : ""}`}{" "}
                    · {fmtDateTime(m.providerCreatedAt ?? m.createdAt)}
                  </div>
                  <p className="whitespace-pre-line">{m.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div>
            <h4 className="mb-2 text-[13px] font-semibold">Proposed replies</h4>
            {d.drafts.length === 0 ? (
              <p className="text-fg-subtle text-[12.5px]">
                {c.status === "needs_human"
                  ? "No automatic drafts: this conversation needs a person."
                  : "No drafts."}
              </p>
            ) : null}
            <div className="space-y-3">
              {d.drafts.map((dr) => (
                <DraftCard key={dr.id} draft={dr} canReply={canReply} />
              ))}
            </div>
          </div>
        </CardBody>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader title="Understanding" />
          <CardBody>
            <KeyValue
              items={[
                ["Intent", c.intent ? sentence(c.intent) : "—"],
                ["Confidence", c.intentConfidence ? Number(c.intentConfidence).toFixed(2) : "—"],
                ["Lead", c.isLead ? "Yes" : "No"],
                [
                  "Original",
                  <span key="o" className="italic">
                    “{origin?.text}”
                  </span>,
                ],
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-1.5">
                <Package className="h-4 w-4" /> Matched product
              </span>
            }
          />
          <CardBody>
            {d.product ? (
              <KeyValue
                items={[
                  ["Product", d.product.name],
                  [
                    "Price",
                    d.product.priceMinor !== null
                      ? fmtMoney(d.product.priceMinor, d.product.currency ?? "USD")
                      : "Not set",
                  ],
                  ["Stock", titleCase(d.product.stockStatus)],
                  [
                    "Link",
                    d.product.url ? (
                      <span key="u" className="text-brand-600 break-all">
                        {d.product.url}
                      </span>
                    ) : (
                      "None"
                    ),
                  ],
                ]}
              />
            ) : (
              <p className="text-fg-muted text-[12.5px]">
                No product matched. Replies needing product details escalate instead of guessing.
              </p>
            )}
            <p className="text-fg-subtle mt-2 text-[11.5px]">
              Source: approved catalog in the Company Brain.
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Eligibility"
            description={
              elig?.checkedAt ? `Checked ${fmtRelative(elig.checkedAt)}; re-checked at send time` : undefined
            }
          />
          <CardBody className="space-y-3">
            {isComment ? <EligRow label="Public comment reply" e={elig?.public} /> : null}
            <EligRow
              label={
                isComment ? "Private reply (1 per comment, ≤ 7 days)" : "DM reply (≤ 24h after their message)"
              }
              e={elig?.private}
            />
            {d.contact ? (
              <div className="border-border flex flex-wrap gap-2 border-t pt-3">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canReply}
                  onClick={() =>
                    run(
                      "opt",
                      () =>
                        api(`/inbox/contacts/${d.contact!.id}`, {
                          method: "PATCH",
                          body: { optedOut: !d.contact!.optedOut },
                        }),
                      { success: "Updated" },
                    )
                  }
                >
                  <Ban className="h-3.5 w-3.5" /> {d.contact.optedOut ? "Clear opt-out" : "Mark opted out"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canReply}
                  onClick={() =>
                    run(
                      "sup",
                      () =>
                        api(`/inbox/contacts/${d.contact!.id}`, {
                          method: "PATCH",
                          body: { suppressed: !d.contact!.suppressed },
                        }),
                      { success: "Updated" },
                    )
                  }
                >
                  <UserRound className="h-3.5 w-3.5" /> {d.contact.suppressed ? "Unsuppress" : "Suppress"}
                </Button>
              </div>
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Action history"
            description="Every stage, including ignored and blocked events."
          />
          <ol className="max-h-[360px] space-y-2 overflow-y-auto px-5 py-3">
            {d.history.map((h) => (
              <li key={h.id} className="text-[12px]">
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      h.result === "blocked"
                        ? "bg-danger-600"
                        : h.result === "success"
                          ? "bg-success-600"
                          : h.result === "failure"
                            ? "bg-danger-600"
                            : "bg-border-strong",
                    )}
                  />
                  <span className="font-medium">
                    {sentence(h.action.replace(/^(inbox|approval|external)\./, ""))}
                  </span>
                  <span className="text-fg-subtle ml-auto">{fmtRelative(h.createdAt)}</span>
                </div>
                {h.metadata && Object.keys(h.metadata).length ? (
                  <div className="text-fg-subtle ml-3 line-clamp-2">{summarize(h.metadata)}</div>
                ) : null}
              </li>
            ))}
          </ol>
        </Card>
      </div>
      {compose ? (
        <ComposeDialog conv={c} onClose={() => setCompose(false)} productId={d.product?.id ?? null} />
      ) : null}
    </div>
  );
}

function summarize(m: Record<string, unknown>) {
  const keys = [
    "intent",
    "confidence",
    "reasons",
    "blocked",
    "actionType",
    "reason",
    "error",
    "mode",
    "productReason",
    "ruleId",
  ];
  return keys
    .filter(
      (k) =>
        m[k] !== undefined && m[k] !== null && !(Array.isArray(m[k]) && (m[k] as unknown[]).length === 0),
    )
    .map((k) => `${k}: ${Array.isArray(m[k]) ? (m[k] as unknown[]).join("; ") : String(m[k])}`)
    .join(" · ");
}

function EligRow({ label, e }: { label: string; e?: Elig }) {
  if (!e) return <div className="text-fg-subtle text-[12.5px]">{label}: not evaluated</div>;
  return (
    <div className="text-[12.5px]">
      <div className="flex items-center gap-1.5 font-medium">
        {e.eligible ? (
          <Check className="text-success-600 h-3.5 w-3.5" />
        ) : (
          <AlertTriangle className="text-danger-600 h-3.5 w-3.5" />
        )}{" "}
        {label}
      </div>
      {e.windowEndsAt ? (
        <div className="text-fg-subtle ml-5 flex items-center gap-1">
          <Clock className="h-3 w-3" /> Window ends {fmtDateTime(e.windowEndsAt)}
        </div>
      ) : null}
      {e.reasons.map((r) => (
        <div key={r} className="text-danger-600 ml-5">
          {r}
        </div>
      ))}
    </div>
  );
}

function DraftCard({ draft: dr, canReply }: { draft: Draft; canReply: boolean }) {
  const { run, isBusy } = useAction();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(dr.text);
  const editable = ["draft", "pending_approval", "approved", "blocked"].includes(dr.status);
  return (
    <div className="border-border rounded-xl border">
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-3.5 py-2">
        <span className="text-[12.5px] font-semibold">{ACTION_LABEL[dr.actionType]}</span>
        <StatusBadge status={dr.status} />
        {dr.automationRuleId ? (
          <Badge tone="info">
            <Bot className="h-3 w-3" /> Rule
          </Badge>
        ) : dr.agentRunId ? (
          <Badge tone="info">AI-assisted</Badge>
        ) : null}
        <span className="text-fg-subtle ml-auto text-[11.5px]">v{dr.version}</span>
      </div>
      <div className="px-3.5 py-3">
        {editing ? (
          <Textarea
            aria-label="Reply text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
          />
        ) : (
          <p className="text-[13.5px] whitespace-pre-line">{dr.text}</p>
        )}
        {dr.blockedReasons.length ? (
          <ul className="mt-2 space-y-0.5">
            {dr.blockedReasons.map((r) => (
              <li key={r} className="text-danger-600 text-[12px]">
                {r}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {canReply && editable ? (
        <div className="border-border bg-surface-2 flex flex-wrap justify-end gap-2 border-t px-3.5 py-2">
          {editing ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setText(dr.text);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={isBusy("save")}
                onClick={() =>
                  run("save", () => api(`/inbox/drafts/${dr.id}`, { method: "PATCH", body: { text } }), {
                    success: "Draft updated — previous approval invalidated",
                  })
                }
              >
                Save & request approval
              </Button>
            </>
          ) : (
            <>
              <ConfirmButton
                size="sm"
                variant="ghost"
                label={
                  <>
                    <Trash2 className="h-3.5 w-3.5" /> Discard
                  </>
                }
                title="Discard draft?"
                effect="Its approval request is invalidated. Nothing is sent."
                confirmLabel="Discard"
                onConfirm={() =>
                  run("del", () => api(`/inbox/drafts/${dr.id}`, { method: "DELETE" }), {
                    success: "Discarded",
                  }).then(() => undefined)
                }
              />
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              {dr.approvalRequestId && dr.status === "pending_approval" ? (
                <Link href={`/approvals?id=${dr.approvalRequestId}`}>
                  <Button size="sm" variant="primary">
                    Review in Approval Center
                  </Button>
                </Link>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ComposeDialog({
  conv,
  onClose,
  productId,
}: {
  conv: Conv;
  onClose: () => void;
  productId: string | null;
}) {
  const { run, isBusy } = useAction();
  const isComment = conv.channel === "instagram_comment";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Write a reply"
      description="Human-written replies still go through grounding checks, eligibility and approval before sending."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run(
            "send",
            () =>
              api(`/inbox/${conv.id}/drafts`, {
                body: { actionType: f.get("actionType"), text: f.get("text"), productId },
              }),
            { success: "Draft created" },
          ).then((r) => r && onClose());
        }}
        className="space-y-4"
      >
        <Field label="Reply type" htmlFor="r-type">
          <Select
            id="r-type"
            name="actionType"
            defaultValue={isComment ? "public_comment_reply" : "dm_reply"}
          >
            {isComment ? (
              <>
                <option value="public_comment_reply">Public reply under the comment</option>
                <option value="private_comment_reply">
                  Private reply (one DM per comment, within 7 days)
                </option>
              </>
            ) : (
              <option value="dm_reply">DM reply (within 24h of their message)</option>
            )}
          </Select>
        </Field>
        <Field
          label="Message"
          htmlFor="r-text"
          hint="Links must be on the approved allowlist; prices must match the catalog."
        >
          <Textarea id="r-text" name="text" required maxLength={1000} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={isBusy("send")}>
            Create & request approval
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function SimulateDialog({
  onClose,
  accounts,
  posts,
}: {
  onClose: () => void;
  accounts: Data["accounts"];
  posts: Data["posts"];
}) {
  const { run, isBusy } = useAction();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [kind, setKind] = useState<"comment" | "dm">("comment");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Simulate an Instagram event"
      description="Development only. Injects a webhook-shaped event for a MOCK account through the real processing pipeline."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run(
            "sim",
            () =>
              api("/inbox/simulate", {
                body: {
                  accountId,
                  kind,
                  text: f.get("text"),
                  mediaId: f.get("mediaId") || undefined,
                  username: f.get("username") || "customer_demo",
                },
              }),
            { success: "Event queued — refresh in a moment" },
          ).then((r) => {
            if (r) {
              onClose();
              setTimeout(() => window.location.reload(), 1500);
            }
          });
        }}
        className="space-y-4"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Mock account" htmlFor="sim-acct">
            <Select id="sim-acct" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username ?? a.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Event" htmlFor="sim-kind">
            <Select id="sim-kind" value={kind} onChange={(e) => setKind(e.target.value as "comment" | "dm")}>
              <option value="comment">Comment on a post/Reel</option>
              <option value="dm">Direct message</option>
            </Select>
          </Field>
        </div>
        {kind === "comment" ? (
          <Field
            label="On post"
            htmlFor="sim-media"
            hint="Posts published to this mock account link comments to their products."
          >
            <Select
              id="sim-media"
              name="mediaId"
              defaultValue={posts.find((p) => p.accountId === accountId)?.mediaId ?? ""}
            >
              <option value="">Unknown media</option>
              {posts
                .filter((p) => p.accountId === accountId)
                .map((p) => (
                  <option key={p.id} value={p.mediaId ?? ""}>
                    {p.title}
                  </option>
                ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Username" htmlFor="sim-user">
          <Input id="sim-user" name="username" defaultValue="customer_demo" />
        </Field>
        <Field label="Text" htmlFor="sim-text">
          <Input
            id="sim-text"
            name="text"
            required
            defaultValue={kind === "comment" ? "Please send me the link" : "How much is it?"}
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={isBusy("sim")}>
            Inject event
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
