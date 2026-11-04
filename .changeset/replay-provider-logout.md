---
"@lpshanley/oidc-start-core": patch
---

Require expiration and token ID claims on provider logout tokens. Use the signed issue time for revocation so retries preserve newer sign-ins. Revocation stores must atomically retain the greatest subject cutoff and provider session expiry on out-of-order writes.
