---
"@lpshanley/oidc-start-core": patch
"@lpshanley/oidc-start-react": patch
---

Revoke a single session when its owner signs out with an idle but authentic cookie. A failed revocation preserves the cookie for retry, and account-wide sign-out requires an active session.
