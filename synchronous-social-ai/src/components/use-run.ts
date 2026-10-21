"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";

export interface RunView {
  id: string;
  agentRole: string;
  state: string;
  output: { result?: unknown; escalationReasons?: string[]; provider?: string } | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  costUsd: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number | null;
  createdAt: string;
}

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_INPUT", "EXPIRED", "REJECTED"];

/** Polls an agent run until it reaches a terminal state (runs execute in the worker process). */
export function useRun(runId: string | null) {
  const [run, setRun] = useState<RunView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let delay = 800;
    const tick = async () => {
      try {
        const r = await api<{ run: RunView }>(`/agents/runs/${runId}`);
        if (!alive) return;
        setRun(r.run);
        if (TERMINAL.includes(r.run.state)) return;
      } catch {
        /* transient: keep polling */
      }
      delay = Math.min(delay * 1.4, 4000);
      timer.current = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [runId]);
  return { run, done: run ? TERMINAL.includes(run.state) : false };
}
