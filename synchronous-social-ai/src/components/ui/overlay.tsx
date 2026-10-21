"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export function Dialog({ open, onOpenChange, title, description, children, footer, size = "md" }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] data-[state=open]:animate-in" />
        <DialogPrimitive.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface shadow-[var(--shadow-pop)] focus:outline-none",
            size === "sm" ? "max-w-md" : size === "lg" ? "max-w-3xl" : "max-w-xl",
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <DialogPrimitive.Title className="text-[15px] font-semibold">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-0.5 text-[13px] text-fg-muted">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer ? <div className="flex justify-end gap-2 border-t border-border bg-surface-2 px-5 py-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Drawer({ open, onOpenChange, title, description, children, footer, width = "max-w-2xl" }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; width?: string }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <DialogPrimitive.Content className={cn("fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-[var(--shadow-pop)] focus:outline-none", width)}>
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate text-[15px] font-semibold">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-0.5 text-[13px] text-fg-muted">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">Details</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close panel">
                <X className="h-4 w-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-surface-2 px-5 py-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Confirmation for destructive/consequential actions: states the exact effect before execution. */
export function ConfirmButton({ label, title, effect, confirmLabel = "Confirm", onConfirm, variant = "secondary", size = "md", disabled, requireText, reason }: { label: ReactNode; title: string; effect: ReactNode; confirmLabel?: string; onConfirm: (reason: string) => Promise<void> | void; variant?: "primary" | "secondary" | "danger" | "ghost" | "outline"; size?: "sm" | "md"; disabled?: boolean; requireText?: string; reason?: { label: string; required?: boolean } }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [why, setWhy] = useState("");
  const blocked = (requireText && text !== requireText) || (reason?.required && !why.trim());
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)} disabled={disabled}>
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={variant === "danger" ? "danger" : "primary"}
              loading={busy}
              disabled={Boolean(blocked)}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm(why);
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13.5px] text-fg-muted">{effect}</div>
        {reason ? (
          <div className="mt-4">
            <label htmlFor="confirm-reason" className="mb-1.5 block text-[12.5px] font-medium text-fg">
              {reason.label}
            </label>
            <textarea id="confirm-reason" value={why} onChange={(e) => setWhy(e.target.value)} className="min-h-[72px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13.5px] focus:border-brand-500 focus:outline-none" />
          </div>
        ) : null}
        {requireText ? (
          <div className="mt-4">
            <label htmlFor="confirm-text" className="mb-1.5 block text-[12.5px] font-medium text-fg">
              Type <code className="rounded bg-surface-2 px-1">{requireText}</code> to confirm
            </label>
            <input id="confirm-text" value={text} onChange={(e) => setText(e.target.value)} className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] focus:border-brand-500 focus:outline-none" />
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, children }: { className?: string; children: ReactNode }) {
  return <TabsPrimitive.List className={cn("inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-1", className)}>{children}</TabsPrimitive.List>;
}
export function TabsTrigger({ value, children, count }: { value: string; children: ReactNode; count?: number }) {
  return (
    <TabsPrimitive.Trigger value={value} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-fg-muted transition-colors hover:text-fg data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-[var(--shadow-card)]">
      {children}
      {count !== undefined ? <span className="rounded bg-black/[0.06] px-1 text-[11px] tabular-nums dark:bg-white/10">{count}</span> : null}
    </TabsPrimitive.Trigger>
  );
}
export const TabsContent = TabsPrimitive.Content;

export function Switch({ checked, onCheckedChange, label, disabled, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative h-5 w-9 shrink-0 rounded-full bg-border-strong transition-colors disabled:opacity-50 data-[state=checked]:bg-brand-600"
    >
      <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content sideOffset={6} className="z-50 max-w-xs rounded-md bg-fg px-2 py-1 text-[12px] text-bg shadow-lg">
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
