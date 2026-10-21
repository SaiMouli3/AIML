# ADR 0001 — Modular monolith + worker

**Status:** accepted · **Date:** 2026-10-21

**Context.** The PRD asks to avoid premature microservices while keeping clean boundaries.
**Decision.** One Next.js application (UI + `/api/v1`) and one worker process sharing `src/server`. Domain services, policy, providers and queue are separate modules with explicit interfaces.
**Consequences.** Single deploy artifact (two processes). Boundaries (services ↔ adapters ↔ policy) allow later extraction of the worker or provider gateways.
