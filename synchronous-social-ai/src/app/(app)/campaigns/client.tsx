"use client";

import { AlertTriangle, CheckCircle2, Megaphone, Plus, Send, ShoppingBag, Sparkles, Tag } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
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
import { api } from "@/lib/api-client";
import { fmtDateTime, fmtMoney, fmtNumber, fmtPercent, titleCase } from "@/lib/format";
import { fromLocalInput } from "../content/client";

interface Promo {
  id: string;
  name: string;
  rawRequest: string | null;
  discountType: string | null;
  discountValue: string | null;
  currency: string | null;
  eligibleProductIds: string[];
  eligibleDescription: string | null;
  exclusions: string | null;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string | null;
  redemptionInstructions: string | null;
  landingPageUrl: string | null;
  customerEligibility: string | null;
  stockNote: string | null;
  terms: string | null;
  adBudgetMinor: number | null;
  audienceNote: string | null;
  status: string;
  missingFields: string[];
  commerceStatus: string;
  reconciliationReport: Record<string, unknown> | null;
  version: number;
}
interface Ad {
  id: string;
  name: string;
  objective: string;
  status: string;
  dailyBudgetMinor: number;
  currency: string;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string | null;
  destinationUrl: string | null;
  audience: { countries: string[]; ageMin: number; ageMax: number; interests: string[]; rationale?: string };
  placements: string[];
  mode: string | null;
  externalCampaignId: string | null;
  providerStatus: string | null;
  lastError: string | null;
  accountId: string | null;
  promotionId: string | null;
  specialAdCategories: string[];
  pixelId: string | null;
  conversionEvent: string | null;
}
interface Review {
  promotion: Promo;
  content: Array<{ id: string; title: string; format: string; status: string }>;
  ads: Ad[];
  issues: Array<{ severity: string; asset: string; message: string }>;
  channels: Record<string, string>;
  notes: { messages: string; commerce: string };
}
interface AdDetail {
  ad: Ad;
  creatives: Array<{
    id: string;
    headline: string;
    primaryText: string;
    callToAction: string;
    externalAdId: string | null;
  }>;
  snapshots: Array<{
    id: string;
    dateStart: string;
    dateStop: string;
    impressions: number | null;
    reach: number | null;
    clicks: number | null;
    spendMinor: number | null;
    currency: string | null;
    source: string;
    attributionWindow: string | null;
    fetchedAt: string;
  }>;
  approvals: Array<{ id: string; status: string; actionType: string; createdAt: string }>;
  actions: Array<{
    id: string;
    status: string;
    mode: string;
    error: string | null;
    createdAt: string;
    providerRef: string | null;
  }>;
  validation: { issues: string[]; projectedMinor: number };
}
interface Data {
  promotions: Promo[];
  ads: Ad[];
  products: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; displayName: string; mode: string; currency: string | null; status: string }>;
  review: Review | null;
  ad: AdDetail | null;
  workspace: { timezone: string; currency: string; cap: number };
  questions: Array<{ field: string; question: string }>;
}

const offer = (p: Promo) =>
  p.discountType === "percent"
    ? `${Number(p.discountValue)}% off`
    : p.discountType === "fixed_amount"
      ? `${p.currency ?? ""} ${Number(p.discountValue)} off`
      : p.discountType
        ? titleCase(p.discountType)
        : "Offer not set";

