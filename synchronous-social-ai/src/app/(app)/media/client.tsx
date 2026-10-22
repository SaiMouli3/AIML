"use client";

import { Clapperboard, ImageIcon, Loader2, Sparkles, Trash2, Upload, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ModeBadge, StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { ConfirmButton, Dialog, Drawer } from "@/components/ui/overlay";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Notice,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { useRouter } from "next/navigation";

interface Asset {
  id: string;
  kind: string;
  origin: string;
  title: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
  altText: string | null;
  rights: { owner?: string; license?: string; consent?: boolean; notes?: string } | null;
  scanStatus: string;
  createdAt: string;
  generationJobId: string | null;
}
interface Job {
  id: string;
  provider: string;
  mode: string;
  model: string;
  kind: string;
  prompt: string;
  status: string;
  error: string | null;
  estimatedCostUsd: string | null;
  estimatedCredits: string | null;
  createdAt: string;
  completedAt: string | null;
  resultAssetIds: string[];
}
interface Data {
  media: Asset[];
  jobs: Job[];
  provider: { connected: boolean; name: string; mode: string | null; reason?: string };
}
type Model = {
  id: string;
  label: string;
  kind: string;
  docs: string;
  defaultParams: Record<string, unknown>;
};

const ORIGIN: Record<string, [string, "neutral" | "warning" | "brand"]> = {
  upload: ["Uploaded", "neutral"],
  provider_generated: ["Provider-generated", "brand"],
  mock_generated: ["MOCK generated", "warning"],
};

export function MediaClient({
  data,
  models,
  canWrite,
  canGenerate,
}: {
  data: Data;
  models: Model[];
  canWrite: boolean;
  canGenerate: boolean;
}) {
  const { run, isBusy } = useAction();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [gen, setGen] = useState(false);
  const [sel, setSel] = useState<Asset | null>(null);
  const active = data.jobs.some((j) => ["queued", "submitted", "in_progress"].includes(j.status));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [active, router]);
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
      <Card>
        <CardHeader
          title={`Assets (${data.media.length})`}
          description="JPEG, PNG, WebP, GIF up to 8 MB; MP4/MOV up to 300 MB. Content type is verified from file bytes."
          actions={
            canWrite ? (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime"
                  className="sr-only"
                  aria-label="Upload media"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const form = new FormData();
                    form.set("file", f);
                    void run("upload", () => api("/media", { form }), { success: "Uploaded" });
                    e.target.value = "";
                  }}
                />
                <Button
                  size="sm"
                  variant="primary"
                  loading={isBusy("upload")}
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" /> Upload
                </Button>
              </>
            ) : null
          }
        />
        {data.media.length === 0 ? (
          <EmptyState
            icon={<ImageIcon className="h-5 w-5" />}
            title="No media yet"
            description="Upload brand photography or generate assets with Higgsfield."
          />
        ) : (
          <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {data.media.map((m) => {
              const [label, tone] = ORIGIN[m.origin] ?? [m.origin, "neutral"];
              return (
                <button
                  key={m.id}
                  onClick={() => setSel(m)}
                  className="group border-border bg-surface-2 overflow-hidden rounded-xl border text-left focus-visible:ring-2"
                  aria-label={`Open ${m.title ?? "asset"}`}
                >
                  <div className="relative aspect-[4/5]">
                    {m.kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={m.url}
                        alt={m.altText ?? m.title ?? ""}
                        className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                      />
                    ) : (
                      <video src={m.url} className="h-full w-full object-cover" muted />
                    )}
                    <span className="absolute top-2 left-2">
                      <Badge tone={tone}>{label}</Badge>
                    </span>
                  </div>
                  <div className="px-2.5 py-2">
                    <div className="truncate text-[12.5px] font-medium">{m.title ?? "Untitled"}</div>
                    <div className="text-fg-subtle text-[11.5px]">
                      {m.width && m.height ? `${m.width}×${m.height} · ` : ""}
                      {(m.sizeBytes / 1024).toFixed(0)} KB
                    </div>
                  </div>
                </button>
              );
            })}
          </CardBody>
        )}
      </Card>
      <div className="space-y-6">
        <Card>
          <CardHeader
            title="Generation jobs"
            description={
              data.provider.connected
                ? data.provider.mode === "mock"
                  ? "Development mock: placeholder images only."
                  : "Higgsfield (live). Costs are estimates until settled."
                : "Higgsfield is not connected."
            }
            actions={
              <Button
                size="sm"
                variant="primary"
                disabled={!canGenerate || !data.provider.connected}
                title={!data.provider.connected ? data.provider.reason : undefined}
                onClick={() => setGen(true)}
              >
                <Sparkles className="h-3.5 w-3.5" /> Generate
              </Button>
            }
          />
          {!data.provider.connected ? (
            <CardBody>
              <Notice tone="neutral" title="Not connected">
                {data.provider.reason}
              </Notice>
            </CardBody>
          ) : data.jobs.length === 0 ? (
            <EmptyState
              icon={<Clapperboard className="h-5 w-5" />}
              title="No generation jobs"
              description="Jobs run asynchronously; results are copied into your storage."
            />
          ) : (
            <ul className="divide-border divide-y">
              {data.jobs.map((j) => (
                <li key={j.id} className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    {["queued", "submitted", "in_progress"].includes(j.status) ? (
                      <Loader2 className="text-brand-600 h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : null}
                    <span className="truncate text-[13px] font-medium">
                      {models.find((m) => m.id === j.model)?.label ?? j.model}
                    </span>
                    <ModeBadge mode={j.mode} />
                    <span className="ml-auto">
                      <StatusBadge status={j.status} />
                    </span>
                  </div>
                  <p className="text-fg-muted mt-1 line-clamp-2 text-[12px]">{j.prompt}</p>
                  <div className="text-fg-subtle mt-1 flex items-center gap-2 text-[11.5px]">
                    {fmtRelative(j.createdAt)}
                    {j.estimatedCostUsd ? ` · est. $${Number(j.estimatedCostUsd).toFixed(3)}` : ""}
                    {j.estimatedCredits ? ` · ${j.estimatedCredits} credits` : ""}
                    {["queued", "submitted"].includes(j.status) && canGenerate ? (
                      <button
                        className="text-danger-600 ml-auto inline-flex items-center gap-1 hover:underline"
                        onClick={() =>
                          run(`c${j.id}`, () => api(`/media/generations/${j.id}/cancel`, { body: {} }), {
                            success: "Cancellation requested",
                          })
                        }
                      >
                        <XCircle className="h-3 w-3" /> Cancel
                      </button>
                    ) : null}
                  </div>
                  {j.error ? <div className="text-danger-600 mt-1 text-[12px]">{j.error}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <GenerateDialog open={gen} onOpenChange={setGen} models={models} mock={data.provider.mode === "mock"} />
      {sel ? <AssetDrawer asset={sel} onClose={() => setSel(null)} canWrite={canWrite} /> : null}
    </div>
  );
}

function GenerateDialog({
  open,
  onOpenChange,
  models,
  mock,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  models: Model[];
  mock: boolean;
}) {
  const { run, isBusy } = useAction();
  const [model, setModel] = useState(models[0]?.id ?? "");
  const m = models.find((x) => x.id === model);
  const [clientRequestId] = useState(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate media"
      description="Jobs are asynchronous. Failed or moderated generations are not charged by Higgsfield."
    >
      {mock ? (
        <Notice tone="warning" title="Development mock" className="mb-4">
          No Higgsfield key is configured; output is a striped placeholder and video models return a
          storyboard frame image.
        </Notice>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const params: Record<string, unknown> = { ...m?.defaultParams };
          if (f.get("aspect_ratio")) params.aspect_ratio = f.get("aspect_ratio");
          if (f.get("duration")) params.duration = Number(f.get("duration"));
          void run(
            "gen",
            () =>
              api("/media/generations", {
                body: { modelId: model, prompt: f.get("prompt"), params, clientRequestId },
              }),
            { success: "Generation queued" },
          ).then((r) => r && onOpenChange(false));
        }}
        className="space-y-4"
      >
        <Field
          label="Model"
          htmlFor="g-model"
          hint={
            m ? (
              <a className="underline" href={m.docs} target="_blank" rel="noreferrer noopener">
                Model reference
              </a>
            ) : undefined
          }
        >
          <Select id="g-model" value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Prompt"
          htmlFor="g-prompt"
          hint="Do not describe real people without documented consent."
        >
          <Textarea id="g-prompt" name="prompt" required minLength={3} maxLength={1500} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Aspect ratio" htmlFor="g-ar">
            <Select
              id="g-ar"
              name="aspect_ratio"
              defaultValue={String(m?.defaultParams.aspect_ratio ?? "4:5")}
            >
              {(m?.kind === "video" ? ["9:16", "16:9", "1:1"] : ["4:5", "1:1", "9:16", "16:9", "3:4"]).map(
                (a) => (
                  <option key={a}>{a}</option>
                ),
              )}
            </Select>
          </Field>
          {m?.kind === "video" ? (
            <Field label="Duration (seconds)" htmlFor="g-dur">
              <Input id="g-dur" name="duration" type="number" min={3} max={15} defaultValue={5} />
            </Field>
          ) : null}
        </div>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={isBusy("gen")}>
            Queue generation
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AssetDrawer({
  asset: a,
  onClose,
  canWrite,
}: {
  asset: Asset;
  onClose: () => void;
  canWrite: boolean;
}) {
  const { run, isBusy } = useAction();
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={a.title ?? "Asset"}
      description={`${a.mimeType} · added ${fmtDateTime(a.createdAt)}`}
    >
      <div className="space-y-5">
        <div className="border-border bg-surface-2 overflow-hidden rounded-xl border">
          {a.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={a.url} alt={a.altText ?? ""} className="max-h-[420px] w-full object-contain" />
          ) : (
            <video src={a.url} controls className="max-h-[420px] w-full" />
          )}
        </div>
        {a.origin === "mock_generated" ? (
          <Notice tone="warning" title="Mock placeholder">
            Generated by the development mock. Not suitable for publication.
          </Notice>
        ) : null}
        <KeyValue
          items={[
            ["Origin", ORIGIN[a.origin]?.[0] ?? a.origin],
            ["Dimensions", a.width && a.height ? `${a.width}×${a.height}` : "—"],
            ["Size", `${(a.sizeBytes / 1024).toFixed(0)} KB`],
            ["Malware scan", a.scanStatus.replace("_", " ")],
            [
              "Instagram",
              a.mimeType === "image/jpeg" || a.kind === "video"
                ? "Publishable format"
                : "Convert to JPEG before publishing",
            ],
          ]}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(
              "rights",
              () =>
                api(`/media/${a.id}`, {
                  method: "PATCH",
                  body: {
                    altText: String(f.get("alt") ?? ""),
                    rights: {
                      owner: String(f.get("owner") ?? "") || undefined,
                      license: String(f.get("license") ?? "") || undefined,
                      consent: f.get("consent") === "on",
                      notes: String(f.get("notes") ?? "") || undefined,
                    },
                  },
                }),
              { success: "Saved" },
            );
          }}
          className="space-y-3"
        >
          <Field label="Alt text" htmlFor="m-alt">
            <Input id="m-alt" name="alt" defaultValue={a.altText ?? ""} disabled={!canWrite} />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Rights owner" htmlFor="m-owner">
              <Input id="m-owner" name="owner" defaultValue={a.rights?.owner ?? ""} disabled={!canWrite} />
            </Field>
            <Field label="License" htmlFor="m-license">
              <Input
                id="m-license"
                name="license"
                defaultValue={a.rights?.license ?? ""}
                disabled={!canWrite}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              name="consent"
              defaultChecked={a.rights?.consent ?? false}
              disabled={!canWrite}
            />{" "}
            People shown have given documented consent
          </label>
          <Field label="Rights notes" htmlFor="m-notes">
            <Textarea id="m-notes" name="notes" defaultValue={a.rights?.notes ?? ""} disabled={!canWrite} />
          </Field>
          {canWrite ? (
            <div className="flex justify-between">
              <ConfirmButton
                variant="ghost"
                label={
                  <>
                    <Trash2 className="h-4 w-4" /> Delete
                  </>
                }
                title="Delete asset?"
                effect="The file is removed from storage. Assets used by current content cannot be deleted."
                confirmLabel="Delete"
                onConfirm={() =>
                  run("del", () => api(`/media/${a.id}`, { method: "DELETE" }), { success: "Deleted" }).then(
                    () => onClose(),
                  )
                }
              />
              <Button type="submit" loading={isBusy("rights")}>
                Save metadata
              </Button>
            </div>
          ) : null}
        </form>
      </div>
    </Drawer>
  );
}
