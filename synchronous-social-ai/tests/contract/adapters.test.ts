import { describe, expect, it } from "vitest";
import { LiveInstagramAdapter } from "@/server/providers/meta/instagram";
import { LiveMetaAdsAdapter } from "@/server/providers/meta/marketing";
import { HiggsfieldProvider, HIGGSFIELD_MODELS } from "@/server/providers/higgsfield/higgsfield";
import { OpenAICompatibleProvider, toStrictSchema } from "@/server/providers/llm/llm";
import { ProviderError } from "@/server/providers/errors";
import { resetEnvCache } from "@/server/env";

/** Fake fetch that records calls and replays sanitized fixtures (shapes from official docs). */
function recorder(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
  }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body as string | undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error("unexpected call");
    if (r instanceof Error) throw r;
    return new Response(r.body === null ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { f, calls };
}

describe("Instagram adapter contract", () => {
  it("creates an image container then publishes, with bearer auth and form params", async () => {
    const { f, calls } = recorder([
      { body: { id: "17890000000000001" } },
      { body: { status_code: "FINISHED" } },
      { body: { id: "17900000000000002" } },
    ]);
    const ig = new LiveInstagramAdapter("1784000000000000", "IGQtest_token_value_1234567890", f);
    const c = await ig.createContainer({
      kind: "image",
      mediaUrl: "https://cdn.example.com/a.jpg",
      caption: "Hi",
      altText: "alt",
    });
    expect(await ig.getContainerStatus(c.id)).toBe("FINISHED");
    expect((await ig.publishContainer(c.id)).id).toBe("17900000000000002");
    expect(calls[0]!.url).toBe("https://graph.instagram.com/v26.0/1784000000000000/media");
    expect(calls[0]!.headers.Authorization).toBe("Bearer IGQtest_token_value_1234567890");
    expect(new URLSearchParams(calls[0]!.body).get("image_url")).toBe("https://cdn.example.com/a.jpg");
    expect(new URLSearchParams(calls[0]!.body).get("alt_text")).toBe("alt");
    expect(calls[1]!.url).toContain("fields=status_code");
    expect(calls[2]!.url).toBe("https://graph.instagram.com/v26.0/1784000000000000/media_publish");
    expect(new URLSearchParams(calls[2]!.body).get("creation_id")).toBe("17890000000000001");
  });

  it("sends private replies by comment_id as JSON", async () => {
    const { f, calls } = recorder([{ body: { recipient_id: "IGSID1", message_id: "mid.1" } }]);
    const ig = new LiveInstagramAdapter("1784", "tok", f);
    expect(await ig.sendPrivateReply("COMMENT_1", "Here you go")).toEqual({
      messageId: "mid.1",
      recipientId: "IGSID1",
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      recipient: { comment_id: "COMMENT_1" },
      message: { text: "Here you go" },
    });
  });

  it("maps errors: expired token → auth, network failure on publish → unknown outcome, 5xx on publish → unknown outcome", async () => {
    const expired = recorder([
      {
        status: 400,
        body: {
          error: {
            message: "Error validating access token",
            type: "OAuthException",
            code: 190,
            fbtrace_id: "x",
          },
        },
      },
    ]);
    await expect(new LiveInstagramAdapter("1", "t", expired.f).getAccount()).rejects.toMatchObject({
      kind: "auth",
    });
    const net = recorder([new Error("ECONNRESET")]);
    await expect(new LiveInstagramAdapter("1", "t", net.f).publishContainer("c")).rejects.toMatchObject({
      kind: "unknown_outcome",
    });
    const fivexx = recorder([
      {
        status: 500,
        body: { error: { code: 2, message: "Service temporarily unavailable", is_transient: true } },
      },
    ]);
    await expect(new LiveInstagramAdapter("1", "t", fivexx.f).publishContainer("c")).rejects.toMatchObject({
      kind: "unknown_outcome",
    });
    const readFail = recorder([{ status: 500, body: { error: { code: 2 } } }]);
    await expect(
      new LiveInstagramAdapter("1", "t", readFail.f).getContainerStatus("c"),
    ).rejects.toMatchObject({ kind: "transient" });
  });
});

