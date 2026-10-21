"use client";

import { AlertTriangle, BookOpen, Check, FileText, Globe, Link2, Package, Plus, Search, Sparkles, Trash2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Dialog, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlay";
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, Input, Notice, Select, Table, Td, Textarea, Th } from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";
import { fmtMoney, fmtRelative, titleCase } from "@/lib/format";

type Profile = {
  data: {
    name?: string; website?: string; description?: string; industry?: string; markets?: string[]; customerSegments?: string[]; objectives?: string[]; differentiators?: string[];
    brandVoice?: { tone?: string; do?: string[]; dont?: string[] }; visualIdentity?: string; pricingNotes?: string; policies?: string; deliveryRegions?: string[]; escalationContact?: string;
  };
  version: number; score: number; missing: string[];
};
interface Data {
  profile: Profile;
  facts: Array<{ fact: { id: string; category: string; key: string; value: string; status: string; origin: string; confidence: string; sourceExcerpt: string | null; updatedAt: string }; sourceTitle: string | null }>;
  products: Array<{ id: string; name: string; url: string | null; priceMinor: number | null; currency: string | null; stockStatus: string; variants: string[]; deliveryPolicy: string | null; keywords: string[]; sku: string | null; description: string | null }>;
  rules: Array<{ id: string; kind: string; text: string }>;
  domains: string[];
  sources: Array<{ id: string; title: string; kind: string; status: string; mimeType: string | null; sizeBytes: number | null; chunkCount: number; error: string | null; scanStatus: string; createdAt: string }>;
}

const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
const join = (v?: string[]) => (v ?? []).join("\n");

