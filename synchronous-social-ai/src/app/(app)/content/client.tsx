"use client";

import {
  AlertTriangle,
  CheckCircle2,
  History,
  ImagePlus,
  Info,
  PenSquare,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
  Sparkles,
  Archive,
  Copy,
  Wand2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ChannelMark } from "@/components/channel-mark";
import { ChannelPreview } from "@/components/channel-preview";
import { ContentStatus, ModeBadge, StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  ConfirmButton,
  Dialog,
  Drawer,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/overlay";
import {
  Badge,
  Card,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Notice,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { useRun } from "@/components/use-run";
import { api } from "@/lib/api-client";
import {
  CHANNEL_META,
  CONTENT_FORMATS,
  channelLabel,
  formatLabel,
  isSocialChannel,
  textLength,
  validateForChannel,
  type SocialChannel,
} from "@/lib/channels";
import { fmtDateTime, fmtRelative, titleCase } from "@/lib/format";

type Finding = { severity: "block" | "warning" | "info"; code: string; message: string };
type Version = {
  id: string;
  version: number;
  caption: string;
  cta: string | null;
  altText: string | null;
  hashtags: string[];
  language: string;
  targetSegment: string | null;
  mediaAssetIds: string[];
  brandCheck: { status: string; findings: Finding[] } | null;
  changeNote: string | null;
  createdAt: string;
  agentRunId: string | null;
  sourceFactIds: string[];
  brief: Record<string, unknown> | null;
};
type Item = {
  id: string;
  title: string;
  format: string;
  status: string;
  scheduledAt: string | null;
  timezone: string | null;
  connectedAccountId: string | null;
  promotionId: string | null;
  productIds: string[];
  publishMode: string | null;
  permalink: string | null;
  lastError: string | null;
  updatedAt: string;
  publishedAt: string | null;
  currentVersion: number;
  version?: Version | null;
};
type Asset = {
  id: string;
  kind: string;
  url: string;
  title: string | null;
  origin: string;
  mimeType: string;
  width: number | null;
  height: number | null;
};
type Account = {
  id: string;
  provider: string;
  displayName: string;
  username: string | null;
  mode: string;
  status: string;
};

const channelOf = (a: Account | null | undefined): SocialChannel | null =>
  a && isSocialChannel(a.provider) ? a.provider : null;

/** "Facebook · Lumen Candles" / "X · @lumen" — used in every destination picker. */
function accountLabel(a: Account) {
  const ch = channelOf(a);
  const handle =
    a.username && a.provider !== "facebook"
      ? `${ch ? CHANNEL_META[ch].handlePrefix : "@"}${a.username}`
      : a.displayName;
  return `${channelLabel(a.provider)} · ${handle}`;
}

/** Destination <option>s grouped by channel. */
function AccountOptions({ accounts, format }: { accounts: Account[]; format?: string }) {
  return (
    <>
      {[...new Set(accounts.map((a) => a.provider))].map((p) => (
        <optgroup key={p} label={channelLabel(p)}>
          {accounts
            .filter((a) => a.provider === p)
            .map((a) => {
              const ch = channelOf(a);
              const unsupported = Boolean(
                format && ch && !CHANNEL_META[ch].formats.includes(format as never),
              );
              return (
                <option key={a.id} value={a.id} disabled={a.status !== "connected" || unsupported}>
                  {accountLabel(a)}
                  {a.mode === "mock" ? " (MOCK — nothing is posted)" : ""}
                  {a.status !== "connected" ? ` (${a.status})` : ""}
                  {unsupported ? ` (no ${formatLabel(ch, format!).toLowerCase()})` : ""}
                </option>
              );
            })}
        </optgroup>
      ))}
    </>
  );
}
interface Detail {
  item: Item;
  current: Version;
  versions: Version[];
  media: Asset[];
  approvals: Array<{
    id: string;
    status: string;
    actionType: string;
    createdAt: string;
    statusReason: string | null;
  }>;
  actions: Array<{
    id: string;
    status: string;
    mode: string;
    providerRef: string | null;
    error: string | null;
    createdAt: string;
    attempts: number;
  }>;
  facts: Array<{ id: string; key: string; value: string }>;
  account: Account | null;
}
interface Data {
  items: Item[];
  accounts: Account[];
  detail: Detail | null;
  media: Asset[];
  products: Array<{ id: string; name: string }>;
  promotions: Array<{ id: string; name: string; status: string }>;
  timezone: string;
}

const STATUS_FILTERS = [
  "",
  "concept",
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "failed",
  "archived",
];

/** datetime-local value in a specific IANA timezone ⇄ ISO string. */
function toLocalInput(iso: string | null, tz: string) {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}
export function fromLocalInput(v: string, tz: string): string | null {
  if (!v) return null;
  const asUtc = new Date(`${v}:00Z`);
  const tzNow = new Date(asUtc.toLocaleString("en-US", { timeZone: tz }));
  const utcNow = new Date(asUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(asUtc.getTime() - (tzNow.getTime() - utcNow.getTime())).toISOString();
}

export function ContentClient({
  data,
  canWrite,
  canRequest,
  openNew,
  filters,
}: {
  data: Data;
  canWrite: boolean;
  canRequest: boolean;
  openNew: boolean;
  filters: { status: string; format: string };
}) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [creating, setCreating] = useState(openNew);
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(sp.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    router.push(`${path}?${p.toString()}`);
  };
  const accountName = (id: string | null) => data.accounts.find((a) => a.id === id);
  return (
    <>
      <Card>
        <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
          <Select
            aria-label="Filter by status"
            value={filters.status}
            onChange={(e) => setParam("status", e.target.value || null)}
            className="h-8 w-[160px] text-[12.5px]"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s ? titleCase(s) : "All statuses"}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by format"
            value={filters.format}
            onChange={(e) => setParam("format", e.target.value || null)}
            className="h-8 w-[140px] text-[12.5px]"
          >
            <option value="">All formats</option>
            {["post", "carousel", "story", "reel"].map((f) => (
              <option key={f} value={f}>
                {titleCase(f)}
              </option>
            ))}
          </Select>
          <div className="ml-auto flex gap-2">
            <Link href="/calendar">
              <Button size="sm" variant="ghost">
                Calendar view
              </Button>
            </Link>
            {canWrite ? (
              <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" /> New content
              </Button>
            ) : null}
          </div>
        </div>
        {data.items.length === 0 ? (
          <EmptyState
            icon={<PenSquare className="h-5 w-5" />}
            title="No content yet"
            description="Create a draft yourself or let the copywriter agent draft variants from a brief."
            action={
              canWrite ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New content
                </Button>
              ) : null
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Title</Th>
                <Th>Format</Th>
                <Th>Status</Th>
                <Th>Channel</Th>
                <Th>Schedule</Th>
                <Th>Checks</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => {
                const acct = accountName(i.connectedAccountId);
                const check = i.version?.brandCheck?.status;
                return (
                  <tr
                    key={i.id}
                    className="hover:bg-surface-2 cursor-pointer"
                    onClick={() => setParam("id", i.id)}
                  >
                    <Td>
                      <button
                        className="text-left font-medium hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setParam("id", i.id);
                        }}
                      >
                        {i.title}
                      </button>
                      <div className="text-fg-muted line-clamp-1 max-w-[340px] text-[12px]">
                        {i.version?.caption || "No caption yet"}
                      </div>
                    </Td>
                    <Td>
                      <Badge>{formatLabel(acct?.provider, i.format)}</Badge>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <ContentStatus status={i.status} />
                        {i.status === "published" ? <ModeBadge mode={i.publishMode} /> : null}
                      </div>
                    </Td>
                    <Td className="text-[12.5px]">
                      {acct ? (
                        <span className="flex items-center gap-1.5">
                          <ChannelMark provider={acct.provider} size="xs" />
                          <span className="max-w-[160px] truncate">{accountLabel(acct).split(" · ")[1]}</span>
                          <ModeBadge mode={acct.mode} />
                        </span>
                      ) : (
                        <span className="text-fg-subtle">Not set</span>
                      )}
                    </Td>
                    <Td className="text-[12.5px] whitespace-nowrap tabular-nums">
                      {i.scheduledAt ? (
                        fmtDateTime(i.scheduledAt, i.timezone)
                      ) : (
                        <span className="text-fg-subtle">Unscheduled</span>
                      )}
                    </Td>
                    <Td>
                      {check === "block" ? (
                        <Badge tone="danger">Blocked</Badge>
                      ) : check === "warning" ? (
                        <Badge tone="warning">Warnings</Badge>
                      ) : check === "pass" ? (
                        <Badge tone="success">Pass</Badge>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td className="text-fg-muted text-[12.5px]">{fmtRelative(i.updatedAt)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        data={data}
        onCreated={(id) => setParam("id", id)}
      />
      {data.detail ? (
        <ContentDrawer
          key={`${data.detail.item.id}:${data.detail.item.currentVersion}:${data.detail.item.status}`}
          detail={data.detail}
          data={data}
          canWrite={canWrite}
          canRequest={canRequest}
          onClose={() => setParam("id", null)}
        />
      ) : null}
    </>
  );
}

function CreateDialog({
  open,
  onOpenChange,
  data,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  data: Data;
  onCreated: (id: string) => void;
}) {
  const { run, isBusy } = useAction();
  const [accountId, setAccountId] = useState("");
  const [format, setFormat] = useState("post");
  const ch = channelOf(data.accounts.find((a) => a.id === accountId));
  const formats = ch ? CHANNEL_META[ch].formats : CONTENT_FORMATS;
  useEffect(() => {
    if (!formats.includes(format as never)) setFormat(formats[0]!);
  }, [formats, format]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New content"
      description="Start as a concept or a draft. Nothing is published without approval."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run(
            "create",
            () =>
              api<{ id: string }>("/content", {
                body: {
                  title: f.get("title"),
                  format: f.get("format"),
                  status: f.get("status"),
                  connectedAccountId: f.get("account") || null,
                  promotionId: f.get("promotion") || null,
                  productIds: f.get("product") ? [f.get("product")] : [],
                  timezone: data.timezone,
                  version: { caption: f.get("caption") ?? "" },
                },
              }),
            { success: "Content created" },
          ).then((r) => {
            if (r) {
              onOpenChange(false);
              onCreated(r.id);
            }
          });
        }}
        className="grid gap-4 md:grid-cols-2"
      >
        <Field label="Title (internal)" htmlFor="c-title" className="md:col-span-2">
          <Input id="c-title" name="title" required />
        </Field>
        <Field
          label="Channel"
          htmlFor="c-account"
          className="md:col-span-2"
          hint={
            data.accounts.length
              ? "Copy it to more channels later from the editor."
              : "Connect a channel in Integrations to publish."
          }
        >
          <Select
            id="c-account"
            name="account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            <option value="">Decide later</option>
            <AccountOptions accounts={data.accounts} />
          </Select>
        </Field>
        <Field label="Format" htmlFor="c-format">
          <Select id="c-format" name="format" value={format} onChange={(e) => setFormat(e.target.value)}>
            {formats.map((f) => (
              <option key={f} value={f}>
                {f === "post" && (!ch || ch === "instagram") ? "Feed post" : formatLabel(ch, f)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Stage" htmlFor="c-status">
          <Select id="c-status" name="status" defaultValue="draft">
            <option value="concept">Concept (idea only)</option>
            <option value="draft">Draft</option>
          </Select>
        </Field>
        <Field
          label="Featured product"
          htmlFor="c-product"
          hint="Links comments on this post to the product."
        >
          <Select id="c-product" name="product" defaultValue="">
            <option value="">None</option>
            {data.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Promotion"
          htmlFor="c-promo"
          className="md:col-span-2"
          hint="Copy is checked against the offer terms."
        >
          <Select id="c-promo" name="promotion" defaultValue="">
            <option value="">None</option>
            {data.promotions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.status})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Caption (optional)" htmlFor="c-caption" className="md:col-span-2">
          <Textarea id="c-caption" name="caption" maxLength={2200} />
        </Field>
        <div className="flex justify-end md:col-span-2">
          <Button type="submit" variant="primary" loading={isBusy("create")}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ContentDrawer({
  detail,
  data,
  canWrite,
  canRequest,
  onClose,
}: {
  detail: Detail;
  data: Data;
  canWrite: boolean;
  canRequest: boolean;
  onClose: () => void;
}) {
  const { run, isBusy } = useAction();
  const { item, current } = detail;
  const tz = item.timezone ?? data.timezone;
  const [caption, setCaption] = useState(current.caption);
  const [cta, setCta] = useState(current.cta ?? "");
  const [alt, setAlt] = useState(current.altText ?? "");
  const [tags, setTags] = useState(current.hashtags.join(" "));
  const [segment, setSegment] = useState(current.targetSegment ?? "");
  const [language, setLanguage] = useState(current.language);
  const [mediaIds, setMediaIds] = useState<string[]>(current.mediaAssetIds);
  const [note, setNote] = useState("");
  const [picker, setPicker] = useState(false);
  const [assist, setAssist] = useState(false);
  const locked = ["publishing", "published"].includes(item.status) || !canWrite;
  const hashtags = tags.split(/[\s,#]+/).filter(Boolean);
  const dirty =
    caption !== current.caption ||
    cta !== (current.cta ?? "") ||
    alt !== (current.altText ?? "") ||
    hashtags.join(" ") !== current.hashtags.join(" ") ||
    segment !== (current.targetSegment ?? "") ||
    language !== current.language ||
    mediaIds.join() !== current.mediaAssetIds.join();
  const allMedia = useMemo(
    () => [...detail.media, ...data.media].filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i),
    [detail.media, data.media],
  );
  const previewMedia = mediaIds.map((id) => allMedia.find((m) => m.id === id)).filter(Boolean) as Asset[];
  const findings = current.brandCheck?.findings ?? [];
  const pendingApproval = detail.approvals.find((a) => a.status === "pending" || a.status === "approved");
  const account = detail.account;
  const channel = channelOf(account);
  const fullText = [caption, hashtags.map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n\n");
  const limit = channel ? Math.min(CHANNEL_META[channel].textLimit, 2200) : 2200;
  const used = channel ? textLength(channel, fullText) : caption.length;
  const channelProblems = channel ? validateForChannel(channel, item.format, previewMedia, fullText) : [];
  const [copying, setCopying] = useState(false);

  const saveVersion = () =>
    run(
      "save",
      () =>
        api(`/content/${item.id}/versions`, {
          body: {
            caption,
            cta: cta || null,
            altText: alt || null,
            hashtags,
            language,
            targetSegment: segment || null,
            mediaAssetIds: mediaIds,
            sourceFactIds: current.sourceFactIds,
            brief: current.brief,
            changeNote: note || undefined,
          },
        }),
      { success: "New version saved" },
    );

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="max-w-[1100px]"
      title={
        <span className="flex items-center gap-2">
          {item.title} <ContentStatus status={item.status} />{" "}
          {item.status === "published" ? <ModeBadge mode={item.publishMode} /> : null}
        </span>
      }
      description={`${channel ? `${CHANNEL_META[channel].label} ` : ""}${formatLabel(channel, item.format)} · version ${item.currentVersion} · updated ${fmtRelative(item.updatedAt)}`}
      footer={
        <>
          {item.status === "failed" && canWrite ? (
            <Button
              onClick={() =>
                run("reset", () => api(`/content/${item.id}/reset`, { body: {} }), {
                  success: "Returned to draft",
                })
              }
            >
              <RotateCcw className="h-4 w-4" /> Return to draft
            </Button>
          ) : null}
          {canWrite && data.accounts.length ? (
            <Button variant="ghost" onClick={() => setCopying(true)}>
              <Copy className="h-4 w-4" /> Copy to channel
            </Button>
          ) : null}
          {canWrite && !locked ? (
            <ConfirmButton
              label={
                <>
                  <Archive className="h-4 w-4" /> Archive
                </>
              }
              variant="ghost"
              title="Archive content?"
              effect="Open approvals for this item are invalidated. The content stays in history."
              confirmLabel="Archive"
              onConfirm={async () => {
                await run("archive", () => api(`/content/${item.id}/archive`, { body: {} }), {
                  success: "Archived",
                });
                onClose();
              }}
            />
          ) : null}
          {canWrite && !locked ? (
            <Button
              onClick={saveVersion}
              disabled={!dirty}
              loading={isBusy("save")}
              title={dirty ? undefined : "No changes to save"}
            >
              Save as new version
            </Button>
          ) : null}
          {canRequest && !locked ? (
            <Button
              variant="primary"
              disabled={dirty || Boolean(pendingApproval) || item.status === "concept"}
              title={
                dirty
                  ? "Save your changes first"
                  : pendingApproval
                    ? "An approval is already open for this version"
                    : item.status === "concept"
                      ? "Convert the concept to a draft by saving a version first"
                      : undefined
              }
              loading={isBusy("request")}
              onClick={() =>
                run("request", () => api(`/content/${item.id}/request-approval`, { body: {} }), {
                  success: "Sent to the Approval Center",
                })
              }
            >
              <Send className="h-4 w-4" /> Prepare for approval
            </Button>
          ) : null}
        </>
      }
    >
      {item.lastError ? (
        <Notice tone="danger" title="Last publish attempt failed" className="mb-4">
          {item.lastError}
        </Notice>
      ) : null}
      {item.status === "published" ? (
        <Notice
          tone={item.publishMode === "mock" ? "warning" : "success"}
          title={
            item.publishMode === "mock"
              ? "Published to a MOCK account"
              : `Published and confirmed by ${channel ? CHANNEL_META[channel].label : "the platform"}`
          }
          className="mb-4"
        >
          {item.publishMode === "mock" ? (
            `Nothing was posted to ${channel ? CHANNEL_META[channel].label : "the platform"}. This shows the end-to-end flow only.`
          ) : item.permalink ? (
            <a className="underline" href={item.permalink} target="_blank" rel="noreferrer noopener">
              {item.permalink}
            </a>
          ) : (
            "Provider confirmed the media ID."
          )}
        </Notice>
      ) : null}
      {pendingApproval ? (
        <Notice tone="info" title={`Approval ${pendingApproval.status}`} className="mb-4">
          Editing caption, media, account or schedule will invalidate this approval.{" "}
          <Link className="underline" href={`/approvals?id=${pendingApproval.id}`}>
            Open in Approval Center
          </Link>
        </Notice>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <ChannelPreview
            channel={channel}
            name={account?.displayName ?? "Your brand"}
            username={account?.username ?? null}
            format={item.format}
            caption={caption}
            hashtags={hashtags}
            media={previewMedia}
          />
          {channel && channelProblems.length ? (
            <Notice tone="warning" title={`${CHANNEL_META[channel].label} rules`}>
              <ul className="list-disc space-y-0.5 pl-4">
                {channelProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
              {current.brandCheck?.status === "block" ? (
                <ShieldAlert className="text-danger-600 h-4 w-4" />
              ) : current.brandCheck?.status === "warning" ? (
                <AlertTriangle className="text-warning-600 h-4 w-4" />
              ) : (
                <CheckCircle2 className="text-success-600 h-4 w-4" />
              )}
              Brand & platform checks (saved version)
            </div>
            {findings.length === 0 ? (
              <p className="text-fg-muted text-[12.5px]">No issues found.</p>
            ) : (
              <ul className="space-y-1.5">
                {findings.map((f, i) => (
                  <li key={i} className="flex gap-2 text-[12.5px]">
                    <Badge
                      tone={
                        f.severity === "block" ? "danger" : f.severity === "warning" ? "warning" : "neutral"
                      }
                    >
                      {f.severity}
                    </Badge>
                    <span className="text-fg-muted">{f.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <Tabs defaultValue="copy">
          <TabsList className="mb-4">
            <TabsTrigger value="copy">Copy & media</TabsTrigger>
            <TabsTrigger value="schedule">Destination & schedule</TabsTrigger>
            <TabsTrigger value="history" count={detail.versions.length}>
              History
            </TabsTrigger>
          </TabsList>
          <TabsContent value="copy" className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-fg-muted text-[12.5px]">
                {current.agentRunId ? "Drafted with the copywriter agent" : "Written by a person"}
              </span>
              {canWrite && !locked ? (
                <Button size="sm" onClick={() => setAssist(true)}>
                  <Wand2 className="h-3.5 w-3.5" /> Draft with AI
                </Button>
              ) : null}
            </div>
            <Field
              label={`Caption (${used.toLocaleString()}/${limit.toLocaleString()}${channel && channel !== "instagram" ? ", incl. hashtags" : ""})`}
              htmlFor="d-caption"
            >
              <Textarea
                id="d-caption"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                disabled={locked}
                maxLength={2200}
                className="min-h-[160px]"
              />
            </Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Call to action" htmlFor="d-cta">
                <Input id="d-cta" value={cta} onChange={(e) => setCta(e.target.value)} disabled={locked} />
              </Field>
              <Field
                label={`Hashtags (${hashtags.length}/30)`}
                htmlFor="d-tags"
                hint="Space separated, without #"
              >
                <Input id="d-tags" value={tags} onChange={(e) => setTags(e.target.value)} disabled={locked} />
              </Field>
              <Field label="Alt text (accessibility)" htmlFor="d-alt" className="md:col-span-2">
                <Input
                  id="d-alt"
                  value={alt}
                  onChange={(e) => setAlt(e.target.value)}
                  disabled={locked}
                  placeholder="Describe the image for screen readers"
                />
              </Field>
              <Field label="Language" htmlFor="d-lang">
                <Input
                  id="d-lang"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  disabled={locked}
                />
              </Field>
              <Field label="Target segment" htmlFor="d-seg">
                <Input
                  id="d-seg"
                  value={segment}
                  onChange={(e) => setSegment(e.target.value)}
                  disabled={locked}
                />
              </Field>
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[12.5px] font-medium">Media ({mediaIds.length})</span>
                {!locked ? (
                  <Button size="sm" variant="ghost" onClick={() => setPicker(true)}>
                    <ImagePlus className="h-3.5 w-3.5" /> Choose media
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {previewMedia.length === 0 ? (
                  <p className="text-fg-subtle text-[12.5px]">No media selected.</p>
                ) : null}
                {previewMedia.map((m) => (
                  <div
                    key={m.id}
                    className="border-border bg-surface-2 relative h-20 w-16 overflow-hidden rounded-md border"
                  >
                    {m.kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={m.url}
                        alt={m.title ?? "Selected media"}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <video src={m.url} className="h-full w-full object-cover" muted />
                    )}
                    {m.origin === "mock_generated" ? (
                      <span className="absolute right-0 bottom-0 left-0 bg-amber-500 text-center text-[9px] font-semibold text-white">
                        MOCK
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            {!locked ? (
              <Field label="Change note (optional)" htmlFor="d-note">
                <Input
                  id="d-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What changed in this version?"
                />
              </Field>
            ) : null}
            {detail.facts.length ? (
              <div>
                <div className="mb-1.5 text-[12.5px] font-medium">Source facts used</div>
                <ul className="space-y-1">
                  {detail.facts.map((f) => (
                    <li key={f.id} className="bg-surface-2 rounded-md px-2.5 py-1.5 text-[12.5px]">
                      <span className="text-fg-muted">{f.key}:</span> {f.value}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </TabsContent>
          <TabsContent value="schedule">
            <ScheduleForm
              item={item}
              accounts={data.accounts}
              products={data.products}
              promotions={data.promotions}
              tz={tz}
              locked={locked}
            />
          </TabsContent>
          <TabsContent value="history" className="space-y-5">
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
                <History className="h-4 w-4" /> Versions
              </h4>
              <ol className="space-y-2">
                {detail.versions.map((v) => (
                  <li key={v.id} className="border-border rounded-lg border p-3">
                    <div className="flex items-center gap-2 text-[12.5px]">
                      <Badge tone={v.version === item.currentVersion ? "brand" : "neutral"}>
                        v{v.version}
                      </Badge>
                      <span className="text-fg-muted">{fmtDateTime(v.createdAt)}</span>
                      {v.agentRunId ? <Badge tone="info">AI draft</Badge> : null}
                      {v.brandCheck ? (
                        <StatusBadge
                          status={
                            v.brandCheck.status === "pass"
                              ? "succeeded"
                              : v.brandCheck.status === "block"
                                ? "blocked"
                                : "pending"
                          }
                          label={`Check: ${v.brandCheck.status}`}
                        />
                      ) : null}
                    </div>
                    {v.changeNote ? <div className="mt-1 text-[12.5px]">{v.changeNote}</div> : null}
                    <p className="text-fg-muted mt-1 line-clamp-2 text-[12px]">{v.caption || "—"}</p>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h4 className="mb-2 text-[13px] font-semibold">Approvals</h4>
              {detail.approvals.length === 0 ? (
                <p className="text-fg-subtle text-[12.5px]">None yet.</p>
              ) : null}
              <ul className="space-y-1.5">
                {detail.approvals.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-[12.5px]">
                    <StatusBadge status={a.status} />
                    <span className="text-fg-muted">{fmtDateTime(a.createdAt)}</span>
                    {a.statusReason ? (
                      <span className="text-fg-subtle truncate">· {a.statusReason}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-2 text-[13px] font-semibold">Publish attempts</h4>
              {detail.actions.length === 0 ? <p className="text-fg-subtle text-[12.5px]">None yet.</p> : null}
              <ul className="space-y-1.5">
                {detail.actions.map((a) => (
                  <li key={a.id} className="text-[12.5px]">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={a.status} /> <ModeBadge mode={a.mode} />
                      <span className="text-fg-muted">
                        {fmtDateTime(a.createdAt)} · attempt {a.attempts}
                      </span>
                    </div>
                    {a.providerRef ? (
                      <div className="text-fg-subtle">Provider ID: {a.providerRef}</div>
                    ) : null}
                    {a.error ? <div className="text-danger-600">{a.error}</div> : null}
                  </li>
                ))}
              </ul>
            </div>
          </TabsContent>
        </Tabs>
      </div>
      <MediaPicker
        open={picker}
        onOpenChange={setPicker}
        media={allMedia}
        selected={mediaIds}
        onChange={setMediaIds}
      />
      <CopyDialog
        open={copying}
        onOpenChange={setCopying}
        itemId={item.id}
        accounts={data.accounts.filter((a) => a.id !== item.connectedAccountId)}
      />
      <AssistDialog
        open={assist}
        onOpenChange={setAssist}
        channel={channel ?? "instagram"}
        format={item.format}
        productIds={item.productIds}
        promotionId={item.promotionId}
        onApply={(v) => {
          setCaption(v.caption);
          setCta(v.cta);
          setAlt(v.altText);
          setTags(v.hashtags.join(" "));
          setNote("Applied AI variant");
        }}
      />
    </Drawer>
  );
}

function ScheduleForm({
  item,
  accounts,
  products,
  promotions,
  tz,
  locked,
}: {
  item: Item;
  accounts: Account[];
  products: Data["products"];
  promotions: Data["promotions"];
  tz: string;
  locked: boolean;
}) {
  const { run, isBusy } = useAction();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const timezone = String(f.get("timezone") || tz);
        void run(
          "schedule",
          () =>
            api(`/content/${item.id}`, {
              method: "PATCH",
              body: {
                connectedAccountId: f.get("account") || null,
                scheduledAt: fromLocalInput(String(f.get("at") ?? ""), timezone),
                timezone,
                promotionId: f.get("promotion") || null,
                productIds: f.getAll("products").map(String),
              },
            }),
          { success: "Destination & schedule saved" },
        );
      }}
      className="space-y-4"
    >
      <Notice tone="neutral" icon={<Info className="h-4 w-4" />}>
        Changing the channel, time, timezone or promotion invalidates any open approval. To post the same
        content on several channels, use <strong>Copy to channel</strong>.
      </Notice>
      <Field label="Channel" htmlFor="s-account">
        <Select id="s-account" name="account" defaultValue={item.connectedAccountId ?? ""} disabled={locked}>
          <option value="">Not selected</option>
          <AccountOptions accounts={accounts} format={item.format} />
        </Select>
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Publish at" htmlFor="s-at" hint="Leave empty to publish as soon as approved.">
          <Input
            id="s-at"
            name="at"
            type="datetime-local"
            defaultValue={toLocalInput(item.scheduledAt, tz)}
            disabled={locked}
          />
        </Field>
        <Field label="Timezone" htmlFor="s-tz">
          <Input id="s-tz" name="timezone" defaultValue={tz} disabled={locked} />
        </Field>
      </div>
      <Field label="Promotion" htmlFor="s-promo">
        <Select id="s-promo" name="promotion" defaultValue={item.promotionId ?? ""} disabled={locked}>
          <option value="">None</option>
          {promotions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset>
        <legend className="mb-1.5 text-[12.5px] font-medium">Featured products</legend>
        <div className="flex flex-wrap gap-2">
          {products.length === 0 ? (
            <span className="text-fg-subtle text-[12.5px]">Add products in the Company Brain.</span>
          ) : null}
          {products.map((p) => (
            <label
              key={p.id}
              className="border-border flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12.5px]"
            >
              <input
                type="checkbox"
                name="products"
                value={p.id}
                defaultChecked={item.productIds.includes(p.id)}
                disabled={locked}
              />{" "}
              {p.name}
            </label>
          ))}
        </div>
      </fieldset>
      {!locked ? (
        <div className="flex justify-end">
          <Button type="submit" loading={isBusy("schedule")}>
            Save destination & schedule
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function MediaPicker({
  open,
  onOpenChange,
  media,
  selected,
  onChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  media: Asset[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Choose media"
      description="Select in display order. Upload or generate assets in the Media Library."
      size="lg"
    >
      {media.length === 0 ? (
        <EmptyState
          title="No media yet"
          description="Upload or generate assets in the Media Library."
          action={
            <Link href="/media">
              <Button>Open Media Library</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {media.map((m) => {
            const idx = selected.indexOf(m.id);
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={idx >= 0}
                onClick={() => onChange(idx >= 0 ? selected.filter((x) => x !== m.id) : [...selected, m.id])}
                className={`relative aspect-[4/5] overflow-hidden rounded-lg border-2 ${idx >= 0 ? "border-brand-600" : "border-transparent"} bg-surface-2`}
              >
                {m.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.url} alt={m.title ?? "Media"} className="h-full w-full object-cover" />
                ) : (
                  <video src={m.url} className="h-full w-full object-cover" muted />
                )}
                {idx >= 0 ? (
                  <span className="bg-brand-600 absolute top-1.5 right-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold text-white">
                    {idx + 1}
                  </span>
                ) : null}
                {m.origin === "mock_generated" ? (
                  <span className="absolute right-0 bottom-0 left-0 bg-amber-500 text-[10px] font-semibold text-white">
                    MOCK
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}

type Variant = {
  hook: string;
  caption: string;
  cta: string;
  hashtags: string[];
  altText: string;
  carouselOutline: string[];
};

function CopyDialog({
  open,
  onOpenChange,
  itemId,
  accounts,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  itemId: string;
  accounts: Account[];
}) {
  const { run, isBusy } = useAction();
  const router = useRouter();
  const path = usePathname();
  const [accountId, setAccountId] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Copy to another channel"
      description="Creates a new draft with the same copy, media and schedule. Review it for that channel, then send it for approval."
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            "copy",
            () => api<{ id: string }>(`/content/${itemId}/duplicate`, { body: { accountId } }),
            { success: "Draft created for the new channel", refresh: false },
          ).then((r) => {
            if (r) {
              onOpenChange(false);
              router.push(`${path}?id=${r.id}`);
              router.refresh();
            }
          });
        }}
      >
        <Field label="Channel" htmlFor="cp-account">
          <Select id="cp-account" required value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Choose a channel…</option>
            <AccountOptions accounts={accounts} />
          </Select>
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!accountId} loading={isBusy("copy")}>
            <Copy className="h-4 w-4" /> Create copy
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AssistDialog({
  open,
  onOpenChange,
  channel,
  format,
  productIds,
  promotionId,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  channel: SocialChannel;
  format: string;
  productIds: string[];
  promotionId: string | null;
  onApply: (v: Variant) => void;
}) {
  const { run, isBusy } = useAction();
  const [runId, setRunId] = useState<string | null>(null);
  const { run: agentRun, done } = useRun(runId);
  useEffect(() => {
    if (!open) setRunId(null);
  }, [open]);
  const result = agentRun?.output?.result as
    { variants?: Variant[]; missingInformation?: string[] } | undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Draft with the copywriter agent"
      description="Uses only approved facts, catalog data and promotion terms. Output is a draft for your review."
      size="lg"
    >
      {!runId ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(
              "start",
              () =>
                api<{ id: string }>("/agents/runs", {
                  body: {
                    role: "content_copywriter",
                    input: {
                      brief: f.get("brief"),
                      format,
                      channel,
                      language: f.get("language") || "en",
                      targetSegment: f.get("segment") || undefined,
                      productIds,
                      variants: 2,
                      ...(promotionId ? { promotionId } : {}),
                    },
                  },
                }),
              { refresh: false },
            ).then((r) => r && setRunId(r.id));
          }}
          className="space-y-4"
        >
          <Field label="Brief" htmlFor="a-brief">
            <Textarea
              id="a-brief"
              name="brief"
              required
              minLength={3}
              placeholder="Introduce our new candle to small business owners who buy gifts for clients"
            />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Language" htmlFor="a-lang">
              <Input id="a-lang" name="language" defaultValue="en" />
            </Field>
            <Field label="Target segment" htmlFor="a-seg">
              <Input id="a-seg" name="segment" />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={isBusy("start")}>
              <Sparkles className="h-4 w-4" /> Generate variants
            </Button>
          </div>
        </form>
      ) : !done ? (
        <div className="text-fg-muted flex items-center gap-3 py-6 text-[13px]" role="status">
          <span className="bg-brand-600 h-2 w-2 animate-pulse rounded-full" />{" "}
          {agentRun ? `Agent run ${agentRun.state.toLowerCase()}…` : "Queued…"} Runs execute in the background
          worker.
        </div>
      ) : agentRun?.state === "FAILED" ? (
        <Notice tone="danger" title="The agent run failed">
          {agentRun.error}
        </Notice>
      ) : (
        <div className="space-y-3">
          {agentRun?.provider === "mock" ? (
            <Notice tone="warning" title="Mock LLM output">
              No LLM provider is configured, so this is a deterministic placeholder draft.
            </Notice>
          ) : null}
          {result?.missingInformation?.length ? (
            <Notice tone="warning" title="The agent needs more information">
              {result.missingInformation.join("; ")}
            </Notice>
          ) : null}
          {(result?.variants ?? []).map((v, i) => (
            <Card key={i} className="p-4">
              <div className="text-fg-subtle mb-1 text-[12px] font-medium">
                Variant {i + 1} · {v.hook}
              </div>
              <p className="text-[13px] whitespace-pre-line">{v.caption}</p>
              <div className="text-fg-muted mt-2 text-[12px]">
                CTA: {v.cta} · {v.hashtags.map((h) => `#${h}`).join(" ")}
              </div>
              <div className="mt-3 flex justify-end">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    onApply(v);
                    onOpenChange(false);
                  }}
                >
                  Use this variant
                </Button>
              </div>
            </Card>
          ))}
          <KeyValue
            items={[
              ["Model", agentRun?.model ?? "—"],
              ["Tokens", `${agentRun?.tokensIn ?? 0} in / ${agentRun?.tokensOut ?? 0} out`],
              ["Cost", `$${Number(agentRun?.costUsd ?? 0).toFixed(4)} (provider-reported or estimated)`],
            ]}
          />
        </div>
      )}
    </Dialog>
  );
}