describe("Meta Marketing adapter contract", () => {
  it("creates objects PAUSED and refuses activation in test mode", async () => {
    process.env.META_ADS_TEST_MODE = "true";
    resetEnvCache();
    const { f, calls } = recorder([{ body: { id: "120200000000001" } }, { body: { id: "120200000000002" } }]);
    const m = new LiveMetaAdsAdapter("act_123", "EAAtoken", f);
    await m.createCampaign({
      name: "Sale [ssa:abc]",
      objective: "OUTCOME_TRAFFIC",
      specialAdCategories: ["NONE"],
    });
    await m.createAdSet({
      name: "s",
      campaignId: "120200000000001",
      dailyBudgetMinor: 2000,
      optimizationGoal: "LINK_CLICKS",
      billingEvent: "IMPRESSIONS",
      targeting: { geo_locations: { countries: ["US"] } },
      startTime: "2026-11-01T00:00:00Z",
      endTime: "2026-11-04T00:00:00Z",
    });
    const c = new URLSearchParams(calls[0]!.body);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/act_123/campaigns");
    expect(c.get("status")).toBe("PAUSED");
    expect(c.get("special_ad_categories")).toBe("[]");
    const a = new URLSearchParams(calls[1]!.body);
    expect(a.get("status")).toBe("PAUSED");
    expect(a.get("daily_budget")).toBe("2000");
    expect(a.get("end_time")).toBe("2026-11-04T00:00:00Z");
    await expect(m.setStatus("120200000000001", "ACTIVE")).rejects.toMatchObject({ kind: "policy" });
  });
  it("parses insights without imputing missing values", async () => {
    const { f } = recorder([
      {
        body: {
          data: [
            {
              impressions: "1200",
              clicks: "30",
              spend: "15.20",
              date_start: "2026-11-01",
              date_stop: "2026-11-03",
            },
          ],
        },
      },
    ]);
    const ins = await new LiveMetaAdsAdapter("act_1", "t", f).getInsights("c", "2026-11-01", "2026-11-03");
    expect(ins).toEqual({
      dateStart: "2026-11-01",
      dateStop: "2026-11-03",
      impressions: 1200,
      reach: null,
      clicks: 30,
      spend: 15.2,
      conversions: null,
    });
  });
});

describe("Higgsfield adapter contract", () => {
  const model = HIGGSFIELD_MODELS[0]!;
  it("submits with Key auth and a stable Idempotency-Key, polls status and parses outputs", async () => {
    const { f, calls } = recorder([
      {
        body: {
          status: "queued",
          request_id: "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff",
          status_url: "x",
          cancel_url: "y",
        },
      },
      {
        body: {
          status: "completed",
          request_id: "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff",
          images: [{ url: "https://cdn.example.com/image-1.jpg" }],
        },
      },
    ]);
    const h = new HiggsfieldProvider("kid", "ksecret", f);
    const sub = await h.submit(
      model,
      "a candle",
      { aspect_ratio: "4:5" },
      "gen:ws:abc",
      "https://app.example.com/api/v1/webhooks/higgsfield?token=t&job=j",
    );
    expect(sub.requestId).toBe("d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff");
    expect(calls[0]!.headers.Authorization).toBe("Key kid:ksecret");
    expect(calls[0]!.headers["Idempotency-Key"]).toBe("gen:ws:abc");
    expect(calls[0]!.url).toContain("/higgsfield-ai/soul/v2/standard?hf_webhook=");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ prompt: "a candle", aspect_ratio: "4:5" });
    const st = await h.status(sub.requestId);
    expect(st).toEqual({
      status: "completed",
      error: null,
      outputs: [{ url: "https://cdn.example.com/image-1.jpg", kind: "image" }],
    });
  });
  it("maps documented error codes and cancellation semantics", async () => {
    const cases: Array<[number, string]> = [
      [401, "auth"],
      [403, "permission"],
      [422, "invalid"],
      [423, "rate_limit"],
      [503, "rate_limit"],
    ];
    for (const [status, kind] of cases) {
      const { f } = recorder([{ status, body: { detail: "x" } }]);
      await expect(new HiggsfieldProvider("a", "b", f).submit(model, "p", {}, "k")).rejects.toMatchObject({
        kind,
      });
    }
    const five = recorder([{ status: 500, body: { detail: "boom" } }]);
    await expect(new HiggsfieldProvider("a", "b", five.f).submit(model, "p", {}, "k")).rejects.toMatchObject({
      kind: "unknown_outcome",
    });
    const started = recorder([{ status: 400, body: { detail: "Request already started" } }]);
    expect(await new HiggsfieldProvider("a", "b", started.f).cancel("r")).toMatchObject({ canceled: false });
    const ok = recorder([{ status: 202, body: null }]);
    expect(await new HiggsfieldProvider("a", "b", ok.f).cancel("r")).toEqual({ canceled: true });
  });
});

