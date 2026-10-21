import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { ContentStatus } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Badge, Card, PageHeader } from "@/components/ui/primitives";
import { Forbidden } from "@/components/forbidden";
import * as s from "@/server/db/schema";
import { loadPage } from "@/server/http/page";
import { calendar } from "@/server/services/content";
import { cn } from "@/lib/cn";

export const metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

/** Calendar day key (YYYY-MM-DD) in the workspace timezone. */
function dayKey(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; view?: string; format?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const view = sp.view === "list" ? "list" : sp.view === "week" ? "week" : "month";
  const base = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? new Date(`${sp.month}-01T12:00:00Z`) : new Date();
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const first = new Date(Date.UTC(y, m, 1));
  const gridStart = new Date(first.getTime() - first.getUTCDay() * 86400_000);
  const days = view === "week" ? 7 : 42;
  const start = view === "week" ? new Date(Date.now() - new Date().getUTCDay() * 86400_000) : gridStart;
  const end = new Date(start.getTime() + days * 86400_000);
  const { data, allowed } = await loadPage(
    async (ctx) => {
      const ws = (
        await ctx.tx.select().from(s.workspaces).where(eq(s.workspaces.id, ctx.workspaceId)).limit(1)
      )[0]!;
      return { ...(await calendar(ctx, start.toISOString(), end.toISOString())), tz: ws.timezone };
    },
    { permission: "content.read" },
  );
  if (!allowed) return <Forbidden what="the calendar" />;
  const { tz, promotions } = data!;
  const items = data!.items.filter(
    (i) => (!sp.format || i.format === sp.format) && (!sp.status || i.status === sp.status),
  );
  const byDay = new Map<string, typeof items>();
  for (const i of items) {
    const k = dayKey(i.scheduledAt!, tz);
    byDay.set(k, [...(byDay.get(k) ?? []), i]);
  }
  const monthLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(first);
  const prev = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 7);
  const q = (o: Record<string, string>) =>
    `?${new URLSearchParams({ view, month: `${y}-${String(m + 1).padStart(2, "0")}`, ...(sp.format ? { format: sp.format } : {}), ...(sp.status ? { status: sp.status } : {}), ...o })}`;
  const today = dayKey(new Date(), tz);
  return (
    <>
      <PageHeader
        title="Calendar"
        description={`Scheduled content and promotion windows in ${tz}.`}
        actions={
          <>
            <div className="border-border bg-surface-2 inline-flex rounded-lg border p-1">
              {(["month", "week", "list"] as const).map((v) => (
                <Link
                  key={v}
                  href={q({ view: v })}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[12.5px] font-medium",
                    view === v ? "bg-surface shadow-[var(--shadow-card)]" : "text-fg-muted",
                  )}
                >
                  {v[0]!.toUpperCase() + v.slice(1)}
                </Link>
              ))}
            </div>
            <form className="flex gap-2" action="/calendar">
              <input type="hidden" name="view" value={view} />
              <select
                name="format"
                defaultValue={sp.format ?? ""}
                aria-label="Format filter"
                className="border-border bg-surface h-9 rounded-lg border px-2 text-[13px]"
              >
                <option value="">All formats</option>
                {["post", "carousel", "story", "reel"].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <select
                name="status"
                defaultValue={sp.status ?? ""}
                aria-label="Status filter"
                className="border-border bg-surface h-9 rounded-lg border px-2 text-[13px]"
              >
                <option value="">All statuses</option>
                {["draft", "in_review", "scheduled", "published", "failed"].map((f) => (
                  <option key={f} value={f}>
                    {f.replace("_", " ")}
                  </option>
                ))}
              </select>
              <Button type="submit" size="md">
                Filter
              </Button>
            </form>
          </>
        }
      />
      {view !== "list" ? (
        <Card className="overflow-hidden">
          <div className="border-border flex items-center gap-2 border-b px-4 py-3">
            {view === "month" ? (
              <>
                <Link href={q({ month: prev })} aria-label="Previous month">
                  <Button size="icon" variant="ghost">
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </Link>
                <span className="w-40 text-center text-[14px] font-semibold">{monthLabel}</span>
                <Link href={q({ month: next })} aria-label="Next month">
                  <Button size="icon" variant="ghost">
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </Link>
              </>
            ) : (
              <span className="text-[14px] font-semibold">This week</span>
            )}
          </div>
          <div className="border-border bg-surface-2 text-fg-muted grid grid-cols-7 border-b text-[11.5px] font-medium">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d} className="px-2 py-1.5">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {Array.from({ length: days }, (_, i) => {
              const d = new Date(start.getTime() + i * 86400_000);
              const k = dayKey(d, tz);
              const inMonth = view === "week" || d.getUTCMonth() === m;
              const promo = promotions.filter(
                (p) => p.startsAt && p.endsAt && dayKey(p.startsAt, tz) <= k && dayKey(p.endsAt, tz) >= k,
              );
              return (
                <div
                  key={k}
                  className={cn(
                    "border-border min-h-[104px] border-r border-b p-1.5 [&:nth-child(7n)]:border-r-0",
                    !inMonth && "bg-surface-2/60 text-fg-subtle",
                    view === "week" && "min-h-[260px]",
                  )}
                >
                  <div
                    className={cn(
                      "mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-[12px]",
                      k === today && "bg-brand-600 font-semibold text-white",
                    )}
                  >
                    {Number(k.slice(8))}
                  </div>
                  {promo.map((p) => (
                    <Link
                      key={p.id}
                      href={`/campaigns?promotion=${p.id}`}
                      className="bg-warning-50 text-warning-600 mb-1 block truncate rounded px-1.5 py-0.5 text-[11px] font-medium"
                    >
                      🏷 {p.name}
                    </Link>
                  ))}
                  {(byDay.get(k) ?? []).map((c) => (
                    <Link
                      key={c.id}
                      href={`/content?id=${c.id}`}
                      className="border-border bg-surface hover:border-brand-500 mb-1 block rounded border px-1.5 py-1 text-[11.5px]"
                    >
                      <div className="truncate font-medium">
                        {new Intl.DateTimeFormat("en-US", {
                          timeStyle: "short",
                          timeZone: c.timezone ?? tz,
                        }).format(c.scheduledAt!)}{" "}
                        {c.title}
                      </div>
                      <div className="mt-0.5">
                        <ContentStatus status={c.status} />
                      </div>
                    </Link>
                  ))}
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        <Card>
          <ul className="divide-border divide-y">
            {items.length === 0 ? (
              <li className="text-fg-muted px-5 py-10 text-center text-[13px]">
                Nothing scheduled in this range.
              </li>
            ) : null}
            {items.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/content?id=${c.id}`}
                  className="hover:bg-surface-2 flex items-center gap-3 px-5 py-3"
                >
                  <span className="text-fg-muted w-44 text-[12.5px] tabular-nums">
                    {new Intl.DateTimeFormat("en-US", {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: c.timezone ?? tz,
                    }).format(c.scheduledAt!)}
                  </span>
                  <span className="flex-1 font-medium">{c.title}</span>
                  <Badge>{c.format}</Badge>
                  <ContentStatus status={c.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
