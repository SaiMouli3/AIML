# ADR 0004 — LLM provider via an OpenAI-compatible gateway

**Status:** accepted · **Date:** 2026-10-21

**Decision.** Agents call `POST {LLM_BASE_URL}/chat/completions` with `response_format: json_schema`. Default gateway: Experiential Labs (`https://api.experientiallabs.ai/v1`), default model `claude-sonnet-5.5`, fast model `claude-haiku-5.5` (both verified to support structured output via the gateway's `/models` endpoint on 2026-10-21). Any OpenAI-compatible endpoint can be configured.
**Safeguards.** Outputs are re-validated with zod; usage and gateway-reported cost (`usage.cost`) are stored per run; when cost is not reported it is estimated from list prices and flagged as an estimate.