export function BrainClient({ data, canWrite, onboarding, initialTab }: { data: Data; canWrite: boolean; onboarding: boolean; initialTab?: string }) {
  const review = data.facts.filter((f) => f.fact.status === "pending" || f.fact.status === "conflict");
  return (
    <>
      {onboarding ? (
        <Notice tone="info" className="mb-6" icon={<Sparkles className="h-4 w-4" />} title="Welcome — start by describing your business">
          Fill in the profile, add your products with approved links, and upload brand guidelines or FAQs. Then connect Instagram in <strong>Integrations</strong>.
        </Notice>
      ) : null}
      <Tabs defaultValue={initialTab ?? "profile"}>
        <TabsList className="mb-5 flex-wrap">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="facts" count={review.length || undefined}>
            Facts & review
          </TabsTrigger>
          <TabsTrigger value="catalog" count={data.products.length}>
            Products & links
          </TabsTrigger>
          <TabsTrigger value="rules">Brand rules</TabsTrigger>
          <TabsTrigger value="sources" count={data.sources.length}>
            Sources
          </TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <ProfileForm profile={data.profile} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="facts">
          <FactsPanel facts={data.facts} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="catalog">
          <CatalogPanel products={data.products} domains={data.domains} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="rules">
          <RulesPanel rules={data.rules} canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="sources">
          <SourcesPanel sources={data.sources} canWrite={canWrite} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function ProfileForm({ profile, canWrite }: { profile: Profile; canWrite: boolean }) {
  const { run, isBusy } = useAction();
  const p = profile.data;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const g = (k: string) => String(f.get(k) ?? "");
        void run(
          "save",
          () =>
            api("/brain/profile", {
              method: "PATCH",
              body: {
                expectedVersion: profile.version || undefined,
                data: {
                  name: g("name") || undefined,
                  website: g("website") || "",
                  description: g("description"),
                  industry: g("industry"),
                  markets: lines(g("markets")),
                  customerSegments: lines(g("customerSegments")),
                  objectives: lines(g("objectives")),
                  differentiators: lines(g("differentiators")),
                  brandVoice: { tone: g("tone"), do: lines(g("do")), dont: lines(g("dont")) },
                  visualIdentity: g("visualIdentity"),
                  pricingNotes: g("pricingNotes"),
                  policies: g("policies"),
                  deliveryRegions: lines(g("deliveryRegions")),
                  escalationContact: g("escalationContact"),
                },
              },
            }),
          { success: "Company profile saved" },
        );
      }}
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Business" description="What you sell and to whom." />
            <CardBody className="grid gap-4 md:grid-cols-2">
              <Field label="Company name" htmlFor="name">
                <Input id="name" name="name" defaultValue={p.name} disabled={!canWrite} />
              </Field>
              <Field label="Website" htmlFor="website" hint="https://…">
                <Input id="website" name="website" type="url" defaultValue={p.website} disabled={!canWrite} />
              </Field>
              <Field label="Industry" htmlFor="industry">
                <Input id="industry" name="industry" defaultValue={p.industry} disabled={!canWrite} />
              </Field>
              <Field label="Escalation contact" htmlFor="escalationContact" hint="Who handles complaints and exceptions.">
                <Input id="escalationContact" name="escalationContact" defaultValue={p.escalationContact} disabled={!canWrite} />
              </Field>
              <Field label="Description" htmlFor="description" className="md:col-span-2">
                <Textarea id="description" name="description" defaultValue={p.description} disabled={!canWrite} />
              </Field>
              <Field label="Markets (one per line)" htmlFor="markets">
                <Textarea id="markets" name="markets" defaultValue={join(p.markets)} disabled={!canWrite} />
              </Field>
              <Field label="Customer segments (one per line)" htmlFor="customerSegments" hint="Used as audience hypotheses, never as sensitive attributes.">
                <Textarea id="customerSegments" name="customerSegments" defaultValue={join(p.customerSegments)} disabled={!canWrite} />
              </Field>
              <Field label="Business objectives" htmlFor="objectives">
                <Textarea id="objectives" name="objectives" defaultValue={join(p.objectives)} disabled={!canWrite} />
              </Field>
              <Field label="Differentiators" htmlFor="differentiators">
                <Textarea id="differentiators" name="differentiators" defaultValue={join(p.differentiators)} disabled={!canWrite} />
              </Field>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Brand voice & identity" />
            <CardBody className="grid gap-4 md:grid-cols-2">
              <Field label="Tone" htmlFor="tone" className="md:col-span-2">
                <Input id="tone" name="tone" defaultValue={p.brandVoice?.tone} placeholder="Warm, confident, plain-spoken" disabled={!canWrite} />
              </Field>
              <Field label="Do (one per line)" htmlFor="do">
                <Textarea id="do" name="do" defaultValue={join(p.brandVoice?.do)} disabled={!canWrite} />
              </Field>
              <Field label="Don't (one per line)" htmlFor="dont">
                <Textarea id="dont" name="dont" defaultValue={join(p.brandVoice?.dont)} disabled={!canWrite} />
              </Field>
              <Field label="Visual identity" htmlFor="visualIdentity" className="md:col-span-2">
                <Textarea id="visualIdentity" name="visualIdentity" defaultValue={p.visualIdentity} placeholder="Colors, typography, photo style, logo usage" disabled={!canWrite} />
              </Field>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Policies" description="Used for replies about delivery, returns and pricing." />
            <CardBody className="grid gap-4 md:grid-cols-2">
              <Field label="Pricing notes" htmlFor="pricingNotes">
                <Textarea id="pricingNotes" name="pricingNotes" defaultValue={p.pricingNotes} disabled={!canWrite} />
              </Field>
              <Field label="Delivery regions (one per line)" htmlFor="deliveryRegions">
                <Textarea id="deliveryRegions" name="deliveryRegions" defaultValue={join(p.deliveryRegions)} disabled={!canWrite} />
              </Field>
              <Field label="Policies (returns, guarantees, terms)" htmlFor="policies" className="md:col-span-2">
                <Textarea id="policies" name="policies" defaultValue={p.policies} disabled={!canWrite} className="min-h-[120px]" />
              </Field>
            </CardBody>
          </Card>
        </div>
        <div className="space-y-4">
          <Card className="sticky top-20">
            <CardBody>
              <div className="text-[12px] font-medium text-fg-muted">Profile completeness</div>
              <div className="mt-1 text-[28px] font-semibold tabular-nums">{profile.score}%</div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full bg-brand-600" style={{ width: `${profile.score}%` }} />
              </div>
              {profile.missing.length ? (
                <ul className="mt-4 space-y-1 text-[12.5px] text-fg-muted">
                  {profile.missing.map((m) => (
                    <li key={m} className="flex items-center gap-1.5">
                      <span className="h-1 w-1 rounded-full bg-fg-subtle" /> {titleCase(m)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-[12.5px] text-success-600">All key sections are filled in.</p>
              )}
              {canWrite ? (
                <Button type="submit" variant="primary" className="mt-5 w-full justify-center" loading={isBusy("save")}>
                  Save profile
                </Button>
              ) : (
                <p className="mt-4 text-[12px] text-fg-subtle">Read-only for your role.</p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </form>
  );
}

function FactsPanel({ facts, canWrite }: { facts: Data["facts"]; canWrite: boolean }) {
  const { run, isBusy } = useAction();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("review");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ chunkId: string; sourceTitle: string; text: string; injectionFlag: boolean }> | null>(null);
  const shown = facts.filter((f) => (filter === "review" ? ["pending", "conflict"].includes(f.fact.status) : filter === "all" ? true : f.fact.status === filter));
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Card>
        <CardHeader
          title="Facts"
          description="Agent-extracted facts start as pending. Conflicting values are never auto-resolved."
          actions={
            <>
              <Select aria-label="Filter facts" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8 w-[150px] text-[12.5px]">
                <option value="review">Needs review</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="all">All</option>
              </Select>
              {canWrite ? (
                <Button size="sm" onClick={() => setOpen(true)}>
                  <Plus className="h-3.5 w-3.5" /> Add fact
                </Button>
              ) : null}
            </>
          }
        />
        {shown.length === 0 ? (
          <EmptyState icon={<BookOpen className="h-5 w-5" />} title={filter === "review" ? "Nothing to review" : "No facts"} description="Add facts manually or extract them from an uploaded source." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Fact</Th>
                <Th>Source</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ fact: f, sourceTitle }) => (
                <tr key={f.id}>
                  <Td className="max-w-[380px]">
                    <div className="text-[12px] text-fg-subtle">{titleCase(f.category)} · {f.key}</div>
                    <div className="font-medium">{f.value}</div>
                    {f.sourceExcerpt ? <div className="mt-1 line-clamp-2 text-[12px] text-fg-muted italic">“{f.sourceExcerpt}”</div> : null}
                  </Td>
                  <Td className="text-[12.5px] text-fg-muted">
                    {sourceTitle ?? (f.origin === "user" ? "Entered by user" : "—")}
                    {f.origin === "agent" ? <div className="text-[11.5px]">Agent · confidence {Number(f.confidence).toFixed(2)}</div> : null}
                  </Td>
                  <Td>
                    {f.status === "conflict" ? (
                      <Badge tone="danger">
                        <AlertTriangle className="h-3 w-3" /> Conflict
                      </Badge>
                    ) : (
                      <StatusBadge status={f.status} />
                    )}
                  </Td>
                  <Td className="text-right">
                    {canWrite && f.status !== "approved" ? (
                      <div className="inline-flex gap-1">
                        <Button size="sm" variant="ghost" aria-label={`Approve ${f.key}`} loading={isBusy(`a${f.id}`)} onClick={() => run(`a${f.id}`, () => api(`/brain/facts/${f.id}/review`, { body: { decision: "approve" } }), { success: "Fact approved" })}>
                          <Check className="h-3.5 w-3.5" /> Approve
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Reject ${f.key}`} onClick={() => run(`r${f.id}`, () => api(`/brain/facts/${f.id}/review`, { body: { decision: "reject" } }), { success: "Fact rejected" })}>
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Search knowledge" description="Tenant-scoped full-text search with sources." />
        <CardBody>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run("search", async () => setResults(await api(`/knowledge/search?q=${encodeURIComponent(q)}`)), { refresh: false });
            }}
            className="flex gap-2"
          >
            <Input aria-label="Search query" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. shipping policy" />
            <Button type="submit" size="icon" aria-label="Search" loading={isBusy("search")}>
              <Search className="h-4 w-4" />
            </Button>
          </form>
          {results ? (
            <ul className="mt-4 space-y-3">
              {results.length === 0 ? <li className="text-[13px] text-fg-muted">No matches.</li> : null}
              {results.map((r) => (
                <li key={r.chunkId} className="rounded-lg border border-border p-3">
                  <div className="mb-1 flex items-center gap-2 text-[12px] text-fg-subtle">
                    <FileText className="h-3.5 w-3.5" /> {r.sourceTitle}
                    {r.injectionFlag ? <Badge tone="warning">Instruction-like text</Badge> : null}
                  </div>
                  <p className="line-clamp-4 text-[12.5px]">{r.text}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>
      <Dialog open={open} onOpenChange={setOpen} title="Add fact" description="Facts you add are approved immediately. Conflicts with existing values are flagged.">
        <form
          id="fact-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run("fact", () => api("/brain/facts", { body: { category: f.get("category"), key: f.get("key"), value: f.get("value") } }), { success: "Fact added" }).then((r) => r && setOpen(false));
          }}
          className="space-y-4"
        >
          <Field label="Category" htmlFor="category">
            <Select id="category" name="category" defaultValue="product">
              {["product", "pricing", "policy", "audience", "offer", "brand", "faq", "delivery", "other"].map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Key" htmlFor="key" hint="e.g. “Return window”">
            <Input id="key" name="key" required />
          </Field>
          <Field label="Value" htmlFor="value">
            <Textarea id="value" name="value" required />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={isBusy("fact")}>
              Add fact
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function CatalogPanel({ products, domains, canWrite }: { products: Data["products"]; domains: string[]; canWrite: boolean }) {
  const { run, isBusy } = useAction();
  const [edit, setEdit] = useState<Data["products"][number] | "new" | null>(null);
  const [domain, setDomain] = useState("");
  const cur = edit && edit !== "new" ? edit : null;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader
          title="Approved product catalog"
          description="The only source for product links, prices, variants, stock and delivery details in replies."
          actions={
            canWrite ? (
              <Button size="sm" variant="primary" onClick={() => setEdit("new")}>
                <Plus className="h-3.5 w-3.5" /> Add product
              </Button>
            ) : null
          }
        />
        {products.length === 0 ? (
          <EmptyState icon={<Package className="h-5 w-5" />} title="No products yet" description="Add products with approved URLs so agents and comment replies can reference them." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Product</Th>
                <Th>Price</Th>
                <Th>Stock</Th>
                <Th>Approved link</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-[12px] text-fg-muted">{[p.sku, p.variants.join(", ")].filter(Boolean).join(" · ") || "—"}</div>
                  </Td>
                  <Td className="tabular-nums">{p.priceMinor !== null ? fmtMoney(p.priceMinor, p.currency ?? "USD") : <span className="text-fg-subtle">Not set</span>}</Td>
                  <Td>
                    <StatusBadge status={p.stockStatus === "in_stock" ? "available" : p.stockStatus === "unknown" ? "unknown" : p.stockStatus} label={titleCase(p.stockStatus)} />
                  </Td>
                  <Td className="max-w-[220px] truncate text-[12.5px]">{p.url ? <span className="text-brand-600">{p.url}</span> : <span className="text-fg-subtle">No link</span>}</Td>
                  <Td className="text-right">
                    {canWrite ? (
                      <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>
                        Edit
                      </Button>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Link allowlist" description="Replies, posts and ads may only link to these domains." />
        <CardBody>
          {canWrite ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run("domain", () => api("/brain/domains", { body: { domain } }), { success: "Domain allowed" }).then((r) => r && setDomain(""));
              }}
              className="mb-4 flex gap-2"
            >
              <Input aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="shop.example.com" />
              <Button type="submit" loading={isBusy("domain")}>
                Add
              </Button>
            </form>
          ) : null}
          {domains.length === 0 ? (
            <p className="text-[13px] text-fg-muted">No domains yet. Any link in a draft will be blocked.</p>
          ) : (
            <ul className="space-y-1.5">
              {domains.map((d) => (
                <li key={d} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-[13px]">
                  <Globe className="h-3.5 w-3.5 text-fg-subtle" />
                  <span className="flex-1 truncate">{d}</span>
                  {canWrite ? (
                    <Button size="icon" variant="ghost" aria-label={`Remove ${d}`} onClick={() => run(`d${d}`, () => api(`/brain/domains?domain=${encodeURIComponent(d)}`, { method: "DELETE" }), { success: "Domain removed" })}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <Dialog open={edit !== null} onOpenChange={(o) => !o && setEdit(null)} title={cur ? `Edit ${cur.name}` : "Add product"} description="The product URL's domain is added to the link allowlist." size="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const price = String(f.get("price") ?? "").trim();
            const body = {
              name: f.get("name"),
              sku: f.get("sku") || null,
              description: f.get("description") || null,
              url: f.get("url") || null,
              priceMinor: price ? Math.round(Number(price) * 100) : null,
              currency: f.get("currency") || null,
              variants: lines(String(f.get("variants") ?? "").replace(/,/g, "\n")),
              stockStatus: f.get("stockStatus"),
              deliveryPolicy: f.get("deliveryPolicy") || null,
              keywords: lines(String(f.get("keywords") ?? "").replace(/,/g, "\n")),
            };
            void run("product", () => api(cur ? `/brain/products/${cur.id}` : "/brain/products", { method: cur ? "PATCH" : "POST", body }), { success: "Product saved" }).then((r) => r && setEdit(null));
          }}
          className="grid gap-4 md:grid-cols-2"
        >
          <Field label="Name" htmlFor="p-name">
            <Input id="p-name" name="name" defaultValue={cur?.name} required />
          </Field>
          <Field label="SKU" htmlFor="p-sku">
            <Input id="p-sku" name="sku" defaultValue={cur?.sku ?? ""} />
          </Field>
          <Field label="Approved product URL" htmlFor="p-url" className="md:col-span-2">
            <Input id="p-url" name="url" type="url" defaultValue={cur?.url ?? ""} placeholder="https://shop.example.com/products/…" />
          </Field>
          <Field label="Price" htmlFor="p-price" hint="Leave empty if not public. Replies about price escalate when missing.">
            <Input id="p-price" name="price" inputMode="decimal" defaultValue={cur?.priceMinor != null ? (cur.priceMinor / 100).toFixed(2) : ""} />
          </Field>
          <Field label="Currency" htmlFor="p-currency">
            <Input id="p-currency" name="currency" defaultValue={cur?.currency ?? "USD"} maxLength={3} />
          </Field>
          <Field label="Stock status" htmlFor="p-stock">
            <Select id="p-stock" name="stockStatus" defaultValue={cur?.stockStatus ?? "unknown"}>
              <option value="in_stock">In stock</option>
              <option value="low">Low</option>
              <option value="out_of_stock">Out of stock</option>
              <option value="unknown">Unknown</option>
            </Select>
          </Field>
          <Field label="Variants (comma separated)" htmlFor="p-variants">
            <Input id="p-variants" name="variants" defaultValue={cur?.variants.join(", ")} />
          </Field>
          <Field label="Keywords for matching comments" htmlFor="p-keywords" className="md:col-span-2" hint="e.g. candle, aurora">
            <Input id="p-keywords" name="keywords" defaultValue={cur?.keywords.join(", ")} />
          </Field>
          <Field label="Delivery policy" htmlFor="p-delivery" className="md:col-span-2">
            <Input id="p-delivery" name="deliveryPolicy" defaultValue={cur?.deliveryPolicy ?? ""} />
          </Field>
          <Field label="Description" htmlFor="p-desc" className="md:col-span-2">
            <Textarea id="p-desc" name="description" defaultValue={cur?.description ?? ""} />
          </Field>
          <div className="flex justify-between md:col-span-2">
            {cur ? (
              <Button type="button" variant="ghost" onClick={() => run("archive", () => api(`/brain/products/${cur.id}`, { method: "DELETE" }), { success: "Product archived" }).then(() => setEdit(null))}>
                <Trash2 className="h-3.5 w-3.5" /> Archive
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" variant="primary" loading={isBusy("product")}>
              Save product
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

const RULE_KINDS: Array<[string, string, string]> = [
  ["approved_claim", "Approved claims", "Claims you can substantiate. Only these may appear as claims."],
  ["forbidden_claim", "Forbidden claims", "Content containing these is blocked."],
  ["forbidden_word", "Forbidden words", "Blocked words or phrases."],
  ["required_disclaimer", "Required disclaimers", "Content without these gets a warning."],
  ["voice", "Voice guidelines", "Passed to the copywriter and creative director."],
];

function RulesPanel({ rules, canWrite }: { rules: Data["rules"]; canWrite: boolean }) {
  const { run } = useAction();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {RULE_KINDS.map(([kind, title, desc]) => {
        const items = rules.filter((r) => r.kind === kind);
        return (
          <Card key={kind}>
            <CardHeader title={title} description={desc} />
            <CardBody>
              <ul className="mb-3 space-y-1.5">
                {items.length === 0 ? <li className="text-[13px] text-fg-subtle">None yet.</li> : null}
                {items.map((r) => (
                  <li key={r.id} className="flex items-start gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-[13px]">
                    <span className="flex-1">{r.text}</span>
                    {canWrite ? (
                      <button className="text-fg-subtle hover:text-danger-600" aria-label={`Remove rule ${r.text}`} onClick={() => run(`rm${r.id}`, () => api(`/brain/rules/${r.id}`, { method: "DELETE" }))}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {canWrite ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = e.currentTarget.elements.namedItem("text") as HTMLInputElement;
                    void run(`add${kind}`, () => api("/brain/rules", { body: { kind, text: input.value } }), { success: "Rule added" }).then((r) => {
                      if (r) input.value = "";
                    });
                  }}
                  className="flex gap-2"
                >
                  <Input name="text" aria-label={`Add ${title}`} placeholder="Add…" required />
                  <Button type="submit" size="sm">
                    Add
                  </Button>
                </form>
              ) : null}
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}

function SourcesPanel({ sources, canWrite }: { sources: Data["sources"]; canWrite: boolean }) {
  const { run, isBusy } = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Sources"
        description="PDF, TXT, Markdown, CSV, JSON or HTML up to 10 MB. Files are content-checked, scanned, stored per tenant and treated as untrusted data."
        actions={
          canWrite ? (
            <>
              <input
                ref={fileRef}
                type="file"
                className="sr-only"
                aria-label="Upload document"
                accept=".pdf,.txt,.md,.csv,.json,.html,text/*,application/pdf,application/json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const form = new FormData();
                  form.set("file", file);
                  void run("upload", () => api("/knowledge/sources", { form }), { success: "Uploaded — processing in the background" });
                  e.target.value = "";
                }}
              />
              <Button size="sm" onClick={() => setPaste(true)}>
                <FileText className="h-3.5 w-3.5" /> Paste text
              </Button>
              <Button size="sm" variant="primary" loading={isBusy("upload")} onClick={() => fileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" /> Upload
              </Button>
            </>
          ) : null
        }
      />
      {sources.length === 0 ? (
        <EmptyState icon={<Link2 className="h-5 w-5" />} title="No sources yet" description="Upload brand guidelines, FAQs, product sheets or offer terms." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Source</Th>
              <Th>Status</Th>
              <Th>Chunks</Th>
              <Th>Added</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <Td>
                  <div className="font-medium">{s.title}</div>
                  <div className="text-[12px] text-fg-muted">
                    {s.mimeType ?? s.kind} {s.sizeBytes ? `· ${(s.sizeBytes / 1024).toFixed(0)} KB` : ""} · scan: {s.scanStatus.replace("_", " ")}
                  </div>
                  {s.error ? <div className="text-[12px] text-danger-600">{s.error}</div> : null}
                </Td>
                <Td>
                  <StatusBadge status={s.status} />
                </Td>
                <Td className="tabular-nums">{s.chunkCount}</Td>
                <Td className="text-[12.5px] text-fg-muted">{fmtRelative(s.createdAt)}</Td>
                <Td className="text-right">
                  {canWrite ? (
                    <div className="inline-flex gap-1">
                      <Button size="sm" variant="ghost" disabled={s.status !== "ready"} title={s.status !== "ready" ? "Available once processing is complete" : undefined} loading={isBusy(`x${s.id}`)} onClick={() => run(`x${s.id}`, () => api(`/knowledge/sources/${s.id}/extract`, { body: {} }), { success: "Extraction started — facts will appear as pending for review" })}>
                        <Sparkles className="h-3.5 w-3.5" /> Extract facts
                      </Button>
                      <Button size="sm" variant="ghost" aria-label={`Delete ${s.title}`} onClick={() => run(`del${s.id}`, () => api(`/knowledge/sources/${s.id}`, { method: "DELETE" }), { success: "Source deleted" })}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Dialog open={paste} onOpenChange={setPaste} title="Paste text source" size="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run("paste", () => api("/knowledge/sources", { body: { title: f.get("title"), text: f.get("text") } }), { success: "Source added" }).then((r) => r && setPaste(false));
          }}
          className="space-y-4"
        >
          <Field label="Title" htmlFor="src-title">
            <Input id="src-title" name="title" required />
          </Field>
          <Field label="Text" htmlFor="src-text">
            <Textarea id="src-text" name="text" required className="min-h-[220px]" />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={isBusy("paste")}>
              Add source
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