describe("LLM gateway contract", () => {
  it("sends strict json_schema structured output and reads usage cost", async () => {
    const { f, calls } = recorder([
      {
        body: {
          model: "claude-haiku-5.5",
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.0001 },
        },
      },
    ]);
    const p = new OpenAICompatibleProvider("gw", "https://api.experientiallabs.ai/v1", "xpl_test", f);
    const r = await p.complete({
      model: "claude-haiku-5.5",
      messages: [{ role: "user", content: "x" }],
      schemaName: "s",
      jsonSchema: { type: "object", properties: { ok: { type: "boolean", default: true } } },
      maxTokens: 50,
    });
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.response_format.json_schema.strict).toBe(true);
    expect(sent.response_format.json_schema.schema).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    });
    expect(r).toMatchObject({
      content: '{"ok":true}',
      tokensIn: 10,
      tokensOut: 3,
      costUsd: 0.0001,
      costEstimated: false,
    });
  });
  it("maps refusals and HTTP errors", async () => {
    const refusal = recorder([{ body: { choices: [{ message: { content: null, refusal: "no" } }] } }]);
    await expect(
      new OpenAICompatibleProvider("gw", "https://x.example", "k", refusal.f).complete({
        model: "m",
        messages: [],
        schemaName: "s",
        jsonSchema: {},
        maxTokens: 1,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    const unauth = recorder([{ status: 401, body: { error: { message: "bad key" } } }]);
    await expect(
      new OpenAICompatibleProvider("gw", "https://x.example", "k", unauth.f).complete({
        model: "m",
        messages: [],
        schemaName: "s",
        jsonSchema: {},
        maxTokens: 1,
      }),
    ).rejects.toMatchObject({ kind: "auth" });
  });
  it("strict schema conversion closes nested objects and strips constraints", () => {
    expect(
      toStrictSchema({
        type: "object",
        properties: {
          a: {
            type: "array",
            minItems: 1,
            items: { type: "object", properties: { b: { type: "string", maxLength: 3 } } },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        a: {
          type: "array",
          items: {
            type: "object",
            properties: { b: { type: "string" } },
            required: ["b"],
            additionalProperties: false,
          },
        },
      },
      required: ["a"],
      additionalProperties: false,
    });
  });
});

describe("missing credentials produce a disconnected state, not fake success", () => {
  it("OAuth start fails clearly without Meta app credentials; providers report not configured", async () => {
    const { as, makeTenant } = await import("../helpers");
    const { startOAuth } = await import("@/server/services/integrations");
    const { liveLlmProvider } = await import("@/server/providers/llm/llm");
    const t = await makeTenant();
    const prev = process.env.META_APP_ID;
    process.env.META_APP_ID = "";
    resetEnvCache();
    try {
      await expect(as(t, (ctx) => startOAuth(ctx, "instagram"))).rejects.toMatchObject({
        code: "INTEGRATION_NOT_CONNECTED",
      });
      expect(liveLlmProvider()).toBeNull();
    } finally {
      process.env.META_APP_ID = prev;
      resetEnvCache();
    }
  });
});
