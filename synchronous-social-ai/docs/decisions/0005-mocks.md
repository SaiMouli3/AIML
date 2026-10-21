# ADR 0005 — Development mocks are labelled and impossible in production

**Status:** accepted · **Date:** 2026-10-21

**Decision.** Mock adapters exist for Instagram, Meta Ads, Higgsfield and the LLM so the full workflow can be exercised locally and in CI. `env().mocksAllowed` is `false` whenever `APP_ENV` is `staging` or `production`, regardless of other flags; mock connected accounts are stored with `mode = 'mock'` and refused by the policy engine when mocks are disallowed. Every mock result is labelled MOCK in the UI, audit log and notifications, and mock providers never return performance metrics.
