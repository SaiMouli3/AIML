import { BarChart3, Info } from "lucide-react";
import { Forbidden } from "@/components/forbidden";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
  PageHeader,
  Stat,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { loadPage } from "@/server/http/page";
import { analyticsOverview } from "@/server/services/analytics";
import { fmtDateTime, fmtMoney, fmtNumber, fmtPercent } from "@/lib/format";
import { RunAnalyst } from "./run-analyst";

export const metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

/** Simple horizontal bar for measured values only (no decorative or synthetic series). */
function Bar({ value, max }: { value: number | null; max: number }) {
  if (value === null || max <= 0) return <span className="text-fg-subtle">—</span>;
  return (
    <div className="flex items-center gap-2">
      <div className="bg-border h-1.5 w-24 overflow-hidden rounded-full" aria-hidden>
        <div
          className="bg-brand-600 h-full rounded-full"
          style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
        />
      </div>
      <span className="tabular-nums">{fmtNumber(value)}</span>
    </div>
  );
}

export default async function AnalyticsPage() {
  const { data, allowed } = await loadPage((ctx) => analyticsOverview(ctx), { permission: "analytics.read" });
  if (!allowed) return <Forbidden what="Analytics" />;
  const a = data!;
  const maxReach = Math.max(0, ...a.content.map((c) => Number(c.metrics.reach ?? 0)));
  const maxImpr = Math.max(0, ...a.ads.map((x) => Number(x.impressions ?? 0)));
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Only provider-reported metrics, each with its source and reporting window. Missing data is shown as missing — never estimated."
        actions={<RunAnalyst />}
      />
      {a.dataGaps.length ? (
        <Notice tone="neutral" icon={<Info className="h-4 w-4" />} title="Data gaps" className="mb-6">
          <ul className="list-disc pl-4">
            {a.dataGaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="p-4">
          <Stat
            label="Published (confirmed)"
            value={a.publishedCount}
            sub={a.mockPublishedCount ? `${a.mockPublishedCount} to mock accounts` : "Provider-confirmed"}
          />
        </Card>
        <Card className="p-4">
          <Stat label="Content with insights" value={a.content.length} sub="Instagram Insights API" />
        </Card>
        <Card className="p-4">
          <Stat label="Leads from inbox (30d)" value={a.inbox.leads} sub="Buying-intent conversations" />
        </Card>
        <Card className="p-4">
          <Stat
            label="Replies sent (30d)"
            value={a.inbox.sent}
            sub={`${a.inbox.repliedTo} replied to · ${a.inbox.escalated} escalated`}
          />
        </Card>
      </div>
      <Card className="mb-6">
        <CardHeader
          title="Organic content"
          description="Latest lifetime snapshot per post from the Instagram Insights API."
        />
        {a.content.length === 0 ? (
          <EmptyState
            icon={<BarChart3 className="h-5 w-5" />}
            title="No organic metrics yet"
            description="Metrics appear after live posts are published and the 6-hourly insights sync runs."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Post</Th>
                <Th>Reach</Th>
                <Th>Views</Th>
                <Th>Likes</Th>
                <Th>Comments</Th>
                <Th>Saves</Th>
                <Th>Shares</Th>
                <Th>Source · window</Th>
              </tr>
            </thead>
            <tbody>
              {a.content.map((c) => (
                <tr key={c.content_item_id}>
                  <Td>
                    <div className="font-medium">{c.title}</div>
                    <div className="text-fg-muted text-[12px]">
                      {c.format} · published {fmtDateTime(c.published_at)}
                    </div>
                  </Td>
                  <Td>
                    <Bar value={c.metrics.reach ?? null} max={maxReach} />
                  </Td>
                  <Td>{fmtNumber(c.metrics.views ?? null)}</Td>
                  <Td>{fmtNumber(c.metrics.likes ?? null)}</Td>
                  <Td>{fmtNumber(c.metrics.comments ?? null)}</Td>
                  <Td>{fmtNumber(c.metrics.saved ?? null)}</Td>
                  <Td>{fmtNumber(c.metrics.shares ?? null)}</Td>
                  <Td className="text-fg-muted text-[12px]">
                    {c.sourceLabel}
                    <br />
                    {c.window_label} · fetched {fmtDateTime(c.fetched_at)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card className="mb-6">
        <CardHeader
          title="Paid campaigns"
          description="Meta Marketing API insights. CTR, CPC and CPM are computed only when both inputs exist."
        />
        {a.ads.length === 0 ? (
          <EmptyState
            icon={<BarChart3 className="h-5 w-5" />}
            title="No ad metrics yet"
            description="Metrics appear after a live campaign delivers and insights sync."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th>Impressions</Th>
                <Th>Reach</Th>
                <Th>Clicks</Th>
                <Th>CTR</Th>
                <Th>CPC</Th>
                <Th>CPM</Th>
                <Th>Spend</Th>
                <Th>Conversions</Th>
                <Th>Window</Th>
              </tr>
            </thead>
            <tbody>
              {a.ads.map((x) => (
                <tr key={x.ad_campaign_id}>
                  <Td className="font-medium">{x.name}</Td>
                  <Td>
                    <Bar value={x.impressions} max={maxImpr} />
                  </Td>
                  <Td>{fmtNumber(x.reach)}</Td>
                  <Td>{fmtNumber(x.clicks)}</Td>
                  <Td>{fmtPercent(x.ctr)}</Td>
                  <Td>{x.cpcMinor !== null ? fmtMoney(Math.round(x.cpcMinor), x.currency ?? "USD") : "—"}</Td>
                  <Td>{x.cpmMinor !== null ? fmtMoney(Math.round(x.cpmMinor), x.currency ?? "USD") : "—"}</Td>
                  <Td>{fmtMoney(x.spend_minor, x.currency ?? "USD")}</Td>
                  <Td>{x.conversions === null ? <Badge>Not tracked</Badge> : fmtNumber(x.conversions)}</Td>
                  <Td className="text-fg-muted text-[12px]">
                    {x.date_start} → {x.date_stop}
                    <br />
                    {x.attribution_window}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader
          title="Comment-to-DM funnel (30 days)"
          description="From stored records. Link clicks and sales are not tracked without an attribution integration."
        />
        <CardBody className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-8">
          {(
            [
              ["Drafted", a.inbox.drafted],
              ["Awaiting approval", a.inbox.awaitingApproval],
              ["Approved", a.inbox.approved],
              ["Sent", a.inbox.sent],
              ["Private sent", a.inbox.sentPrivate],
              ["Replied to", a.inbox.repliedTo],
              ["Escalated", a.inbox.escalated],
              ["Failed", a.inbox.failed],
            ] as Array<[string, number]>
          ).map(([k, v]) => (
            <Stat key={k} label={k} value={v} />
          ))}
        </CardBody>
      </Card>
    </>
  );
}
