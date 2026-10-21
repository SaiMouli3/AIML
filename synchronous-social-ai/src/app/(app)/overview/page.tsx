import { ChannelMark } from "@/components/channel-mark";
import { channelLabel } from "@/lib/channels";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  Megaphone,
  Plug,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { ModeBadge, StatusBadge, TierBadge, ContentStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader, Stat } from "@/components/ui/primitives";
import { fmtDateTime, fmtMoney, fmtRelative, titleCase } from "@/lib/format";
import { CONTRACTS, isAgentRole } from "@/server/agents/contracts";
import { loadPage } from "@/server/http/page";
import { overview } from "@/server/services/analytics";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const { data: d, session } = await loadPage((ctx) => overview(ctx));
  const o = d!;
  const tz = o.workspace.timezone;
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(new Date()),
  );
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const needsHuman = (o.inbox.needs_human ?? 0) + (o.inbox.awaiting_approval ?? 0);
  const isNew = o.profile.completeness < 60;
  return (
    <>
      <PageHeader
        eyebrow={o.workspace.name}
        title={`${greet}, ${session.user.name.split(" ")[0]}`}
        description="Everything below comes from stored workspace data and connected providers. Nothing is estimated or invented."
        actions={
          <>
            <Link href="/campaigns?new=promotion">
              <Button>
                <Megaphone className="h-4 w-4" /> Plan a promotion
              </Button>
            </Link>
            <Link href="/content?new=1">
              <Button variant="primary">
                <Sparkles className="h-4 w-4" /> Create content
              </Button>
            </Link>
          </>
        }
      />

      {isNew ? (
        <Card className="mb-6 overflow-hidden">
          <div className="flex flex-col gap-5 p-5 md:flex-row md:items-center">
            <div className="bg-brand-50 text-brand-600 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-semibold">Complete your company profile</h2>
              <p className="text-fg-muted mt-0.5 text-[13px]">
                Agents only use facts you approve. The more complete your Company Brain, the less generic
                their drafts.
              </p>
              <div className="mt-3 flex items-center gap-3">
                <div
                  className="bg-border h-1.5 w-full max-w-sm overflow-hidden rounded-full"
                  role="progressbar"
                  aria-valuenow={o.profile.completeness}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Profile completeness"
                >
                  <div
                    className="bg-brand-600 h-full rounded-full"
                    style={{ width: `${o.profile.completeness}%` }}
                  />
                </div>
                <span className="text-fg-muted text-[12px] font-medium tabular-nums">
                  {o.profile.completeness}%
                </span>
              </div>
              {o.profile.missing.length ? (
                <p className="text-fg-subtle mt-2 text-[12px]">
                  Missing: {o.profile.missing.map(titleCase).join(", ")}
                </p>
              ) : null}
            </div>
            <Link href="/brain?onboarding=1">
              <Button variant="primary">
                Complete company profile <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </Card>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Card className="p-4">
          <Stat
            label="Approvals waiting"
            value={o.approvalCount}
            sub={o.approvalCount ? "Highest tier first" : "Queue is clear"}
            tone={o.approvalCount ? "warning" : undefined}
          />
        </Card>
        <Card className="p-4">
          <Stat label="Content due today" value={o.dueToday.length} sub={`Timezone ${tz}`} />
        </Card>
        <Card className="p-4">
          <Stat
            label="Inbox needing you"
            value={needsHuman}
            sub={`${o.inbox.open ?? 0} open · ${o.inbox.handled ?? 0} handled`}
            tone={needsHuman ? "warning" : undefined}
          />
        </Card>
        <Card className="p-4">
          <Stat
            label="Known ad spend"
            value={
              o.knownSpend.spendMinor !== null
                ? fmtMoney(o.knownSpend.spendMinor, o.knownSpend.currency ?? o.workspace.currency)
                : "—"
            }
            sub={o.knownSpend.spendMinor !== null ? "Meta insights, latest sync" : "No provider spend data"}
          />
        </Card>
        <Card className="p-4">
          <Stat
            label="Failed jobs / uncertain"
            value={`${o.failedJobs} / ${o.unknownActions}`}
            sub={o.failedJobs || o.unknownActions ? "Review in Settings → Operations" : "No failures"}
            tone={o.failedJobs || o.unknownActions ? "danger" : undefined}
          />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Waiting for your approval"
              description="Each approval is bound to the exact version shown."
              actions={
                <Link href="/approvals" className="text-brand-600 text-[13px] font-medium hover:underline">
                  Open Approval Center
                </Link>
              }
            />
            {o.approvals.length === 0 ? (
              <EmptyState
                icon={<ShieldCheck className="h-5 w-5" />}
                title="Nothing waiting"
                description="Requests for publishing, replies and ad launches will appear here."
              />
            ) : (
              <ul className="divide-border divide-y">
                {o.approvals.map((a) => (
                  <li key={a.id}>
                    <Link
                      href={`/approvals?id=${a.id}`}
                      className="hover:bg-surface-2 flex items-center gap-3 px-5 py-3"
                    >
                      <TierBadge tier={a.tier} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium">{a.summary.title}</div>
                        <div className="text-fg-muted text-[12px]">
                          {a.summary.channel} · requested {fmtRelative(a.createdAt)}
                          {a.requiredApprovals > 1 ? " · two-person approval" : ""}
                        </div>
                      </div>
                      <ModeBadge mode={a.summary.mode} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Scheduled this week"
              description="Content and campaign milestones in the next 7 days."
              actions={
                <Link href="/calendar" className="text-brand-600 text-[13px] font-medium hover:underline">
                  Calendar
                </Link>
              }
            />
            {o.upcoming.length === 0 && o.promotions.length === 0 ? (
              <EmptyState
                icon={<CalendarClock className="h-5 w-5" />}
                title="Nothing scheduled"
                description="Schedule content from the Content Studio."
              />
            ) : (
              <ul className="divide-border divide-y">
                {o.upcoming.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/content?id=${c.id}`}
                      className="hover:bg-surface-2 flex items-center gap-3 px-5 py-3"
                    >
                      <div className="text-fg-muted w-[120px] shrink-0 text-[12px] tabular-nums">
                        {fmtDateTime(c.scheduledAt, c.timezone ?? tz)}
                      </div>
                      <div className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{c.title}</div>
                      <Badge>{titleCase(c.format)}</Badge>
                      <ContentStatus status={c.status} />
                    </Link>
                  </li>
                ))}
                {o.promotions.map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/campaigns?promotion=${p.id}`}
                      className="hover:bg-surface-2 flex items-center gap-3 px-5 py-3"
                    >
                      <div className="text-fg-muted w-[120px] shrink-0 text-[12px] tabular-nums">
                        {p.startsAt ? fmtDateTime(p.startsAt, p.timezone ?? tz) : "Dates missing"}
                      </div>
                      <div className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                        Promotion: {p.name}
                      </div>
                      <StatusBadge status={p.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Recent results"
              description="Published items. Performance metrics appear in Analytics only after a provider sync."
              actions={
                <Link href="/analytics" className="text-brand-600 text-[13px] font-medium hover:underline">
                  Analytics
                </Link>
              }
            />
            {o.recentPublished.length === 0 ? (
              <EmptyState
                icon={<CheckCircle2 className="h-5 w-5" />}
                title="No published content yet"
                description="Results appear here once content is published and confirmed by the provider."
              />
            ) : (
              <ul className="divide-border divide-y">
                {o.recentPublished.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium">{c.title}</div>
                      <div className="text-fg-muted text-[12px]">Published {fmtRelative(c.publishedAt)}</div>
                    </div>
                    <ModeBadge mode={c.publishMode} />
                    {c.permalink && c.publishMode === "live" ? (
                      <a
                        href={c.permalink}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-brand-600 text-[12.5px] font-medium hover:underline"
                      >
                        View on Instagram
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Integration health"
              actions={
                <Link href="/integrations" className="text-brand-600 text-[13px] font-medium hover:underline">
                  Manage
                </Link>
              }
            />
            {o.accounts.length === 0 ? (
              <EmptyState
                icon={<Plug className="h-5 w-5" />}
                title="No accounts connected"
                description="Connect Instagram and Meta through official authorization."
                action={
                  <Link href="/integrations">
                    <Button size="sm">Connect</Button>
                  </Link>
                }
              />
            ) : (
              <ul className="divide-border divide-y">
                {o.accounts.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                    <ChannelMark provider={a.provider} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium">{a.displayName}</div>
                      <div className="text-fg-muted text-[12px]">
                        {channelLabel(a.provider)}
                        {a.tokenExpiresAt
                          ? ` · token ${new Date(a.tokenExpiresAt) < new Date() ? "expired" : `expires ${fmtRelative(a.tokenExpiresAt)}`}`
                          : ""}
                      </div>
                      {a.healthError ? (
                        <div className="text-danger-600 mt-0.5 text-[12px]">{a.healthError}</div>
                      ) : null}
                    </div>
                    {a.expiringSoon && a.mode === "live" ? (
                      <Badge tone="warning">
                        <AlertTriangle className="h-3 w-3" /> Expiring
                      </Badge>
                    ) : null}
                    <ModeBadge mode={a.mode} />
                    <StatusBadge status={a.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Agent activity"
              description="Recorded runs with status. No live animations."
              actions={
                <Link href="/ai-team" className="text-brand-600 text-[13px] font-medium hover:underline">
                  AI Team
                </Link>
              }
            />
            {o.runs.length === 0 ? (
              <EmptyState
                icon={<Bot className="h-5 w-5" />}
                title="No agent runs yet"
                description="Ask the strategist for a 30-day plan to get started."
              />
            ) : (
              <ol className="relative px-5 py-3">
                {o.runs.map((r) => (
                  <li key={r.id} className="flex gap-3 py-2">
                    <span className="bg-border-strong mt-1.5 h-2 w-2 shrink-0 rounded-full" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium">
                          {isAgentRole(r.agentRole) ? CONTRACTS[r.agentRole].title : r.agentRole}
                        </span>
                        <StatusBadge status={r.state} />
                        {r.provider === "mock" ? <Badge tone="warning">Mock LLM</Badge> : null}
                      </div>
                      <div className="text-fg-subtle text-[12px]">
                        {fmtRelative(r.createdAt)}
                        {r.error ? ` · ${r.error}` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Active campaigns"
              actions={
                <Link href="/campaigns" className="text-brand-600 text-[13px] font-medium hover:underline">
                  Campaigns
                </Link>
              }
            />
            {o.ads.length === 0 ? (
              <EmptyState
                icon={<Megaphone className="h-5 w-5" />}
                title="No ad campaigns"
                description="Ad drafts and launches show here with their provider status."
              />
            ) : (
              <ul className="divide-border divide-y">
                {o.ads.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium">{a.name}</div>
                      <div className="text-fg-muted text-[12px]">
                        {fmtMoney(a.dailyBudgetMinor, a.currency)}/day
                      </div>
                    </div>
                    <ModeBadge mode={a.mode} />
                    <StatusBadge status={a.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {o.workspace.spendCapMinor === 0 ? (
            <Notice tone="neutral" title="Ad spend cap is 0">
              Live ad launches are blocked until an owner sets a monthly spend cap in Settings.
            </Notice>
          ) : null}
        </div>
      </div>
    </>
  );
}
