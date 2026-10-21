"use client";

import { Bot, CheckCircle2, CircleSlash, ExternalLink, FlaskConical, HelpCircle, Image as ImageIcon, Camera, Megaphone, RefreshCw, Unplug } from "lucide-react";
import { ModeBadge, StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ConfirmButton, Switch } from "@/components/ui/overlay";
import { Badge, Card, CardBody, CardHeader, Notice } from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";
import { fmtRelative, sentence, titleCase } from "@/lib/format";

interface Cap { capability: string; status: string; reason: string | null; checkedAt: string }
interface Account { id: string; provider: string; mode: string; externalId: string; displayName: string; username: string | null; status: string; grantedScopes: string[]; tokenExpiresAt: string | null; healthError: string | null; automationPaused: boolean; settings: { commentMonitoring?: boolean; publicReplySuggestions?: boolean; privateReplies?: boolean; dmAutoReplies?: boolean; pageId?: string }; capabilities: Cap[]; lastHealthCheckAt: string | null; currency: string | null }
interface Data {
  providers: {
    instagram: { configured: boolean; webhooksConfigured: boolean; scopes: string[] };
    meta_ads: { configured: boolean; testMode: boolean; scopes: string[] };
    higgsfield: { configured: boolean; models: Array<{ id: string; label: string; kind: string; docs: string }> };
    llm: { configured: boolean; baseUrl: string; models: { default: string; fast: string } };
  };
  mocksAllowed: boolean;
  accounts: Account[];
  media: { connected: boolean; name: string; mode: string | null; reason?: string };
}

const capIcon = (s: string) => (s === "available" ? <CheckCircle2 className="h-3.5 w-3.5 text-success-600" /> : s === "unknown" ? <HelpCircle className="h-3.5 w-3.5 text-warning-600" /> : <CircleSlash className="h-3.5 w-3.5 text-fg-subtle" />);

