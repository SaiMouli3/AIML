import { Bookmark, Heart, ImageIcon, MessageCircle, Send, Video } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Instagram-like preview. Explicitly labelled as an approximation: final rendering is controlled by
 * Instagram (cropping, truncation, fonts).
 */
export function IgPreview({
  username,
  format,
  caption,
  hashtags,
  media,
  className,
}: {
  username: string;
  format: string;
  caption: string;
  hashtags: string[];
  media: Array<{ url: string; kind: string; origin?: string }>;
  className?: string;
}) {
  const first = media[0];
  const tall = format === "reel" || format === "story";
  const tags = hashtags.map((h) => `#${h}`).join(" ");
  return (
    <div className={cn("mx-auto w-full max-w-[340px]", className)}>
      <div className="border-border overflow-hidden rounded-[22px] border bg-white text-[13px] text-[#0f1115] shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <div className="h-7 w-7 rounded-full bg-gradient-to-tr from-amber-400 via-pink-500 to-violet-600 p-[2px]">
            <div className="h-full w-full rounded-full bg-white" />
          </div>
          <span className="font-semibold">{username}</span>
          <span className="ml-auto text-[11px] text-neutral-400">{format.toUpperCase()}</span>
        </div>
        <div className={cn("relative bg-neutral-100", tall ? "aspect-[9/16] max-h-[420px]" : "aspect-[4/5]")}>
          {first ? (
            first.kind === "video" ? (
              <video src={first.url} className="h-full w-full object-cover" controls muted playsInline />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={first.url} alt="" className="h-full w-full object-cover" />
            )
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-neutral-400">
              {tall ? <Video className="h-8 w-8" /> : <ImageIcon className="h-8 w-8" />}
              <span className="text-[12px]">No media attached</span>
            </div>
          )}
          {media.length > 1 ? (
            <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">
              1/{media.length}
            </span>
          ) : null}
          {first?.origin === "mock_generated" ? (
            <span className="absolute bottom-2 left-2 rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              MOCK ASSET
            </span>
          ) : null}
        </div>
        {format !== "story" ? (
          <div className="px-3 pt-2.5 pb-3">
            <div className="mb-2 flex items-center gap-3.5">
              <Heart className="h-5 w-5" />
              <MessageCircle className="h-5 w-5" />
              <Send className="h-5 w-5" />
              <Bookmark className="ml-auto h-5 w-5" />
            </div>
            <p className="line-clamp-4 break-words whitespace-pre-line">
              <span className="font-semibold">{username}</span>{" "}
              {caption || <span className="text-neutral-400">Caption…</span>}
              {tags ? <span className="text-[#00376b]"> {tags}</span> : null}
            </p>
          </div>
        ) : null}
      </div>
      <p className="text-fg-subtle mt-2 text-center text-[11.5px]">
        Approximate preview — Instagram controls final rendering.
      </p>
    </div>
  );
}
