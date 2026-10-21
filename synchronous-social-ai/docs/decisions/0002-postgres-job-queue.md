# ADR 0002 — Durable queue on PostgreSQL (SKIP LOCKED)

**Status:** accepted · **Date:** 2026-10-21

**Options considered.** Temporal, Inngest, BullMQ + Redis, Postgres table queue.
**Decision.** A Postgres-backed queue (`scheduled_jobs`) claimed with `FOR UPDATE SKIP LOCKED`.
**Why.**

- **Transactional enqueue:** jobs are inserted in the same transaction as the state change that requires them (e.g. approval → publish job). With Redis, a crash between the DB commit and the enqueue loses or duplicates work.
- **Idempotency by constraint:** unique `idempotency_key` makes duplicate enqueue impossible.
- One fewer stateful dependency to secure, back up and operate; queue state is covered by database backups.
- Per-tenant concurrency and kill-switch holds are a SQL predicate.
  **Trade-offs.** Lower peak throughput than Redis (fine for marketing workloads: thousands of jobs/hour, not millions). No built-in workflow UI — the Operations tab in Settings lists jobs, dead-letters and uncertain external actions. If volume grows, the `queue.ts` interface can be re-implemented on Temporal without touching services.
