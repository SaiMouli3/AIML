import Link from "next/link";
import { cn } from "@/lib/cn";

/** URL-driven filter tabs (navigation, not ARIA tabs). */
export function SegmentedNav({
  items,
  active,
  label,
}: {
  items: Array<{ value: string; label: string; href: string }>;
  active: string;
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="border-border bg-surface-2 inline-flex flex-wrap items-center gap-1 rounded-lg border p-1"
    >
      {items.map((i) => (
        <Link
          key={i.value}
          href={i.href}
          aria-current={i.value === active ? "page" : undefined}
          className={cn(
            "text-fg-muted hover:text-fg inline-flex h-7 items-center rounded-md px-2.5 text-[12.5px] font-medium transition-colors",
            i.value === active && "bg-surface text-fg shadow-[var(--shadow-card)]",
          )}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
