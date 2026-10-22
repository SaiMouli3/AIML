"use client";

import { CheckCircle2, KeyRound, PlugZap, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Notice,
  Table,
  Td,
  Th,
} from "@/components/ui/primitives";
import { useAction } from "@/components/use-action";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { fmtRelative } from "@/lib/format";

type SecretKey = "llm_api_key" | "higgsfield_key_id" | "higgsfield_key_secret";
type Price = { input: number; output: number };
type ImageProvider = "auto" | "higgsfield" | "gateway" | "off";

export interface AiData {
  settings: {
    llmBaseUrl?: string;
    defaultModel?: string;
    fastModel?: string;
    imageModel?: string;
    imageProvider?: ImageProvider;
    prices?: Record<string, Price>;
    imagePriceUsd?: number;
  };
  secrets: Record<SecretKey, { saved: boolean; hint?: string; updatedAt?: string }>;
  serverDefaults: {
    llmBaseUrl: string;
    defaultModel: string;
    fastModel: string;
    imageModel: string;
    imagePriceUsd: number;
    hasServerLlmKey: boolean;
    hasServerHiggsfield: boolean;
  };
  effective: {
    llmBaseUrl: string;
    keySource: "workspace" | "server" | "none";
    models: { default: string; fast: string; image: string };
    imageProvider: ImageProvider;
    higgsfieldSource: "workspace" | "server" | "none";
  };
}

interface GatewayModel {
  id: string;
  structuredOutput: boolean;
  emitsImages: boolean;
  contextTokens: number | null;
  price: Price | null;
}

const IMAGE_PROVIDERS: Array<[ImageProvider, string, string]> = [
  ["auto", "Automatic", "Higgsfield if keys are saved, otherwise the gateway image model"],
  ["gateway", "Gateway image model", "Generate images through the AI gateway (e.g. Nano Banana)"],
  ["higgsfield", "Higgsfield", "Use Higgsfield for images and video"],
  ["off", "Off", "No image generation in this workspace"],
];

