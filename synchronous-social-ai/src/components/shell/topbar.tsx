"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Bell, Check, ChevronsUpDown, LogOut, Menu, Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { fmtRelative } from "@/lib/format";
import { Button } from "../ui/button";
import { SideNav } from "./nav";

interface Props {
  user: { name: string; email: string };
  workspace: { id: string; name: string };
  memberships: Array<{ workspaceId: string; name: string; role: string }>;
  role: string;
  notifications: {
    items: Array<{
      id: string;
      title: string;
      body: string | null;
      link: string | null;
      createdAt: string | Date;
      readAt: string | Date | null;
    }>;
    unread: number;
  };
  counts: { approvals: number; inbox: number };
}

export function Topbar({ user, workspace, memberships, role, notifications, counts }: Props) {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const switchTo = async (id: string) => {
    await api("/auth/switch-workspace", { body: { workspaceId: id } });
    router.push("/overview");
    router.refresh();
  };
  const menuItem =
    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-surface-2";
  return (
    <header className="border-border bg-bg/85 sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 backdrop-blur md:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Open navigation"
        onClick={() => setMobileOpen(true)}
      >
        <Menu className="h-4 w-4" />
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="flex h-8 max-w-[300px] items-center gap-2 rounded-lg px-2 text-[13px] font-medium hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            aria-label={`Workspace: ${workspace.name}. Switch workspace`}
          >
            <span className="from-brand-500 to-brand-700 flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br text-[11px] font-semibold text-white">
              {workspace.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="truncate">{workspace.name}</span>
            <span className="text-fg-muted hidden rounded bg-black/[0.05] px-1 text-[11px] sm:inline dark:bg-white/10">
              {role.replace("_", " ")}
            </span>
            <ChevronsUpDown className="text-fg-subtle h-3.5 w-3.5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            className="border-border bg-surface z-50 min-w-[240px] rounded-xl border p-1 shadow-[var(--shadow-pop)]"
          >
            <DropdownMenu.Label className="text-fg-subtle px-2 py-1.5 text-[11.5px] font-medium">
              Workspaces
            </DropdownMenu.Label>
            {memberships.map((m) => (
              <DropdownMenu.Item
                key={m.workspaceId}
                onSelect={() => switchTo(m.workspaceId)}
                className={menuItem}
              >
                <span className="flex-1 truncate">{m.name}</span>
                {m.workspaceId === workspace.id ? <Check className="text-brand-600 h-3.5 w-3.5" /> : null}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="bg-border my-1 h-px" />
            <DropdownMenu.Item asChild>
              <Link href="/onboarding?new=1" className={menuItem}>
                <Plus className="h-3.5 w-3.5" /> New workspace
              </Link>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <div className="ml-auto flex items-center gap-1">
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Notifications (${notifications.unread} unread)`}
              className="relative"
            >
              <Bell className="h-4 w-4" />
              {notifications.unread ? (
                <span className="bg-danger-600 absolute top-1 right-1 h-2 w-2 rounded-full" />
              ) : null}
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={6}
              className="border-border bg-surface z-50 w-[min(360px,calc(100vw-2rem))] rounded-xl border shadow-[var(--shadow-pop)]"
            >
              <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
                <span className="text-[13px] font-semibold">Notifications</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!notifications.unread}
                  onClick={async () => {
                    await api("/notifications/read", { body: {} });
                    router.refresh();
                  }}
                >
                  Mark all read
                </Button>
              </div>
              <ul className="max-h-[380px] overflow-y-auto">
                {notifications.items.length === 0 ? (
                  <li className="text-fg-muted px-4 py-8 text-center text-[13px]">No notifications yet.</li>
                ) : null}
                {notifications.items.map((n) => (
                  <li key={n.id} className="border-border border-b last:border-0">
                    <Link href={n.link ?? "/overview"} className="hover:bg-surface-2 block px-4 py-2.5">
                      <div className="flex items-start gap-2">
                        {!n.readAt ? (
                          <span className="bg-brand-600 mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" />
                        ) : (
                          <span className="w-1.5" />
                        )}
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium">{n.title}</div>
                          {n.body ? <div className="text-fg-muted truncate text-[12px]">{n.body}</div> : null}
                          <div className="text-fg-subtle mt-0.5 text-[11.5px]">
                            {fmtRelative(n.createdAt)}
                          </div>
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className="bg-surface ring-border ml-1 flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-semibold ring-1"
              aria-label="Account menu"
            >
              {user.name.slice(0, 1).toUpperCase()}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              className="border-border bg-surface z-50 min-w-[220px] rounded-xl border p-1 shadow-[var(--shadow-pop)]"
            >
              <div className="px-2 py-1.5">
                <div className="text-[13px] font-medium">{user.name}</div>
                <div className="text-fg-muted truncate text-[12px]">{user.email}</div>
              </div>
              <DropdownMenu.Separator className="bg-border my-1 h-px" />
              <DropdownMenu.Item
                onSelect={async () => {
                  try {
                    await api("/auth/logout", { body: {} });
                  } catch {
                    toast.error("Sign out failed");
                  }
                  router.push("/login");
                  router.refresh();
                }}
                className={menuItem}
              >
                <LogOut className="h-3.5 w-3.5" /> Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <div className="border-border bg-bg absolute inset-y-0 left-0 w-72 overflow-y-auto border-r p-3">
            <div className="mb-3 flex justify-end">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close navigation"
                onClick={() => setMobileOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <SideNav counts={counts} onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      ) : null}
    </header>
  );
}
