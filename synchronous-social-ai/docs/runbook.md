# Runbook

## Processes

| Process    | Command                                                                       | Health                                                                    |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Web        | `npm run build && npm start`                                                  | `GET /api/health` (liveness), `GET /api/ready` (config + DB + migrations) |
| Worker     | `npm run worker`                                                              | logs `worker_started`; jobs visible in Settings → Operations              |
| Migrations | `npm run db:migrate` (run before each deploy; forward-only SQL in `drizzle/`) |                                                                           |

Run at least one worker. Multiple workers are safe (SKIP LOCKED + idempotency keys). The worker handles SIGTERM gracefully (finishes in-flight jobs).

## Deploy checklist

1. `APP_ENV=production`, strong `SESSION_SECRET`, `ENCRYPTION_KEY` (32 bytes base64), HTTPS `APP_URL`, `STORAGE_DRIVER=s3`.
2. Database role is **not** a superuser (RLS). Migrations owner may equal the app role (RLS is FORCED).
3. `npm run db:migrate`, then roll web and worker.
4. Keep `META_ADS_TEST_MODE=true` until the launch checklist below is complete.

## Production launch checklist

- [ ] Meta App Review + Business Verification complete; real account capabilities verified in Integrations.
- [ ] OAuth redirect URIs, token storage, refresh and disconnect tested on production.
- [ ] Webhook verified (`GET` handshake) and a signed test event processed.
- [ ] Ads tested with `META_ADS_TEST_MODE=true` (paused objects only); spend cap set; two-person threshold set; kill switch tested.
- [ ] Approval-bypass, tenant-isolation and prompt-injection tests pass in CI.
- [ ] No secrets in logs/bundles (`grep` build output for key prefixes); error messages generic.
- [ ] Backup restore and migration rollback rehearsed.
- [ ] Privacy policy, terms, data-processing disclosures, retention and deletion flows published.
- [ ] Provider costs and quotas documented; LLM and media monthly budgets set.
- [ ] Incident owner and rollback plan named.

## Backups & restore

- PostgreSQL: enable managed PITR (≥7 days) plus nightly `pg_dump -Fc`. Restore: `pg_restore -d <new_db> dump.file`, run `npm run db:migrate`, point `DATABASE_URL`, start workers last.
- Object storage: enable bucket versioning + lifecycle; keys are tenant-prefixed so a workspace can be restored independently.
- Queue state lives in Postgres and is restored with the database. After restore, review `scheduled_jobs` in `running` state (stale locks are recovered automatically; external jobs become dead-lettered for review rather than re-run).

## Incident response basics

1. **Contain:** Settings → _Emergency kill switch_ (blocks all external mutations, holds external jobs). For ads already live, pause in Meta Ads Manager if the kill switch is insufficient.
2. **Pause automation:** Inbox/Automations → _Pause all automated replies_; per-account pause in Integrations.
3. **Investigate:** Settings → Audit log (filter by `external.`, `approval.`, `budget.`); every request/job/provider call shares a correlation ID in logs.
4. **Revoke:** disconnect affected accounts (destroys tokens); rotate `META_APP_SECRET`/Higgsfield keys; rotate `SESSION_SECRET` to invalidate sessions.
5. **Uncertain outcomes:** Settings → Operations lists external actions with unknown outcomes; verify on the provider and record "sent"/"not sent".
6. **Recover:** fix, lift kill switch, retry dead-lettered jobs from Operations, write a blameless post-mortem.

## Troubleshooting

| Symptom                                                   | Cause / fix                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Agent runs stay `REQUESTED`                               | Worker not running (`npm run worker`).                                                                                |
| Publishing fails "Media must be JPEG" / Meta cannot fetch | Convert to JPEG; `APP_URL` must be public HTTPS (or use S3).                                                          |
| Comments not arriving                                     | Webhook not subscribed/verified, app not Live, account not connected, or comment monitoring disabled for the account. |
| Private reply blocked                                     | Read the eligibility reasons in the Inbox (window expired, already replied, missing scope, opt-out, rate limit).      |
| `SPEND_CAP_EXCEEDED`                                      | Raise the monthly cap in Settings (owner/admin) or reduce budget/duration.                                            |
| Mock buttons missing                                      | `APP_ENV` is staging/production or `ALLOW_MOCK_PROVIDERS=false` — expected.                                           |
