import { forwardRef, type HTMLAttributes, type InputHTMLAttributes, type LabelHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-card)]", className)} {...p} />;
}
export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b border-border px-5 py-4", className)}>
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold tracking-[-0.01em]">{title}</h3>
        {description ? <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
export function CardBody({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...p} />;
}

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1 text-[12px] font-medium tracking-wide text-fg-subtle uppercase">{eyebrow}</div> : null}
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-[13.5px] text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export const Label = ({ className, ...p }: LabelHTMLAttributes<HTMLLabelElement>) => (
  <label className={cn("mb-1.5 block text-[12.5px] font-medium text-fg", className)} {...p} />
);

const fieldBase =
  "w-full rounded-lg border border-border bg-surface px-3 text-[13.5px] text-fg placeholder:text-fg-subtle transition-colors hover:border-border-strong focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger-600";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(fieldBase, "h-9", className)} {...p} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, "min-h-[88px] py-2 leading-relaxed", className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return (
    <select ref={ref} className={cn(fieldBase, "h-9 pr-8", className)} {...p}>
      {children}
    </select>
  );
});

export function Field({ label, htmlFor, hint, error, children, className }: { label: string; htmlFor: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="mt-1 text-[12px] text-danger-600" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-[12px] text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";
const tones: Record<Tone, string> = {
  neutral: "bg-black/[0.04] text-fg-muted ring-black/[0.06] dark:bg-white/[0.06] dark:ring-white/10",
  brand: "bg-brand-50 text-brand-700 ring-brand-200 dark:text-brand-200",
  success: "bg-success-50 text-success-600 ring-success-600/20",
  warning: "bg-warning-50 text-warning-600 ring-warning-600/20",
  danger: "bg-danger-50 text-danger-600 ring-danger-600/20",
  info: "bg-info-50 text-info-600 ring-info-600/20",
};
export function Badge({ tone = "neutral", className, children, dot }: { tone?: Tone; className?: string; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium whitespace-nowrap ring-1 ring-inset", tones[tone], className)}>
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {icon ? <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-surface-2 text-fg-muted">{icon}</div> : null}
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {description ? <p className="mt-1 max-w-md text-[13px] text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} aria-hidden />;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "danger" | "warning" }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium text-fg-muted">{label}</div>
      <div className={cn("mt-1 text-[22px] font-semibold tracking-[-0.02em] tabular-nums", tone === "danger" && "text-danger-600", tone === "warning" && "text-warning-600")}>{value}</div>
      {sub ? <div className="mt-0.5 truncate text-[12px] text-fg-subtle">{sub}</div> : null}
    </div>
  );
}

export function KeyValue({ items, className }: { items: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-[13px]", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-fg-muted">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Table({ className, ...p }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-left text-[13px]", className)} {...p} />
    </div>
  );
}
export const Th = ({ className, ...p }: HTMLAttributes<HTMLTableCellElement>) => (
  <th scope="col" className={cn("border-b border-border bg-surface-2 px-4 py-2.5 text-[12px] font-medium whitespace-nowrap text-fg-muted", className)} {...p} />
);
export const Td = ({ className, ...p }: HTMLAttributes<HTMLTableCellElement>) => <td className={cn("border-b border-border px-4 py-3 align-middle", className)} {...p} />;

export function Notice({ tone = "info", title, children, className, icon }: { tone?: "info" | "warning" | "danger" | "success" | "neutral"; title?: ReactNode; children?: ReactNode; className?: string; icon?: ReactNode }) {
  const map = {
    info: "border-info-600/20 bg-info-50 text-info-600",
    warning: "border-warning-600/25 bg-warning-50 text-warning-600",
    danger: "border-danger-600/25 bg-danger-50 text-danger-600",
    success: "border-success-600/20 bg-success-50 text-success-600",
    neutral: "border-border bg-surface-2 text-fg-muted",
  } as const;
  return (
    <div className={cn("flex gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px]", map[tone], className)} role={tone === "danger" ? "alert" : "status"}>
      {icon ? <div className="mt-0.5 shrink-0">{icon}</div> : null}
      <div className="min-w-0">
        {title ? <div className="font-semibold">{title}</div> : null}
        {children ? <div className={cn(title && "mt-0.5", "text-fg-muted [&_strong]:text-fg")}>{children}</div> : null}
      </div>
    </div>
  );
}
