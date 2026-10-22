/**
 * Social channel catalog shared by server and client. Pure data + validation: no secrets, no I/O.
 * Limits follow each platform's current publishing docs (see docs/integrations.md).
 */

export const SOCIAL_CHANNELS = ["instagram", "facebook", "threads", "x", "tiktok"] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

export const CONTENT_FORMATS = ["post", "carousel", "reel", "story"] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export interface ChannelMeta {
  label: string;
  /** Brand color for the small channel mark. */
  color: string;
  /** Short glyph used inside the channel mark (no third-party logo assets are bundled). */
  glyph: string;
  textLimit: number;
  formats: ContentFormat[];
  /** Per-format label override ("reel" is a "Video" outside Instagram). */
  formatLabels?: Partial<Record<ContentFormat, string>>;
  /** Comments and DMs flow into the Inbox (comment-to-DM assistant). */
  inbox: boolean;
  handlePrefix: string;
  /** Requires media; text-only posts are not possible. */
  mediaRequired: boolean;
  /** One-line description shown on the connector card. */
  blurb: string;
}

export const CHANNEL_META: Record<SocialChannel, ChannelMeta> = {
  instagram: {
    label: "Instagram",
    color: "#d62976",
    glyph: "IG",
    textLimit: 2200,
    formats: ["post", "carousel", "reel", "story"],
    inbox: true,
    handlePrefix: "@",
    mediaRequired: true,
    blurb: "Posts, carousels, Reels and Stories. Comments and DMs in the Inbox.",
  },
  facebook: {
    label: "Facebook",
    color: "#1877f2",
    glyph: "f",
    textLimit: 63206,
    formats: ["post", "carousel", "reel"],
    formatLabels: { carousel: "Multi-photo", reel: "Video" },
    inbox: true,
    handlePrefix: "",
    mediaRequired: false,
    blurb: "Page posts, photos and videos. Page comments and Messenger in the Inbox.",
  },
  threads: {
    label: "Threads",
    color: "#101010",
    glyph: "@",
    textLimit: 500,
    formats: ["post", "carousel", "reel"],
    formatLabels: { reel: "Video" },
    inbox: false,
    handlePrefix: "@",
    mediaRequired: false,
    blurb: "Text, image, video and carousel threads.",
  },
  x: {
    label: "X",
    color: "#0f1419",
    glyph: "X",
    textLimit: 280,
    formats: ["post", "carousel", "reel"],
    formatLabels: { carousel: "Multi-image", reel: "Video" },
    inbox: false,
    handlePrefix: "@",
    mediaRequired: false,
    blurb: "Posts with up to 4 images or one video.",
  },
  tiktok: {
    label: "TikTok",
    color: "#010101",
    glyph: "♪",
    textLimit: 2200,
    formats: ["reel", "carousel"],
    formatLabels: { reel: "Video", carousel: "Photo post" },
    inbox: false,
    handlePrefix: "@",
    mediaRequired: true,
    blurb: "Direct-post videos and photo posts with the creator's privacy setting.",
  },
};

export function isSocialChannel(p: string | null | undefined): p is SocialChannel {
  return !!p && (SOCIAL_CHANNELS as readonly string[]).includes(p);
}

export function channelLabel(p: string | null | undefined) {
  if (isSocialChannel(p)) return CHANNEL_META[p].label;
  if (p === "meta_ads") return "Meta ad account";
  return p ?? "Unknown";
}

export function formatLabel(channel: string | null | undefined, format: string) {
  const meta = isSocialChannel(channel) ? CHANNEL_META[channel] : null;
  const o = meta?.formatLabels?.[format as ContentFormat];
  if (o) return o;
  return format === "reel"
    ? "Reel"
    : format === "story"
      ? "Story"
      : format === "carousel"
        ? "Carousel"
        : "Post";
}

