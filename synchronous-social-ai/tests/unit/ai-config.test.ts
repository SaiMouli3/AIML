import { describe, expect, it } from "vitest";
import { assertSafeGatewayUrl, parseGatewayModels } from "@/server/services/ai-config";
import { OpenAICompatibleProvider } from "@/server/providers/llm/llm";

const resolveTo =
  (...ips: string[]) =>
  async () =>
    ips;

describe("gateway URL safety", () => {
  it("accepts public https endpoints and strips the trailing slash", async () => {
    await expect(
      assertSafeGatewayUrl("https://api.experientiallabs.ai/v1/", resolveTo("104.18.1.1")),
    ).resolves.toBe("https://api.experientiallabs.ai/v1");
  });

  it("rejects http, credentials and private, loopback, link-local and metadata addresses", async () => {
    await expect(assertSafeGatewayUrl("http://gw.example.com/v1", resolveTo("104.18.1.1"))).rejects.toThrow(
      /https/,
    );
    await expect(assertSafeGatewayUrl("https://u:p@gw.example.com", resolveTo("104.18.1.1"))).rejects.toThrow(
      /credentials/,
    );
    for (const ip of [
      "10.0.0.5",
      "172.20.1.1",
      "192.168.1.10",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
    ])
      await expect(assertSafeGatewayUrl("https://internal.example.com/v1", resolveTo(ip))).rejects.toThrow(
        /private/,
      );
    // A hostname that resolves to any private address is rejected, even if another address is public.
    await expect(
      assertSafeGatewayUrl("https://mixed.example.com", resolveTo("104.18.1.1", "10.1.2.3")),
    ).rejects.toThrow(/private/);
    await expect(assertSafeGatewayUrl("https://nowhere.example.com", async () => [])).rejects.toThrow(
      /resolve/,
    );
  });

  it("allows http://localhost outside staging/production for local gateways", async () => {
    await expect(assertSafeGatewayUrl("http://localhost:11434/v1", resolveTo())).resolves.toBe(
      "http://localhost:11434/v1",
    );
  });
});

describe("gateway model listing", () => {
  it("reads Experiential Labs nano-USD pricing and capability flags", () => {
    const models = parseGatewayModels({
      data: [
        {
          id: "claude-sonnet-5.5",
          supports_structured_output: true,
          emits_images: false,
          context_window_tokens: 200000,
          pricing: {
            input_nano_usd_per_million_tokens: 2_000_000_000,
            output_nano_usd_per_million_tokens: 10_000_000_000,
          },
        },
        {
          id: "gemini-2.5-flash-image",
          emits_images: true,
          input_cost_per_million_tokens_usd: 0.3,
          output_cost_per_million_tokens_usd: 30,
        },
        { id: "no-price" },
        { nope: true },
      ],
    });
    expect(models).toEqual([
      {
        id: "claude-sonnet-5.5",
        structuredOutput: true,
        emitsImages: false,
        contextTokens: 200000,
        price: { input: 2, output: 10 },
      },
      {
        id: "gemini-2.5-flash-image",
        structuredOutput: true,
        emitsImages: true,
        contextTokens: null,
        price: { input: 0.3, output: 30 },
      },
      { id: "no-price", structuredOutput: true, emitsImages: false, contextTokens: null, price: null },
    ]);
  });
});

describe("workspace prices", () => {
  it("are used for cost when the gateway does not report one", async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({
          model: "my-model",
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 },
        }),
        {
          status: 200,
        },
      )) as unknown as typeof fetch;
    const p = new OpenAICompatibleProvider("gw", "https://gw", "k", f, {
      "my-model": { input: 1.5, output: 6 },
    });
    const r = await p.complete({
      model: "my-model",
      messages: [{ role: "user", content: "x" }],
      schemaName: "t",
      jsonSchema: { type: "object" },
      maxTokens: 10,
    });
    expect(r.costUsd).toBeCloseTo(1.5 + 3);
    expect(r.costEstimated).toBe(true);
  });
});