export function IntegrationsClient({ data, canManage, canAutomate, banner, redirectUris }: { data: Data; canManage: boolean; canAutomate: boolean; banner: { tone: "success" | "danger"; text: string } | null; redirectUris: { instagram: string; meta_ads: string; webhook: string } }) {
  const { run, isBusy } = useAction();
  const connect = (provider: "instagram" | "meta_ads") =>
    run(provider, async () => {
      const r = await api<{ url: string }>(`/integrations/${provider}/connect`, { body: {} });
      window.location.assign(r.url);
    }, { refresh: false });
  const ig = data.accounts.filter((a) => a.provider === "instagram");
  const ads = data.accounts.filter((a) => a.provider === "meta_ads");
  return (
    <div className="space-y-6">
      {banner ? <Notice tone={banner.tone} title={banner.text} /> : null}
      <div className="grid gap-6 xl:grid-cols-2">
        <ProviderCard
          icon={<Camera className="h-5 w-5" />}
          title="Instagram (Business Login)"
          description="Publishing, comments, private replies and messaging for professional accounts via graph.instagram.com."
          configured={data.providers.instagram.configured}
          notConfigured="META_APP_ID and META_APP_SECRET are not set on the server. Create a Meta app with the Instagram product, add the redirect URI below and submit permissions for app review."
          details={[`Redirect URI: ${redirectUris.instagram}`, `Webhook callback: ${redirectUris.webhook} (${data.providers.instagram.webhooksConfigured ? "verify token configured" : "META_WEBHOOK_VERIFY_TOKEN not set"})`, `Requested scopes: ${data.providers.instagram.scopes.join(", ")}`]}
          actions={
            <>
              {data.mocksAllowed && canManage ? (
                <Button size="sm" variant="ghost" loading={isBusy("mock-ig")} onClick={() => run("mock-ig", () => api("/integrations/mock", { body: { provider: "instagram" } }), { success: "Mock Instagram account connected (development only)" })}>
                  <FlaskConical className="h-3.5 w-3.5" /> Connect mock
                </Button>
              ) : null}
              <Button size="sm" variant="primary" disabled={!canManage || !data.providers.instagram.configured} title={!data.providers.instagram.configured ? "Meta app credentials are not configured" : undefined} loading={isBusy("instagram")} onClick={() => connect("instagram")}>
                Connect Instagram
              </Button>
            </>
          }
        >
          {ig.map((a) => <AccountRow key={a.id} account={a} canManage={canManage} canAutomate={canAutomate} />)}
        </ProviderCard>
        <ProviderCard
          icon={<Megaphone className="h-5 w-5" />}
          title="Meta Marketing API"
          description="Ad account metadata, campaign drafts, launch/pause and insights via graph.facebook.com."
          configured={data.providers.meta_ads.configured}
          notConfigured="META_APP_ID and META_APP_SECRET are not set. Ads require Facebook Login for Business with ads_management/ads_read (Advanced Access) and a verified business."
          details={[`Redirect URI: ${redirectUris.meta_ads}`, data.providers.meta_ads.testMode ? "META_ADS_TEST_MODE is ON: campaigns are created PAUSED and never activated." : "Test mode is OFF: approved launches can spend money within caps.", `Requested scopes: ${data.providers.meta_ads.scopes.join(", ")}`]}
          actions={
            <>
              {data.mocksAllowed && canManage ? (
                <Button size="sm" variant="ghost" loading={isBusy("mock-ads")} onClick={() => run("mock-ads", () => api("/integrations/mock", { body: { provider: "meta_ads" } }), { success: "Mock ad account connected (development only)" })}>
                  <FlaskConical className="h-3.5 w-3.5" /> Connect mock
                </Button>
              ) : null}
              <Button size="sm" variant="primary" disabled={!canManage || !data.providers.meta_ads.configured} title={!data.providers.meta_ads.configured ? "Meta app credentials are not configured" : undefined} loading={isBusy("meta_ads")} onClick={() => connect("meta_ads")}>
                Connect ad accounts
              </Button>
            </>
          }
        >
          {ads.map((a) => <AccountRow key={a.id} account={a} canManage={canManage} canAutomate={canAutomate} />)}
        </ProviderCard>
        <ProviderCard
          icon={<ImageIcon className="h-5 w-5" />}
          title="Higgsfield media generation"
          description="Asynchronous image and video generation with idempotent submission, polling/webhooks and cancellation."
          configured={data.media.connected && data.media.mode === "live"}
          notConfigured={data.media.connected ? "No API key: a labelled development mock produces placeholder images only." : (data.media.reason ?? "Not connected")}
          details={[...data.providers.higgsfield.models.map((m) => `${m.label} — ${m.kind}`), "Model availability depends on your Higgsfield account; verify in console.higgsfield.ai."]}
          status={data.media.connected ? <ModeBadge mode={data.media.mode} /> : <Badge>Not connected</Badge>}
        />
        <ProviderCard
          icon={<Bot className="h-5 w-5" />}
          title="LLM gateway"
          description="OpenAI-compatible structured outputs for the specialist agents. Outputs are schema-validated; cost and tokens are recorded per run."
          configured={data.providers.llm.configured}
          notConfigured="LLM_API_KEY is not set: agents use a deterministic, labelled mock."
          details={[`Endpoint: ${data.providers.llm.baseUrl}`, `Default model: ${data.providers.llm.models.default}`, `Fast model: ${data.providers.llm.models.fast}`]}
          status={data.providers.llm.configured ? <Badge tone="success">Connected</Badge> : <Badge tone="warning">Mock</Badge>}
        />
      </div>
    </div>
  );
}

function ProviderCard({ icon, title, description, configured, notConfigured, details, actions, status, children }: { icon: React.ReactNode; title: string; description: string; configured: boolean; notConfigured: string; details: string[]; actions?: React.ReactNode; status?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2">{icon} {title}</span>}
        description={description}
        actions={status ?? actions ?? (configured ? <Badge tone="success">Configured</Badge> : <Badge>Not configured</Badge>)}
      />
      <CardBody className="space-y-3">
        {!configured ? <Notice tone="neutral" title="Not connected">{notConfigured}</Notice> : null}
        <ul className="space-y-1 text-[12px] break-all text-fg-subtle">
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
        {status && actions ? <div className="flex justify-end gap-2">{actions}</div> : null}
        {children}
      </CardBody>
    </Card>
  );
}

