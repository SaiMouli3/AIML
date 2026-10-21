# ADR 0006 — One content item per channel; a shared publisher interface

**Status:** accepted · **Date:** 2026-10-21

**Context.** Facebook Pages, Threads, X and TikTok were added next to Instagram. Each has different formats, limits, media rules, OAuth flows and asynchronous processing. The product had to stay simple: no extra navigation, and no weakening of approvals.

**Decision.**

- A content item still has exactly **one destination account**. Cross-posting is **Copy to channel**, which creates a new draft for that channel. Each copy is validated against its own platform rules, approved separately (the approval payload includes the channel, and for TikTok the privacy level) and published, reconciled and audited independently. One approval never fans out to several platforms.
- Facebook, Threads, X and TikTok implement a single `ChannelPublisher` interface: `publish` returns `published` or `processing` with a provider ref, and `checkPublish` advances it. The ref is persisted in the job payload (`RescheduleSignal`), so a retry continues the same post instead of creating a second one. Instagram keeps its existing container adapter, which already works this way.
- `findRecent` reconciles ambiguous outcomes where the platform allows it (Facebook, Threads, X). TikTok returns `undefined` (no lookup), so a person resolves it.
- Channel rules (formats, limits, media counts) live in `src/lib/channels.ts`. Both the UI (live hints, preview counter) and the server (approval gate) use it, so they cannot disagree.
- The comment-to-DM inbox covers Instagram and Facebook Pages, which share Meta's webhook, private-reply and 24-hour messaging model. Threads, X and TikTok are publishing-only for now, because their reply and DM APIs have different eligibility rules and costs that need their own design.

**Consequences.** Adding a channel means writing an adapter, a catalog entry and OAuth wiring; approvals, policy, the queue and the audit log are reused unchanged. Posting to N channels takes N approvals, which is deliberate.
