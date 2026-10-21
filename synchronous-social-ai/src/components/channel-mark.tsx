import { CHANNEL_META, isSocialChannel } from "@/lib/channels";
import { cn } from "@/lib/cn";

/** Compact channel mark (brand color + glyph). No third-party logo assets are bundled. */
export function ChannelMark({
  provider,
  size = "md",
  className,
}: {
  provider: string | null | undefined;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const meta = isSocialChannel(provider) ? CHANNEL_META[provider] : null;
  const dims = {
    xs: "h-4 w-4 text-[8px] rounded",
    sm: "h-5 w-5 text-[9.5px] rounded-md",
    md: "h-8 w-8 text-[12px] rounded-lg",
    lg: "h-10 w-10 text-[14px] rounded-xl",
  }[size];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-bold tracking-tight text-white shadow-sm ring-1 ring-black/5 select-none",
        dims,
        className,
      )}
      style={{
        background:
          provider === "instagram"
            ? "linear-gradient(135deg,#feda75 0%,#fa7e1e 25%,#d62976 55%,#962fbf 80%,#4f5bd5 100%)"
            : (meta?.color ?? "#64748b"),
      }}
    >
      {meta?.glyph ?? (provider === "meta_ads" ? "Ad" : "?")}
    </span>
  );
}

export function ChannelName({ provider, className }: { provider: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <ChannelMark provider={provider} size="xs" />
      {isSocialChannel(provider) ? CHANNEL_META[provider].label : provider}
    </span>
  );
}