function AccountRow({ account: a, canManage, canAutomate }: { account: Account; canManage: boolean; canAutomate: boolean }) {
  const { run, isBusy } = useAction();
  const toggle = (key: keyof Account["settings"] | "automationPaused", value: boolean) => run(`s${key}`, () => api(`/integrations/accounts/${a.id}`, { method: "PATCH", body: { [key]: value } }), { success: "Saved" });
  const expired = a.tokenExpiresAt && new Date(a.tokenExpiresAt) < new Date();
  return (
    <div className="rounded-xl border border-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold">
            {a.username ? `@${a.username}` : a.displayName} <ModeBadge mode={a.mode} /> <StatusBadge status={a.status} />
          </div>
          <div className="text-[12px] text-fg-muted">
            {a.externalId} · checked {fmtRelative(a.lastHealthCheckAt)}
            {a.tokenExpiresAt ? ` · token ${expired ? "expired" : `expires ${fmtRelative(a.tokenExpiresAt)}`}` : ""}
          </div>
          {a.healthError ? <div className="mt-0.5 text-[12px] text-danger-600">{a.healthError}</div> : null}
        </div>
        {canManage ? (
          <>
            <Button size="sm" variant="ghost" loading={isBusy("caps")} onClick={() => run("caps", () => api(`/integrations/accounts/${a.id}/capabilities`, { body: {} }), { success: "Capabilities re-checked" })}>
              <RefreshCw className="h-3.5 w-3.5" /> Re-check
            </Button>
            <ConfirmButton size="sm" variant="ghost" label={<><Unplug className="h-3.5 w-3.5" /> Disconnect</>} title="Disconnect account?" effect="Stored tokens are destroyed. Scheduled publishing and replies for this account will be blocked until it is reconnected." confirmLabel="Disconnect" onConfirm={() => run("disc", () => api(`/integrations/accounts/${a.id}`, { method: "DELETE" }), { success: "Disconnected" }).then(() => undefined)} />
          </>
        ) : null}
      </div>
      <div className="grid gap-4 px-4 py-3 md:grid-cols-2">
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-fg-muted">Capabilities (from granted scopes and live checks)</div>
          <ul className="space-y-1">
            {a.capabilities.map((c) => (
              <li key={c.capability} className="flex items-start gap-1.5 text-[12.5px]">
                {capIcon(c.status)}
                <span>
                  {sentence(c.capability)}
                  {c.reason ? <span className="block text-[11.5px] text-fg-subtle">{c.reason}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 text-[11.5px] break-words text-fg-subtle">Granted: {a.grantedScopes.join(", ") || "none"}</div>
        </div>
        {a.provider === "instagram" ? (
          <div className="space-y-2.5">
            <div className="text-[12px] font-medium text-fg-muted">Inbox automation</div>
            {(
              [
                ["commentMonitoring", "Monitor comments"],
                ["publicReplySuggestions", "Draft public replies"],
                ["privateReplies", "Draft private replies"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-center justify-between gap-3 text-[13px]">
                {label}
                <Switch checked={a.settings[k] !== false} onCheckedChange={(v) => toggle(k, v)} label={label} disabled={!canManage} />
              </label>
            ))}
            <label className="flex items-center justify-between gap-3 text-[13px]">
              <span>
                Pause automated replies <span className="block text-[11.5px] text-fg-subtle">Per-account emergency pause</span>
              </span>
              <Switch checked={a.automationPaused} onCheckedChange={(v) => toggle("automationPaused", v)} label="Pause automated replies for this account" disabled={!canAutomate} />
            </label>
          </div>
        ) : (
          <div className="space-y-2 text-[12.5px]">
            <div className="text-[12px] font-medium text-fg-muted">Ad account</div>
            <div>Currency: {a.currency ?? "—"}</div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v = (e.currentTarget.elements.namedItem("pageId") as HTMLInputElement).value;
                void run("page", () => api(`/integrations/accounts/${a.id}`, { method: "PATCH", body: { pageId: v } }), { success: "Page ID saved" });
              }}
              className="flex items-end gap-2"
            >
              <label className="flex-1">
                <span className="mb-1 block text-[12px] text-fg-muted">Facebook Page ID (required for creatives)</span>
                <input name="pageId" defaultValue={a.settings.pageId ?? ""} inputMode="numeric" className="h-8 w-full rounded-md border border-border bg-surface px-2 text-[13px]" disabled={!canManage} />
              </label>
              <Button size="sm" type="submit" disabled={!canManage}>
                Save
              </Button>
            </form>
            <a className="inline-flex items-center gap-1 text-brand-600 hover:underline" href="https://developers.facebook.com/docs/marketing-api/" target="_blank" rel="noreferrer noopener">
              Marketing API docs <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
      </div>
      <div className="border-t border-border px-4 py-2 text-[11.5px] text-fg-subtle">{titleCase(a.provider)} · {a.mode === "mock" ? "Development mock — never contacts Meta" : "Live connection"}</div>
    </div>
  );
}