export function CampaignsClient({
  data,
  canWrite,
  canRequest,
  testMode,
  initialTab,
  openNew,
}: {
  data: Data;
  canWrite: boolean;
  canRequest: boolean;
  testMode: boolean;
  initialTab: string;
  openNew: boolean;
}) {
  const router = useRouter();
  const path = usePathname();
  const [newPromo, setNewPromo] = useState(openNew);
  const [newAd, setNewAd] = useState(false);
  return (
    <>
      {testMode ? (
        <Notice tone="info" title="Ads test mode is on" className="mb-5">
          Approved launches create campaigns at Meta in the PAUSED state. No money is spent until an operator
          disables META_ADS_TEST_MODE after the launch checklist.
        </Notice>
      ) : null}
      <Tabs defaultValue={initialTab}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="promotions" count={data.promotions.length}>
              Promotions
            </TabsTrigger>
            <TabsTrigger value="ads" count={data.ads.length}>
              Ad campaigns
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto flex gap-2">
            {canWrite ? (
              <>
                <Button size="sm" onClick={() => setNewAd(true)}>
                  <Plus className="h-3.5 w-3.5" /> Ad draft
                </Button>
                <Button size="sm" variant="primary" onClick={() => setNewPromo(true)}>
                  <Tag className="h-3.5 w-3.5" /> New promotion
                </Button>
              </>
            ) : null}
          </div>
        </div>
        <TabsContent value="promotions">
          <Card>
            {data.promotions.length === 0 ? (
              <EmptyState
                icon={<Tag className="h-5 w-5" />}
                title="No promotions"
                description="Describe an offer in plain language, e.g. “Run 50% off on our candles for three days”. We'll ask for anything missing."
                action={
                  canWrite ? (
                    <Button variant="primary" onClick={() => setNewPromo(true)}>
                      New promotion
                    </Button>
                  ) : null
                }
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Promotion</Th>
                    <Th>Offer</Th>
                    <Th>Window</Th>
                    <Th>Status</Th>
                    <Th>Missing</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.promotions.map((p) => (
                    <tr
                      key={p.id}
                      className="hover:bg-surface-2 cursor-pointer"
                      onClick={() => router.push(`${path}?promotion=${p.id}`)}
                    >
                      <Td>
                        <button
                          className="font-medium hover:underline"
                          onClick={() => router.push(`${path}?promotion=${p.id}`)}
                        >
                          {p.name}
                        </button>
                        <div className="text-fg-muted line-clamp-1 text-[12px]">{p.rawRequest}</div>
                      </Td>
                      <Td>{offer(p)}</Td>
                      <Td className="text-[12.5px] whitespace-nowrap">
                        {p.startsAt ? (
                          `${fmtDateTime(p.startsAt, p.timezone)} → ${fmtDateTime(p.endsAt, p.timezone)}`
                        ) : (
                          <span className="text-fg-subtle">Not set</span>
                        )}
                      </Td>
                      <Td>
                        <StatusBadge status={p.status} />
                      </Td>
                      <Td>
                        {p.missingFields.length ? (
                          <Badge tone="warning">{p.missingFields.length} to answer</Badge>
                        ) : (
                          <Badge tone="success">Complete</Badge>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="ads">
          <Card>
            {data.ads.length === 0 ? (
              <EmptyState
                icon={<Megaphone className="h-5 w-5" />}
                title="No ad campaigns"
                description="Create an ad draft or plan ads from a promotion. Launching needs a Tier 4 approval within your spend cap."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Campaign</Th>
                    <Th>Objective</Th>
                    <Th>Budget</Th>
                    <Th>Schedule</Th>
                    <Th>Status</Th>
                    <Th>Provider</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.ads.map((a) => (
                    <tr
                      key={a.id}
                      className="hover:bg-surface-2 cursor-pointer"
                      onClick={() => router.push(`${path}?ad=${a.id}`)}
                    >
                      <Td>
                        <button
                          className="font-medium hover:underline"
                          onClick={() => router.push(`${path}?ad=${a.id}`)}
                        >
                          {a.name}
                        </button>
                      </Td>
                      <Td className="text-[12.5px]">
                        {titleCase(a.objective.replace("OUTCOME_", "").toLowerCase())}
                      </Td>
                      <Td className="tabular-nums">{fmtMoney(a.dailyBudgetMinor, a.currency)}/day</Td>
                      <Td className="text-[12.5px] whitespace-nowrap">
                        {a.startsAt ? fmtDateTime(a.startsAt, a.timezone) : "—"}
                      </Td>
                      <Td>
                        <StatusBadge status={a.status} />
                      </Td>
                      <Td>
                        <div className="flex items-center gap-1.5">
                          <ModeBadge mode={a.mode} />
                          {a.providerStatus ? <Badge>{a.providerStatus}</Badge> : null}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </TabsContent>
      </Tabs>
      {newPromo ? (
        <NewPromotionDialog
          onClose={() => setNewPromo(false)}
          onCreated={(id) => router.push(`${path}?promotion=${id}`)}
        />
      ) : null}
      {newAd ? (
        <AdDialog
          data={data}
          onClose={() => setNewAd(false)}
          onCreated={(id) => router.push(`${path}?ad=${id}`)}
        />
      ) : null}
      {data.review ? (
        <PromotionDrawer
          key={`${data.review.promotion.id}:${data.review.promotion.version}`}
          r={data.review}
          data={data}
          canWrite={canWrite}
          onClose={() => router.push(path)}
        />
      ) : null}
      {data.ad ? (
        <AdDrawer
          key={data.ad.ad.id + data.ad.ad.status}
          d={data.ad}
          canRequest={canRequest}
          onClose={() => router.push(`${path}?tab=ads`)}
        />
      ) : null}
    </>
  );
}

function NewPromotionDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { run, isBusy } = useAction();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New promotion"
      description="Describe it in plain language. Only what you state is extracted; everything else becomes a question."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void run(
            "create",
            () => api<{ promotion: { id: string } }>("/promotions", { body: { request: f.get("request") } }),
            { success: "Promotion drafted — answer the open questions" },
          ).then((r) => r && onCreated(r.promotion.id));
        }}
        className="space-y-4"
      >
        <Field label="What do you want to run?" htmlFor="pr-req">
          <Textarea
            id="pr-req"
            name="request"
            required
            defaultValue="Run 50% off on our products for three days"
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={isBusy("create")}>
            <Sparkles className="h-4 w-4" /> Parse request
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function toLocal(iso: string | null, tz: string) {
  if (!iso) return "";
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

function PromotionDrawer({
  r,
  data,
  canWrite,
  onClose,
}: {
  r: Review;
  data: Data;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { run, isBusy } = useAction();
  const p = r.promotion;
  const tz = p.timezone ?? data.workspace.timezone;
  const missing = new Set(p.missingFields);
  const q = (f: string) => (missing.has(f) ? data.questions.find((x) => x.field === f)?.question : undefined);
  const locked = !canWrite || ["ended", "cancelled"].includes(p.status);
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="max-w-[980px]"
      title={
        <span className="flex items-center gap-2">
          {p.name} <StatusBadge status={p.status} />
        </span>
      }
      description={p.rawRequest ? `Request: “${p.rawRequest}”` : undefined}
      footer={
        canWrite && !locked ? (
          <>
            <ConfirmButton
              variant="ghost"
              label="Cancel promotion"
              title="Cancel promotion?"
              effect="Approvals on all linked content and ads are invalidated. Nothing already published is removed."
              confirmLabel="Cancel promotion"
              onConfirm={() =>
                run("cancel", () => api(`/promotions/${p.id}/cancel`, { body: {} }), {
                  success: "Cancelled",
                }).then(() => undefined)
              }
            />
            <Button
              disabled={missing.size > 0}
              title={missing.size ? "Answer the open questions first" : undefined}
              loading={isBusy("plan")}
              onClick={() =>
                run("plan", () => api(`/promotions/${p.id}/plan`, { body: { includeAds: false } }), {
                  success: "Drafted post, story and reel concept",
                })
              }
            >
              Plan organic content
            </Button>
            <Button
              variant="primary"
              disabled={missing.size > 0 || !p.adBudgetMinor}
              title={!p.adBudgetMinor ? "Set an ad budget to plan ads" : undefined}
              loading={isBusy("planAds")}
              onClick={() =>
                run("planAds", () => api(`/promotions/${p.id}/plan`, { body: { includeAds: true } }), {
                  success: "Drafted content and a paused Meta campaign plan",
                })
              }
            >
              Plan content + ads
            </Button>
          </>
        ) : null
      }
    >
      {missing.size ? (
        <Notice
          tone="warning"
          title={`${missing.size} detail(s) needed before anything is drafted`}
          className="mb-5"
        >
          <ul className="list-disc pl-4">
            {data.questions
              .filter((x) => missing.has(x.field))
              .map((x) => (
                <li key={x.field}>{x.question}</li>
              ))}
          </ul>
        </Notice>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const g = (k: string) => String(f.get(k) ?? "").trim();
          const timezone = g("timezone") || tz;
          const body = {
            name: g("name"),
            discountType: g("discountType") || null,
            discountValue: g("discountValue") ? Number(g("discountValue")) : null,
            currency: g("currency") || null,
            eligibleProductIds: f.getAll("products").map(String),
            eligibleDescription: g("eligibleDescription") || null,
            exclusions: g("exclusions") || null,
            startsAt: fromLocalInput(g("startsAt"), timezone),
            endsAt: fromLocalInput(g("endsAt"), timezone),
            timezone,
            landingPageUrl: g("landingPageUrl") || null,
            redemptionInstructions: g("redemption") || null,
            customerEligibility: g("customerEligibility") || null,
            stockNote: g("stockNote") || null,
            terms: g("terms") || null,
            adBudgetMinor: g("adBudget") ? Math.round(Number(g("adBudget")) * 100) : null,
            audienceNote: g("audienceNote") || null,
          };
          void run("save", () => api(`/promotions/${p.id}`, { method: "PATCH", body }), {
            success: "Offer terms saved — linked approvals invalidated if terms changed",
          });
        }}
        className="grid gap-4 md:grid-cols-2"
      >
        <Field label="Name" htmlFor="p-name" className="md:col-span-2">
          <Input id="p-name" name="name" defaultValue={p.name} disabled={locked} />
        </Field>
        <Field label="Discount type" htmlFor="p-dt" error={q("discount")}>
          <Select id="p-dt" name="discountType" defaultValue={p.discountType ?? ""} disabled={locked}>
            <option value="">Not set</option>
            <option value="percent">Percent off</option>
            <option value="fixed_amount">Fixed amount off</option>
            <option value="bogo">Buy one get one</option>
            <option value="free_shipping">Free shipping</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Value" htmlFor="p-dv">
            <Input
              id="p-dv"
              name="discountValue"
              inputMode="decimal"
              defaultValue={p.discountValue ? String(Number(p.discountValue)) : ""}
              disabled={locked}
            />
          </Field>
          <Field label="Currency" htmlFor="p-cur">
            <Input
              id="p-cur"
              name="currency"
              defaultValue={p.currency ?? data.workspace.currency}
              maxLength={3}
              disabled={locked}
            />
          </Field>
        </div>
        <fieldset className="md:col-span-2">
          <legend className="mb-1.5 text-[12.5px] font-medium">Eligible products</legend>
          {q("eligibleProducts") ? (
            <p className="text-danger-600 mb-1.5 text-[12px]">{q("eligibleProducts")}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {data.products.length === 0 ? (
              <span className="text-fg-subtle text-[12.5px]">
                No products in the catalog — describe eligibility below.
              </span>
            ) : null}
            {data.products.map((x) => (
              <label
                key={x.id}
                className="border-border flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12.5px]"
              >
                <input
                  type="checkbox"
                  name="products"
                  value={x.id}
                  defaultChecked={p.eligibleProductIds.includes(x.id)}
                  disabled={locked}
                />{" "}
                {x.name}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Or describe eligibility" htmlFor="p-ed" hint="e.g. “All products in the store”">
          <Input
            id="p-ed"
            name="eligibleDescription"
            defaultValue={p.eligibleDescription ?? ""}
            disabled={locked}
          />
        </Field>
        <Field label="Exclusions" htmlFor="p-ex">
          <Input id="p-ex" name="exclusions" defaultValue={p.exclusions ?? ""} disabled={locked} />
        </Field>
        <Field label="Starts" htmlFor="p-st" error={q("startsAt")}>
          <Input
            id="p-st"
            name="startsAt"
            type="datetime-local"
            defaultValue={toLocal(p.startsAt, tz)}
            disabled={locked}
          />
        </Field>
        <Field label="Ends" htmlFor="p-en" error={q("endsAt")}>
          <Input
            id="p-en"
            name="endsAt"
            type="datetime-local"
            defaultValue={toLocal(p.endsAt, tz)}
            disabled={locked}
          />
        </Field>
        <Field
          label="Timezone"
          htmlFor="p-tz"
          error={q("timezone")}
          hint={`Workspace default: ${data.workspace.timezone}`}
        >
          <Input
            id="p-tz"
            name="timezone"
            defaultValue={p.timezone ?? ""}
            placeholder={data.workspace.timezone}
            disabled={locked}
          />
        </Field>
        <Field
          label="Landing page"
          htmlFor="p-lp"
          error={q("landingPageUrl")}
          hint="Must be on the approved link allowlist."
        >
          <Input
            id="p-lp"
            name="landingPageUrl"
            type="url"
            defaultValue={p.landingPageUrl ?? ""}
            disabled={locked}
          />
        </Field>
        <Field label="Terms" htmlFor="p-terms" error={q("terms")} className="md:col-span-2">
          <Textarea id="p-terms" name="terms" defaultValue={p.terms ?? ""} disabled={locked} />
        </Field>
        <Field label="Redemption instructions" htmlFor="p-red">
          <Input
            id="p-red"
            name="redemption"
            defaultValue={p.redemptionInstructions ?? ""}
            disabled={locked}
          />
        </Field>
        <Field label="Customer eligibility" htmlFor="p-ce">
          <Input
            id="p-ce"
            name="customerEligibility"
            defaultValue={p.customerEligibility ?? ""}
            disabled={locked}
          />
        </Field>
        <Field label="Stock / availability note" htmlFor="p-sn">
          <Input id="p-sn" name="stockNote" defaultValue={p.stockNote ?? ""} disabled={locked} />
        </Field>
        <Field label="Total ad budget (optional)" htmlFor="p-ab" hint="Required only to plan ads.">
          <Input
            id="p-ab"
            name="adBudget"
            inputMode="decimal"
            defaultValue={p.adBudgetMinor ? (p.adBudgetMinor / 100).toFixed(2) : ""}
            disabled={locked}
          />
        </Field>
        <Field label="Audience note" htmlFor="p-an" className="md:col-span-2">
          <Input id="p-an" name="audienceNote" defaultValue={p.audienceNote ?? ""} disabled={locked} />
        </Field>
        {!locked ? (
          <div className="flex justify-end md:col-span-2">
            <Button type="submit" loading={isBusy("save")}>
              Save offer terms
            </Button>
          </div>
        ) : null}
      </form>

      <h3 className="mt-8 mb-3 text-[14px] font-semibold">Unified review</h3>
      <div className="grid gap-3 md:grid-cols-4">
        {(
          [
            ["Organic content", r.channels.organic, "Separate publish approval per post"],
            ["Customer messages", r.channels.messages, r.notes.messages],
            ["Paid ads", r.channels.ads, "Tier 4 approval within spend cap"],
            ["Commerce", r.channels.commerce, r.notes.commerce],
          ] as Array<[string, string, string]>
        ).map(([k, v, note]) => (
          <Card key={k} className="p-3.5">
            <div className="text-fg-muted text-[12px]">{k}</div>
            <div className="mt-1">
              <StatusBadge
                status={v === "draft_only" ? "pending" : v === "not_connected" ? "disconnected" : v}
                label={titleCase(v)}
              />
            </div>
            <p className="text-fg-subtle mt-2 text-[11.5px]">{note}</p>
          </Card>
        ))}
      </div>
      <div className="mt-5">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold">
          {r.issues.some((i) => i.severity === "block") ? (
            <AlertTriangle className="text-danger-600 h-4 w-4" />
          ) : (
            <CheckCircle2 className="text-success-600 h-4 w-4" />
          )}{" "}
          Offer consistency across assets
        </div>
        {r.issues.length === 0 ? (
          <p className="text-fg-muted text-[12.5px]">
            {r.content.length + r.ads.length ? "All assets state the same terms." : "No assets yet."}
          </p>
        ) : (
          <ul className="space-y-1">
            {r.issues.map((i, n) => (
              <li key={n} className="flex gap-2 text-[12.5px]">
                <Badge tone={i.severity === "block" ? "danger" : "warning"}>{i.severity}</Badge>
                <span className="font-medium">{i.asset}:</span>{" "}
                <span className="text-fg-muted">{i.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 text-[13px] font-semibold">Linked content</div>
          <ul className="space-y-1.5">
            {r.content.length === 0 ? <li className="text-fg-subtle text-[12.5px]">None yet.</li> : null}
            {r.content.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/content?id=${c.id}`}
                  className="flex items-center gap-2 text-[13px] hover:underline"
                >
                  {c.title} <ContentStatus status={c.status} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-2 text-[13px] font-semibold">Linked ad campaigns</div>
          <ul className="space-y-1.5">
            {r.ads.length === 0 ? <li className="text-fg-subtle text-[12.5px]">None yet.</li> : null}
            {r.ads.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/campaigns?ad=${a.id}`}
                  className="flex items-center gap-2 text-[13px] hover:underline"
                >
                  {a.name} <StatusBadge status={a.status} />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <Notice
        tone="neutral"
        icon={<ShoppingBag className="h-4 w-4" />}
        className="mt-5"
        title="Prices and coupons are not changed here"
      >
        {r.notes.commerce}
      </Notice>
      {p.reconciliationReport ? (
        <Notice tone="info" className="mt-3" title="End-of-offer reconciliation">
          <pre className="text-[11.5px] whitespace-pre-wrap">
            {JSON.stringify(p.reconciliationReport, null, 2)}
          </pre>
        </Notice>
      ) : null}
    </Drawer>
  );
}

function AdDialog({
  data,
  onClose,
  onCreated,
}: {
  data: Data;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { run, isBusy } = useAction();
  const tz = data.workspace.timezone;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New ad campaign draft"
      description="Drafts are internal. Launching requires approval and passes spend-cap checks immediately before the API call."
      size="lg"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const g = (k: string) => String(f.get(k) ?? "").trim();
          const body = {
            name: g("name"),
            objective: g("objective"),
            accountId: g("account") || null,
            dailyBudgetMinor: Math.round(Number(g("budget")) * 100),
            currency: g("currency") || "USD",
            startsAt: fromLocalInput(g("start"), tz),
            endsAt: fromLocalInput(g("end"), tz),
            timezone: tz,
            destinationUrl: g("url"),
            pixelId: g("pixel") || null,
            audience: {
              countries: g("countries")
                .split(/[,\s]+/)
                .filter(Boolean)
                .map((c) => c.toUpperCase()),
              ageMin: Number(g("ageMin")),
              ageMax: Number(g("ageMax")),
              interests: g("interests")
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
              rationale: "Hypothesis — validate with results",
            },
            placements: f.getAll("placements").map(String),
            creatives: [{ headline: g("headline"), primaryText: g("text"), callToAction: g("cta") }],
          };
          void run("create", () => api<{ id: string }>("/ads", { body }), {
            success: "Ad draft created",
          }).then((r) => r && onCreated(r.id));
        }}
        className="grid gap-4 md:grid-cols-2"
      >
        <Field label="Name" htmlFor="ad-name" className="md:col-span-2">
          <Input id="ad-name" name="name" required />
        </Field>
        <Field label="Objective" htmlFor="ad-obj">
          <Select id="ad-obj" name="objective" defaultValue="OUTCOME_TRAFFIC">
            {[
              "OUTCOME_AWARENESS",
              "OUTCOME_TRAFFIC",
              "OUTCOME_ENGAGEMENT",
              "OUTCOME_LEADS",
              "OUTCOME_SALES",
            ].map((o) => (
              <option key={o} value={o}>
                {titleCase(o.replace("OUTCOME_", "").toLowerCase())}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ad account" htmlFor="ad-acct">
          <Select id="ad-acct" name="account" defaultValue={data.accounts[0]?.id ?? ""}>
            <option value="">Not selected</option>
            {data.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
                {a.mode === "mock" ? " (MOCK)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Daily budget" htmlFor="ad-budget">
          <Input id="ad-budget" name="budget" inputMode="decimal" required defaultValue="20.00" />
        </Field>
        <Field label="Currency" htmlFor="ad-cur">
          <Input
            id="ad-cur"
            name="currency"
            defaultValue={data.accounts[0]?.currency ?? data.workspace.currency}
            maxLength={3}
          />
        </Field>
        <Field label={`Start (${tz})`} htmlFor="ad-start">
          <Input id="ad-start" name="start" type="datetime-local" required />
        </Field>
        <Field
          label={`End (${tz})`}
          htmlFor="ad-end"
          hint="Strongly recommended: Meta stops delivery at the end time."
        >
          <Input id="ad-end" name="end" type="datetime-local" />
        </Field>
        <Field label="Destination URL" htmlFor="ad-url" className="md:col-span-2">
          <Input id="ad-url" name="url" type="url" required />
        </Field>
        <Field label="Countries (ISO codes)" htmlFor="ad-c">
          <Input id="ad-c" name="countries" defaultValue="US" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Age min" htmlFor="ad-a1">
            <Input id="ad-a1" name="ageMin" type="number" min={18} max={65} defaultValue={18} />
          </Field>
          <Field label="Age max" htmlFor="ad-a2">
            <Input id="ad-a2" name="ageMax" type="number" min={18} max={65} defaultValue={65} />
          </Field>
        </div>
        <Field label="Interests (comma separated)" htmlFor="ad-int" hint="Sensitive categories are rejected.">
          <Input id="ad-int" name="interests" />
        </Field>
        <Field label="Meta Pixel ID (sales objective)" htmlFor="ad-px">
          <Input id="ad-px" name="pixel" inputMode="numeric" />
        </Field>
        <fieldset className="md:col-span-2">
          <legend className="mb-1.5 text-[12.5px] font-medium">Placements</legend>
          <div className="flex flex-wrap gap-2">
            {["instagram_feed", "instagram_stories", "instagram_reels", "instagram_explore"].map((p) => (
              <label
                key={p}
                className="border-border flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12.5px]"
              >
                <input
                  type="checkbox"
                  name="placements"
                  value={p}
                  defaultChecked={p !== "instagram_explore"}
                />{" "}
                {titleCase(p.replace("instagram_", ""))}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Headline" htmlFor="ad-h">
          <Input id="ad-h" name="headline" required maxLength={80} />
        </Field>
        <Field label="Call to action" htmlFor="ad-cta">
          <Select id="ad-cta" name="cta" defaultValue="LEARN_MORE">
            {["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "CONTACT_US", "GET_OFFER"].map((c) => (
              <option key={c} value={c}>
                {titleCase(c.toLowerCase())}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Primary text" htmlFor="ad-t" className="md:col-span-2">
          <Textarea id="ad-t" name="text" required maxLength={500} />
        </Field>
        <div className="flex justify-end md:col-span-2">
          <Button type="submit" variant="primary" loading={isBusy("create")}>
            Create draft
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AdDrawer({ d, canRequest, onClose }: { d: AdDetail; canRequest: boolean; onClose: () => void }) {
  const { run, isBusy } = useAction();
  const a = d.ad;
  const pending = d.approvals.find((x) => x.status === "pending");
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width="max-w-[860px]"
      title={
        <span className="flex items-center gap-2">
          {a.name} <StatusBadge status={a.status} /> <ModeBadge mode={a.mode} />
        </span>
      }
      description={titleCase(a.objective.replace("OUTCOME_", "").toLowerCase())}
      footer={
        <>
          {a.externalCampaignId && canRequest && ["active", "launched_paused"].includes(a.status) ? (
            <Button
              onClick={() =>
                run("pause", () => api(`/ads/${a.id}/request-pause`, { body: {} }), {
                  success: "Pause request sent for approval",
                })
              }
            >
              Request pause
            </Button>
          ) : null}
          {canRequest && ["draft", "failed"].includes(a.status) ? (
            <Button
              variant="primary"
              disabled={d.validation.issues.length > 0 || Boolean(pending)}
              title={d.validation.issues.length ? "Resolve validation issues first" : undefined}
              loading={isBusy("launch")}
              onClick={() =>
                run("launch", () => api(`/ads/${a.id}/request-launch`, { body: {} }), {
                  success: "Launch sent to the Approval Center (Tier 4)",
                })
              }
            >
              <Send className="h-4 w-4" /> Request launch approval
            </Button>
          ) : null}
          {pending ? (
            <Link href={`/approvals?id=${pending.id}`}>
              <Button variant="primary">Review approval</Button>
            </Link>
          ) : null}
        </>
      }
    >
      {a.lastError ? (
        <Notice tone="danger" title="Last provider error" className="mb-4">
          {a.lastError}
        </Notice>
      ) : null}
      {d.validation.issues.length ? (
        <Notice tone="warning" title="Not ready to launch" className="mb-4">
          <ul className="list-disc pl-4">
            {d.validation.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </Notice>
      ) : ["draft", "failed"].includes(a.status) ? (
        <Notice tone="success" title="Validation passed" className="mb-4">
          Projected maximum spend: {fmtMoney(d.validation.projectedMinor, a.currency)} (re-checked against the
          cap before launch).
        </Notice>
      ) : null}
      <KeyValue
        items={[
          ["Daily budget", `${fmtMoney(a.dailyBudgetMinor, a.currency)}`],
          [
            "Schedule",
            `${fmtDateTime(a.startsAt, a.timezone)} → ${a.endsAt ? fmtDateTime(a.endsAt, a.timezone) : "no end date"} (${a.timezone ?? "UTC"})`,
          ],
          [
            "Audience (hypothesis)",
            `${a.audience.countries.join(", ")} · ${a.audience.ageMin}–${a.audience.ageMax}${a.audience.interests.length ? ` · ${a.audience.interests.join(", ")}` : ""}`,
          ],
          ["Placements", a.placements.map((p) => titleCase(p.replace("instagram_", ""))).join(", ")],
          [
            "Destination",
            <span key="u" className="text-brand-600 break-all">
              {a.destinationUrl}
            </span>,
          ],
          ["Tracking", a.pixelId ? `Pixel ${a.pixelId} · ${a.conversionEvent ?? "PURCHASE"}` : "No pixel"],
          ["Meta campaign ID", a.externalCampaignId ?? "Not created"],
          ["Provider status", a.providerStatus ?? "—"],
        ]}
      />
      <h4 className="mt-6 mb-2 text-[13px] font-semibold">Creatives</h4>
      <div className="grid gap-3 md:grid-cols-2">
        {d.creatives.map((c) => (
          <Card key={c.id} className="p-3.5">
            <div className="font-semibold">{c.headline}</div>
            <p className="text-fg-muted mt-1 text-[12.5px]">{c.primaryText}</p>
            <Badge className="mt-2">{titleCase(c.callToAction.toLowerCase())}</Badge>
          </Card>
        ))}
      </div>
      <h4 className="mt-6 mb-2 text-[13px] font-semibold">Results</h4>
      {d.snapshots.length === 0 ? (
        <p className="text-fg-muted text-[12.5px]">
          No provider metrics yet.{" "}
          {a.mode === "mock"
            ? "Mock campaigns never report metrics."
            : "Insights sync every 6 hours after launch."}
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Window</Th>
              <Th>Impressions</Th>
              <Th>Reach</Th>
              <Th>Clicks</Th>
              <Th>CTR</Th>
              <Th>Spend</Th>
            </tr>
          </thead>
          <tbody>
            {d.snapshots.map((s) => (
              <tr key={s.id}>
                <Td className="text-[12.5px]">
                  {s.dateStart} → {s.dateStop}
                </Td>
                <Td>{fmtNumber(s.impressions)}</Td>
                <Td>{fmtNumber(s.reach)}</Td>
                <Td>{fmtNumber(s.clicks)}</Td>
                <Td>{s.impressions && s.clicks !== null ? fmtPercent(s.clicks / s.impressions) : "—"}</Td>
                <Td>{fmtMoney(s.spendMinor, s.currency ?? a.currency)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="text-fg-subtle mt-2 text-[11.5px]">
        Source: Meta Marketing API insights; attribution per Meta defaults. Results are not guaranteed and
        depend on Meta delivery.
      </p>
      {d.actions.length ? (
        <>
          <h4 className="mt-6 mb-2 text-[13px] font-semibold">Provider actions</h4>
          <ul className="space-y-1.5">
            {d.actions.map((x) => (
              <li key={x.id} className="text-[12.5px]">
                <StatusBadge status={x.status} /> <ModeBadge mode={x.mode} />{" "}
                <span className="text-fg-muted">{fmtDateTime(x.createdAt)}</span>
                {x.error ? <div className="text-danger-600">{x.error}</div> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Drawer>
  );
}
