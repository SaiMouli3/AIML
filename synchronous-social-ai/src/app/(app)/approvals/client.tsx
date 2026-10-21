"use client";

import { AlertTriangle, CalendarClock, CheckCircle2, Fingerprint, Globe, Link2, ShieldCheck, Target, Users, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { IgPreview } from "@/components/ig-preview";
import { ModeBadge, StatusBadge, TierBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ConfirmButton, Tabs, TabsList, TabsTrigger } from "@/components/ui/overlay";
import { Badge, Card, CardBody, CardHeader, EmptyState, KeyValue, Notice } from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";
import { fmtDateTime, fmtMoney, fmtRelative, titleCase } from "@/lib/format";

interface Summary {
  title: string;
  channel: string;
  destination?: string;
  mode?: "live" | "mock";
  schedule?: { at?: string | null; timezone?: string | null };
  audience?: string;
  recipient?: string;
  budget?: { amountMinor: number; currency: string; period: string; durationDays?: number | null };
  landingPage?: string | null;
  risks: string[];
  sideEffects: string[];
  preview?: { text?: string; mediaAssetIds?: string[]; url?: string | null };
}
interface Approval {
  id: string;
  actionType: string;
  tier: number;
  subjectType: string;
  subjectId: string;
  subjectVersion: number | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  summary: Summary;
  status: string;
  requiredApprovals: number;
  requestedBy: string | null;
  requestedByAgentRunId: string | null;
  expiresAt: string | null;
  createdAt: string;
  statusReason: string | null;
}
interface Data {
  list: Approval[];
  detail: { approval: Approval; decisions: Array<{ d: { id: string; decision: string; reason: string | null; userId: string; createdAt: string; payloadHash: string }; name: string }> } | null;
  media: Array<{ id: string; kind: string; origin: string; url: string }>;
}

const SUBJECT_LINK: Record<string, (id: string) => string> = {
  content_item: (id) => `/content?id=${id}`,
  ad_campaign: (id) => `/campaigns?ad=${id}`,
  reply_draft: () => `/inbox`,
};

export function ApprovalsClient({ data, status, userId, canTier3, canTier4 }: { data: Data; status: string; userId: string; canTier3: boolean; canTier4: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const sel = data.detail?.approval;
  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <div>
        <Tabs value={status} onValueChange={(v) => router.push(`${path}?status=${v}`)}>
          <TabsList className="mb-3">
            <TabsTrigger value="pending">Pending</TabsTrigger>
            <TabsTrigger value="approved">Approved</TabsTrigger>
            <TabsTrigger value="executed">Executed</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <Card>
          {data.list.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title={status === "pending" ? "You're all caught up" : "Nothing here"} description="Publishing, replies, DMs and ad launches that need a decision appear here, highest risk first." />
          ) : (
            <ul className="divide-y divide-border">
              {data.list.map((a) => (
                <li key={a.id}>
                  <Link href={`${path}?status=${status}&id=${a.id}`} className={`block px-4 py-3 hover:bg-surface-2 ${sel?.id === a.id ? "bg-brand-50/60" : ""}`} aria-current={sel?.id === a.id ? "true" : undefined}>
                    <div className="flex items-center gap-2">
                      <TierBadge tier={a.tier} />
                      <span className="truncate text-[13.5px] font-medium">{a.summary.title}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[12px] text-fg-muted">
                      <StatusBadge status={a.status} />
                      <span>{a.summary.channel}</span>
                      <span>· {fmtRelative(a.createdAt)}</span>
                      <ModeBadge mode={a.summary.mode} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {sel && data.detail ? <ApprovalDetail approval={sel} decisions={data.detail.decisions} media={data.media} userId={userId} canDecide={sel.tier >= 4 ? canTier4 : canTier3} /> : <Card><EmptyState title="Select a request" description="Choose an item to review its exact content and effects." /></Card>}
    </div>
  );
}

function ApprovalDetail({ approval: a, decisions, media, userId, canDecide }: { approval: Approval; decisions: NonNullable<Data["detail"]>["decisions"]; media: Data["media"]; userId: string; canDecide: boolean }) {
  const { run, isBusy } = useAction();
  const [, setDone] = useState(false);
  const s = a.summary;
  const myApproval = decisions.some((d) => d.d.userId === userId && d.d.decision === "approve");
  const approvals = decisions.filter((d) => d.d.decision === "approve").length;
  const selfBlocked = a.requiredApprovals > 1 && a.requestedBy === userId;
  const isReply = a.subjectType === "reply_draft";
  const hashtags = (a.payload.hashtags as string[] | undefined) ?? [];
  const caption = (a.payload.caption as string | undefined) ?? s.preview?.text ?? "";
  const decideReq = (decision: string, reason?: string) =>
    run(decision, () => api(`/approvals/${a.id}/decision`, { body: { decision, reason, payloadHash: a.payloadHash } }), { success: decision === "approve" ? (approvals + 1 >= a.requiredApprovals ? "Approved — execution queued" : "Approval recorded; another approver is required") : "Decision recorded" }).then(() => setDone(true));
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.title} <TierBadge tier={a.tier} /> <StatusBadge status={a.status} /> <ModeBadge mode={s.mode} />
          </span>
        }
        description={`${titleCase(a.actionType)} · requested ${fmtDateTime(a.createdAt)}${a.requestedByAgentRunId ? " by an agent workflow" : ""}`}
        actions={SUBJECT_LINK[a.subjectType] ? <Link href={SUBJECT_LINK[a.subjectType]!(a.subjectId)} className="text-[13px] font-medium text-brand-600 hover:underline">Open source</Link> : null}
      />
      <CardBody className="space-y-5">
        {s.mode === "mock" ? <Notice tone="warning" title="Mock destination">Approving runs the full workflow against a development mock. Nothing reaches Instagram or Meta.</Notice> : null}
        {a.statusReason ? <Notice tone="neutral" title={`Status: ${titleCase(a.status)}`}>{a.statusReason}</Notice> : null}
        <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
          <div>
            {a.subjectType === "content_item" ? (
              <IgPreview username={(s.destination ?? "").replace("@", "") || "account"} format={String(a.payload.format ?? "post")} caption={caption} hashtags={hashtags} media={media} />
            ) : (
              <div className="rounded-xl border border-border bg-surface-2 p-4">
                <div className="mb-2 text-[12px] font-medium text-fg-subtle">{isReply ? "Exact message that will be sent" : "Exact payload"}</div>
                {s.preview?.text ? <p className="text-[13.5px] whitespace-pre-line">{s.preview.text}</p> : null}
                {a.subjectType === "ad_campaign" ? (
                  <ul className="mt-2 space-y-2">
                    {((a.payload.creatives as Array<{ headline: string; primaryText: string; cta: string }>) ?? []).map((c, i) => (
                      <li key={i} className="rounded-lg border border-border bg-surface p-3">
                        <div className="text-[13px] font-semibold">{c.headline}</div>
                        <p className="text-[12.5px] text-fg-muted">{c.primaryText}</p>
                        <Badge className="mt-1">{c.cta.replace("_", " ")}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </div>
          <div className="space-y-5">
            <KeyValue
              items={[
                [<span key="c" className="flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" /> Channel</span>, s.channel],
                [<span key="d" className="flex items-center gap-1.5"><Target className="h-3.5 w-3.5" /> Destination</span>, s.destination ?? "—"],
                ...(s.schedule ? ([[<span key="s" className="flex items-center gap-1.5"><CalendarClock className="h-3.5 w-3.5" /> Schedule</span>, s.schedule.at ? `${fmtDateTime(s.schedule.at, s.schedule.timezone)} (${s.schedule.timezone ?? "UTC"})` : "Immediately after approval"]] as Array<[React.ReactNode, React.ReactNode]>) : []),
                ...(s.recipient ? ([[<span key="r" className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> Recipient</span>, s.recipient]] as Array<[React.ReactNode, React.ReactNode]>) : []),
                ...(s.audience ? ([[<span key="a" className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" /> Audience</span>, s.audience]] as Array<[React.ReactNode, React.ReactNode]>) : []),
                ...(s.budget ? ([[<span key="b" className="flex items-center gap-1.5"><Wallet className="h-3.5 w-3.5" /> Budget</span>, `${fmtMoney(s.budget.amountMinor, s.budget.currency)} ${s.budget.period}${s.budget.durationDays ? ` × ${s.budget.durationDays} days (max ${fmtMoney(s.budget.amountMinor * s.budget.durationDays, s.budget.currency)})` : " (no end date)"}`]] as Array<[React.ReactNode, React.ReactNode]>) : []),
                ...(s.landingPage ? ([[<span key="l" className="flex items-center gap-1.5"><Link2 className="h-3.5 w-3.5" /> Landing page</span>, <span key="lv" className="break-all text-brand-600">{s.landingPage}</span>]] as Array<[React.ReactNode, React.ReactNode]>) : []),
                [<span key="f" className="flex items-center gap-1.5"><Fingerprint className="h-3.5 w-3.5" /> Fingerprint</span>, <code key="fv" className="text-[12px]">{a.payloadHash.slice(0, 16)}… {a.subjectVersion ? `(v${a.subjectVersion})` : ""}</code>],
                ["Expires", a.expiresAt ? fmtDateTime(a.expiresAt) : "—"],
                ["Approvals", `${approvals} of ${a.requiredApprovals}${a.requiredApprovals > 1 ? " (two-person rule)" : ""}`],
              ]}
            />
            {s.risks.length ? (
              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold"><AlertTriangle className="h-3.5 w-3.5 text-warning-600" /> Risks & checks</div>
                <ul className="space-y-1">
                  {s.risks.map((r, i) => (
                    <li key={i} className="rounded-md bg-warning-50 px-2.5 py-1.5 text-[12.5px] text-warning-600">{r}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div>
              <div className="mb-1.5 text-[12.5px] font-semibold">What happens if approved</div>
              <ul className="space-y-1">
                {s.sideEffects.map((r, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px] text-fg-muted"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {r}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        {decisions.length ? (
          <div>
            <div className="mb-1.5 text-[12.5px] font-semibold">Decision history</div>
            <ul className="space-y-1.5">
              {decisions.map(({ d, name }) => (
                <li key={d.id} className="text-[12.5px]">
                  <StatusBadge status={d.decision === "approve" ? "approved" : d.decision === "reject" ? "rejected" : d.decision} label={titleCase(d.decision)} /> <span className="font-medium">{name}</span> <span className="text-fg-muted">· {fmtDateTime(d.createdAt)}</span>
                  {d.reason ? <div className="ml-1 text-fg-muted">“{d.reason}”</div> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          {!canDecide ? <span className="mr-auto text-[12.5px] text-fg-subtle">Your role cannot decide Tier {a.tier} actions.</span> : null}
          {selfBlocked ? <span className="mr-auto text-[12.5px] text-fg-subtle">Two-person rule: a different approver must approve your request.</span> : null}
          {a.status === "pending" && canDecide ? (
            <>
              <ConfirmButton label="Request changes" title="Request changes" effect="The item returns to draft with your note. A new approval request is needed after edits." confirmLabel="Send" reason={{ label: "What should change?", required: true }} onConfirm={(r) => decideReq("request_changes", r).then(() => undefined)} />
              <ConfirmButton label="Reject" variant="danger" title="Reject request" effect="Nothing will be executed. The requester sees your reason." confirmLabel="Reject" reason={{ label: "Reason", required: true }} onConfirm={(r) => decideReq("reject", r).then(() => undefined)} />
              <ConfirmButton
                label={a.requiredApprovals > 1 ? `Approve (${approvals}/${a.requiredApprovals})` : "Approve"}
                variant="primary"
                disabled={myApproval || selfBlocked}
                title={`Approve: ${s.title}`}
                effect={
                  <>
                    <p>You are approving fingerprint <code>{a.payloadHash.slice(0, 12)}…</code>. If anything changes before execution, this approval will no longer apply.</p>
                    <ul className="list-disc pl-5">{s.sideEffects.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  </>
                }
                confirmLabel="Approve"
                onConfirm={() => decideReq("approve").then(() => undefined)}
              />
            </>
          ) : null}
          {(a.status === "approved" || a.status === "pending") && canDecide && !isBusy("revoke") ? (
            a.status === "approved" ? <ConfirmButton label="Revoke" variant="danger" title="Revoke approval" effect="Execution will be blocked if it has not started. Already-executed actions must be undone on the provider." confirmLabel="Revoke" reason={{ label: "Reason" }} onConfirm={(r) => decideReq("revoke", r).then(() => undefined)} /> : null
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}
