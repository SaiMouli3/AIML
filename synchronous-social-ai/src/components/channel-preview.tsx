import { ImageIcon, Video } from "lucide-react";
import { CHANNEL_META, formatLabel, textLength, type SocialChannel } from "@/lib/channels";
import { cn } from "@/lib/cn";
import { ChannelMark } from "./channel-mark";
import { IgPreview } from "./ig-preview";

type Media = { url: string; kind: string; origin?: string };

/**
 * Per-channel post preview. Instagram keeps its dedicated mock-up; other channels get a neutral
 * feed card. Always labelled as an approximation.
 */
export function ChannelPreview({
  channel,
  name,
  username,
  format,
  caption,
  hashtags,
  media,
}: {
  channel: SocialChannel | null;
  name: string;
  username: string | null;
  format: string;
  caption: string;
  hashtags: string[];
  media: Media[];
}) {
  if (!channel || channel === "instagram")
    return (
      <IgPreview
        username={username ?? "your_account"}
        format={format}
        caption={caption}
        hashtags={hashtags}
        media={media}
      />
    );
  const meta = CHANNEL_META[channel];
  const tags = hashtags.map((h) => `#${h}`).join(" ");
  // Same joining as the publisher (caption, blank line, hashtags) so the count matches what is posted.
  const text = [caption, tags].filter(Boolean).join("\n\n");
  const len = textLength(channel, text);
  const over = len > meta.textLimit;
  const vertical = channel === "tiktok" || (format === "reel" && channel !== "facebook");
  const grid = media.slice(0, 4);
  return (
    <div className="mx-auto w-full max-w-[340px]">
      <div className="border-border overflow-hidden rounded-[18px] border bg-white text-[13px] text-[#0f1115] shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2">
          <ChannelMark provider={channel} size="md" className="rounded-full" />
          <div className="min-w-0 leading-tight">
            <div className="truncate font-semibold">{name}</div>
            <div className="truncate text-[11.5px] text-neutral-500">
              {username ? `${meta.handlePrefix}${username}` : meta.label} · {formatLabel(channel, format)}
            </div>
          </div>
        </div>
        {text ? (
          <p className="px-3.5 pb-2.5 break-words whitespace-pre-line">
            {over ? (
              <>
                {[...text].slice(0, meta.textLimit).join("")}
                <mark className="bg-red-100 text-red-700">{[...text].slice(meta.textLimit).join("")}</mark>
              </>
            ) : (
              text
            )}
          </p>
        ) : (
          <p className="px-3.5 pb-2.5 text-neutral-400">Write something…</p>
        )}
        {grid.length ? (
          <div
            className={cn(
              "grid gap-0.5 bg-neutral-100",
              grid.length > 1 ? "grid-cols-2" : "grid-cols-1",
              vertical && grid.length === 1 ? "mx-auto aspect-[9/16] max-h-[380px]" : "",
            )}
          >
            {grid.map((m, i) => (
              <div
                key={`${m.url}-${i}`}
                className={cn(
                  "relative bg-neutral-200",
                  grid.length === 1 ? (vertical ? "h-full" : "aspect-[4/3]") : "aspect-square",
                )}
              >
                {m.kind === "video" ? (
                  <video src={m.url} className="h-full w-full object-cover" controls muted playsInline />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.url} alt="" className="h-full w-full object-cover" />
                )}
                {i === 3 && media.length > 4 ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-lg font-semibold text-white">
                    +{media.length - 4}
                  </span>
                ) : null}
                {m.origin === "mock_generated" ? (
                  <span className="absolute bottom-1.5 left-1.5 rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    MOCK ASSET
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : meta.mediaRequired || format !== "post" ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 bg-neutral-100 text-neutral-400">
            {format === "reel" ? <Video className="h-7 w-7" /> : <ImageIcon className="h-7 w-7" />}
            <span className="text-[12px]">No media attached</span>
          </div>
        ) : null}
        <div className="flex items-center justify-between border-t border-neutral-100 px-3.5 py-2 text-[11.5px] text-neutral-500">
          <span>{meta.label}</span>
          <span className={cn("tabular-nums", over && "font-semibold text-red-600")}>
            {len.toLocaleString()}/{meta.textLimit.toLocaleString()}
          </span>
        </div>
      </div>
      <p className="text-fg-subtle mt-2 text-center text-[11.5px]">
        Approximate preview — {meta.label} controls final rendering.
      </p>
    </div>
  );
}
