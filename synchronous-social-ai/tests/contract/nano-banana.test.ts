import { afterEach, describe, expect, it, vi } from "vitest";
import { NanoBananaProvider, NANO_BANANA_MODEL } from "@/server/providers/higgsfield/nano-banana";

afterEach(() => vi.unstubAllGlobals());

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function gateway(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

describe("Nano Banana provider", () => {
  it("output survives a new provider instance (the media job reschedules between submit and status)", async () => {
    const calls = gateway({
      choices: [
        { message: { images: [{ image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }] } },
      ],
    });
    const sub = await new NanoBananaProvider("https://gw.example.com/v1", "key").submit(
      NANO_BANANA_MODEL,
      "A candle",
      { aspect_ratio: "4:5" },
    );
    expect(calls[0]!.url).toBe("https://gw.example.com/v1/chat/completions");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      model: "gemini-2.5-flash-image",
      modalities: ["image", "text"],
    });
    // Next job attempt: mediaProvider() builds a fresh instance.
    const later = new NanoBananaProvider("https://gw.example.com/v1", "key");
    const st = await later.status(sub.requestId);
    expect(st.status).toBe("completed");
    const file = await later.download(st.outputs[0]!.url);
    expect(file).toEqual({ data: png, contentType: "image/png" });
    // Released after download.
    await expect(later.download(st.outputs[0]!.url)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("maps a missing image to a policy error and HTTP errors to provider kinds", async () => {
    gateway({ choices: [{ message: { content: "I can't help with that." } }] });
    await expect(
      new NanoBananaProvider("https://gw", "k").submit(NANO_BANANA_MODEL, "x", {}),
    ).rejects.toMatchObject({
      kind: "policy",
    });
    gateway({ error: "nope" }, 401);
    await expect(
      new NanoBananaProvider("https://gw", "k").submit(NANO_BANANA_MODEL, "x", {}),
    ).rejects.toMatchObject({
      kind: "auth",
    });
  });
});
