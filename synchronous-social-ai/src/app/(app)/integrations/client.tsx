"use client";

import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  ExternalLink,
  FlaskConical,
  HelpCircle,
  Image as ImageIcon,
  Megaphone,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { ChannelMark } from "@/components/channel-mark";
import { ModeBadge, StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ConfirmButton, Switch } from "@/components/ui/overlay";
import { Badge, Card, CardBody, CardHeader, Notice, Select } from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";
import {
  CHANNEL_META,
  channelLabel,
  isSocialChannel,
  SOCIAL_CHANNELS,
  TIKTOK_PRIVACY_LABELS,
  TIKTOK_PRIVACY_LEVELS,
  type SocialChannel,
} from "@/lib/channels";
import { fmtRelative, sentence } from "@/lib/format";

interface Cap {
  capability: string;
  status: string;
  reason: string | null;
  checkedAt: string;
}
interface Account {
  id: string;
  provider: string;
  mode: string;
  externalId: string;
  displayName: string;
  username: string | null;
  status: string;
  grantedScopes: string[];
  tokenExpiresAt: string | null;
  healthError: string | null;
  automationPaused: boolean;
  settings: {
    commentMonitoring?: boolean;
    publicReplySuggestions?: boolean;
    privateReplies?: boolean;
    dmAutoReplies?: boolean;
    pageId?: string;
    tiktokPrivacy?: string;
  };
  capabilities: Cap[];
  lastHealthCheckAt: string | null;
  currency: string | null;
}
interface Data {
  providers: {
    instagram: { configured: boolean; webhooksConfigured: boolean; scopes: string[] };
    facebook: { configured: boolean; webhooksConfigured: boolean; scopes: string[] };
    threads: { configured: boolean; scopes: string[] };
    x: { configured: boolean; scopes: string[] };
    tiktok: { configured: boolean; scopes: string[] };
    meta_ads: { configured: boolean; testMode: boolean; scopes: string[] };
    higgsfield: {
      configured: boolean;
      models: Array<{ id: string; label: string; kind: string; docs: string }>;
    };
    llm: { configured: boolean; baseUrl: string; models: { default: string; fast: string } };
  };
  mocksAllowed: boolean;
  accounts: Account[];
  media: { connected: boolean; name: string; mode: string | null; reason?: string };
}

const capIcon = (s: string) =>
  s === "available" ? (
    <CheckCircle2 className="text-success-600 h-3.5 w-3.5" />
  ) : s === "unknown" ? (
    <HelpCircle className="text-warning-600 h-3.5 w-3.5" />
  ) : (
    <CircleSlash className="text-fg-subtle h-3.5 w-3.5" />
  );

type ConnectProvider = "instagram" | "facebook" | "threads" | "x" | "tiktok" | "meta_ads";

const SETUP: Record<SocialChannel, { needs: string; docs: string }> = {
  instagram: {
    needs:
      "META_APP_ID / META_APP_SECRET, Instagram product, app review for instagram_business_* permissions",
    docs: "https://developers.facebook.com/docs/instagram-platform",
  },
  facebook: {
    needs: "META_APP_ID / META_APP_SECRET (same Meta app), app review for pages_* permissions",
    docs: "https://developers.facebook.com/docs/pages-api",
  },
  threads: {
    needs: "THREADS_APP_ID / THREADS_APP_SECRET (Threads use case in your Meta app)",
    docs: "https://developers.facebook.com/docs/threads",
  },
  x: {
    needs: "X_CLIENT_ID / X_CLIENT_SECRET (OAuth 2.0 confidential client, Read and write)",
    docs: "https://docs.x.com/x-api/posts/manage-tweets/introduction",
  },
  tiktok: {
    needs: "TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET, Content Posting API, verified media URL domain",
    docs: "https://developers.tiktok.com/doc/content-posting-api-get-started",
  },
};

