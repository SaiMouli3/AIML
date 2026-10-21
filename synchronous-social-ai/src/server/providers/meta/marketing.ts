import { randomUUID } from "node:crypto";
import { env } from "../../env";
import { ProviderError } from "../errors";
import { graphCall } from "./graph";

/**
 * Meta Marketing API adapter (graph.facebook.com). Objects are always created with status=PAUSED;
 * activation is a separate, approved, spend-capped mutation. In META_ADS_TEST_MODE the adapter refuses
 * to set any object ACTIVE, so automated tests and test-mode workspaces can never spend money.
 */

export const ADS_SCOPES = ["ads_management", "ads_read", "business_management", "pages_show_list"] as const;

export const OBJECTIVES = ["OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_SALES"] as const;
export type Objective = (typeof OBJECTIVES)[number];
export const SPECIAL_AD_CATEGORIES = ["NONE", "HOUSING", "EMPLOYMENT", "FINANCIAL_PRODUCTS_SERVICES", "ISSUES_ELECTIONS_POLITICS"] as const;

export interface AdAccountInfo {
  id: string; // act_<id>
  name: string;
  currency: string;
  accountStatus: number; // 1 = ACTIVE per Marketing API
  disableReason?: number;
}

export interface CampaignSpec {
  name: string;
  objective: Objective;
  specialAdCategories: string[];
}
export interface AdSetSpec {
  name: string;
  campaignId: string;
  dailyBudgetMinor: number;
  optimizationGoal: string;
  billingEvent: string;
  targeting: Record<string, unknown>;
  startTime?: string | null;
  endTime?: string | null;
  promotedObject?: Record<string, unknown> | null;
}
export interface CreativeSpec {
  name: string;
  pageId: string;
  instagramUserId?: string | null;
  link: string;
  message: string;
  headline: string;
  imageUrl?: string | null;
  callToAction: string;
}

export interface MetaAdsAdapter {
  readonly mode: "live" | "mock";
  getAdAccount(): Promise<AdAccountInfo>;
  createCampaign(spec: CampaignSpec): Promise<{ id: string }>;
  createAdSet(spec: AdSetSpec): Promise<{ id: string }>;
  createCreative(spec: CreativeSpec): Promise<{ id: string }>;
  createAd(name: string, adSetId: string, creativeId: string): Promise<{ id: string }>;
  setStatus(objectId: string, status: "ACTIVE" | "PAUSED"): Promise<void>;
  getObject(objectId: string): Promise<{ id: string; status?: string; effective_status?: string; name?: string }>;
  findCampaignByName(name: string): Promise<{ id: string; status?: string } | null>;
  getInsights(campaignId: string, since: string, until: string): Promise<AdInsights | null>;
}

export interface AdInsights {
  dateStart: string;
  dateStop: string;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  spend: number | null; // account currency, major units as returned by Meta
  conversions: number | null;
}

export const ACCOUNT_STATUS: Record<number, string> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
  201: "ANY_ACTIVE",
  202: "ANY_CLOSED",
};

