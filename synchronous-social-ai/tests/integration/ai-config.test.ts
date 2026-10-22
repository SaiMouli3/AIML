import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { as, drain, makeTenant } from "../helpers";
import { withTenant } from "@/server/db/tenant";
import * as s from "@/server/db/schema";
import { listAudit } from "@/server/audit/audit";
import { getAiSettings, resolveAiConfig, updateAiSettings } from "@/server/services/ai-config";
import { getRun, startAgentRun } from "@/server/agents/orchestrator";
import { workspaceMediaProvider } from "@/server/services/media";

afterEach(() => vi.unstubAllGlobals());

const KEY = "sk-test-workspace-key-1234ABCD";

describe("owner-managed AI settings", () => {
  it("only the owner can read or change them; admins are refused", async () => {
    const t = await makeTenant();
    await expect(as(t, (ctx) => getAiSettings(ctx), { role: "admin" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      as(t, (ctx) => updateAiSettings(ctx, { defaultModel: "gpt-5.5" }), { role: "admin" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as(t, (ctx) => getAiSettings(ctx))).resolves.toBeTruthy();
  });

  it("keys are encrypted, shown only as last 4, never written to the audit log, and removable", async () => {
    const t = await makeTenant();
    const r = await as(t, (ctx) =>
      updateAiSettings(ctx, { defaultModel: "gpt-5.5", secrets: { llm_api_key: KEY } }),
    );
    expect(r.secrets.llm_api_key).toMatchObject({ saved: true, hint: "ABCD" });
    expect(JSON.stringify(r)).not.toContain(KEY);
    const rows = await withTenant(t.workspaceId, (tx) => tx.select().from(s.workspaceSecrets));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.encryptedValue).not.toContain(KEY);
    const log = await as(t, (ctx) => listAudit(ctx, { action: "ai.settings_updated" }));
    expect(log.items).toHaveLength(1);
    expect(JSON.stringify(log.items[0])).not.toContain(KEY);
    expect(log.items[0]!.metadata).toMatchObject({ keysChanged: ["AI gateway key: set"] });

    let eff = await as(t, (ctx) => resolveAiConfig(ctx));
    expect(eff.llm).toMatchObject({ apiKey: KEY, keySource: "workspace" });
    expect(eff.models.default).toBe("gpt-5.5");

    await as(t, (ctx) => updateAiSettings(ctx, { defaultModel: "", secrets: { llm_api_key: null } }));
    eff = await as(t, (ctx) => resolveAiConfig(ctx));
    // Test env has no server key, so the workspace now has none; the model falls back to the server default.
    expect(eff.llm.keySource).toBe("none");
    expect(eff.models.default).toBe("claude-sonnet-5.5");
  });

  it("another workspace never sees these keys", async () => {
    const a = await makeTenant("A");
    const b = await makeTenant("B");
    await as(a, (ctx) => updateAiSettings(ctx, { secrets: { llm_api_key: KEY } }));
    const effB = await as(b, (ctx) => resolveAiConfig(ctx));
    expect(effB.llm.apiKey).not.toBe(KEY);
    const rowsB = await withTenant(b.workspaceId, (tx) => tx.select().from(s.workspaceSecrets));
    expect(rowsB).toHaveLength(0);
  });

  it("agent runs use the workspace's gateway URL, key and model", async () => {
    const t = await makeTenant();
    await as(t, (ctx) =>
      updateAiSettings(ctx, {
        llmBaseUrl: "http://localhost:9/v1",
        defaultModel: "gpt-5.5",
        prices: { "gpt-5.5": { input: 1, output: 2 } },
        secrets: { llm_api_key: KEY },
      }),
    );
    const calls: Array<{ url: string; auth: string; model: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          auth: (init.headers as Record<string, string>).Authorization ?? "",
          model: JSON.parse(String(init.body)).model,
        });
        return new Response(
          JSON.stringify({
            model: "gpt-5.5",
            choices: [{ message: { content: "not json" } }],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          }),
          { status: 200 },
        );
      }),
    );
    const run = await as(t, (ctx) =>
      startAgentRun(ctx, "content_copywriter", { brief: "Launch our candle", format: "post" }),
    );
    await drain();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toEqual({
      url: "http://localhost:9/v1/chat/completions",
      auth: `Bearer ${KEY}`,
      model: "gpt-5.5",
    });
    const after = await as(t, (ctx) => getRun(ctx, run.id));
    expect(after.provider).toBe("localhost");
    expect(after.model).toBe("gpt-5.5");
  });

  it("image provider follows the owner's choice", async () => {
    const t = await makeTenant();
    await as(t, (ctx) =>
      updateAiSettings(ctx, {
        imageProvider: "gateway",
        imageModel: "gemini-3.1-flash-image",
        imagePriceUsd: 0.02,
        secrets: { llm_api_key: KEY },
      }),
    );
    const p = await as(t, (ctx) => workspaceMediaProvider(ctx));
    expect(p?.name).toBe("nano-banana");
    expect(p!.models()[0]!.label).toContain("gemini-3.1-flash-image");
    await expect(p!.estimate(p!.models()[0]!, "x", {})).resolves.toMatchObject({ usd: 0.02 });
    await as(t, (ctx) => updateAiSettings(ctx, { imageProvider: "off" }));
    expect(await as(t, (ctx) => workspaceMediaProvider(ctx))).toBeNull();
    const ws = await withTenant(t.workspaceId, (tx) =>
      tx.select().from(s.workspaces).where(eq(s.workspaces.id, t.workspaceId)),
    );
    expect(ws[0]!.settings.ai).toMatchObject({ imageProvider: "off", imageModel: "gemini-3.1-flash-image" });
  });

  it("rejects a gateway URL on a private network", async () => {
    const t = await makeTenant();
    await expect(
      as(t, (ctx) => updateAiSettings(ctx, { llmBaseUrl: "https://10.0.0.8/v1" })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