/** Write-only key field: shows whether a key is saved (last 4 only); typing a value replaces it on save. */
function SecretField({
  id,
  label,
  hint,
  state,
  fallback,
  value,
  remove,
  onChange,
  onRemove,
}: {
  id: string;
  label: string;
  hint?: string;
  state: { saved: boolean; hint?: string; updatedAt?: string };
  fallback?: string;
  value: string;
  remove: boolean;
  onChange: (v: string) => void;
  onRemove: (v: boolean) => void;
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={
        remove
          ? "Will be removed when you save."
          : state.saved
            ? `Saved ••••${state.hint} · updated ${fmtRelative(state.updatedAt ?? null)}. Type a new value to replace it.`
            : (hint ?? fallback)
      }
    >
      <div className="flex gap-2">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={state.saved ? `••••••••${state.hint}` : "Paste key"}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (e.target.value) onRemove(false);
          }}
        />
        {state.saved ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={remove ? `Keep ${label}` : `Remove ${label}`}
            title={remove ? "Keep the saved key" : "Remove the saved key"}
            onClick={() => onRemove(!remove)}
            className={cn(remove && "text-danger-600")}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

export function AiSettings({ data }: { data: AiData }) {
  const { run, isBusy } = useAction();
  const d = data.serverDefaults;
  const [baseUrl, setBaseUrl] = useState(data.settings.llmBaseUrl ?? "");
  const [models, setModels] = useState({
    defaultModel: data.settings.defaultModel ?? "",
    fastModel: data.settings.fastModel ?? "",
    imageModel: data.settings.imageModel ?? "",
  });
  const [imageProvider, setImageProvider] = useState<ImageProvider>(data.settings.imageProvider ?? "auto");
  const [prices, setPrices] = useState<Record<string, Price>>(data.settings.prices ?? {});
  const [imagePrice, setImagePrice] = useState(
    data.settings.imagePriceUsd !== undefined ? String(data.settings.imagePriceUsd) : "",
  );
  const [secrets, setSecrets] = useState<Record<SecretKey, string>>({
    llm_api_key: "",
    higgsfield_key_id: "",
    higgsfield_key_secret: "",
  });
  const [removed, setRemoved] = useState<Record<SecretKey, boolean>>({
    llm_api_key: false,
    higgsfield_key_id: false,
    higgsfield_key_secret: false,
  });
  const [gateway, setGateway] = useState<{ count: number; latencyMs: number; models: GatewayModel[] } | null>(
    null,
  );
  const [newModel, setNewModel] = useState("");

  const effective = {
    default: models.defaultModel || d.defaultModel,
    fast: models.fastModel || d.fastModel,
    image: models.imageModel || d.imageModel,
  };
  const textModels = useMemo(
    () => gateway?.models.filter((m) => m.structuredOutput && !m.emitsImages) ?? [],
    [gateway],
  );
  const imageModels = useMemo(() => gateway?.models.filter((m) => m.emitsImages) ?? [], [gateway]);
  const gatewayPrice = (id: string) => gateway?.models.find((m) => m.id === id)?.price ?? null;
  const priceRows = [...new Set([effective.default, effective.fast, ...Object.keys(prices)])];

  const secretPayload = () => {
    const out: Partial<Record<SecretKey, string | null>> = {};
    for (const k of Object.keys(secrets) as SecretKey[]) {
      if (secrets[k].trim()) out[k] = secrets[k].trim();
      else if (removed[k]) out[k] = null;
    }
    return out;
  };

  const test = () =>
    run(
      "test",
      async () => {
        const r = await api<{ count: number; latencyMs: number; models: GatewayModel[] }>(
          "/workspace/ai/test",
          {
            body: {
              ...(baseUrl.trim() ? { llmBaseUrl: baseUrl.trim() } : {}),
              ...(secrets.llm_api_key.trim() ? { apiKey: secrets.llm_api_key.trim() } : {}),
            },
          },
        );
        setGateway(r);
        return r;
      },
      { success: "Gateway reachable", refresh: false },
    );

  const save = () =>
    run(
      "save-ai",
      () =>
        api("/workspace/ai", {
          method: "PUT",
          body: {
            llmBaseUrl: baseUrl.trim(),
            defaultModel: models.defaultModel.trim(),
            fastModel: models.fastModel.trim(),
            imageModel: models.imageModel.trim(),
            imageProvider,
            prices,
            imagePriceUsd: imagePrice.trim() === "" ? null : Number(imagePrice),
            secrets: secretPayload(),
          },
        }),
      { success: "AI settings saved (audited; key values are never logged)" },
    ).then((r) => {
      if (r) {
        setSecrets({ llm_api_key: "", higgsfield_key_id: "", higgsfield_key_secret: "" });
        setRemoved({ llm_api_key: false, higgsfield_key_id: false, higgsfield_key_secret: false });
      }
    });

  const setPrice = (model: string, side: keyof Price, v: string) =>
    setPrices((p) => {
      const cur = p[model] ?? gatewayPrice(model) ?? { input: 0, output: 0 };
      return { ...p, [model]: { ...cur, [side]: v === "" ? 0 : Number(v) } };
    });

  const keyBadge =
    data.effective.keySource === "workspace" ? (
      <Badge tone="success">Workspace key</Badge>
    ) : data.effective.keySource === "server" ? (
      <Badge tone="info">Using server key</Badge>
    ) : (
      <Badge tone="warning">No key · agents use the labelled mock</Badge>
    );

  return (
    <div className="space-y-6">
      <Notice
        tone="neutral"
        icon={<KeyRound className="h-4 w-4" />}
        title="Only the workspace owner can see and change this page"
      >
        Keys are encrypted at rest and never shown again after saving. Anything you leave empty uses the
        server default. Every change is recorded in the audit log without the key values.
      </Notice>

      <Card>
        <CardHeader
          title="AI gateway"
          description="Any OpenAI-compatible endpoint. Experiential Labs is the default."
          actions={keyBadge}
        />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <Field label="Gateway base URL" htmlFor="ai-url" hint={`Empty = server default (${d.llmBaseUrl})`}>
            <Input
              id="ai-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={d.llmBaseUrl}
              inputMode="url"
            />
          </Field>
          <SecretField
            id="ai-key"
            label="API key"
            state={data.secrets.llm_api_key}
            fallback={d.hasServerLlmKey ? "Empty = use the server's key" : "Required for live AI"}
            value={secrets.llm_api_key}
            remove={removed.llm_api_key}
            onChange={(v) => setSecrets((s) => ({ ...s, llm_api_key: v }))}
            onRemove={(v) => setRemoved((s) => ({ ...s, llm_api_key: v }))}
          />
          <div className="flex flex-wrap items-center gap-3 md:col-span-2">
            <Button type="button" onClick={test} loading={isBusy("test")}>
              <PlugZap className="h-4 w-4" /> Test connection & load models
            </Button>
            {gateway ? (
              <span className="text-success-600 inline-flex items-center gap-1.5 text-[12.5px]">
                <CheckCircle2 className="h-4 w-4" /> {gateway.count} models · {gateway.latencyMs} ms
              </span>
            ) : (
              <span className="text-fg-subtle text-[12.5px]">
                Uses the URL and key above (unsaved values included); nothing is stored by testing.
              </span>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Models"
          description="Which model each kind of work uses. Pick from the gateway list after testing, or type a model ID."
        />
        <CardBody className="grid gap-4 md:grid-cols-3">
          <datalist id="ai-text-models">
            {textModels.map((m) => (
              <option key={m.id} value={m.id} />
            ))}
          </datalist>
          <datalist id="ai-image-models">
            {imageModels.map((m) => (
              <option key={m.id} value={m.id} />
            ))}
          </datalist>
          {(
            [
              [
                "defaultModel",
                "Default model",
                "Strategy, copywriting, community replies, ads",
                d.defaultModel,
                "ai-text-models",
              ],
              [
                "fastModel",
                "Fast model",
                "Quick classification and short tasks",
                d.fastModel,
                "ai-text-models",
              ],
              [
                "imageModel",
                "Image model",
                "Used when images come from the gateway",
                d.imageModel,
                "ai-image-models",
              ],
            ] as const
          ).map(([k, label, hint, def, list]) => (
            <Field key={k} label={label} htmlFor={`ai-${k}`} hint={`${hint}. Empty = ${def}`}>
              <Input
                id={`ai-${k}`}
                list={list}
                value={models[k]}
                placeholder={def}
                onChange={(e) => setModels((m) => ({ ...m, [k]: e.target.value }))}
                spellCheck={false}
              />
            </Field>
          ))}
          <fieldset className="md:col-span-3">
            <legend className="mb-2 text-[12.5px] font-medium">Image generation</legend>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {IMAGE_PROVIDERS.map(([v, label, desc]) => (
                <label
                  key={v}
                  className={cn(
                    "border-border hover:border-border-strong flex cursor-pointer gap-2.5 rounded-lg border p-3 text-[13px]",
                    imageProvider === v && "border-brand-500 bg-brand-50/50",
                  )}
                >
                  <input
                    type="radio"
                    name="image-provider"
                    value={v}
                    checked={imageProvider === v}
                    onChange={() => setImageProvider(v)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{label}</span>
                    <span className="text-fg-muted block text-[12px]">{desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Costs"
          description="USD per 1M tokens. Used for budgets and usage when the gateway doesn't report the exact cost of a call."
          actions={
            gateway ? (
              <Button
                size="sm"
                type="button"
                onClick={() =>
                  setPrices((p) => {
                    const next = { ...p };
                    for (const m of priceRows) {
                      const gp = gatewayPrice(m);
                      if (gp) next[m] = gp;
                    }
                    return next;
                  })
                }
              >
                <RefreshCw className="h-3.5 w-3.5" /> Use gateway prices
              </Button>
            ) : null
          }
        />
        <Table>
          <thead>
            <tr>
              <Th>Model</Th>
              <Th>Input $/1M</Th>
              <Th>Output $/1M</Th>
              <Th>Gateway list price</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {priceRows.map((m) => {
              const gp = gatewayPrice(m);
              const p = prices[m];
              return (
                <tr key={m}>
                  <Td className="font-mono text-[12.5px]">
                    {m}
                    {m === effective.default ? <Badge className="ml-2">default</Badge> : null}
                    {m === effective.fast ? <Badge className="ml-2">fast</Badge> : null}
                  </Td>
                  {(["input", "output"] as const).map((side) => (
                    <Td key={side}>
                      <Input
                        aria-label={`${m} ${side} price`}
                        inputMode="decimal"
                        className="h-8 w-28"
                        value={p ? String(p[side]) : ""}
                        placeholder={gp ? String(gp[side]) : "built-in"}
                        onChange={(e) => setPrice(m, side, e.target.value)}
                      />
                    </Td>
                  ))}
                  <Td className="text-fg-muted text-[12.5px] tabular-nums">
                    {gp ? `$${gp.input} / $${gp.output}` : gateway ? "not listed" : "test to load"}
                  </Td>
                  <Td>
                    {p ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        onClick={() =>
                          setPrices((x) => {
                            const n = { ...x };
                            delete n[m];
                            return n;
                          })
                        }
                      >
                        Reset
                      </Button>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <CardBody className="border-border grid gap-4 border-t md:grid-cols-3">
          <Field label="Add a model price" htmlFor="ai-add-model" hint="For other models you route work to.">
            <div className="flex gap-2">
              <Input
                id="ai-add-model"
                list="ai-text-models"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                placeholder="model-id"
                spellCheck={false}
              />
              <Button
                type="button"
                disabled={!newModel.trim()}
                onClick={() => {
                  const id = newModel.trim();
                  setPrices((p) => ({ ...p, [id]: p[id] ?? gatewayPrice(id) ?? { input: 0, output: 0 } }));
                  setNewModel("");
                }}
              >
                Add
              </Button>
            </div>
          </Field>
          <Field
            label="Image price (USD per image)"
            htmlFor="ai-img-price"
            hint={`Estimate used for media budgets. Empty = $${d.imagePriceUsd}`}
          >
            <Input
              id="ai-img-price"
              inputMode="decimal"
              value={imagePrice}
              placeholder={String(d.imagePriceUsd)}
              onChange={(e) => setImagePrice(e.target.value)}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Higgsfield"
          description="Image and video generation. Leave empty to use the server's keys, if any."
          actions={
            data.effective.higgsfieldSource === "workspace" ? (
              <Badge tone="success">Workspace keys</Badge>
            ) : data.effective.higgsfieldSource === "server" ? (
              <Badge tone="info">Using server keys</Badge>
            ) : (
              <Badge>Not set</Badge>
            )
          }
        />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <SecretField
            id="hf-id"
            label="API key ID"
            state={data.secrets.higgsfield_key_id}
            value={secrets.higgsfield_key_id}
            remove={removed.higgsfield_key_id}
            onChange={(v) => setSecrets((s) => ({ ...s, higgsfield_key_id: v }))}
            onRemove={(v) => setRemoved((s) => ({ ...s, higgsfield_key_id: v }))}
          />
          <SecretField
            id="hf-secret"
            label="API key secret"
            state={data.secrets.higgsfield_key_secret}
            value={secrets.higgsfield_key_secret}
            remove={removed.higgsfield_key_secret}
            onChange={(v) => setSecrets((s) => ({ ...s, higgsfield_key_secret: v }))}
            onRemove={(v) => setRemoved((s) => ({ ...s, higgsfield_key_secret: v }))}
          />
        </CardBody>
      </Card>

      <div className="flex justify-end">
        <Button variant="primary" onClick={save} loading={isBusy("save-ai")}>
          Save AI settings
        </Button>
      </div>
    </div>
  );
}
