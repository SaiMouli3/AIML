"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bot,
  Brain,
  CalendarDays,
  Images,
  Inbox,
  LayoutDashboard,
  Megaphone,
  PenSquare,
  Plug,
  Settings,
  ShieldCheck,
  Users,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/cn";

export const NAV = [
  { href: "/overview", label: "Overview", icon: LayoutDashboard },
  { href: "/ai-team", label: "AI Team", icon: Bot },
  { href: "/content", label: "Content Studio", icon: PenSquare },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/inbox", label: "Inbox", icon: Inbox, badge: "inbox" },
  { href: "/campaigns", label: "Campaigns & Ads", icon: Megaphone },
  { href: "/media", label: "Media Library", icon: Images },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/brain", label: "Company Brain", icon: Brain },
  { href: "/approvals", label: "Approvals", icon: ShieldCheck, badge: "approvals" },
  { href: "/automations", label: "Automations", icon: Workflow },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/team", label: "Team & Permissions", icon: Users },
  { href: "/settings", label: "Settings & Usage", icon: Settings },
] as const;

export function SideNav({
  counts,
  onNavigate,
}: {
  counts: { approvals: number; inbox: number };
  onNavigate?: () => void;
}) {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const active = path === item.href || path.startsWith(`${item.href}/`);
        const Icon = item.icon;
        const count = "badge" in item ? counts[item.badge as keyof typeof counts] : 0;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
              active
                ? "bg-surface text-fg ring-border shadow-[var(--shadow-card)] ring-1"
                : "text-fg-muted hover:text-fg hover:bg-black/[0.035] dark:hover:bg-white/[0.05]",
            )}
          >
            <Icon
              className={cn(
                "h-4 w-4 shrink-0",
                active ? "text-brand-600" : "text-fg-subtle group-hover:text-fg-muted",
              )}
              aria-hidden
            />
            <span className="truncate">{item.label}</span>
            {count > 0 ? (
              <span className="bg-brand-600 ml-auto rounded-md px-1.5 text-[11px] leading-[18px] font-semibold text-white tabular-nums">
                {count > 99 ? "99+" : count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
