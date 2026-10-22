import { describe, expect, it } from "vitest";
import { CHANNEL_META, SOCIAL_CHANNELS, formatLabel, textLength, validateForChannel } from "@/lib/channels";
import { normalizeMetaWebhook } from "@/server/services/inbox";

const img = { kind: "image", mimeType: "image/jpeg" };
const png = { kind: "image", mimeType: "image/png" };
const vid = { kind: "video", mimeType: "video/mp4" };

describe("channel rules", () => {
  it("every channel declares limits, formats and a label", () => {
    for (const c of SOCIAL_CHANNELS) {
      expect(CHANNEL_META[c].label).toBeTruthy();
      expect(CHANNEL_META[c].textLimit).toBeGreaterThan(0);
      expect(CHANNEL_META[c].formats.length).toBeGreaterThan(0);
    }
  });

  it("X counts URLs as 23 characters and enforces 280", () => {
    expect(textLength("x", `hi https://example.com/${"a".repeat(200)}`)).toBe(3 + 23);
    expect(validateForChannel("x", "post", [], "a".repeat(281))).toEqual([
      "X allows 280 characters; this has 281.",
    ]);
    expect(validateForChannel("x", "post", [], "a".repeat(280))).toEqual([]);
  });

  it("X allows text-only posts and 2–4 images in a multi-image post", () => {
    expect(validateForChannel("x", "post", [], "hello")).toEqual([]);
    expect(validateForChannel("x", "carousel", [img, img, img, img, img], "x")).toContain(
      "X allows 2–4 images per post.",
    );
    expect(validateForChannel("x", "reel", [vid], "x")).toEqual([]);
  });

  it("Threads enforces 500 characters and 2–20 carousel items", () => {
    expect(validateForChannel("threads", "post", [], "a".repeat(501))[0]).toMatch(/500/);
    expect(validateForChannel("threads", "carousel", [img], "x")).toContain(
      "Threads carousels need 2–20 images or videos.",
    );
    expect(validateForChannel("threads", "carousel", [img, vid], "x")).toEqual([]);
  });

  it("TikTok needs media: one video, or 1–35 JPEG/WebP photos; no text-only or stories", () => {
    expect(validateForChannel("tiktok", "post", [], "x")[0]).toMatch(/does not support post/);
    expect(validateForChannel("tiktok", "reel", [img], "x")).toContain(
      "TikTok videos need exactly one video.",
    );
    expect(validateForChannel("tiktok", "carousel", [png], "x")).toContain(
      "TikTok photo posts accept JPEG or WebP images.",
    );
    expect(validateForChannel("tiktok", "reel", [vid], "x")).toEqual([]);
  });

  it("Facebook allows text-only and multi-photo (2–10 images) posts, but not stories", () => {
    expect(validateForChannel("facebook", "post", [], "hello")).toEqual([]);
    expect(validateForChannel("facebook", "carousel", [img, vid], "x")).toContain(
      "Multi-photo posts need 2–10 images.",
    );
    expect(validateForChannel("facebook", "story", [img], "x")[0]).toMatch(/does not support story/);
  });

  it("Instagram keeps its media rules", () => {
    expect(validateForChannel("instagram", "post", [], "x")).toContain(
      "Feed posts need exactly one media asset.",
    );
    expect(validateForChannel("instagram", "reel", [img], "x")).toContain("Reels need exactly one video.");
  });

  it("format labels follow each platform's vocabulary", () => {
    expect(formatLabel("instagram", "reel")).toBe("Reel");
    expect(formatLabel("x", "reel")).toBe("Video");
    expect(formatLabel("tiktok", "carousel")).toBe("Photo post");
    expect(formatLabel("facebook", "carousel")).toBe("Multi-photo");
  });
});

describe("Facebook Page webhook normalization", () => {
  it("maps feed comment additions to comment events and ignores edits, reactions and posts", () => {
    const { events, ignored } = normalizeMetaWebhook({
      object: "page",
      entry: [
        {
          id: "PAGE1",
          time: 1_700_000_000,
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "PAGE1_c1",
                post_id: "PAGE1_p1",
                parent_id: "PAGE1_p1",
                message: "Link please",
                from: { id: "u1", name: "Jo Doe" },
                created_time: 1_700_000_100,
              },
            },
            {
              field: "feed",
              value: { item: "comment", verb: "edited", comment_id: "c2", message: "x", from: { id: "u1" } },
            },
            { field: "feed", value: { item: "reaction", verb: "add", from: { id: "u1" } } },
          ],
        },
      ],
    });
    expect(ignored).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      platform: "facebook",
      kind: "comment",
      eventKey: "comment:PAGE1_c1",
      accountExternalId: "PAGE1",
      mediaId: "PAGE1_p1",
      fromUsername: "Jo Doe",
      text: "Link please",
      isEcho: false,
      parentCommentId: undefined, // top-level comment: parent is the post
    });
  });

  it("maps Messenger messages to DM events and flags the Page's own comments as echoes", () => {
    const { events } = normalizeMetaWebhook({
      object: "page",
      entry: [
        {
          id: "PAGE1",
          time: 1_700_000_000_000,
          messaging: [
            {
              sender: { id: "psid1" },
              recipient: { id: "PAGE1" },
              timestamp: 1_700_000_000_000,
              message: { mid: "m1", text: "Hi" },
            },
          ],
          changes: [
            {
              field: "feed",
              value: {
                item: "comment",
                verb: "add",
                comment_id: "c9",
                post_id: "p",
                message: "Thanks!",
                from: { id: "PAGE1" },
              },
            },
          ],
        },
      ],
    });
    const dm = events.find((e) => e.kind === "dm")!;
    expect(dm).toMatchObject({ platform: "facebook", fromId: "psid1", text: "Hi", isEcho: false });
    expect(events.find((e) => e.kind === "comment")!.isEcho).toBe(true);
  });

  it("Instagram payloads are still tagged as Instagram", () => {
    const { events } = normalizeMetaWebhook({
      object: "instagram",
      entry: [{ id: "IG1", field: "comments", value: { id: "c1", text: "hi", from: { id: "u" } } }],
    });
    expect(events[0]).toMatchObject({ platform: "instagram", accountExternalId: "IG1" });
  });
});