/** X counts every URL as 23 characters; everything else is counted as code points here (close enough for a pre-check). */
export function textLength(channel: SocialChannel, text: string) {
  if (channel === "x") return [...text.replace(/https?:\/\/\S+/g, "x".repeat(23))].length;
  return [...text].length;
}

export interface MediaShape {
  kind: string; // image | video
  mimeType?: string;
}

/** Platform rules for a draft. Returns human-readable problems; empty means publishable. */
export function validateForChannel(
  channel: SocialChannel,
  format: string,
  media: MediaShape[],
  text: string,
): string[] {
  const m = CHANNEL_META[channel];
  const p: string[] = [];
  const imgs = media.filter((x) => x.kind === "image");
  const vids = media.filter((x) => x.kind === "video");
  const fl = formatLabel(channel, format);
  if (!m.formats.includes(format as ContentFormat)) {
    p.push(`${m.label} does not support ${fl.toLowerCase()} content.`);
    return p;
  }
  const len = textLength(channel, text);
  if (len > m.textLimit) p.push(`${m.label} allows ${m.textLimit} characters; this has ${len}.`);
  switch (channel) {
    case "instagram":
      if ((format === "post" || format === "story") && media.length !== 1)
        p.push(`${format === "post" ? "Feed posts" : "Stories"} need exactly one media asset.`);
      if (format === "carousel" && (media.length < 2 || media.length > 20))
        p.push("Carousels need 2–20 media assets.");
      if (format === "reel" && (media.length !== 1 || vids.length !== 1))
        p.push("Reels need exactly one video.");
      break;
    case "facebook":
      if (format === "post" && media.length > 1) p.push("Use Multi-photo for more than one image.");
      if (format === "post" && media.length === 0 && !text.trim()) p.push("Add text or one image.");
      if (format === "carousel" && (imgs.length < 2 || imgs.length > 10 || vids.length))
        p.push("Multi-photo posts need 2–10 images.");
      if (format === "reel" && (media.length !== 1 || vids.length !== 1))
        p.push("Video posts need exactly one video.");
      break;
    case "threads":
      if (format === "post" && media.length > 1) p.push("Use Carousel for more than one image or video.");
      if (format === "post" && media.length === 0 && !text.trim()) p.push("Text-only threads need text.");
      if (format === "carousel" && (media.length < 2 || media.length > 20))
        p.push("Threads carousels need 2–20 images or videos.");
      if (format === "reel" && (media.length !== 1 || vids.length !== 1))
        p.push("Video threads need exactly one video.");
      break;
    case "x":
      if (format === "post" && media.length > 1) p.push("Use Multi-image for more than one image.");
      if (format === "post" && media.length === 0 && !text.trim()) p.push("Add text or an image.");
      if (format === "post" && vids.length) p.push("Use Video for a video post.");
      if (format === "carousel" && (imgs.length < 2 || imgs.length > 4 || vids.length))
        p.push("X allows 2–4 images per post.");
      if (format === "reel" && (media.length !== 1 || vids.length !== 1))
        p.push("Video posts need exactly one video.");
      break;
    case "tiktok":
      if (format === "reel" && (media.length !== 1 || vids.length !== 1))
        p.push("TikTok videos need exactly one video.");
      if (format === "carousel" && (imgs.length < 1 || imgs.length > 35 || vids.length))
        p.push("TikTok photo posts need 1–35 images.");
      if (imgs.some((x) => x.mimeType && !["image/jpeg", "image/webp"].includes(x.mimeType)))
        p.push("TikTok photo posts accept JPEG or WebP images.");
      break;
  }
  return p;
}

export const TIKTOK_PRIVACY_LEVELS = [
  "SELF_ONLY",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "PUBLIC_TO_EVERYONE",
] as const;
export type TikTokPrivacy = (typeof TIKTOK_PRIVACY_LEVELS)[number];
export const TIKTOK_PRIVACY_LABELS: Record<TikTokPrivacy, string> = {
  SELF_ONLY: "Only me",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  PUBLIC_TO_EVERYONE: "Everyone",
};
