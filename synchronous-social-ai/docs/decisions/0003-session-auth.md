# ADR 0003 — First-party session authentication

**Status:** accepted · **Date:** 2026-10-21

**Decision.** Email/password with Node's built-in `scrypt`, opaque 256-bit session tokens stored only as SHA-256 hashes, `HttpOnly; SameSite=Lax; Secure` cookies (`__Host-` prefix on HTTPS), 14-day sliding expiry, login throttling per IP and per account. This follows the pattern Lucia's maintainers now recommend implementing directly rather than via a library.
**Why.** Minimal dependency surface, full control over tenant-aware session resolution (membership is re-verified on every request), easy to audit.
**Future.** The session layer (`src/server/auth/session.ts`) is the seam for enterprise SSO (OIDC/SAML via a managed provider) and MFA; RBAC and tenancy do not depend on how the user authenticated.