export function IntegrationsClient({
  data,
  canManage,
  canAutomate,
  banner,
  redirectUris,
}: {
  data: Data;
  canManage: boolean;
  canAutomate: boolean;
  banner: { tone: "success" | "danger"; text: string } | null;
  redirectUris: Record<ConnectProvider, string> & { webhook: string };
}) {
  const { run, isBusy } = useAction();
  const connect = (provider: ConnectProvider) =>
    run(
      provider,
      async () => {
        const r = await api<{ url: string }>(`/integrations/${provider}/connect`, { body: {} });
        window.location.assign(r.url);
      },
      { refresh: false },
    );
  const connectMock = (provider: ConnectProvider, label: string) =>
    run(`mock-${provider}`, () => api("/integrations/mock", { body: { provider } }), {
      success: `Mock ${label} connected (development only)`,
    });
  const channelAccounts = data.accounts.filter(
    (a) => isSocialChannel(a.provider) && a.status !== "disconnected",
  );
  const ads = data.accounts.filter((a) => a.provider === "meta_ads");
  return (
    <div className="space-y-8">
      {banner ? <Notice tone={banner.tone} title={banner.text} /> : null}

      <section aria-labelledby="channels-h" className="space-y-3">
        <div>
          <h2 id="channels-h" className="text-[15px] font-semibold">
            Social channels
          </h2>
          <p className="text-fg-muted text-[13px]">
            Connect once, then pick any channel as a destination in Content Studio. Every post is approved per
            channel.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {SOCIAL_CHANNELS.map((ch) => {
            const meta = CHANNEL_META[ch];
            const p = data.providers[ch];
            const count = channelAccounts.filter((a) => a.provider === ch).length;
            return (
              <Card key={ch} className="flex flex-col" data-testid={`channel-${ch}`}>
                <div className="flex flex-1 flex-col gap-3 p-4">
                  <div className="flex items-center gap-3">
                    <ChannelMark provider={ch} size="lg" />
                    <div className="min-w-0">
                      <div className="text-[14px] font-semibold">{meta.label}</div>
                      <div className="text-[12px]">
                        {count ? (
                          <span className="text-success-600 font-medium">{count} connected</span>
                        ) : p.configured ? (
                          <span className="text-fg-muted">Ready to connect</span>
                        ) : (
                          <span className="text-fg-subtle">App not configured</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="text-fg-muted text-[12.5px] leading-snug">{meta.blurb}</p>
                  <div className="mt-auto flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      className="flex-1"
                      disabled={!canManage || !p.configured}
                      title={!p.configured ? `Server is missing ${SETUP[ch].needs.split(",")[0]}` : undefined}
                      loading={isBusy(ch)}
                      onClick={() => connect(ch)}
                    >
                      {count ? "Add another" : "Connect"}
                    </Button>
                    {data.mocksAllowed && canManage ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={isBusy(`mock-${ch}`)}
                        onClick={() => connectMock(ch, meta.label)}
                        aria-label={`Connect mock ${meta.label}`}
                        title="Development-only mock account"
                      >
                        <FlaskConical className="h-3.5 w-3.5" /> Mock
                      </Button>
                    ) : null}
                  </div>
                  <details className="text-fg-subtle text-[11.5px]">
                    <summary className="hover:text-fg cursor-pointer select-none">Setup details</summary>
                    <ul className="mt-1.5 space-y-1 break-all">
                      <li>Needs: {SETUP[ch].needs}</li>
                      <li>Redirect URI: {redirectUris[ch]}</li>
                      {ch === "instagram" || ch === "facebook" ? (
                        <li>
                          Webhook: {redirectUris.webhook} (
                          {data.providers.instagram.webhooksConfigured
                            ? "verify token set"
                            : "verify token not set"}
                          )
                        </li>
                      ) : null}
                      <li>Scopes: {p.scopes.join(", ")}</li>
                      <li>
                        <a
                          className="text-brand-600 inline-flex items-center gap-1 hover:underline"
                          href={SETUP[ch].docs}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Platform docs <ExternalLink className="h-3 w-3" />
                        </a>
                      </li>
                    </ul>
                  </details>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="accounts-h" className="space-y-3">
        <h2 id="accounts-h" className="text-[15px] font-semibold">
          Connected accounts
        </h2>
        {channelAccounts.length ? (
          <div className="space-y-3">
            {channelAccounts.map((a) => (
              <AccountRow key={a.id} account={a} canManage={canManage} canAutomate={canAutomate} />
            ))}
          </div>
        ) : (
          <Card>
            <CardBody className="text-fg-muted text-[13px]">
              No channels connected yet. Connect one above to start publishing.
            </CardBody>
          </Card>
        )}
      </section>

      <section aria-labelledby="platform-h" className="space-y-3">
        <h2 id="platform-h" className="text-[15px] font-semibold">
          Ads, media and AI
        </h2>
        <div className="grid gap-6 xl:grid-cols-2">
          <ProviderCard
            icon={<Megaphone className="h-5 w-5" />}
            title="Meta Marketing API"
            description="Ad account metadata, campaign drafts, launch/pause and insights via graph.facebook.com."
            configured={data.providers.meta_ads.configured}
            notConfigured="META_APP_ID and META_APP_SECRET are not set. Ads require Facebook Login for Business with ads_management/ads_read (Advanced Access) and a verified business."
            details={[
              `Redirect URI: ${redirectUris.meta_ads}`,
              data.providers.meta_ads.testMode
                ? "META_ADS_TEST_MODE is ON: campaigns are created PAUSED and never activated."
                : "Test mode is OFF: approved launches can spend money within caps.",
              `Requested scopes: ${data.providers.meta_ads.scopes.join(", ")}`,
            ]}
            actions={
              <>
                {data.mocksAllowed && canManage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={isBusy("mock-meta_ads")}
                    onClick={() => connectMock("meta_ads", "ad account")}
                  >
                    <FlaskConical className="h-3.5 w-3.5" /> Connect mock
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!canManage || !data.providers.meta_ads.configured}
                  title={
                    !data.providers.meta_ads.configured
                      ? "Meta app credentials are not configured"
                      : undefined
                  }
                  loading={isBusy("meta_ads")}
                  onClick={() => connect("meta_ads")}
                >
                  Connect ad accounts
                </Button>
              </>
            }
          >
            {ads.map((a) => (
              <AccountRow key={a.id} account={a} canManage={canManage} canAutomate={canAutomate} />
            ))}
          </ProviderCard>
          <ProviderCard
            icon={<ImageIcon className="h-5 w-5" />}
            title="Higgsfield media generation"
            description="Asynchronous image and video generation with idempotent submission, polling/webhooks and cancellation."
            configured={data.media.connected && data.media.mode === "live"}
            notConfigured={
              data.media.connected
                ? "No API key: a labelled development mock produces placeholder images only."
                : (data.media.reason ?? "Not connected")
            }
            details={[
              ...data.providers.higgsfield.models.map((m) => `${m.label} — ${m.kind}`),
              "Model availability depends on your Higgsfield account; verify in console.higgsfield.ai.",
            ]}
            status={
              data.media.connected ? <ModeBadge mode={data.media.mode} /> : <Badge>Not connected</Badge>
            }
          />
          <ProviderCard
            icon={<Bot className="h-5 w-5" />}
            title="LLM gateway"
            description="OpenAI-compatible structured outputs for the specialist agents. Outputs are schema-validated; cost and tokens are recorded per run."
            configured={data.providers.llm.configured}
            notConfigured="LLM_API_KEY is not set: agents use a deterministic, labelled mock."
            details={[
              `Endpoint: ${data.providers.llm.baseUrl}`,
              `Default model: ${data.providers.llm.models.default}`,
              `Fast model: ${data.providers.llm.models.fast}`,
            ]}
            status={
              data.providers.llm.configured ? (
                <Badge tone="success">Connected</Badge>
              ) : (
                <Badge tone="warning">Mock</Badge>
              )
            }
          />
        </div>
      </section>
    </div>
  );
}

function ProviderCard({
  icon,
  title,
  description,
  configured,
  notConfigured,
  details,
  actions,
  status,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  configured: boolean;
  notConfigured: string;
  details: string[];
  actions?: React.ReactNode;
  status?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {icon} {title}
          </span>
        }
        description={description}
        actions={
          status ??
          actions ??
          (configured ? <Badge tone="success">Configured</Badge> : <Badge>Not configured</Badge>)
        }
      />
      <CardBody className="space-y-3">
        {!configured ? (
          <Notice tone="neutral" title="Not connected">
            {notConfigured}
          </Notice>
        ) : null}
        <ul className="text-fg-subtle space-y-1 text-[12px] break-all">
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

function AccountRow({
  account: a,
  canManage,
  canAutomate,
}: {
  account: Account;
  canManage: boolean;
  canAutomate: boolean;
}) {
  const { run, isBusy } = useAction();
  const toggle = (key: keyof Account["settings"] | "automationPaused", value: boolean) =>
    run(`s${key}`, () => api(`/integrations/accounts/${a.id}`, { method: "PATCH", body: { [key]: value } }), {
      success: "Saved",
    });
  const expired = a.tokenExpiresAt && new Date(a.tokenExpiresAt) < new Date();
  return (
    <div className="border-border rounded-xl border">
      <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold">
            {isSocialChannel(a.provider) ? <ChannelMark provider={a.provider} size="sm" /> : null}
            {a.username && a.provider !== "facebook"
              ? `${isSocialChannel(a.provider) ? CHANNEL_META[a.provider].handlePrefix : "@"}${a.username}`
              : a.displayName}{" "}
            <ModeBadge mode={a.mode} /> <StatusBadge status={a.status} />
          </div>
          <div className="text-fg-muted text-[12px]">
            {a.externalId} · checked {fmtRelative(a.lastHealthCheckAt)}
            {a.tokenExpiresAt
              ? ` · token ${expired ? "expired" : `expires ${fmtRelative(a.tokenExpiresAt)}`}`
              : ""}
          </div>
          {a.healthError ? <div className="text-danger-600 mt-0.5 text-[12px]">{a.healthError}</div> : null}
        </div>
        {canManage ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              loading={isBusy("caps")}
              onClick={() =>
                run("caps", () => api(`/integrations/accounts/${a.id}/capabilities`, { body: {} }), {
                  success: "Capabilities re-checked",
                })
              }
            >
              <RefreshCw className="h-3.5 w-3.5" /> Re-check
            </Button>
            <ConfirmButton
              size="sm"
              variant="ghost"
              label={
                <>
                  <Unplug className="h-3.5 w-3.5" /> Disconnect
                </>
              }
              title="Disconnect account?"
              effect="Stored tokens are destroyed. Scheduled publishing and replies for this account will be blocked until it is reconnected."
              confirmLabel="Disconnect"
              onConfirm={() =>
                run("disc", () => api(`/integrations/accounts/${a.id}`, { method: "DELETE" }), {
                  success: "Disconnected",
                }).then(() => undefined)
              }
            />
          </>
        ) : null}
      </div>
      <details
        className="group"
        open={a.status !== "connected" || Boolean(a.healthError) || a.provider === "meta_ads"}
      >
        <summary className="text-fg-muted hover:text-fg flex cursor-pointer items-center gap-1.5 px-4 py-2.5 text-[12.5px] font-medium select-none">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
          Settings & permissions
          <span className="text-fg-subtle font-normal">
            · {a.capabilities.filter((c) => c.status === "available").length}/{a.capabilities.length}{" "}
            capabilities available
          </span>
        </summary>
        <div className="border-border grid gap-4 border-t px-4 py-3 md:grid-cols-2">
          <div>
            <div className="text-fg-muted mb-1.5 text-[12px] font-medium">
              Capabilities (from granted scopes and live checks)
            </div>
            <ul className="space-y-1">
              {a.capabilities.map((c) => (
                <li key={c.capability} className="flex items-start gap-1.5 text-[12.5px]">
                  {capIcon(c.status)}
                  <span>
                    {sentence(c.capability)}
                    {c.reason ? <span className="text-fg-subtle block text-[11.5px]">{c.reason}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
            <div className="text-fg-subtle mt-2 text-[11.5px] break-words">
              Granted: {a.grantedScopes.join(", ") || "none"}
            </div>
          </div>
          {a.provider === "instagram" || a.provider === "facebook" ? (
            <div className="space-y-2.5">
              <div className="text-fg-muted text-[12px] font-medium">Inbox automation</div>
              {(
                [
                  ["commentMonitoring", "Monitor comments"],
                  ["publicReplySuggestions", "Draft public replies"],
                  ["privateReplies", "Draft private replies"],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex items-center justify-between gap-3 text-[13px]">
                  {label}
                  <Switch
                    checked={a.settings[k] !== false}
                    onCheckedChange={(v) => toggle(k, v)}
                    label={label}
                    disabled={!canManage}
                  />
                </label>
              ))}
              <label className="flex items-center justify-between gap-3 text-[13px]">
                <span>
                  Pause automated replies{" "}
                  <span className="text-fg-subtle block text-[11.5px]">Per-account emergency pause</span>
                </span>
                <Switch
                  checked={a.automationPaused}
                  onCheckedChange={(v) => toggle("automationPaused", v)}
                  label="Pause automated replies for this account"
                  disabled={!canAutomate}
                />
              </label>
            </div>
          ) : a.provider === "tiktok" ? (
            <div className="space-y-2 text-[12.5px]">
              <div className="text-fg-muted text-[12px] font-medium">Who can see posts</div>
              <Select
                aria-label="TikTok post visibility"
                value={a.settings.tiktokPrivacy ?? "SELF_ONLY"}
                disabled={!canManage || isBusy("priv")}
                onChange={(e) =>
                  void run(
                    "priv",
                    () =>
                      api(`/integrations/accounts/${a.id}`, {
                        method: "PATCH",
                        body: { tiktokPrivacy: e.target.value },
                      }),
                    { success: "Visibility saved. Open approvals for this account must be re-approved." },
                  )
                }
              >
                {TIKTOK_PRIVACY_LEVELS.map((p) => (
                  <option key={p} value={p}>
                    {TIKTOK_PRIVACY_LABELS[p]}
                  </option>
                ))}
              </Select>
              <p className="text-fg-subtle text-[11.5px]">
                Apps that have not passed TikTok&apos;s audit can only post as &quot;Only me&quot;. The level
                is re-checked against the creator&apos;s options right before posting.
              </p>
            </div>
          ) : isSocialChannel(a.provider) ? (
            <div className="text-fg-muted space-y-1 text-[12.5px]">
              <div className="text-[12px] font-medium">Publishing</div>
              <p>
                Posts to {CHANNEL_META[a.provider].label} after approval. Limit{" "}
                {CHANNEL_META[a.provider].textLimit.toLocaleString()} characters per post.
              </p>
            </div>
          ) : (
            <div className="space-y-2 text-[12.5px]">
              <div className="text-fg-muted text-[12px] font-medium">Ad account</div>
              <div>Currency: {a.currency ?? "—"}</div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = (e.currentTarget.elements.namedItem("pageId") as HTMLInputElement).value;
                  void run(
                    "page",
                    () => api(`/integrations/accounts/${a.id}`, { method: "PATCH", body: { pageId: v } }),
                    { success: "Page ID saved" },
                  );
                }}
                className="flex items-end gap-2"
              >
                <label className="flex-1">
                  <span className="text-fg-muted mb-1 block text-[12px]">
                    Facebook Page ID (required for creatives)
                  </span>
                  <input
                    name="pageId"
                    defaultValue={a.settings.pageId ?? ""}
                    inputMode="numeric"
                    className="border-border bg-surface h-8 w-full rounded-md border px-2 text-[13px]"
                    disabled={!canManage}
                  />
                </label>
                <Button size="sm" type="submit" disabled={!canManage}>
                  Save
                </Button>
              </form>
              <a
                className="text-brand-600 inline-flex items-center gap-1 hover:underline"
                href="https://developers.facebook.com/docs/marketing-api/"
                target="_blank"
                rel="noreferrer noopener"
              >
                Marketing API docs <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      </details>
      <div className="border-border text-fg-subtle border-t px-4 py-2 text-[11.5px]">
        {channelLabel(a.provider)} ·{" "}
        {a.mode === "mock" ? "Development mock — never contacts the platform" : "Live connection"}
      </div>
    </div>
  );
}