export class LiveMetaAdsAdapter implements MetaAdsAdapter {
  readonly mode = "live" as const;
  constructor(
    private readonly adAccountId: string, // act_<id>
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private base() {
    return `https://graph.facebook.com/${env().META_GRAPH_VERSION}`;
  }
  private call<T>(method: "GET" | "POST", path: string, params?: Record<string, string | number | boolean | undefined>, mutation = false) {
    return graphCall<T>({ method, url: `${this.base()}${path}`, token: this.token, params, mutation, fetchImpl: this.fetchImpl }, "meta_ads");
  }
  async getAdAccount() {
    const r = await this.call<{ id: string; name: string; currency: string; account_status: number; disable_reason?: number }>("GET", `/${this.adAccountId}`, {
      fields: "id,name,currency,account_status,disable_reason",
    });
    return { id: r.id, name: r.name, currency: r.currency, accountStatus: r.account_status, disableReason: r.disable_reason };
  }
  createCampaign(spec: CampaignSpec) {
    return this.call<{ id: string }>(
      "POST",
      `/${this.adAccountId}/campaigns`,
      {
        name: spec.name,
        objective: spec.objective,
        status: "PAUSED",
        special_ad_categories: JSON.stringify(spec.specialAdCategories.filter((c) => c !== "NONE")),
      },
      true,
    );
  }
  createAdSet(spec: AdSetSpec) {
    return this.call<{ id: string }>(
      "POST",
      `/${this.adAccountId}/adsets`,
      {
        name: spec.name,
        campaign_id: spec.campaignId,
        daily_budget: spec.dailyBudgetMinor,
        billing_event: spec.billingEvent,
        optimization_goal: spec.optimizationGoal,
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        targeting: JSON.stringify(spec.targeting),
        start_time: spec.startTime ?? undefined,
        end_time: spec.endTime ?? undefined,
        promoted_object: spec.promotedObject ? JSON.stringify(spec.promotedObject) : undefined,
        status: "PAUSED",
      },
      true,
    );
  }
  createCreative(spec: CreativeSpec) {
    return this.call<{ id: string }>(
      "POST",
      `/${this.adAccountId}/adcreatives`,
      {
        name: spec.name,
        object_story_spec: JSON.stringify({
          page_id: spec.pageId,
          ...(spec.instagramUserId ? { instagram_user_id: spec.instagramUserId } : {}),
          link_data: {
            link: spec.link,
            message: spec.message,
            name: spec.headline,
            ...(spec.imageUrl ? { picture: spec.imageUrl } : {}),
            call_to_action: { type: spec.callToAction, value: { link: spec.link } },
          },
        }),
      },
      true,
    );
  }
  createAd(name: string, adSetId: string, creativeId: string) {
    return this.call<{ id: string }>(
      "POST",
      `/${this.adAccountId}/ads`,
      { name, adset_id: adSetId, creative: JSON.stringify({ creative_id: creativeId }), status: "PAUSED" },
      true,
    );
  }
  async setStatus(objectId: string, status: "ACTIVE" | "PAUSED") {
    if (status === "ACTIVE" && env().META_ADS_TEST_MODE) {
      throw new ProviderError("policy", "meta_ads", "META_ADS_TEST_MODE is on: activation (real spend) is disabled");
    }
    await this.call("POST", `/${objectId}`, { status }, true);
  }
  getObject(objectId: string) {
    return this.call<{ id: string; status?: string; effective_status?: string; name?: string }>("GET", `/${objectId}`, { fields: "id,name,status,effective_status" });
  }
  async findCampaignByName(name: string) {
    const r = await this.call<{ data: Array<{ id: string; name: string; status?: string }> }>("GET", `/${this.adAccountId}/campaigns`, {
      fields: "id,name,status",
      filtering: JSON.stringify([{ field: "name", operator: "EQUAL", value: name }]),
      limit: 5,
    });
    const hit = r.data?.find((c) => c.name === name);
    return hit ? { id: hit.id, status: hit.status } : null;
  }
  async getInsights(campaignId: string, since: string, until: string) {
    const r = await this.call<{ data: Array<Record<string, unknown>> }>("GET", `/${campaignId}/insights`, {
      fields: "impressions,reach,clicks,spend,actions,date_start,date_stop",
      time_range: JSON.stringify({ since, until }),
    });
    const d = r.data?.[0];
    if (!d) return null;
    const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
    const actions = (d.actions as Array<{ action_type: string; value: string }> | undefined) ?? [];
    const purchase = actions.find((a) => a.action_type === "offsite_conversion.fb_pixel_purchase" || a.action_type === "purchase");
    return {
      dateStart: String(d.date_start),
      dateStop: String(d.date_stop),
      impressions: num(d.impressions),
      reach: num(d.reach),
      clicks: num(d.clicks),
      spend: num(d.spend),
      conversions: purchase ? Number(purchase.value) : null,
    };
  }
}

/** Development mock: returns IDs but never metrics (no fabricated performance). */
export class MockMetaAdsAdapter implements MetaAdsAdapter {
  readonly mode = "mock" as const;
  constructor(private readonly adAccountId: string, private readonly currency = "USD") {}
  async getAdAccount() {
    return { id: this.adAccountId, name: "Mock Ad Account (development)", currency: this.currency, accountStatus: 1 };
  }
  async createCampaign(spec: CampaignSpec) {
    if (spec.name.includes("[mock:fail]")) throw new ProviderError("transient", "meta_ads", "Mock transient failure");
    return { id: `mock_campaign_${randomUUID()}` };
  }
  async createAdSet() {
    return { id: `mock_adset_${randomUUID()}` };
  }
  async createCreative() {
    return { id: `mock_creative_${randomUUID()}` };
  }
  async createAd() {
    return { id: `mock_ad_${randomUUID()}` };
  }
  async setStatus() {}
  async getObject(objectId: string) {
    return { id: objectId, status: "PAUSED", effective_status: "PAUSED" };
  }
  async findCampaignByName() {
    return null;
  }
  async getInsights() {
    return null;
  }
}

export function facebookAuthorizeUrl(state: string, redirectUri: string) {
  const u = new URL(`https://www.facebook.com/${env().META_GRAPH_VERSION}/dialog/oauth`);
  u.searchParams.set("client_id", env().META_APP_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("scope", ADS_SCOPES.join(","));
  u.searchParams.set("response_type", "code");
  return u.toString();
}

export async function exchangeFacebookCode(code: string, redirectUri: string, fetchImpl: typeof fetch = fetch) {
  const e = env();
  const u = new URL(`https://graph.facebook.com/${e.META_GRAPH_VERSION}/oauth/access_token`);
  u.searchParams.set("client_id", e.META_APP_ID ?? "");
  u.searchParams.set("client_secret", e.META_APP_SECRET ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code", code);
  const res = await fetchImpl(u, { signal: AbortSignal.timeout(20_000) });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !json.access_token) throw new ProviderError("auth", "meta_ads", `Code exchange failed (${res.status})`);
  const ll = new URL(`https://graph.facebook.com/${e.META_GRAPH_VERSION}/oauth/access_token`);
  ll.searchParams.set("grant_type", "fb_exchange_token");
  ll.searchParams.set("client_id", e.META_APP_ID ?? "");
  ll.searchParams.set("client_secret", e.META_APP_SECRET ?? "");
  ll.searchParams.set("fb_exchange_token", json.access_token);
  const llRes = await fetchImpl(ll, { signal: AbortSignal.timeout(20_000) });
  const llJson = (await llRes.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  const token = llJson.access_token ?? json.access_token;
  const perms = await graphCall<{ data: Array<{ permission: string; status: string }> }>(
    { method: "GET", url: `https://graph.facebook.com/${e.META_GRAPH_VERSION}/me/permissions`, token, fetchImpl },
    "meta_ads",
  );
  const accounts = await graphCall<{ data: Array<{ id: string; name: string; currency: string; account_status: number }> }>(
    { method: "GET", url: `https://graph.facebook.com/${e.META_GRAPH_VERSION}/me/adaccounts`, token, params: { fields: "id,name,currency,account_status", limit: 50 }, fetchImpl },
    "meta_ads",
  );
  return {
    accessToken: token,
    expiresAt: new Date(Date.now() + (llJson.expires_in ?? json.expires_in ?? 3600) * 1000),
    scopes: (perms.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission),
    adAccounts: accounts.data ?? [],
  };
}
